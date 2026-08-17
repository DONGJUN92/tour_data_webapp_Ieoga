import { getRuntimeSecret } from "@/lib/runtime-env";
import {
  KTO_BASE_URL,
  KTO_MOBILE_APP,
  KTO_MOBILE_OS,
} from "./registry";
import {
  KtoError,
  type KtoAudit,
  type KtoCallResult,
  type KtoItem,
  type KtoServiceName,
} from "./types";

type KtoParams = Record<string, string | number | boolean | undefined>;

export type KtoCallOptions = {
  fieldsUsed?: string[];
  timeoutMs?: number;
  retry?: boolean;
  cacheTtlSeconds?: number;
  signal?: AbortSignal;
};

type WorkerCacheStorage = {
  default?: Cache;
};

function asItems(value: unknown): KtoItem[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is KtoItem => Boolean(item) && typeof item === "object",
    );
  }
  if (value && typeof value === "object") return [value as KtoItem];
  return [];
}

function asNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sourceReferenceDate(items: KtoItem[]): string | undefined {
  const first = items[0];
  if (!first) return undefined;
  const candidates = [
    first.baseYmd,
    first.baseYm,
    first.modifiedtime,
    first.createdtime,
  ];
  return candidates.find((value): value is string => typeof value === "string");
}

function safeCode(value: unknown): string {
  const code = typeof value === "string" ? value : "UNKNOWN";
  return code.replace(/[^A-Z0-9_-]/gi, "").slice(0, 40) || "UNKNOWN";
}

export function ktoServiceKeyConfigured(): boolean {
  return Boolean(getRuntimeSecret("KTO_SERVICE_KEY"));
}

/* The portal queues concurrent requests per account rather than serving them
   in parallel: measured against the live service, three simultaneous calls
   each return in about 0.2s while eight push most responses past 3.4s. Detail
   lookups run on a 2.5s budget, so an unthrottled burst turns calls that would
   have succeeded into timeouts — losing the opening-hours evidence and
   spending the recovery budget on nothing. Capping in-flight requests keeps
   each one fast instead. */
const MAX_CONCURRENT_KTO_REQUESTS = 3;
let inFlightRequests = 0;
const waiting: Array<() => void> = [];

async function acquireRequestSlot(): Promise<void> {
  if (inFlightRequests < MAX_CONCURRENT_KTO_REQUESTS) {
    inFlightRequests += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlightRequests += 1;
}

function releaseRequestSlot(): void {
  inFlightRequests -= 1;
  const next = waiting.shift();
  if (next) next();
}

/* Waits before a retry so a struggling upstream is not hit again instantly.
   Exponential with jitter, so concurrent callers that failed together do not
   line up and retry in the same instant. Resolves early if the caller aborts,
   which keeps the recovery response budget honest. */
function backoffDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  const base = Math.min(1_000, 150 * 2 ** attempt);
  const wait = base + Math.random() * base * 0.5;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, wait);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* Latency on the portal is erratic rather than uniformly slow: the identical
   query, with the same parameters and the same result count, was measured
   returning in 0.19s on one call and 6.5s on the next. Waiting longer does not
   help, because a slow call is not a call that is nearly done — it is a call
   that drew the bad path. Retrying only after a timeout means paying the full
   timeout first.

   So for calls the whole request depends on, a second identical attempt is
   started while the first is still running, and whichever answers first wins.
   The loser is aborted. This converts "sometimes 6s" into "almost always fast"
   at the cost of one extra call on the slow fraction. Use it only where the
   result is on the critical path; ordinary calls keep the plain retry. */
