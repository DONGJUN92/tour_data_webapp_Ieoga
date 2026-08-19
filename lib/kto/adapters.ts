import {
  KTO_BURST_CACHE_TTL_SECONDS,
  POLICY_INDICATORS,
  analysisRegionCode,
  analysisDistrictCode,
  previousCompleteMonth,
  priorMonth,
  rawDistrictCode,
} from "./registry";
import {
  callKto,
  callKtoHedged,
  type KtoCallOptions,
} from "./client";
import type { KtoAudit, KtoCallResult, KtoItem } from "./types";

const listDefaults = { pageNo: 1, numOfRows: 100 };

/* `locationBasedList2`가 허용하는 최대 반경과 복구 후보 탐색용 페이지 크기.
   화면의 과거 거리 설정은 더 이상 후보를 자르는 조건이 아니며, 이 값들은
   공사 API에서 가능한 후보 풀을 넓게 확보하기 위한 내부 조회 규칙이다. */
export const KTO_CANDIDATE_RADIUS_METERS = 20_000;
export const KTO_CANDIDATE_PAGE_SIZE = 100;

/* 공사 `contentTypeId` 25 = 추천코스. */
const COURSE_CONTENT_TYPE_ID = "25";

/* 월 단위 API의 기준월 해석.

   `baseYm`을 받는 공사 API는 직전 달이 아직 발행되지 않은 기간이 있다. 2026-08-04
   실측: `TarRlteTarService1` 해운대구는 202607이 0건, 202606이 601건, 202605가
   632건이었고 `LocgoHubTarService1`도 202607이 0건, 202606이 100건이었다. 응답은
   HTTP 200 + `resultMsg: OK`로 오므로 오류로 잡히지 않고 데이터 공백처럼 보인다.

   그래서 매월 1일부터 발행 시점까지 연관 관광지는 모든 복구에서 기여가 0이 되고
   중심 관광지는 정책 화면에서 사라졌다. 더 나쁜 것은 그 공백이 "공사 데이터가
   없다"는 개선 미션으로 되돌아간다는 점이다. 실제로는 있는 데이터다.

   정책 지표 경로에는 이미 3개월 하강 루프가 있었고 복구·중심관광지 경로에만
   없었다. 같은 규칙을 여기 한곳에 모아 함께 쓰게 한다. */
const MONTH_DESCENT_ATTEMPTS = 3;

/* 한 번 확인한 발행 기준월을 이소레이트 안에서 재사용한다. 발행 지연은 서비스
   단위 월 현상이므로, 첫 요청이 202607이 비었음을 확인하면 이후 요청은 202606에서
   시작해 하강 비용을 내지 않는다. TTL이 지나면 다시 직전 달부터 시도해, 새 달이
   발행된 뒤에도 옛 달에 머무는 일을 막는다. */
const RESOLVED_BASE_MONTH_TTL_MS = 6 * 60 * 60 * 1000;
const resolvedBaseMonth = new Map<
  string,
  { baseYm: string; learnedAt: number }
>();

export function resetResolvedBaseMonths(): void {
  resolvedBaseMonth.clear();
}

async function callMonthlyWithDescent(
  memoKey: string,
  pinnedBaseYm: string | undefined,
  call: (baseYm: string) => Promise<KtoCallResult>,
): Promise<KtoCallResult> {
  /* 호출자가 기준월을 지정했으면 그 달만 조회한다. 지정한 달을 조용히 바꾸면
     화면이 표시한 기준월과 실제 조회한 달이 달라진다. */
  if (pinnedBaseYm) return call(pinnedBaseYm);

  const memo = resolvedBaseMonth.get(memoKey);
  let baseYm =
    memo && Date.now() - memo.learnedAt < RESOLVED_BASE_MONTH_TTL_MS
      ? memo.baseYm
      : previousCompleteMonth();
  let firstAttempt: KtoCallResult | undefined;

  for (let attempt = 0; attempt < MONTH_DESCENT_ATTEMPTS; attempt += 1) {
    const result = await call(baseYm);
    firstAttempt ??= result;
    if (result.items.length) {
      resolvedBaseMonth.set(memoKey, { baseYm, learnedAt: Date.now() });
      return result;
    }
    baseYm = priorMonth(baseYm);
  }

  /* 세 달 모두 비었으면 학습하지 않고 첫 시도 결과를 그대로 돌려준다. 원장에는
     현재 기준월로 본 달을 요청했고 비어 있었다는 사실이 남는다. */
  resolvedBaseMonth.delete(memoKey);
  return firstAttempt as KtoCallResult;
}

