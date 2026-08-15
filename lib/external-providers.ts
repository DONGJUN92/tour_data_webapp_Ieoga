import { getRuntimeSecret } from "@/lib/runtime-env";

export const PUBLIC_NOMINATIM_REVERSE_URL =
  "https://nominatim.openstreetmap.org/reverse";
export const PUBLIC_NOMINATIM_SEARCH_URL =
  "https://nominatim.openstreetmap.org/search";
export const PUBLIC_OSRM_WALKING_URL =
  "https://routing.openstreetmap.de/routed-foot/route/v1/driving";
export const PUBLIC_OPEN_METEO_URL =
  "https://api.open-meteo.com/v1/forecast";

export type ProviderMode = "managed" | "public_shared";

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function canonicalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    const port =
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
        ? ""
        : url.port;
    return `${url.protocol}//${hostname}${port ? `:${port}` : ""}`;
  } catch {
    return undefined;
  }
}

function sameOrigin(left: string, right: string): boolean {
  const leftOrigin = canonicalOrigin(left);
  const rightOrigin = canonicalOrigin(right);
  return leftOrigin && rightOrigin
    ? leftOrigin === rightOrigin
    : normalizeUrl(left) === normalizeUrl(right);
}

/* Splits a comma-separated endpoint list without breaking URLs that carry a
   comma inside their query string — `annotations=distance,duration` is valid
   and must not be read as two endpoints. Any fragment that does not begin a
   new URL is rejoined to the one before it, so a misplaced comma degrades
   into one endpoint rather than silently dropping configuration. */
function splitEndpointList(value: string | undefined): string[] {
  const parts = (value ?? "").split(",");
  const endpoints: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (/^https?:\/\//i.test(trimmed) || endpoints.length === 0) {
      endpoints.push(trimmed);
    } else {
      endpoints[endpoints.length - 1] += `,${trimmed}`;
    }
  }
  return endpoints.filter((entry) => /^https?:\/\//i.test(entry));
}

/* 카카오 로컬. 행정구역 역지오코딩과 장소 검색을 실제로 수행하는 1순위
   제공자이며 `KAKAO_REST_API_KEY` 하나로 동작한다. 경로·기상과 같은 키 기반
   상용 제공자이므로 준비 상태 분류에서도 같은 등급으로 다룬다. */
export const KAKAO_LOCAL_REVERSE_URL =
  "https://dapi.kakao.com/v2/local/geo/coord2regioncode.json";
export const KAKAO_LOCAL_SEARCH_URL =
  "https://dapi.kakao.com/v2/local/search/keyword.json";

export function kakaoLocalConfigured(): boolean {
  return Boolean(getRuntimeSecret("KAKAO_REST_API_KEY"));
}

/* 지오코딩이 실제로 닿을 수 있는 제공자 사슬을 호출 순서대로 만든다.
   경로(`routingEndpoints`)와 같은 규칙이다.

   예전에는 이 자리에 사슬이 없었다. 설정값이 비어 있으면 무조건 공개
   Nominatim으로 떨어지도록 되어 있어서, **카카오가 그 일을 하고 있는데도**
   준비 상태는 늘 `public_shared`였고 탐침은 `PUBLIC_SHARED_BLOCKED`를
   돌려주었다. 그래서 제품은 정상인데 서비스 준비 현황이 스스로를 "일부 제한"
   으로 신고했다. 배포본에서 실제로 그렇게 보였다.

   경로·기상과 마찬가지로 공개 폴백은 운영자가 명시적으로 끌 수 있어야 하고,
   끈 경우에는 남은 사슬이 키 기반 제공자뿐이므로 `managed`가 된다. 반대로
   공개 폴백이 사슬에 남아 있으면 상용 1순위가 있더라도 그 사실을 감추지 않고
   `public_shared`로 분류한다 — 기존 경로 정책과 같은 판단이다. */
function geocodeChain(
  configuredSecret: string,
  kakaoUrl: string,
  publicUrl: string,
): string[] {
  const chain: string[] = [];
  if (kakaoLocalConfigured()) chain.push(kakaoUrl);
  const raw = getRuntimeSecret(configuredSecret)?.trim();
  if (fallbackDisabled(raw)) return chain;
  const configured = splitEndpointList(raw);
  if (configured.length) return [...chain, ...configured];
  return [...chain, publicUrl];
}

