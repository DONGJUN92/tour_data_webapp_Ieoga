const SHELL_CACHE = "ieoga-shell-v2";
const SNAPSHOT_CACHE = "ieoga-private-offline-v1";
const SNAPSHOT_PATH = "/__offline/journey-snapshot";
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRECACHE_URLS = [
  "/offline",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key !== SHELL_CACHE && key !== SNAPSHOT_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheableAsset(request, url) {
  return (
    url.origin === self.location.origin &&
    (request.destination === "style" ||
      request.destination === "script" ||
      request.destination === "font" ||
      request.destination === "image" ||
      url.pathname.startsWith("/assets/"))
  );
}

function text(value, limit = 120) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function number(value, minimum = 0, maximum = 1440) {
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function minimalStep(step) {
  if (!step || typeof step !== "object") return null;
  const title = text(step.title, 100);
  if (!title) return null;
  return {
    title,
    role: text(step.role, 32),
    scheduledAt: timestamp(step.scheduledAt ?? step.startAt),
    estimatedArrivalAt: timestamp(step.estimatedArrivalAt),
    durationMinutes: number(step.durationMinutes),
    locked: step.locked === true,
    reservation: step.reservation === true,
    status: text(step.status, 24),
  };
}

function recoverySnapshot(payload) {
  const options = Array.isArray(payload?.options) ? payload.options : [];
  const sanitized = options.slice(0, 5).flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const title = text(option.title, 100);
    if (!title) return [];
    const window = option.scheduleDiff?.openWindow;
    return [{
      title,
      travelToMinutes: number(window?.travelToMinutes),
      stayMinutes: number(window?.appliedStayMinutes),
      returnMinutes: number(window?.returnMinutes),
      leftoverMinutes: number(window?.leftoverMinutes),
      confirmationRequired: option.confirmationRequired === true,
    }];
  });
  return sanitized.length
    ? { kind: "recovery", options: sanitized }
    : null;
}

function journeySnapshot(payload) {
  const execution = payload?.execution;
  if (!execution || !Array.isArray(execution.steps)) return null;
  const steps = execution.steps.map(minimalStep).filter(Boolean).slice(0, 30);
  return steps.length
    ? { kind: "journey", status: text(execution.status, 24), steps }
    : null;
}

function itinerarySnapshot(payload) {
  const itinerary = payload?.itinerary;
  if (!itinerary || !Array.isArray(itinerary.nodes)) return null;
  const steps = itinerary.nodes.map(minimalStep).filter(Boolean).slice(0, 30);
  return steps.length
    ? { kind: "itinerary", title: text(itinerary.title, 100), steps }
    : null;
}

async function storeSanitizedSnapshot(response, source) {
  if (!response.ok) return;
  let payload;
  try {
    payload = await response.json();
  } catch {
    return;
  }
  const snapshot =
    source === "journey"
      ? journeySnapshot(payload)
      : source === "itinerary"
        ? itinerarySnapshot(payload)
        : recoverySnapshot(payload);
  if (!snapshot) return;
  const savedAt = new Date().toISOString();
  const cache = await caches.open(SNAPSHOT_CACHE);
  const snapshotRequest = new Request(
    new URL(SNAPSHOT_PATH, self.location.origin),
  );
  let snapshots = {};
  try {
    const previous = await cache.match(snapshotRequest);
    const parsed = previous ? await previous.json() : null;
    if (parsed?.schemaVersion === 2 && parsed.snapshots) {
      snapshots = parsed.snapshots;
    }
  } catch {
    snapshots = {};
  }
  snapshots[snapshot.kind] = {
    ...snapshot,
    savedAt,
    expiresAt: new Date(Date.now() + SNAPSHOT_MAX_AGE_MS).toISOString(),
  };
  await cache.put(snapshotRequest, snapshotResponse(snapshots));
}

function snapshotResponse(snapshots) {
  return new Response(
    JSON.stringify({
      schemaVersion: 2,
      privacy:
        "device-only; coordinates, addresses, identifiers and source payload are excluded",
      snapshots,
    }),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    },
  );
}

async function readSnapshot() {
  const cache = await caches.open(SNAPSHOT_CACHE);
  const snapshotRequest = new Request(
    new URL(SNAPSHOT_PATH, self.location.origin),
  );
  const cached = await cache.match(snapshotRequest);
  if (!cached) return new Response(null, { status: 404 });
  try {
    const payload = await cached.clone().json();
    const snapshots = Object.fromEntries(
      Object.entries(payload.snapshots ?? {}).filter(
        ([, snapshot]) => Date.parse(snapshot.expiresAt) > Date.now(),
      ),
    );
    if (Object.keys(snapshots).length === 0) {
      await cache.delete(snapshotRequest);
      return new Response(null, { status: 410 });
    }
    if (
      Object.keys(snapshots).length !==
      Object.keys(payload.snapshots ?? {}).length
    ) {
      await cache.put(snapshotRequest, snapshotResponse(snapshots));
    }
    return snapshotResponse(snapshots);
  } catch {
    await cache.delete(snapshotRequest);
    return new Response(null, { status: 410 });
  }
}