/* Region and district codes are official reference data that changes on the
   order of once a year, yet ldongCode2 is hit on every page load and its
   latency is spiky enough to occasionally exceed the request timeout. The
   short burst window absorbs that without holding tourism content: the same
   five-minute ceiling as every other cached call, so the agency-side call log
   still shows continuous use. */
export function getRegions(): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "ldongCode2",
    { ...listDefaults },
    {
      fieldsUsed: ["code", "name"],
      cacheTtlSeconds: KTO_BURST_CACHE_TTL_SECONDS,
      timeoutMs: 12_000,
    },
  );
}

export function getDistricts(regionCode: string): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "ldongCode2",
    { ...listDefaults, lDongRegnCd: regionCode },
    {
      fieldsUsed: ["code", "name"],
      cacheTtlSeconds: KTO_BURST_CACHE_TTL_SECONDS,
      timeoutMs: 12_000,
    },
  );
}

export function getNearbyTourism(params: {
  longitude: number;
  latitude: number;
  radius: number;
  pageNo?: number;
  numOfRows?: number;
  regionCode?: string;
  districtCode?: string;
}, requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {}): Promise<KtoCallResult> {
  const pageNo = Math.max(1, Math.trunc(params.pageNo ?? 1));
  const query = {
    pageNo,
    numOfRows: params.numOfRows ?? KTO_CANDIDATE_PAGE_SIZE,
    mapX: params.longitude,
    mapY: params.latitude,
    radius: params.radius,
    arrange: "E",
    lDongRegnCd: analysisRegionCode(params.regionCode),
    lDongSignguCd: rawDistrictCode(
      params.regionCode,
      params.districtCode,
    ),
  };
  const options = {
    ...requestOptions,
    fieldsUsed: [
      "contentid",
      "contenttypeid",
      "title",
      "addr1",
      "mapx",
      "mapy",
      "dist",
      "firstimage",
      "firstimage2",
      "modifiedtime",
      "lDongRegnCd",
      "lDongSignguCd",
      "lclsSystm1",
      "lclsSystm2",
      "lclsSystm3",
    ],
  };

  /* The first page gates the entire recovery, so it keeps the measured
     latency hedge. Later pages are optional expansion work: issuing a hedge
     for every page would double upstream traffic exactly when a request is
     already broad, so those pages use one non-retrying call. */
  if (pageNo === 1) {
    return callKtoHedged(
      "KorService2",
      "locationBasedList2",
      query,
      options,
    );
  }
  return callKto(
    "KorService2",
    "locationBasedList2",
    query,
    options,
  );
}

/* 행사·공연·축제만은 위치 기반 목록으로 찾을 수 없다.
 *
 * `locationBasedList2`에 `contentTypeId=15`를 걸면 주변 행사가 돌아오기는 하는데,
 * 그 응답에는 `eventstartdate`/`eventenddate`가 **없다.** 행사 기간은 상세조회에만
 * 있으므로, 이미 끝난 행사인지 알아내려면 후보 하나마다 외부 조회를 한 건씩 써야
 * 한다. 2026-08-19 실측: 대전역 반경 20km에서 10건이 돌아왔고 표본 6건이 전부
 * 작년에 끝난 행사였다(20250829~20250831 등). 그래서 이 분류를 고르면 예산을 전부
 * 탈락에 쓰고 화면은 0건이 됐다 — 프로덕션에서 `OFFICIALLY_CLOSED: 3`, 후보 0곳.
 *
 * `searchFestival2`는 `eventStartDate`를 받아 그 날짜 이후에 열리는 행사만 준다.
 * 같은 응답에 기간과 좌표(`mapx`/`mapy`)가 함께 오므로, 조회 한 건으로 날짜가
 * 유효한 후보만 받고 거리는 우리가 계산한다. 실측: 대전 3건·서울 32건 모두 끝난
 * 행사 0건, 좌표 누락 0건.
 *
 * 반경을 받지 않으므로 지역 코드로 받는다. 거리 판정은 호출한 쪽이 좌표로 한다.
 */