export function reverseGeocodeChain(): string[] {
  return geocodeChain(
    "REVERSE_GEOCODE_URL",
    KAKAO_LOCAL_REVERSE_URL,
    PUBLIC_NOMINATIM_REVERSE_URL,
  );
}

export function forwardGeocodeChain(): string[] {
  return geocodeChain(
    "FORWARD_GEOCODE_URL",
    KAKAO_LOCAL_SEARCH_URL,
    PUBLIC_NOMINATIM_SEARCH_URL,
  );
}

/* 공개 Nominatim이 사슬에 남아 있는가. 남아 있으면 초당 1회 예의 제한을
   지켜야 하고, 없으면 지킬 대상 자체가 없다. */
export function usesPublicNominatim(): boolean {
  return reverseGeocodeChain().some((url) =>
    sameOrigin(url, PUBLIC_NOMINATIM_REVERSE_URL),
  );
}

function chainProviderConfig(
  chain: string[],
  publicUrl: string,
): { url: string; mode: ProviderMode } {
  return {
    url: chain[0] ?? publicUrl,
    mode: chain.some((url) => sameOrigin(url, publicUrl))
      ? "public_shared"
      : "managed",
  };
}

/* Nominatim 계열 엔드포인트만 골라 준다.
   사슬의 첫 자리는 이제 카카오일 수 있으므로, Nominatim 질의를 만드는 쪽이
   `chain[0]`을 그대로 쓰면 카카오 주소에 Nominatim 파라미터를 붙이게 된다.
   `undefined`면 그 경로는 아예 호출하지 않는다는 뜻이다. */
export function nominatimReverseEndpoint(): string | undefined {
  return reverseGeocodeChain().find(
    (url) => !sameOrigin(url, KAKAO_LOCAL_REVERSE_URL),
  );
}

export function nominatimSearchEndpoint(): string | undefined {
  return forwardGeocodeChain().find(
    (url) => !sameOrigin(url, KAKAO_LOCAL_SEARCH_URL),
  );
}

export function reverseGeocodeProviderConfig() {
  return chainProviderConfig(
    reverseGeocodeChain(),
    PUBLIC_NOMINATIM_REVERSE_URL,
  );
}

export function forwardGeocodeProviderConfig() {
  return chainProviderConfig(
    forwardGeocodeChain(),
    PUBLIC_NOMINATIM_SEARCH_URL,
  );
}

export const TMAP_PEDESTRIAN_URL =
  "https://apis.openapi.sk.com/tmap/routes/pedestrian";

/* 자동차 경로는 같은 `TMAP_APP_KEY`로 동작한다. 별도 발급·별도 승인이 필요하지
   않음을 2026-08-04 실호출로 확인했다. */
export const TMAP_CAR_URL = "https://apis.openapi.sk.com/tmap/routes";
export const TMAP_CAR_PREDICTION_URL =
  "https://apis.openapi.sk.com/tmap/routes/prediction";

export function tmapPedestrianConfigured(): boolean {
  return Boolean(getRuntimeSecret("TMAP_APP_KEY"));
}

export function tmapCarConfigured(): boolean {
  return Boolean(getRuntimeSecret("TMAP_APP_KEY"));
}

/* 자동차 경로에는 OSRM 공개 폴백을 붙이지 않는다. 공개 OSRM 기본 프로파일은
   보행이고, 자동차 프로파일을 쓰는 공개 서버를 임의로 가정하면 "차로 12분"이
   실제로는 걸어서 12분인 값이 될 수 있다. 도착 시각이 판정 근거이므로 잘못된
   단위로 통과시키는 것보다 확인하지 못한 채 탈락시키는 쪽이 안전하다. */
export function carRouteChain(): string[] {
  return tmapCarConfigured() ? [TMAP_CAR_URL] : [];
}

/* 카카오 대중교통·자전거 경로. 2026-08-04 실호출로 확인. 자동차와 달리
   `dapi.kakao.com/v2/routing/*`이며 `KAKAO_REST_API_KEY` 하나로 동작한다.
   도보·자차는 TMAP을 쓰므로 여기에는 두지 않는다. */
export const KAKAO_TRANSIT_ROUTE_URL =
  "https://dapi.kakao.com/v2/routing/publictraffic";