export async function callKtoHedged(
  service: KtoServiceName,
  operation: string,
  params: KtoParams = {},
  options: KtoCallOptions & { hedgeAfterMs?: number } = {},
): Promise<KtoCallResult> {
  const hedgeAfterMs = options.hedgeAfterMs ?? 1_200;
  const controllers: AbortController[] = [];
  /* 실제로 띄운 시도 수. 헤지가 걸리면 2건이 바깥으로 나가는데, 승자의 감사
     기록만 돌려주면 그 안에는 1건으로 적혀 있다. 예산 계량기가 그 값을 믿으면
     느린 구간에서 조용히 한도를 넘는다. */
  let launched = 0;

  function launch(): Promise<KtoCallResult> {
    launched += 1;
    const controller = new AbortController();
    controllers.push(controller);
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    return callKto(service, operation, params, {
      ...options,
      signal,
      retry: false,
    });
  }

  /* Called once a winner has been awaited, so aborting every controller is
     safe: the settled attempt ignores it and any still-running one is
     released. Aborting only the non-first controller would leak the original
     request whenever the hedge won. */
  function abortAll() {
    for (const controller of controllers) controller.abort();
  }

  const first = launch();

  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  const hedged = new Promise<KtoCallResult>((resolve, reject) => {
    hedgeTimer = setTimeout(() => {
      launch().then(resolve, reject);
    }, hedgeAfterMs);
  });

  try {
    /* Promise.any resolves on the first success and only rejects if every
       attempt fails, which is exactly the desired semantics: a hedge must not
       turn one slow-but-fine call into an error. */
    const result = await Promise.any([first, hedged]);
    /* 승자 한 건이 아니라 **띄운 만큼**을 적는다. 승자 자신이 재시도를 했다면
       그 값이 이미 1보다 크므로, 큰 쪽을 남긴다. */
    return {
      ...result,
      audit: {
        ...result.audit,
        upstreamCalls: Math.max(result.audit.upstreamCalls, launched),
      },
    };
  } catch (error) {
    /* AggregateError means both attempts failed. Surface the first attempt's
       own error so the audit keeps its real code rather than a wrapper. */
    if (error instanceof AggregateError) {
      return await first;
    }
    throw error;
  } finally {
    if (hedgeTimer) clearTimeout(hedgeTimer);
    abortAll();
    /* Keep the unawaited loser from surfacing as an unhandled rejection. */
    void hedged.catch(() => undefined);
    void first.catch(() => undefined);
  }
}

