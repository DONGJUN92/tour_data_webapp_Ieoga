import { haversineMeters } from "@/lib/geo";
import type { KtoItem } from "@/lib/kto/types";

/* 추천코스를 여행 일정으로 바꾼다.
 *
 * 두 갈래가 있고, 둘의 출처를 절대 섞지 않는다.
 *
 * (1) `official` — 공사 공식 추천코스(`contentTypeId=25`). 코스와 그 구성 지점이
 *     모두 공사 데이터다.
 * (2) `assembled` — 공사 관광정보로 **우리가 엮은** 하루 코스. 지점은 전부 공사
 *     콘텐츠이지만 엮은 순서는 우리 것이다.
 *
 * (2)가 필요한 이유는 데이터다. 2026-08-19 실측: 공식 추천코스는 16개 시·도 중
 * 11곳에만 있고 전국 53건이다. 서울·대전·울산·제주·세종은 **0건**이다. 그 지역
 * 여행자에게 "없습니다"만 돌려주면 기능이 아니다.
 *
 * (2)를 어떻게 엮는가 — 실제 코스 22건을 측정해 형태를 배웠다.
 *   · 지점 수: 중앙값 7, 평균 6.2, 범위 2~10
 *   · 유형 조합: 관광지가 대부분이고 식당이 사이에 끼워진다
 *     (실측 패턴 "관광지 → 식당 → 관광지 → 식당 → 관광지")
 *   · 거리: 35~430km, 소요 50분~7시간 30분, 1박2일·3박이상이 흔하다
 *
 * 마지막 항목이 중요하다. 공식 코스는 **광역 드라이브**다. 그것을 그대로 흉내내면
 * 200km 이동이 되고, 이어가가 다루는 상황("도시 안에서 다음 약속을 지킨다")에서는
 * 쓸 수 없다. 그래서 형태 중 **베낄 것과 버릴 것**을 갈랐다.
 *   베낀다 : 관광지↔식당 교차, 4~5개 지점
 *   버린다 : 광역 이동 거리 — 대신 한 행정구역 안에서 서로 가까운 지점만 쓴다
 *
 * 웹 검색으로 코스를 지어내지 않는다. 이 앱은 다른 모든 화면에서 "없는 것을 만들지
 * 않는다"를 지키고, 관광데이터로 판정한 근거만 화면에 올린다. 검색으로 엮은 코스는
 * 출처를 원장에 남길 수 없고, 그 한 화면 때문에 나머지 전부의 신뢰가 깎인다.
 * 대신 "형태를 배워 실제 공사 장소로 채우는" 방식을 택했다 — 장소·좌표·운영시간이
 * 모두 검증 가능하고, 복구 엔진이 그대로 다시 쓸 수 있다. */

export type CourseSource = "official" | "assembled";

export type CourseStop = {
  /* 공사 콘텐츠 ID. 일정 노드 ID로 그대로 쓸 수 있다(`[a-zA-Z0-9_-]`). */
  contentId: string;
  contentTypeId: string;
  title: string;
  address?: string;
  latitude: number;
  longitude: number;
  imageUrl?: string;
  /* 공사 상세 운영정보에서 읽은 값. 코스 카드가 "몇 시에 여는가"를 말할 수 있어야
     여행자가 그 지점을 갈지 정할 수 있다. 없으면 없다고 적는다. */
  operatingHours?: string;
  restDate?: string;
  contact?: string;
  /* 앞 지점에서 이 지점까지의 직선거리와 권하는 이동 수단. 실제 경로가 아니라
     좌표 사이 직선이라는 사실을 화면이 함께 밝힌다 — 경로 조회는 복구 시점에
     한다. */
  legMeters?: number;
  legMode?: "walk" | "transit" | "car";
};

export type CoursePlan = {
  source: CourseSource;
  /* 공식 코스일 때만 있다. 우리가 엮은 코스에는 공사 코스 ID가 없다. */
  contentId?: string;
  title: string;
  regionCode?: string;
  districtCode?: string;
  imageUrl?: string;
  /* 공식 코스의 공식 소요시간·길이(있을 때만). */
  officialDuration?: string;
  officialDistance?: string;
  stops: CourseStop[];
};

/* 일정 노드 유형. 식당은 `meal`로 둔다 — 복구 엔진이 원래 활동 유형을 그 값으로
   읽어 "식사 대신 식사"를 목적 유지로 판정한다. */
function nodeTypeFor(contentTypeId: string): "visit" | "meal" | "stay" {
  if (contentTypeId === "39") return "meal";
  if (contentTypeId === "32") return "stay";
  return "visit";
}