export function getFestivals(params: {
  eventStartDate: string;
  regionCode?: string;
  districtCode?: string;
  numOfRows?: number;
}, requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {}): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "searchFestival2",
    {
      pageNo: 1,
      numOfRows: params.numOfRows ?? 50,
      arrange: "A",
      eventStartDate: params.eventStartDate,
      lDongRegnCd: analysisRegionCode(params.regionCode),
      lDongSignguCd: rawDistrictCode(params.regionCode, params.districtCode),
    },
    {
      ...requestOptions,
      fieldsUsed: [
        "contentid",
        "contenttypeid",
        "title",
        "addr1",
        "mapx",
        "mapy",
        "firstimage",
        "firstimage2",
        "modifiedtime",
        "eventstartdate",
        "eventenddate",
        "lDongRegnCd",
        "lDongSignguCd",
        "lclsSystm1",
        "lclsSystm2",
        "lclsSystm3",
      ],
    },
  );
}

export function searchTourism(params: {
  keyword: string;
  regionCode?: string;
  districtCode?: string;
  numOfRows?: number;
}): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "searchKeyword2",
    {
      pageNo: 1,
      numOfRows: params.numOfRows ?? 20,
      keyword: params.keyword,
      arrange: "A",
      lDongRegnCd: analysisRegionCode(params.regionCode),
      lDongSignguCd: rawDistrictCode(
        params.regionCode,
        params.districtCode,
      ),
    },
    {
      fieldsUsed: [
        "contentid",
        "contenttypeid",
        "title",
        "addr1",
        "mapx",
        "mapy",
        "firstimage",
        "firstimage2",
        "modifiedtime",
        "lDongRegnCd",
        "lDongSignguCd",
      ],
    },
  );
}

export function getTourismIntro(
  contentId: string,
  contentTypeId: string,
  requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {},
): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "detailIntro2",
    {
      contentId,
      contentTypeId,
      pageNo: 1,
      numOfRows: 10,
    },
    {
      timeoutMs: requestOptions.timeoutMs ?? 2_500,
      retry: requestOptions.retry ?? false,
      signal: requestOptions.signal,
      /* 원장에 적히는 필드 목록은 실제로 읽는 필드와 같아야 한다. 유형별
         이름(`usetimeculture` 등)을 빼놓으면 심사 증거로 제출하는 기여 원장이
         읽지 않은 필드를 읽었다고 적게 된다. 행사의 `usetimefestival`은 실제로는
         이용요금이므로 운영시간 근거 목록에 두지 않는다. */
      fieldsUsed: [
        "usetime",
        "usetimeculture",
        "usetimeleports",
        "opentime",
        "opentimefood",
        "playtime",
        "restdate",
        "restdateculture",
        "restdateleports",
        "restdateshopping",
        "restdatefood",
        "eventstartdate",
        "eventenddate",
        "checkintime",
        "checkouttime",
        "infocenter",
        "infocenterculture",
        /* 같은 응답에서 여행자에게 보여 줄 사실도 함께 읽는다. 추가 호출은 없지만
           원장은 읽은 것을 전부 적어야 하므로 여기에 남긴다. */
        "firstmenu",
        "treatmenu",
        "parking",
        "parkingfood",
        "parkingculture",
        "parkingleports",
        "parkingshopping",
        "parkinglodging",
        "usefee",
        "usetimefestival",
        "reservationurl",
        "reservationfood",
        "reservationlodging",
        "chkcreditcard",
        "chkcreditcardfood",
        "chkpet",
      ],
    },
  );
}

/* 행정구역 안의 공사 공식 추천코스 목록.
 *
 * 위치 기반이 아니라 지역 기반이다 — 코스는 여러 시·군을 넘나드는 것이 많아
 * 반경으로 자르면 시작 지점만 가까운 코스가 걸리거나 아무것도 안 걸린다.
 *
 * 2026-08-19 실측 커버리지: 16개 시·도 중 11곳, 전국 53건. 서울·대전·울산·제주·
 * 세종은 **0건**이다. 호출한 쪽은 반드시 빈 결과를 정상 상태로 다뤄야 한다. */
export function getAreaCourses(params: {
  regionCode?: string;
  districtCode?: string;
  numOfRows?: number;
}, requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {}): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "areaBasedList2",
    {
      pageNo: 1,
      numOfRows: params.numOfRows ?? 30,
      arrange: "A",
      contentTypeId: COURSE_CONTENT_TYPE_ID,
      lDongRegnCd: analysisRegionCode(params.regionCode),
      lDongSignguCd: rawDistrictCode(params.regionCode, params.districtCode),
    },
    {
      ...requestOptions,
      timeoutMs: requestOptions.timeoutMs ?? 7_000,
      fieldsUsed: [
        "contentid",
        "contenttypeid",
        "title",
        "addr1",
        "mapx",
        "mapy",
        "firstimage",
        "firstimage2",
        "modifiedtime",
        "lDongRegnCd",
        "lDongSignguCd",
      ],
    },
  );
}

