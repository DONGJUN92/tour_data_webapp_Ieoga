import {
  getDistricts,
  getNearbyTourism,
  getRegions,
  normalizeAnalysisCodes,
} from "@/lib/kto/adapters";
import {
  nominatimReverseEndpoint,
  usesPublicNominatim,
} from "@/lib/external-providers";
import { getRuntimeSecret } from "@/lib/runtime-env";

type NominatimAddress = Record<string, string | undefined>;

type NominatimResponse = {
  display_name?: string;
  address?: NominatimAddress;
};

export type ResolvedLocation = {
  label: string;
  areaCode?: string;
  sigunguCode?: string;
  areaName?: string;
  districtName?: string;
  source:
    | "kakao_local_reverse"
    | "openstreetmap_reverse"
    | "kto_nearest_content";
  confidence:
    | "legal_dong_code"
    | "administrative_match"
    | "nearest_content";
  attribution: string;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: ResolvedLocation }>();
let nextPublicReverseAt = 0;

function cacheKey(latitude: number, longitude: number) {
  return `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
}

function normalizeAdminName(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(
      /(특별자치도|특별자치시|특별시|광역시|도|시|군|구|자치구)$/u,
      "",
    )
    .toLowerCase();
}

function firstAddressValue(
  address: NominatimAddress,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = address[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function findByAdministrativeName<T extends { name: string }>(
  rows: T[],
  candidates: Array<string | undefined>,
): T | undefined {
  const normalizedCandidates = candidates
    .map(normalizeAdminName)
    .filter(Boolean);
  return rows.find((row) => {
    const normalized = normalizeAdminName(row.name);
    return normalizedCandidates.some(
      (candidate) =>
        candidate === normalized ||
        candidate.includes(normalized) ||
        normalized.includes(candidate),
    );
  });
}

/* Paces calls to the shared public geocoder. Reserves a timestamp rather than
   chaining callers onto each other's promises: the chained form deadlocks
   permanently once any caller is abandoned mid-wait, since the promise the
   next caller awaits is never resolved. See the routing limiter for the same
   fix and the failure it caused. */
async function respectPublicReverseLimit(): Promise<void> {
  if (!usesPublicNominatim()) return;
  const now = Date.now();
  const slotAt = Math.max(now, nextPublicReverseAt);
  nextPublicReverseAt = slotAt + 1_050;
  const waitMs = slotAt - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/* Kakao returns the ten-digit legal-dong code for a coordinate, whose first
   two and five digits are exactly the area and sigungu codes the KTO services
   expect. That is a direct lookup, where the Nominatim path below has to match
   place *names* against the agency's list and can miss on spelling or on
   boundary renames. Both codes are still validated against the official list
   before use, so a code the agency does not publish is rejected rather than
   passed downstream. Used only when KAKAO_REST_API_KEY is configured. */
async function reverseWithKakao(
  latitude: number,
  longitude: number,
): Promise<ResolvedLocation | null> {
  const key = getRuntimeSecret("KAKAO_REST_API_KEY");
  if (!key) return null;

  const url = new URL(
    "https://dapi.kakao.com/v2/local/geo/coord2regioncode.json",
  );
  url.searchParams.set("x", String(longitude));
  url.searchParams.set("y", String(latitude));

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `KakaoAK ${key}`,
      },
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      documents?: Array<{
        region_type?: string;
        code?: string;
        region_1depth_name?: string;
        region_2depth_name?: string;
        address_name?: string;
      }>;
    };
    /* "B" is the legal-dong record, which is the one whose code lines up with
       the agency's ldongCode2 values. */
    const document =
      payload.documents?.find((entry) => entry.region_type === "B") ??
      payload.documents?.[0];
    const legalCode = (document?.code ?? "").trim();
    if (!/^\d{10}$/.test(legalCode)) return null;

    const regions = (await getRegions()).items
      .map((item) => ({
        code: String(item.code ?? ""),
        name: String(item.name ?? ""),
      }))
      .filter((item) => item.code && item.name);

    /* Sejong and similar single-tier areas are published as one five-digit
       region rather than a two-digit region plus districts. */
    const fiveDigit = legalCode.slice(0, 5);
    const twoDigit = legalCode.slice(0, 2);
    const region =
      regions.find((entry) => entry.code === fiveDigit) ??
      regions.find((entry) => entry.code === twoDigit);
    if (!region) return null;

    let districtCode: string | undefined;
    let districtName: string | undefined;
    if (region.code.length === 2) {
      const districts = (await getDistricts(region.code)).items.map((item) => ({
        code: `${region.code}${String(item.code ?? "")}`,
        name: String(item.name ?? ""),
      }));
      const match = districts.find((entry) => entry.code === fiveDigit);
      if (match) {
        districtCode = match.code;
        districtName = match.name;
      }
    }

    const label =
      [document?.region_1depth_name, document?.region_2depth_name]
        .filter(Boolean)
        .join(" ") ||
      document?.address_name ||
      "현재 위치";

    return {
      label,
      areaCode: region.code,
      sigunguCode: districtCode,
      areaName: region.name,
      districtName,
      source: "kakao_local_reverse",
      confidence: "legal_dong_code",
      attribution: "카카오맵 (Kakao)",
    };
  } catch {
    return null;
  }
}

async function reverseWithNominatim(
  latitude: number,
  longitude: number,
): Promise<ResolvedLocation | null> {
  /* 사슬에 Nominatim이 없으면 폴백 자체가 없는 구성이다. 그때는 호출하지
     않는다 — 사슬의 첫 자리(카카오)에 Nominatim 파라미터를 붙이면 엉뚱한
     요청이 된다. */
  const baseUrl = nominatimReverseEndpoint();
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "ko");
  url.searchParams.set("zoom", "16");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    await respectPublicReverseLimit();
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "IEOGA/1.0 (+https://github.com/DONGJUN92/tour_data_webapp_Ieoga/issues)",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as NominatimResponse;
    const address = payload.address ?? {};

    const regionCandidate = firstAddressValue(address, [
      "state",
      "province",
      "city",
    ]);
    const districtCandidates = [
      address.borough,
      address.city_district,
      address.county,
      address.city,
      address.town,
      address.municipality,
    ];

    const regionResult = await getRegions();
    const regions = regionResult.items
      .map((item) => ({
        code: String(item.code ?? ""),
        name: String(item.name ?? ""),
      }))
      .filter((item) => item.code && item.name);
    const region = findByAdministrativeName(regions, [regionCandidate]);
    if (!region) return null;

    const district =
      region.code.length === 5
        ? {
            rawCode: "",
            code: region.code,
            name: region.name,
          }
        : findByAdministrativeName(
            (await getDistricts(region.code)).items
              .map((item) => ({
                rawCode: String(item.code ?? ""),
                code: `${region.code}${String(item.code ?? "")}`,
                name: String(item.name ?? ""),
              }))
              .filter((item) => item.rawCode && item.name),
            districtCandidates,
          );

    const shortLabel = [
      district &&
      normalizeAdminName(district.name) !== normalizeAdminName(region.name)
        ? district.name
        : undefined,
      region.name,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      label: shortLabel || payload.display_name || "현재 위치",
      areaCode: region.code,
      sigunguCode: district?.code,
      areaName: region.name,
      districtName: district?.name,
      source: "openstreetmap_reverse",
      confidence: "administrative_match",
      attribution: "© OpenStreetMap contributors",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveWithNearestKtoContent(
  latitude: number,
  longitude: number,
): Promise<ResolvedLocation | null> {
  try {
    const nearby = await getNearbyTourism({
      latitude,
      longitude,
      radius: 20_000,
      numOfRows: 10,
    });
    const nearest = nearby.items[0];
    if (!nearest) return null;
    const codes = normalizeAnalysisCodes(nearest);
    if (!codes.regionCode) return null;

    const title = String(nearest.title ?? "").trim();
    const address = String(nearest.addr1 ?? "").trim();
    return {
      label: address || (title ? `${title} 인근` : "현재 위치 인근"),
      areaCode: codes.regionCode,
      sigunguCode: codes.districtCode,
      source: "kto_nearest_content",
      confidence: "nearest_content",
      attribution: "한국관광공사 국문 관광정보",
    };
  } catch {
    return null;
  }
}

export async function resolveLocation(
  latitude: number,
  longitude: number,
): Promise<ResolvedLocation | null> {
  const key = cacheKey(latitude, longitude);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  /* Managed provider first, then the shared public one, then the agency's own
     nearest-content fallback. Each step is strictly less precise than the one
     before, and every step reports which provider answered. */
  const resolved =
    (await reverseWithKakao(latitude, longitude)) ??
    (await reverseWithNominatim(latitude, longitude)) ??
    (await resolveWithNearestKtoContent(latitude, longitude));
  if (resolved) {
    cache.set(key, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value: resolved,
    });
  }
  return resolved;
}
