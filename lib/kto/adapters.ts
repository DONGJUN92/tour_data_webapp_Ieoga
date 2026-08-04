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
  numOfRows?: number;
  regionCode?: string;
  districtCode?: string;
}, requestOptions: Pick<KtoCallOptions, "signal" | "timeoutMs" | "retry"> = {}): Promise<KtoCallResult> {
  /* Candidate discovery gates the entire recovery, and this endpoint is the
     one with the worst measured latency spread, so it is the call worth
     hedging. */
  return callKtoHedged(
    "KorService2",
    "locationBasedList2",
    {
      pageNo: 1,
      numOfRows: params.numOfRows ?? 60,
      mapX: params.longitude,
      mapY: params.latitude,
      radius: params.radius,
      arrange: "E",
      lDongRegnCd: analysisRegionCode(params.regionCode),
      lDongSignguCd: rawDistrictCode(
        params.regionCode,
        params.districtCode,
      ),
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
        "dist",
        "firstimage",
        "modifiedtime",
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
      numOfRows: 1_000,
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