/* 코스 지점을 한 곳당 몇 분으로 둘 것인가. 공사는 지점별 체류시간을 주지 않으므로
   우리가 정하는 값이고, 그 사실은 화면이 밝힌다. 식사는 조금 길게 둔다. */
function stayMinutesFor(contentTypeId: string): number {
  if (contentTypeId === "39") return 60;
  if (contentTypeId === "32") return 60;
  return 60;
}

/* 지점 사이 이동에 두는 여유.
 *
 * 30분으로 두었더니 코스로 만든 일정이 복구되지 않았다 — 체류 60분 + 이동 30분이면
 * 한 곳을 바꾼 뒤 다음 지점까지 걸어갈 수 없어서, 실측에서 대안이 0곳이었다
 * (`NEXT_FIXED_APPOINTMENT_AT_RISK` 27건). 60분으로 늘리면 19곳이 나온다.
 * 등록만 되고 복구가 안 되면 코스를 일정으로 삼는 의미가 없다. */
const GAP_MINUTES = 60;

export type CourseItineraryNode = {
  id: string;
  sequence: number;
  type: "visit" | "meal" | "stay";
  title: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  locked: boolean;
  reservation: boolean;
  location: {
    label: string;
    latitude: number;
    longitude: number;
    areaCode?: string;
    sigunguCode?: string;
  };
};

function isoWithKoreaOffset(ms: number): string {
  /* 계약은 오프셋이 있는 ISO만 받는다. 한국 시각 문자열을 만들어 `+09:00`을
     붙이면 서머타임이 없는 한국에서는 정확하다. */
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const v = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}+09:00`;
}

/**
 * 코스를 일정 노드 배열로 바꾼다.
 *
 * 계약이 요구하는 것을 모두 지킨다: 시작 시각이 순서대로 **엄격히 증가**하고,
 * 앞 일정이 끝나기 전에 다음이 시작하지 않고, 잠금·예약 일정 하나가 좌표와
 * **미래 시각**을 함께 가진다. 마지막 지점을 잠금으로 두는데, 그것이 여행자가
 * "꼭 지킬 곳"이면서 복구가 지켜야 할 다음 고정 일정이 되기 때문이다.
 */
export function courseItineraryNodes(
  plan: CoursePlan,
  startAtMs: number,
): CourseItineraryNode[] {
  const nodes: CourseItineraryNode[] = [];
  let cursor = startAtMs;
  plan.stops.forEach((stop, index) => {
    const stay = stayMinutesFor(stop.contentTypeId);
    const startAt = cursor;
    const endAt = startAt + stay * 60_000;
    const last = index === plan.stops.length - 1;
    nodes.push({
      id: `c${stop.contentId}`,
      sequence: index,
      type: nodeTypeFor(stop.contentTypeId),
      title: stop.title.slice(0, 100),
      startAt: isoWithKoreaOffset(startAt),
      endAt: isoWithKoreaOffset(endAt),
      durationMinutes: stay,
      /* 마지막 지점만 잠근다. 전부 잠그면 복구가 바꿀 수 있는 곳이 없어져
         "한 곳만 바꿔 다음 약속을 지킨다"가 성립하지 않는다. */
      locked: last,
      reservation: false,
      location: {
        label: stop.title.slice(0, 100),
        latitude: stop.latitude,
        longitude: stop.longitude,
        ...(plan.regionCode ? { areaCode: plan.regionCode } : {}),
        ...(plan.districtCode ? { sigunguCode: plan.districtCode } : {}),
      },
    });
    cursor = endAt + GAP_MINUTES * 60_000;
  });
  return nodes;
}

/* 앞 지점에서 이 지점까지 권하는 이동 수단.
 *
 * 직선거리로만 정한다 — 경로 조회는 요청당 외부 조회 예산을 쓰고, 계획 단계에서는
 * 지점마다 그것을 쓸 값어치가 없다. 그래서 화면은 "직선거리 기준"임을 함께 적고,
 * 실제 경로는 일정이 틀어져 복구할 때 조회한다. */
export function legModeFor(meters: number): "walk" | "transit" | "car" {
  if (meters <= 1_500) return "walk";
  if (meters <= 10_000) return "transit";
  return "car";
}

/* 지점 사이 구간 정보를 채운다. 첫 지점에는 앞 구간이 없다. */
export function withLegs(stops: CourseStop[]): CourseStop[] {
  return stops.map((stop, index) => {
    if (index === 0) return stop;
    const meters = Math.round(haversineMeters(stops[index - 1], stop));
    return { ...stop, legMeters: meters, legMode: legModeFor(meters) };
  });
}

/* ---------------------------------------------------------------- 엮기 ---- */

/* 실측한 형태를 그대로 옮긴 것. 관광지·문화시설 사이에 식당을 끼운다. */
const ASSEMBLED_SHAPE: ReadonlyArray<"sight" | "meal"> = [
  "sight",
  "meal",
  "sight",
  "sight",
];

/* 한 행정구역 안이라도 서로 멀면 하루 코스가 되지 않는다. 공식 코스가 수십~수백
   km인 것과 정확히 갈라서는 지점이다. */
const ASSEMBLED_MAX_SPAN_METERS = 12_000;

function toStop(item: KtoItem): CourseStop | undefined {
  const contentId = String(item.contentid ?? "").trim();
  const title = String(item.title ?? "").trim();
  const latitude = Number(item.mapy);
  const longitude = Number(item.mapx);
  if (!contentId || !title) return undefined;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (latitude < 33 || latitude > 39 || longitude < 124 || longitude > 132) {
    return undefined;
  }
  const image = String(item.firstimage ?? item.firstimage2 ?? "").trim();
  return {
    contentId,
    contentTypeId: String(item.contenttypeid ?? "").trim(),
    title,
    address: String(item.addr1 ?? "").trim() || undefined,
    latitude,
    longitude,
    imageUrl: image
      ? image.startsWith("http://")
        ? `https://${image.slice(7)}`
        : image
      : undefined,
  };
}