/* 코스를 이루는 지점 목록. `detailInfo2`가 `subname`·`subcontentid`·`subnum`을
   주지만 **좌표는 주지 않는다** — 지점 좌표는 `subcontentid`로 `detailCommon2`를
   한 번 더 불러야 한다. 그래서 코스 하나를 일정으로 만드는 비용은
   1(목록) + 1(지점) + N(지점별 좌표)이다. 실측 중앙값이 7지점이므로 약 9건. */
export function getCourseStops(
  contentId: string,
  requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {},
): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "detailInfo2",
    {
      contentId,
      contentTypeId: COURSE_CONTENT_TYPE_ID,
      pageNo: 1,
      numOfRows: 30,
    },
    {
      ...requestOptions,
      timeoutMs: requestOptions.timeoutMs ?? 7_000,
      fieldsUsed: [
        "contentid",
        "contenttypeid",
        "subcontentid",
        "subname",
        "subnum",
        "subdetailoverview",
        "subdetailimg",
      ],
    },
  );
}

/* 행정구역 안의 관광 콘텐츠. 공식 코스가 없는 지역에서 실제 장소로 하루 코스를
   엮을 때 쓴다. 유형을 지정해 부른다(관광지 12 / 문화시설 14 / 식당 39 등). */
export function getAreaPlaces(params: {
  regionCode?: string;
  districtCode?: string;
  contentTypeId: string;
  numOfRows?: number;
}, requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {}): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "areaBasedList2",
    {
      pageNo: 1,
      numOfRows: params.numOfRows ?? 50,
      /* 수정일 역순. 가나다순으로 받으면 앞 글자에 몰린 표본만 보게 되고,
         실제로 집중률 조회에서 그렇게 잘려 명소가 통째로 빠진 적이 있다. */
      arrange: "S",
      contentTypeId: params.contentTypeId,
      lDongRegnCd: analysisRegionCode(params.regionCode),
      lDongSignguCd: rawDistrictCode(params.regionCode, params.districtCode),
    },
    {
      ...requestOptions,
      timeoutMs: requestOptions.timeoutMs ?? 7_000,
      fieldsUsed: [
        "contentid",
        "contenttypeid",
        "title",
        "addr1",
        "mapx",
        "mapy",
        "firstimage",
        "firstimage2",
        "modifiedtime",
        "lclsSystm1",
        "lclsSystm2",
        "lclsSystm3",
        "lDongRegnCd",
        "lDongSignguCd",
      ],
    },
  );
}

export function getTourismCommonDetail(
  contentId: string,
  requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {},
): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "detailCommon2",
    {
      contentId,
      pageNo: 1,
      numOfRows: 10,
    },
    {
      timeoutMs: requestOptions.timeoutMs ?? 4_000,
      retry: requestOptions.retry ?? false,
      signal: requestOptions.signal,
      fieldsUsed: [
        "contentid",
        "contenttypeid",
        "title",
        "addr1",
        "addr2",
        "mapx",
        "mapy",
        "modifiedtime",
        "lDongRegnCd",
        "lDongSignguCd",
      ],
    },
  );
}

export function getNearbyAccessibleTourism(params: {
  longitude: number;
  latitude: number;
  radius: number;
}, requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {}): Promise<KtoCallResult> {
  return callKto(
    "KorWithService2",
    "locationBasedList2",
    {
      pageNo: 1,
      numOfRows: 100,
      mapX: params.longitude,
      mapY: params.latitude,
      radius: params.radius,
      arrange: "E",
    },
    {
      ...requestOptions,
      fieldsUsed: [
        "contentid",
        "contenttypeid",
        "title",
        "mapx",
        "mapy",
        "dist",
      ],
    },
  );
}

export function getAccessibilityDetail(
  contentId: string,
  requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {},
): Promise<KtoCallResult> {
  return callKto(
    "KorWithService2",
    "detailWithTour2",
    { contentId, pageNo: 1, numOfRows: 10 },
    {
      /* Bounded like the other per-candidate detail lookups. This runs once
         per shortlisted candidate for non-general audiences, so inheriting the
         eight-second default with retries let a single slow response consume
         the entire recovery budget — the stroller and wheelchair journeys
         timed out before returning anything. An unanswered lookup is recorded
         as an accessibility gap, which is a usable outcome; a timeout is not. */
      timeoutMs: requestOptions.timeoutMs ?? 2_500,
      retry: requestOptions.retry ?? false,
      ...requestOptions,
      fieldsUsed: [
        "route",
        "publictransport",
        "ticketoffice",
        "wheelchair",
        "elevator",
        "restroom",
        "stroller",
        "lactationroom",
        "parking",
        "exit",
        "auditorium",
        "room",
        "handicapetc",
      ],
    },
  );
}

