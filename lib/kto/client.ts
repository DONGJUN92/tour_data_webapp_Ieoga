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

export async function callKto(
  service: KtoServiceName,
  operation: string,
  params: KtoParams = {},
  options: KtoCallOptions = {},
): Promise<KtoCallResult> {
  const serviceKey = getRuntimeSecret("KTO_SERVICE_KEY");
  const startedAt = Date.now();
  const baseAudit: KtoAudit = {
    apiName: service,
    operation,
    status: "error",
    latencyMs: 0,
    resultCount: 0,
    totalCount: 0,
    fieldsUsed: options.fieldsUsed ?? [],
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
    try {
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
    }
  }

  const audit: KtoAudit = {
    ...baseAudit,
    httpStatus: lastStatus,
    latencyMs: Date.now() - startedAt,
    errorCode: lastCode,
  };
  throw new KtoError(
    "한국관광공사 OpenAPI 응답을 확인하지 못했습니다.",
    lastCode,
    lastStatus && lastStatus < 500 ? 502 : 503,
    audit,
  );
}