/**
 * 공식 코스가 없는 지역에서, 그 지역의 실제 공사 장소로 하루 코스를 엮는다.
 *
 * 형태는 실측한 공식 코스에서 배웠고(관광지↔식당 교차, 4개 지점), 거리는 배우지
 * 않았다 — 공식 코스는 광역 드라이브라 그대로 쓸 수 없기 때문이다. 대신 첫 지점에서
 * 12km 안에 있는 곳만 골라 하루에 실제로 돌 수 있게 한다.
 *
 * 장소가 모자라면 지어내지 않고 **모인 만큼만** 돌려준다. 두 곳도 못 모으면
 * `undefined`를 준다 — 일정 계약이 최소 두 노드를 요구하고, 무엇보다 없는 곳을
 * 만들어 넣지 않는다.
 */
export function assembleLocalCourse(params: {
  sights: KtoItem[];
  meals: KtoItem[];
  regionName: string;
  regionCode?: string;
  districtCode?: string;
  /* 여행자가 있는 곳. 주면 그 지점에서 가장 가까운 장소를 기준점으로 삼는다.
     주지 않으면 목록의 첫 장소가 기준점이 된다 — 그때는 같은 시·군·구 안이지만
     여행자에게서 멀 수 있고, 제목도 "근처"라고 적을 수 없다. */
  origin?: { latitude: number; longitude: number };
  originLabel?: string;
}): CoursePlan | undefined {
  const sights = params.sights
    .map(toStop)
    .filter((stop): stop is CourseStop => Boolean(stop));
  const meals = params.meals
    .map(toStop)
    .filter((stop): stop is CourseStop => Boolean(stop));
  if (!sights.length) return undefined;

  /* 기준점. 여행자 위치를 알면 거기서 가장 가까운 장소를 잡는다 — 같은 시·군·구
     안이라도 첫 장소가 20km 밖일 수 있고, 그러면 "근처 하루 코스"가 거짓이 된다. */
  const anchor = params.origin
    ? sights.reduce((closest, stop) =>
        haversineMeters(params.origin!, stop) <
        haversineMeters(params.origin!, closest)
          ? stop
          : closest,
      )
    : sights[0];
  const near = (stop: CourseStop) =>
    haversineMeters(anchor, stop) <= ASSEMBLED_MAX_SPAN_METERS;
  const nearSights = sights.filter(near);
  const nearMeals = meals.filter(near);

  /* 기준점을 첫 지점으로 두고, 실측한 형태대로 나머지를 채운다. */
  const used = new Set<string>([anchor.contentId]);
  const stops: CourseStop[] = [anchor];
  for (const slot of ASSEMBLED_SHAPE.slice(1)) {
    const pool = slot === "meal" ? nearMeals : nearSights;
    const pick = pool.find((stop) => !used.has(stop.contentId));
    if (!pick) continue;
    used.add(pick.contentId);
    stops.push(pick);
  }
  if (stops.length < 2) return undefined;

  return {
    source: "assembled",
    title: params.originLabel
      ? `${params.originLabel} 근처 하루 코스`
      : `${params.regionName} 하루 코스`,
    regionCode: params.regionCode,
    districtCode: params.districtCode,
    imageUrl: stops.find((stop) => stop.imageUrl)?.imageUrl,
    stops: withLegs(stops),
  };
}