export function getRelatedTourism(params: {
  regionCode: string;
  districtCode: string;
  baseYm?: string;
  numOfRows?: number;
}, requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {}): Promise<KtoCallResult> {
  return callMonthlyWithDescent(
    "TarRlteTarService1:areaBasedList1",
    params.baseYm,
    (baseYm) =>
      callKto(
        "TarRlteTarService1",
        "areaBasedList1",
        {
          pageNo: 1,
          numOfRows: params.numOfRows ?? 1_000,
          baseYm,
          areaCd: analysisRegionCode(params.regionCode),
          signguCd: analysisDistrictCode(
            params.regionCode,
            params.districtCode,
          ),
        },
        {
          ...requestOptions,
          cacheTtlSeconds: KTO_BURST_CACHE_TTL_SECONDS,
          fieldsUsed: [
            "baseYm",
            "tAtsNm",
            "rlteTatsNm",
            "rlteCtgryLclsNm",
            "rlteCtgryMclsNm",
            "rlteCtgrySclsNm",
            "rlteRank",
          ],
        },
      ),
  );
}

/* 집중률은 시군구 하나에 **관광지 수 x 30일**만큼의 행을 준다. 종로는 113곳 x
   30일 = 3,390행이다. 그런데 이 호출이 1,000행만 받고 있었고, 응답이 가나다순
   이어서 `가회민화박물관`부터 `보신각 터`까지 34곳에서 잘렸다. 북촌한옥마을·
   창덕궁·종묘·세종문화회관이 통째로 빠졌다 — 집중률 데이터의 유무가 **관광지
   이름의 자모 순서**로 결정되고 있었다는 뜻이다. 잘린 후보는 중립값 50점을
   받으므로 `혼잡` 상황을 골라도 순위가 거의 바뀌지 않았다.

   실측 최대치는 종로 3,390행이고 5,000행이면 한 번에 받는다(+0.15초, +366KB).
   상한을 두는 이유는 응답 크기 자체를 통제해야 하기 때문이고, 그 상한을
   넘는 지역이 나오면 조용히 잃지 않도록 호출자가 `totalCount`와 받은 건수를
   비교해 밝힌다. 조용히 잘리는 것이 원래 결함이었다. */
export const CONCENTRATION_PAGE_SIZE = 5_000;

export function getConcentrationForecast(params: {
  regionCode: string;
  districtCode: string;
  tourismName?: string;
}, requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {}): Promise<KtoCallResult> {
  return callKto(
    "TatsCnctrRateService",
    "tatsCnctrRatedList",
    {
      pageNo: 1,
      numOfRows: CONCENTRATION_PAGE_SIZE,
      areaCd: analysisRegionCode(params.regionCode),
      signguCd: analysisDistrictCode(
        params.regionCode,
        params.districtCode,
      ),
      tAtsNm: params.tourismName,
    },
    {
      ...requestOptions,
      cacheTtlSeconds: KTO_BURST_CACHE_TTL_SECONDS,
      fieldsUsed: ["baseYmd", "tAtsNm", "cnctrRate"],
    },
  );
}

export function getHubTourism(params: {
  regionCode: string;
  districtCode: string;
  baseYm?: string;
}): Promise<KtoCallResult> {
  return callMonthlyWithDescent(
    "LocgoHubTarService1:areaBasedList1",
    params.baseYm,
    (baseYm) =>
      callKto(
        "LocgoHubTarService1",
        "areaBasedList1",
        {
          pageNo: 1,
          numOfRows: 100,
          baseYm,
          areaCd: analysisRegionCode(params.regionCode),
          signguCd: analysisDistrictCode(
            params.regionCode,
            params.districtCode,
          ),
        },
        {
          fieldsUsed: [
            "baseYm",
            "mapX",
            "mapY",
            "hubTatsNm",
            "hubCtgryLclsNm",
            "hubCtgryMclsNm",
            "hubRank",
          ],
        },
      ),
  );
}

