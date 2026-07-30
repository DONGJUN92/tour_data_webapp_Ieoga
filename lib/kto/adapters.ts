import {
  POLICY_INDICATORS,
  analysisRegionCode,
  analysisDistrictCode,
  previousCompleteMonth,
  priorMonth,
  rawDistrictCode,
} from "./registry";
import { callKto, type KtoCallOptions } from "./client";
import type { KtoAudit, KtoCallResult, KtoItem } from "./types";

const listDefaults = { pageNo: 1, numOfRows: 100 };

export function getRegions(): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "ldongCode2",
    { ...listDefaults },
    { fieldsUsed: ["code", "name"] },
  );
}

export function getDistricts(regionCode: string): Promise<KtoCallResult> {
  return callKto(
    "KorService2",
    "ldongCode2",
    { ...listDefaults, lDongRegnCd: regionCode },
    { fieldsUsed: ["code", "name"] },
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
  return callKto(
    "KorService2",
    "locationBasedList2",
    {
      pageNo: 1,
      numOfRows: params.numOfRows ?? 60,
      mapX: params.longitude,
      mapY: params.latitude,
      radius: params.radius,
      arrange: "E",
      lDongRegnCd: params.regionCode,
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
      lDongRegnCd: params.regionCode,
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
      fieldsUsed: [
        "usetime",
        "restdate",
        "opentime",
        "restdateshopping",
        "opentimefood",
        "restdatefood",
        "usetimefestival",
        "eventstartdate",
        "eventenddate",
        "checkintime",
        "checkouttime",
        "infocenter",
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
  return callKto(
    "TarRlteTarService1",
    "areaBasedList1",
    {
      pageNo: 1,
      numOfRows: params.numOfRows ?? 1_000,
      baseYm: params.baseYm ?? previousCompleteMonth(),
      areaCd: analysisRegionCode(params.regionCode),
      signguCd: analysisDistrictCode(
        params.regionCode,
        params.districtCode,
      ),
    },
    {
      ...requestOptions,
      cacheTtlSeconds: 21_600,
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
      cacheTtlSeconds: 1_800,
      fieldsUsed: ["baseYmd", "tAtsNm", "cnctrRate"],
    },
  );
}

export function getHubTourism(params: {
  regionCode: string;
  districtCode: string;
  baseYm?: string;
}): Promise<KtoCallResult> {
  return callKto(
    "LocgoHubTarService1",
    "areaBasedList1",
    {
      pageNo: 1,
      numOfRows: 100,
      baseYm: params.baseYm ?? previousCompleteMonth(),
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
}> {
  let baseYm = params.startingBaseYm ?? previousCompleteMonth();

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
      return { baseYm, results };
    }
    baseYm = priorMonth(baseYm);
  }

  return { baseYm, results: [] };
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
