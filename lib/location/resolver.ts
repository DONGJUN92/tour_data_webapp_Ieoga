import {
  getDistricts,
  getNearbyTourism,
  getRegions,
  normalizeAnalysisCodes,
} from "@/lib/kto/adapters";
import { reverseGeocodeProviderConfig } from "@/lib/external-providers";

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
  source: "openstreetmap_reverse" | "kto_nearest_content";
  confidence: "administrative_match" | "nearest_content";
  attribution: string;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: ResolvedLocation }>();
let reverseQueue: Promise<void> = Promise.resolve();
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

async function respectPublicReverseLimit(): Promise<void> {
  if (reverseGeocodeProviderConfig().mode !== "public_shared") return;
  const previous = reverseQueue;
  let release: (() => void) | undefined;
  reverseQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const waitMs = Math.max(0, nextPublicReverseAt - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  nextPublicReverseAt = Date.now() + 1_050;
  release?.();
}

async function reverseWithNominatim(
  latitude: number,
  longitude: number,
): Promise<ResolvedLocation | null> {
  const { url: baseUrl } = reverseGeocodeProviderConfig();
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
        "User-Agent": "IEOGA/1.0 (+https://ieoga.kr)",
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

  const resolved =
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
