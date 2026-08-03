import { haversineMeters } from "@/lib/geo";
import {
  getNearbyTourism,
  normalizeAnalysisCodes,
  searchTourism,
} from "@/lib/kto/adapters";
import type { KtoItem } from "@/lib/kto/types";
import {
  branchAffinity,
  matchesBase,
  normalizeName,
  parseBranchQuery,
  type BranchQuery,
} from "@/lib/location/branch-query";
import {
  kakaoLocalConfigured,
  searchKakaoLocal,
} from "@/lib/location/kakao-local";
import { searchForwardGeocoder } from "@/lib/location/forward-geocoder";
import {
  koreaLatitude,
  koreaLongitude,
} from "@/lib/validation/numbers";

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
  /* 이 결과가 왜 올라왔는지. 지점 검색은 "제목이 비슷해서"가 아니라
     "지점 단서 주변에서 찾아서"인 경우가 있어 사용자에게 알려 준다. */
  matchReason?: "name" | "branch_name" | "branch_area";
};

function normalized(value: string): string {
  return normalizeName(value);
}

function nameScore(keyword: string, title: string, address: string): number {
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

/**
 * 지점 단서를 반영한 점수.
 *
 * `성심당 DCC점`에서 본점과 DCC점이 함께 나오면, 제목이나 주소에 `DCC`가
 * 있는 쪽이 위로 올라와야 한다. 이름 유사도만 쓰면 본점(`성심당`)이 완전
 * 일치로 1.0을 받아 항상 1위가 된다.
 */
function scoreFor(
  query: BranchQuery,
  title: string,
  address: string,
): { score: number; reason: UnifiedPlace["matchReason"] } {
  const raw = nameScore(query.raw, title, address);
  if (!query.branch) return { score: raw, reason: "name" };

  const base = nameScore(query.base, title, address);
  const affinity = branchAffinity(query, title, address);
  /* 기저명이 맞고 지점 단서까지 확인되면 원문 유사도보다 신뢰도가 높다. */
  const combined = Math.min(1, base * 0.7 + affinity * 0.35);
  const score = Math.max(raw, combined);
  if (affinity >= 1) return { score, reason: "branch_name" };
  if (affinity >= 0.6) return { score, reason: "branch_area" };
  /* 0.3은 지역명만 겹친 부분 일치다. 순위에는 반영하되 "지점을 찾았다"고
     보지는 않는다. */
  return { score, reason: "name" };
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

function toKtoPlace(
  item: KtoItem,
  query: BranchQuery,
  reasonOverride?: UnifiedPlace["matchReason"],
): UnifiedPlace[] {
  const latitude = koreaLatitude(item.mapy);
  const longitude = koreaLongitude(item.mapx);
  const contentId = String(item.contentid ?? "").trim();
  const title = String(item.title ?? "").trim();
  if (
    !contentId ||
    !title ||
    latitude === undefined ||
    longitude === undefined
  ) {
    return [];
  }
  const codes = normalizeAnalysisCodes(item);
  const address = String(item.addr1 ?? "").trim();
  const scored = scoreFor(query, title, address);
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
      matchScore: scored.score,
      matchReason: reasonOverride ?? scored.reason,
    },
  ];
}

/**
 * 지점 단서를 좌표로 바꿔 그 주변의 공식 관광정보를 훑는다.
 *
 * `성심당 DCC점`의 지점이 관광정보 제목에 `DCC`로 적혀 있지 않아도, 대전
 * 컨벤션센터 주변 1.2km 안에서 제목에 `성심당`이 들어간 콘텐츠를 찾으면
 * 그 지점이다. 주소가 근거가 되므로 이름 표기가 달라도 도달할 수 있다.
 */