export const KAKAO_BICYCLE_ROUTE_URL =
  "https://dapi.kakao.com/v2/routing/bicycle";

export function kakaoRoutingConfigured(): boolean {
  return Boolean(getRuntimeSecret("KAKAO_REST_API_KEY"));
}

/* 대중교통·자전거에도 공개 폴백을 붙이지 않는다. 공개 OSRM은 두 수단의
   프로파일이 없어 대체하면 단위가 다른 시간이 도착 판정에 들어간다. */
export function transitRouteChain(): string[] {
  return kakaoRoutingConfigured() ? [KAKAO_TRANSIT_ROUTE_URL] : [];
}

export function bicycleRouteChain(): string[] {
  return kakaoRoutingConfigured() ? [KAKAO_BICYCLE_ROUTE_URL] : [];
}

/* The complete chain a walking-route request can actually reach, in call
   order. TMAP is not an OSRM-compatible endpoint and cannot be expressed in
   ROUTING_BASE_URL, so it is joined here rather than classified on its own.
   Readiness asks "does a shared public server remain reachable", not "what
   answers first" — the same rule Kakao and KMA already live under, where a
   commercial primary does not hide the public fallback behind it. */
export function walkingRouteChain(): string[] {
  const endpoints = routingEndpoints();
  return tmapPedestrianConfigured()
    ? [TMAP_PEDESTRIAN_URL, ...endpoints]
    : endpoints;
}

export function routingProviderConfig(): { url?: string; mode: ProviderMode } {
  const chain = walkingRouteChain();
  return {
    url: chain[0],
    mode: chain.some(
      (url) => sameOrigin(url, PUBLIC_OSRM_WALKING_URL),
    )
      ? ("public_shared" as const)
      : ("managed" as const),
  };
}

/* Operators need a way to say "no public fallback" out loud. Without it the
   public default is appended forever, so a deployment running entirely on a
   commercial or official provider could never be classified as anything but
   shared — and the honest classification would be unreachable by
   configuration. */
const FALLBACK_DISABLED_VALUES = new Set(["none", "disabled", "off"]);

function fallbackDisabled(value: string | undefined): boolean {
  return Boolean(value && FALLBACK_DISABLED_VALUES.has(value.toLowerCase()));
}

/* Walking ETA is a hard gate: a candidate whose arrival cannot be verified is
   rejected rather than guessed. ROUTING_BASE_URL accepts a comma-separated
   list of OSRM-compatible endpoints, tried in order. A configured list is
   authoritative; operators must explicitly include a shared-public fallback,
   allowing readiness to classify the complete reachable chain truthfully. */
export function routingEndpoints(): string[] {
  const raw = getRuntimeSecret("ROUTING_BASE_URL")?.trim();
  if (fallbackDisabled(raw)) return [];
  const configured = splitEndpointList(raw);
  return configured.length ? configured : [PUBLIC_OSRM_WALKING_URL];
}

export const KMA_SHORT_TERM_URL =
  "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";

export function kmaShortTermConfigured(): boolean {
  return Boolean(getRuntimeSecret("KMA_SERVICE_KEY"));
}

/* The Open-Meteo-compatible endpoint the weather fallback calls, or undefined
   when the operator has declared there is no fallback. Kept separate from the
   chain below because callers fetch this one directly and must not be handed
   the agency URL, which speaks a different contract entirely. */
export function openMeteoEndpoint(): string | undefined {
  const raw = getRuntimeSecret("WEATHER_API_URL")?.trim();
  if (fallbackDisabled(raw)) return undefined;
  return raw || PUBLIC_OPEN_METEO_URL;
}

/* 기상청 answers first when its key is set, so it leads the chain the same way
   TMAP leads walking routes. Readiness asks what remains reachable behind it,
   not what answers first. */
export function weatherChain(): string[] {
  const fallback = openMeteoEndpoint();
  return [
    ...(kmaShortTermConfigured() ? [KMA_SHORT_TERM_URL] : []),
    ...(fallback ? [fallback] : []),
  ];
}

export function weatherProviderConfig(): { url?: string; mode: ProviderMode } {
  const chain = weatherChain();
  return {
    url: chain[0],
    mode: chain.some((url) => sameOrigin(url, PUBLIC_OPEN_METEO_URL))
      ? ("public_shared" as const)
      : ("managed" as const),
  };
}