export async function getPolicyIndicator(
  indicator: (typeof POLICY_INDICATORS)[number],
  params: {
    regionCode: string;
    districtCode?: string;
    baseYm: string;
  },
): Promise<KtoCallResult> {
  return callKto(
    indicator.service,
    indicator.operation,
    {
      pageNo: 1,
      numOfRows: 10,
      baseYm: params.baseYm,
      areaCd: analysisRegionCode(params.regionCode),
      signguCd: analysisDistrictCode(
        params.regionCode,
        params.districtCode,
      ),
      [indicator.param]: indicator.code,
    },
    {
      fieldsUsed: [
        "baseYm",
        "areaCd",
        "areaNm",
        "signguCd",
        "signguNm",
        indicator.nameField,
        indicator.valueField,
      ],
    },
  );
}

export async function getPolicyBundle(params: {
  regionCode: string;
  districtCode?: string;
  startingBaseYm?: string;
}): Promise<{
  baseYm: string;
  results: Array<{
    indicator: (typeof POLICY_INDICATORS)[number];
    result?: KtoCallResult;
    audit: KtoAudit;
    item?: KtoItem;
  }>;
  /* 값이 없는 이유가 우리 쪽 호출 실패인가. 참이면 "공사 데이터 공백"이라고
     말해서는 안 된다. */
  upstreamFailed: boolean;
}> {
  let baseYm = params.startingBaseYm ?? previousCompleteMonth();
  let lastResults: Array<{
    indicator: (typeof POLICY_INDICATORS)[number];
    result?: KtoCallResult;
    audit: KtoAudit;
    item?: KtoItem;
  }> = [];

  for (let monthAttempt = 0; monthAttempt < 3; monthAttempt += 1) {
    const results: Array<{
      indicator: (typeof POLICY_INDICATORS)[number];
      result?: KtoCallResult;
      audit: KtoAudit;
      item?: KtoItem;
    }> = [];

    for (let offset = 0; offset < POLICY_INDICATORS.length; offset += 4) {
      const group = POLICY_INDICATORS.slice(offset, offset + 4);
      const settled = await Promise.allSettled(
        group.map((indicator) =>
          getPolicyIndicator(indicator, { ...params, baseYm }),
        ),
      );
      settled.forEach((entry, index) => {
        const indicator = group[index];
        if (entry.status === "fulfilled") {
          results.push({
            indicator,
            result: entry.value,
            audit: entry.value.audit,
            item: entry.value.items[0],
          });
        } else {
          const reason = entry.reason;
          results.push({
            indicator,
            audit:
              reason && typeof reason === "object" && "audit" in reason
                ? (reason.audit as KtoAudit)
                : {
                    apiName: indicator.service,
                    operation: indicator.operation,
                    status: "error",
                    latencyMs: 0,
                    resultCount: 0,
                    totalCount: 0,
                    fieldsUsed: [],
                    errorCode: "UNKNOWN",
                    upstreamCalls: 1,
                  },
          });
        }
      });
    }

    if (results.some((entry) => entry.result?.items.length)) {
      return { baseYm, results, upstreamFailed: false };
    }
    lastResults = results;
    baseYm = priorMonth(baseYm);
  }

  /* 세 달을 다 써도 값이 없을 때 예전 구현은 빈 배열을 돌려주며 감사 기록까지
     버렸다. 그러면 호출자는 "우리 호출이 실패했다"와 "공사에 그 값이 없다"를
     구분할 수 없고, 화면은 후자로 단정해 공사 담당부서에 개선 미션을 발행했다.
     실제로는 같은 파라미터로 직접 호출하면 값이 나오는 경우가 있었다.
     마지막 시도의 감사를 그대로 넘겨 두 상태를 호출자가 가릴 수 있게 한다. */
  const upstreamFailed = lastResults.some(
    (entry) => entry.audit.status === "error",
  );
  return { baseYm, results: lastResults, upstreamFailed };
}

export function normalizeAnalysisCodes(item: KtoItem): {
  regionCode?: string;
  districtCode?: string;
} {
  const regionCode =
    typeof item.lDongRegnCd === "string" ? item.lDongRegnCd : undefined;
  const rawDistrict =
    typeof item.lDongSignguCd === "string" ? item.lDongSignguCd : undefined;
  return {
    regionCode,
    districtCode:
      analysisDistrictCode(regionCode, rawDistrict) ??
      (regionCode?.length === 5 ? regionCode : undefined),
  };
}

export function toLegacyDistrictCode(
  regionCode: string | undefined,
  districtCode: string | undefined,
): string | undefined {
  return rawDistrictCode(regionCode, districtCode);
}
