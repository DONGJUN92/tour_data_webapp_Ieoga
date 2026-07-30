import { haversineMeters } from "@/lib/geo";
import {
  normalizeAnalysisCodes,
  searchTourism,
} from "@/lib/kto/adapters";
import {
  kakaoLocalConfigured,
  searchKakaoLocal,
} from "@/lib/location/kakao-local";
import { searchForwardGeocoder } from "@/lib/location/forward-geocoder";

export type PlaceSearchPurpose = "saved_stop" | "current_origin";
export type PlaceSearchFallback = "auto" | "force";

export type UnifiedPlace = {
  provider: "kto" | "kakao_local" | "forward_geocoder";
  providerId: string;
  contentId?: string;
  contentTypeId?: string;
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  imageUrl?: string;
  regionCode?: string;
  districtCode?: string;
  modifiedAt?: string;
  sourceLabel: string;
  externalUrl?: string;
  retention: "persistable" | "ephemeral";
  matchScore: number;
};

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function matchScore(keyword: string, title: string, address: string): number {
  const query = normalized(keyword);
  const name = normalized(title);
  if (!query || !name) return 0;
  if (name === query) return 1;
  if (name.startsWith(query) || query.startsWith(name)) return 0.9;
  if (name.includes(query) || query.includes(name)) return 0.78;
  const tokens = keyword
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 1);
  if (!tokens.length) return 0.2;
  const hits = tokens.filter(
    (token) =>
      title.toLowerCase().includes(token) ||
      address.toLowerCase().includes(token),
  ).length;
  return Math.min(0.72, hits / tokens.length);
}

function deduplicate(places: UnifiedPlace[]): UnifiedPlace[] {
  const result: UnifiedPlace[] = [];
  for (const place of places) {
    const duplicate = result.some(
      (current) =>
        normalized(current.title) === normalized(place.title) &&
        haversineMeters(current, place) <= 100,
    );
    if (!duplicate) result.push(place);
  }
  return result;
}

export async function searchPlaces(params: {
  keyword: string;
  purpose: PlaceSearchPurpose;
  fallback: PlaceSearchFallback;
  regionCode?: string;
  districtCode?: string;
  latitude?: number;
  longitude?: number;
}): Promise<{
  places: UnifiedPlace[];
  usedFallback: boolean;
  fallbackProvider?: "kakao_local" | "forward_geocoder";
  ktoStatus: "live" | "empty" | "unavailable";
}> {
  let ktoStatus: "live" | "empty" | "unavailable" = "unavailable";
  let ktoPlaces: UnifiedPlace[] = [];
  try {
    const result = await searchTourism({
      keyword: params.keyword,
      regionCode: params.regionCode,
      districtCode: params.districtCode,
      numOfRows: 20,
    });
    ktoStatus = result.items.length ? "live" : "empty";
    ktoPlaces = result.items.flatMap((item): UnifiedPlace[] => {
      const latitude = Number(item.mapy);
      const longitude = Number(item.mapx);
      const contentId = String(item.contentid ?? "").trim();
      const title = String(item.title ?? "").trim();
      if (
        !contentId ||
        !title ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        return [];
      }
      const codes = normalizeAnalysisCodes(item);
      const address = String(item.addr1 ?? "").trim();
      return [
        {
          provider: "kto",
          providerId: contentId,
          contentId,
          contentTypeId: String(item.contenttypeid ?? "").trim() || undefined,
          title,
          address,
          latitude,
          longitude,
          imageUrl:
            String(item.firstimage ?? "")
              .trim()
              .replace(/^http:\/\//, "https://") || undefined,
          regionCode: codes.regionCode,
          districtCode: codes.districtCode,
          modifiedAt: String(item.modifiedtime ?? "").trim() || undefined,
          sourceLabel: "한국관광공사 국문 관광정보",
          retention: "persistable",
          matchScore: matchScore(params.keyword, title, address),
        },
      ];
    });
  } catch {
    ktoStatus = "unavailable";
  }

  const topKtoScore = Math.max(
    0,
    ...ktoPlaces.map((place) => place.matchScore),
  );
  const shouldFallback =
    params.fallback === "force" ||
    ktoPlaces.length === 0 ||
    topKtoScore < 0.58;
  if (!shouldFallback) {
    return {
      places: ktoPlaces
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 8),
      usedFallback: false,
      ktoStatus,
    };
  }

  let fallbackProvider: "kakao_local" | "forward_geocoder" =
    "forward_geocoder";
  let fallbackPlaces: UnifiedPlace[] = [];
  if (params.purpose === "current_origin" && kakaoLocalConfigured()) {
    fallbackProvider = "kakao_local";
    try {
      fallbackPlaces = (
        await searchKakaoLocal({
          keyword: params.keyword,
          latitude: params.latitude,
          longitude: params.longitude,
        })
      ).map((place) => ({
        ...place,
        matchScore: matchScore(
          params.keyword,
          place.title,
          place.address,
        ),
      }));
    } catch {
      fallbackPlaces = [];
    }
  }
  if (!fallbackPlaces.length) {
    fallbackProvider = "forward_geocoder";
    try {
      fallbackPlaces = (await searchForwardGeocoder(params.keyword)).map(
        (place) => ({
          ...place,
          matchScore: matchScore(
            params.keyword,
            place.title,
            place.address,
          ),
        }),
      );
    } catch {
      fallbackPlaces = [];
    }
  }

  return {
    places: deduplicate([...ktoPlaces, ...fallbackPlaces])
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 10),
    usedFallback: fallbackPlaces.length > 0,
    fallbackProvider:
      fallbackPlaces.length > 0 ? fallbackProvider : undefined,
    ktoStatus,
  };
}