async function clearSnapshot() {
  const cache = await caches.open(SNAPSHOT_CACHE);
  await cache.delete(new Request(new URL(SNAPSHOT_PATH, self.location.origin)));
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function offlineSnapshotMarkup(bundle) {
  const snapshots = Object.values(bundle?.snapshots ?? {});
  if (!snapshots.length) {
    return "<p class=empty>이 기기에 저장된 일정 사본이 없습니다.</p>";
  }
  return snapshots
    .map((snapshot) => {
      const heading =
        snapshot.kind === "journey"
          ? "진행 중인 복구 일정"
          : snapshot.kind === "itinerary"
            ? "등록한 원래 일정"
            : "최근 복구 후보";
      const entries = snapshot.steps ?? snapshot.options ?? [];
      const rows = entries
        .map((entry) => {
          const when = entry.scheduledAt ?? entry.estimatedArrivalAt;
          const detail = when
            ? new Date(when).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
            : entry.travelToMinutes !== undefined
              ? `이동 ${entry.travelToMinutes}분 · 체류 ${entry.stayMinutes ?? "?"}분`
              : "시각 미정";
          return `<li><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(detail)}</span></li>`;
        })
        .join("");
      return `<section><h2>${heading}</h2><p>${escapeHtml(snapshot.savedAt)} 저장</p><ol>${rows}</ol></section>`;
    })
    .join("");
}

async function offlineDocument() {
  let bundle = null;
  try {
    const response = await readSnapshot();
    if (response.ok) bundle = await response.json();
  } catch {
    bundle = null;
  }
  const markup = offlineSnapshotMarkup(bundle);
  return new Response(
    `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>오프라인 · 이어가</title><style>html{font-family:system-ui,sans-serif;background:#f7f3ea;color:#142d26}body{margin:0;padding:24px}main{max-width:640px;margin:auto;background:#fff;border:1px solid #b7c9be;border-radius:24px;padding:clamp(24px,6vw,44px)}h1{font-size:clamp(1.7rem,7vw,2.4rem)}section{margin-top:24px;padding-top:18px;border-top:1px solid #cad8d0}h2{font-size:1.1rem}ol{display:grid;gap:10px;padding-left:24px}li strong,li span{display:block}li span,section p{color:#49635a;font-size:.9rem}.warning{padding:16px;border-radius:12px;background:#fff3e8;color:#702e18;font-weight:700;line-height:1.6}a{display:inline-flex;margin-top:20px;padding:12px 18px;border-radius:999px;background:#174a3a;color:#fff;font-weight:800;text-decoration:none}</style><main><p>OFFLINE</p><h1>연결 없이 보는 마지막 안전 사본</h1><p>좌표·주소·세션 식별자를 저장하지 않은 이 기기의 24시간 사본입니다.</p>${markup}<p class="warning">운영시간·날씨·교통은 바뀔 수 있습니다. 연결이 복구되기 전에는 새 추천으로 판단하거나 출발하지 마세요.</p><a href="/">연결 다시 확인</a></main></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "IEOGA_CLEAR_OFFLINE_SNAPSHOT") {
    event.waitUntil(clearSnapshot());
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;
  if (url.pathname === SNAPSHOT_PATH && request.method === "GET") {
    event.respondWith(readSnapshot());
    return;
  }
  if (
    url.pathname === "/api/v1/privacy/session" &&
    request.method === "DELETE"
  ) {
    event.waitUntil(clearSnapshot());
    return;
  }
  if (url.pathname === "/api/v1/recover" && request.method === "POST") {
    event.respondWith(
      fetch(request).then((response) => {
        event.waitUntil(storeSanitizedSnapshot(response.clone(), "recovery"));
        return response;
      }),
    );
    return;
  }
  if (request.method !== "GET") return;

  const snapshotSource =
    url.pathname === "/api/v1/journey/active"
      ? "journey"
      : url.pathname === "/api/v1/itineraries"
        ? "itinerary"
        : null;
  if (snapshotSource) {
    event.respondWith(
      fetch(request).then((response) => {
        event.waitUntil(
          storeSanitizedSnapshot(response.clone(), snapshotSource),
        );
        return response;
      }),
    );
    return;
  }
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => offlineDocument()),
    );
    return;
  }

  if (!isCacheableAsset(request, url)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
      return cached || network;
    }),
  );
});