export async function callKto(
  service: KtoServiceName,
  operation: string,
  params: KtoParams = {},
  options: KtoCallOptions = {},
): Promise<KtoCallResult> {
  const serviceKey = getRuntimeSecret("KTO_SERVICE_KEY");
  const startedAt = Date.now();
  /* 실제로 나간 fetch 횟수. 시도 루프 안에서 호출 직전에 증가시킨다 — 재시도와
     실패도 예산을 쓰기 때문이다. */
  let upstreamCalls = 0;
  const baseAudit: KtoAudit = {
    apiName: service,
    operation,
    status: "error",
    latencyMs: 0,
    resultCount: 0,
    totalCount: 0,
    fieldsUsed: options.fieldsUsed ?? [],
    upstreamCalls: 0,
  };

  if (!serviceKey) {
    const audit = {
      ...baseAudit,
      latencyMs: Date.now() - startedAt,
      errorCode: "KTO_KEY_MISSING",
    };
    throw new KtoError(
      "한국관광공사 OpenAPI 인증키가 서버에 설정되지 않았습니다.",
      "KTO_KEY_MISSING",
      503,
      audit,
    );
  }

  const edgeCache = (
    globalThis as unknown as { caches?: WorkerCacheStorage }
  ).caches?.default;
  const cacheRequest =
    edgeCache && options.cacheTtlSeconds
      ? new Request(
          `https://kto-cache.ieoga.internal/${service}/${operation}?${new URLSearchParams(
            Object.entries(params)
              .filter((entry): entry is [string, string | number | boolean] =>
                entry[1] !== undefined && entry[1] !== "",
              )
              .map(([key, value]) => [key, String(value)]),
          ).toString()}`,
        )
      : undefined;
  if (edgeCache && cacheRequest) {
    const cached = await edgeCache.match(cacheRequest);
    if (cached) {
      const result = (await cached.json()) as KtoCallResult;
      return {
        ...result,
        audit: {
          ...result.audit,
          latencyMs: Date.now() - startedAt,
          fieldsUsed: options.fieldsUsed ?? result.audit.fieldsUsed,
          /* 캐시 적중은 바깥으로 나가지 않았다. 저장된 값에 딸려 온 호출 수를
             그대로 쓰면 이번 요청의 예산을 쓴 것처럼 계산된다. */
          upstreamCalls: 0,
        },
      };
    }
  }

  const url = new URL(`${KTO_BASE_URL}/${service}/${operation}`);
  const search = new URLSearchParams({
    serviceKey,
    MobileOS: KTO_MOBILE_OS,
    MobileApp: KTO_MOBILE_APP,
    _type: "json",
  });

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  url.search = search.toString();

  const attempts = options.retry === false ? 1 : 2;
  let lastStatus: number | undefined;
  let lastCode = "KTO_UPSTREAM_ERROR";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    /* The slot is held only for the network call, so a slow response cannot
       block the queue longer than its own timeout. */
    await acquireRequestSlot();
    try {
      upstreamCalls += 1;
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: options.signal
          ? AbortSignal.any([
              options.signal,
              AbortSignal.timeout(options.timeoutMs ?? 8_000),
            ])
          : AbortSignal.timeout(options.timeoutMs ?? 8_000),
        cache: "no-store",
      });
      lastStatus = response.status;

      if (!response.ok) {
        lastCode = `HTTP_${response.status}`;
        if (
          attempt + 1 < attempts &&
          (response.status === 429 || response.status >= 500)
        ) {
          await backoffDelay(attempt, options.signal);
          continue;
        }
        break;
      }

      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        lastCode = "INVALID_JSON";
        break;
      }

      const envelope = payload as {
        response?: {
          header?: { resultCode?: unknown; resultMsg?: unknown };
          body?: {
            items?: { item?: unknown } | "";
            totalCount?: unknown;
            pageNo?: unknown;
            numOfRows?: unknown;
          };
        };
      };
      const resultCode = String(envelope.response?.header?.resultCode ?? "");
      if (resultCode !== "0000") {
        lastCode = safeCode(resultCode || "INVALID_ENVELOPE");
        break;
      }

      const body = envelope.response?.body;
      const itemValue =
        body?.items && typeof body.items === "object"
          ? body.items.item
          : undefined;
      const items = asItems(itemValue);
      const totalCount = asNumber(body?.totalCount, items.length);
      const audit: KtoAudit = {
        ...baseAudit,
        status: items.length > 0 || totalCount > 0 ? "live" : "empty",
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
        resultCount: items.length,
        totalCount,
        sourceReferenceDate: sourceReferenceDate(items),
        upstreamCalls,
      };

      const result: KtoCallResult = {
        items,
        totalCount,
        pageNo: asNumber(body?.pageNo, 1),
        numOfRows: asNumber(body?.numOfRows, items.length),
        audit,
      };
      if (edgeCache && cacheRequest && options.cacheTtlSeconds) {
        await edgeCache.put(
          cacheRequest,
          new Response(JSON.stringify(result), {
            headers: {
              "Cache-Control": `public, max-age=${options.cacheTtlSeconds}`,
              "Content-Type": "application/json",
            },
          }),
        );
      }
      return result;
    } catch (error) {
      if (options.signal?.aborted) {
        lastCode = "REQUEST_ABORTED";
        break;
      }
      lastCode =
        error instanceof DOMException && error.name === "TimeoutError"
          ? "TIMEOUT"
          : "NETWORK_ERROR";
      if (attempt + 1 < attempts) {
        await backoffDelay(attempt, options.signal);
        continue;
      }
    } finally {
      /* Covers every exit from the attempt — success, break, continue and
         throw — so a slot is never leaked. Backoff runs before this, which
         means a failing upstream also paces the whole client rather than
         letting the next caller hammer it immediately. */
      releaseRequestSlot();
    }
  }

  const audit: KtoAudit = {
    ...baseAudit,
    httpStatus: lastStatus,
    latencyMs: Date.now() - startedAt,
    errorCode: lastCode,
    /* 실패한 호출도 예산을 썼다. 0으로 두면 상류가 불안정할 때 계량기가 실제보다
       적게 세어 한도를 넘긴다. */
    upstreamCalls,
  };
  throw new KtoError(
    "한국관광공사 OpenAPI 응답을 확인하지 못했습니다.",
    lastCode,
    lastStatus && lastStatus < 500 ? 502 : 503,
    audit,
  );
}