async function searchAroundBranchAnchor(params: {
  query: BranchQuery;
  regionCode?: string;
  districtCode?: string;
}): Promise<{ places: UnifiedPlace[]; anchorTitle?: string }> {
  const anchor = params.query.anchorKeyword;
  if (!anchor) return { places: [] };

  let anchorPoint:
    | { latitude: number; longitude: number; title: string }
    | undefined;

  try {
    const anchorResult = await searchTourism({
      keyword: anchor,
      regionCode: params.regionCode,
      districtCode: params.districtCode,
      numOfRows: 10,
    });
    /* 첫 결과를 그대로 쓰면 `롯데백화점` 앵커가 `가네시 롯데백화점 본점`
       (식당)으로 잡힌다. 앵커는 지점 단서 자체에 가장 가까운 이름이어야
       하므로 유사도로 고른다. */
    let best: { score: number; length: number } | undefined;
    const baseName = normalizeName(params.query.base);
    for (const item of anchorResult.items) {
      const latitude = koreaLatitude(item.mapy);
      const longitude = koreaLongitude(item.mapx);
      const title = String(item.title ?? "").trim();
      if (latitude === undefined || longitude === undefined || !title) continue;
      /* 앵커는 시설이어야 한다. 제목에 찾는 상호가 들어 있으면 그것은
         앵커가 아니라 목표 그 자체이므로 제외한다. */
      if (baseName.length > 1 && normalizeName(title).includes(baseName)) {
        continue;
      }
      const score = nameScore(anchor, title, String(item.addr1 ?? ""));
      if (score < 0.7) continue;
      /* 같은 점수면 군더더기가 적은 이름을 고른다. `롯데백화점` 앵커로
         `가네시 롯데백화점 본점`(식당)이 아니라 백화점 자체가 잡히게 한다. */
      const length = title.length;
      if (
        !best ||
        score > best.score ||
        (score === best.score && length < best.length)
      ) {
        best = { score, length };
        anchorPoint = { latitude, longitude, title };
      }
    }
  } catch {
    anchorPoint = undefined;
  }

  /* 관광정보에 없는 지점 단서(사설 건물 등)는 카카오 로컬로 좌표만 얻는다.
     좌표는 앵커로만 쓰고 결과는 전부 공식 관광정보에서 나온다. */
  if (!anchorPoint && kakaoLocalConfigured()) {
    try {
      const hits = await searchKakaoLocal({ keyword: anchor });
      const first = hits[0];
      if (first) {
        anchorPoint = {
          latitude: first.latitude,
          longitude: first.longitude,
          title: first.title,
        };
      }
    } catch {
      anchorPoint = undefined;
    }
  }

  if (!anchorPoint) return { places: [] };

  try {
    const nearby = await getNearbyTourism({
      latitude: anchorPoint.latitude,
      longitude: anchorPoint.longitude,
      radius: 1_200,
      numOfRows: 60,
      regionCode: params.regionCode,
      districtCode: params.districtCode,
    });
    const places = nearby.items
      .flatMap((item) =>
        toKtoPlace(item, params.query, "branch_area"),
      )
      .filter((place) => matchesBase(params.query, place.title))
      .map((place) => ({
        ...place,
        /* 앵커 주변에서 기저명이 일치했다는 것은 지점을 찾았다는 뜻이다.
           이름만 비슷한 결과보다 위로 올린다. */
        matchScore: Math.max(place.matchScore, 0.86),
      }));
    return { places, anchorTitle: anchorPoint.title };
  } catch {
    return { places: [], anchorTitle: anchorPoint.title };
  }
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
  branchQuery?: {
    base: string;
    branch?: string;
    anchorTitle?: string;
    /* 물어본 지점을 최종 목록에서 실제로 찾았는지. false면 화면이
       "같은 상호의 다른 지점입니다"라고 밝힌다. */
    branchResolved?: boolean;
  };
}> {
  const query = parseBranchQuery(params.keyword);

  let ktoStatus: "live" | "empty" | "unavailable" = "unavailable";
  let ktoPlaces: UnifiedPlace[] = [];
  try {
    const result = await searchTourism({
      keyword: query.raw,
      regionCode: params.regionCode,
      districtCode: params.districtCode,
      numOfRows: 20,
    });
    ktoStatus = result.items.length ? "live" : "empty";
    ktoPlaces = result.items.flatMap((item) => toKtoPlace(item, query));
  } catch {
    ktoStatus = "unavailable";
  }

  const bestScore = (places: UnifiedPlace[]) =>
    Math.max(0, ...places.map((place) => place.matchScore));

  /* 2차: 지점 단서를 떼고 기저명으로 다시 조회한다. `성심당 DCC점`이 0건이어도
     `성심당`은 등록되어 있는 경우가 많다. */
  if (query.branch && ktoStatus !== "unavailable") {
    const needsBaseQuery =
      ktoPlaces.length === 0 ||
      !ktoPlaces.some((place) => place.matchReason !== "name") ||
      bestScore(ktoPlaces) < 0.9;
    if (needsBaseQuery) {
      try {
        const baseResult = await searchTourism({
          keyword: query.base,
          regionCode: params.regionCode,
          districtCode: params.districtCode,
          numOfRows: 20,
        });
        if (baseResult.items.length) ktoStatus = "live";
        ktoPlaces = deduplicate([
          ...ktoPlaces,
          ...baseResult.items.flatMap((item) => toKtoPlace(item, query)),
        ]);
      } catch {
        /* 기저명 조회 실패는 1차 결과에 영향을 주지 않는다. */
      }
    }
  }

  /* 3차: 지점 단서를 좌표 앵커로 삼아 그 주변 공식 관광정보를 훑는다. */
  let anchorTitle: string | undefined;
  const hasBranchHit = ktoPlaces.some(
    (place) => place.matchReason === "branch_name",
  );
  if (query.branch && !hasBranchHit) {
    const anchored = await searchAroundBranchAnchor({
      query,
      regionCode: params.regionCode,
      districtCode: params.districtCode,
    });
    anchorTitle = anchored.anchorTitle;
    if (anchored.places.length) {
      ktoStatus = "live";
      ktoPlaces = deduplicate([...anchored.places, ...ktoPlaces]);
    }
  }

  const topKtoScore = bestScore(ktoPlaces);
  const branchUnresolved =
    Boolean(query.branch) &&
    !ktoPlaces.some(
      (place) =>
        place.matchReason === "branch_name" ||
        place.matchReason === "branch_area",
    );
  const shouldFallback =
    params.fallback === "force" ||
    ktoPlaces.length === 0 ||
    topKtoScore < 0.58 ||
    /* 상호는 찾았지만 물어본 지점을 못 찾은 경우. 공식 관광정보에 그 지점이
       등록돼 있지 않다는 뜻이므로, 좌표를 아는 보조 제공자에게 물어본다. */
    branchUnresolved;

  const branchQuery = query.branch
    ? {
        base: query.base,
        branch: query.branch,
        anchorTitle,
        /* 상호는 찾았지만 물어본 지점을 끝내 못 찾았음을 화면에 알리기 위한
           신호. 조용히 본점만 보여 주면 사용자는 자기가 찾던 지점이라고
           오해한다. */
        branchResolved: !branchUnresolved,
      }
    : undefined;

  if (!shouldFallback) {
    return {
      places: ktoPlaces
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 8),
      usedFallback: false,
      ktoStatus,
      branchQuery,
    };
  }

  /* 보조 제공자는 좌표를 얻기 위한 것이다. 예전에는 현재 위치를 찾을 때만
     썼는데, 약속 장소가 공식 관광정보에 없는 경우(신축 상가, 사무실, 카페
     지점)에도 사용자는 그곳을 약속 장소로 지정해야 한다. 그래서 두 목적
     모두에서 쓰고, 결과에는 공식 관광정보가 아니라는 표시(retention:
     ephemeral)를 그대로 남긴다. */
  let fallbackProvider: "kakao_local" | "forward_geocoder" =
    "forward_geocoder";
  let fallbackPlaces: UnifiedPlace[] = [];
  if (kakaoLocalConfigured()) {
    fallbackProvider = "kakao_local";
    try {
      fallbackPlaces = (
        await searchKakaoLocal({
          keyword: query.raw,
          latitude: params.latitude,
          longitude: params.longitude,
        })
      ).map((place) => {
        const scored = scoreFor(query, place.title, place.address);
        return {
          ...place,
          matchScore: scored.score,
          matchReason: scored.reason,
        };
      });
    } catch {
      fallbackPlaces = [];
    }
  }
  if (!fallbackPlaces.length) {
    fallbackProvider = "forward_geocoder";
    try {
      fallbackPlaces = (await searchForwardGeocoder(query.raw)).map(
        (place) => {
          const scored = scoreFor(query, place.title, place.address);
          return {
            ...place,
            matchScore: scored.score,
            matchReason: scored.reason,
          };
        },
      );
    } catch {
      fallbackPlaces = [];
    }
  }

  /* 지점을 물었을 때 보조 제공자가 돌려준 무관한 상호는 뺀다. `성심당 DCC점`
     검색에 `보통날 엑스포코아점`이 섞여 들어오면 목록의 신뢰가 떨어진다. */
  const relevantFallback = query.branch
    ? fallbackPlaces.filter(
        (place) =>
          matchesBase(query, place.title) ||
          branchAffinity(query, place.title, place.address) > 0,
      )
    : fallbackPlaces;

  const merged = deduplicate([...ktoPlaces, ...relevantFallback]);

  /* 지점 해석 여부는 최종 목록으로 판단한다. KTO 결과만 보고 계산하면,
     보조 제공자가 지점을 정확히 찾아 1순위에 올렸는데도 화면에는
     "지점을 찾지 못했습니다"라는 안내가 붙는다. */
  const branchResolved =
    !query.branch ||
    merged.some(
      (place) =>
        place.matchReason === "branch_name" ||
        place.matchReason === "branch_area",
    );

  return {
    places: merged
      .sort((a, b) => {
        /* 지점을 물었을 때는 지점을 맞힌 결과가 먼저다. 공식 관광정보의
           본점이 완전 일치로 1.00을 받아 위에 남으면, 사용자는 여전히
           자기가 찾던 지점을 못 본다. */
        if (query.branch) {
          const rank = (place: UnifiedPlace) =>
            place.matchReason === "branch_name"
              ? 2
              : place.matchReason === "branch_area"
                ? 1
                : 0;
          const byBranch = rank(b) - rank(a);
          if (byBranch) return byBranch;
        }
        return b.matchScore - a.matchScore;
      })
      .slice(0, 10),
    usedFallback: relevantFallback.length > 0,
    fallbackProvider:
      relevantFallback.length > 0 ? fallbackProvider : undefined,
    ktoStatus,
    branchQuery: query.branch
      ? { base: query.base, branch: query.branch, anchorTitle, branchResolved }
      : undefined,
  };
}
