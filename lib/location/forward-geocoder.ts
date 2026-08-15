import {
  forwardGeocodeProviderConfig,
  nominatimSearchEndpoint,
  type ProviderMode,
} from "@/lib/external-providers";

type NominatimSearchItem = {
  place_id?: number | string;
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  address?: Record<string, string | undefined>;
};

export type ForwardGeocodePlace = {
  provider: "forward_geocoder";
  providerId: string;
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  sourceLabel: string;
  retention: "persistable";
  providerMode: ProviderMode;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<
  string,
  { expiresAt: number; value: ForwardGeocodePlace[] }
>();
let publicQueue: Promise<void> = Promise.resolve();
let nextPublicRequestAt = 0;

async function respectPublicLimit(mode: ProviderMode): Promise<void> {
  if (mode !== "public_shared") return;
  const previous = publicQueue;
  let release: (() => void) | undefined;
  publicQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const waitMs = Math.max(0, nextPublicRequestAt - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  nextPublicRequestAt = Date.now() + 1_050;
  release?.();
}

function shortTitle(item: NominatimSearchItem): string {
  const address = item.address ?? {};
  return (
    item.name?.trim() ||
    address.attraction?.trim() ||
    address.amenity?.trim() ||
    address.tourism?.trim() ||
    address.building?.trim() ||
    item.display_name?.split(",")[0]?.trim() ||
    "검색 장소"
  );
}

export async function searchForwardGeocoder(
  keyword: string,
): Promise<ForwardGeocodePlace[]> {
  const key = keyword.normalize("NFKC").trim().toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  /* 이 함수는 Nominatim 질의만 만든다. 사슬의 첫 자리가 카카오일 수 있으므로
     Nominatim 엔드포인트를 따로 받아 쓰고, 없으면 호출하지 않는다. 장소 검색
     자체는 카카오 로컬이 별도 경로로 수행한다. */
  const provider = forwardGeocodeProviderConfig();
  const searchUrl = nominatimSearchEndpoint();
  if (!searchUrl) return [];
  const url = new URL(searchUrl);
  url.searchParams.set("q", keyword);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("countrycodes", "kr");
  url.searchParams.set("accept-language", "ko");
  url.searchParams.set("limit", "8");

  await respectPublicLimit(provider.mode);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "IEOGA/1.0 (+https://github.com/DONGJUN92/tour_data_webapp_Ieoga/issues)",
    },
    signal: AbortSignal.timeout(5_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`FORWARD_GEOCODER_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  const rows = Array.isArray(payload) ? (payload as NominatimSearchItem[]) : [];
  const places = rows.flatMap((item): ForwardGeocodePlace[] => {
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < 32 ||
      latitude > 39.8 ||
      longitude < 124 ||
      longitude > 132
    ) {
      return [];
    }
    return [
      {
        provider: "forward_geocoder",
        providerId: String(item.place_id ?? `${latitude},${longitude}`),
        title: shortTitle(item),
        address: item.display_name?.trim() || shortTitle(item),
        latitude,
        longitude,
        sourceLabel: "© OpenStreetMap contributors",
        retention: "persistable",
        providerMode: provider.mode,
      },
    ];
  });
  cache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value: places,
  });
  return places;
}
