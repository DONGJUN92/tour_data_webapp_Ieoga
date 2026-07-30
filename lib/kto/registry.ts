import type { KtoServiceName } from "./types";

export const KTO_BASE_URL = "https://apis.data.go.kr/B551011";
export const KTO_MOBILE_OS = "ETC";
export const KTO_MOBILE_APP = "IEOGA";

/* Short-lived edge de-duplication for repeated identical queries, sized as
   burst protection rather than storage. The contest requires live calls and
   verifies the agency-side call log, so this window is kept small enough that
   any real usage still produces a continuous trail. Responses are never
   written to D1 or any durable store. */
export const KTO_BURST_CACHE_TTL_SECONDS = 300;

export const KTO_SERVICES: Record<
  KtoServiceName,
  { label: string; role: string; primaryOperation: string }
> = {
  KorService2: {
    label: "국문 관광정보",
    role: "관광지 후보·좌표·분류·상세정보",
    primaryOperation: "locationBasedList2",
  },
  TarRlteTarService1: {
    label: "관광지별 연관 관광지",
    role: "원래 여행 맥락과 지역 연결성 보정",
    primaryOperation: "areaBasedList1",
  },
  TatsCnctrRateService: {
    label: "관광지 집중률 방문자 추이 예측",
    role: "향후 30일 관광지별 상대 집중률 근거",
    primaryOperation: "tatsCnctrRatedList",
  },
  KorWithService2: {
    label: "무장애 여행정보",
    role: "휠체어·영유아·고령자 편의정보 검증",
    primaryOperation: "detailWithTour2",
  },
  LocgoHubTarService1: {
    label: "기초지자체 중심 관광지",
    role: "지역 내 연계방문 중심 관광지 식별",
    primaryOperation: "areaBasedList1",
  },
  AreaTarDemDsService: {
    label: "지역별 관광 수요 강도",
    role: "체류·소비 수요 강도",
    primaryOperation: "areaTarSjrnDsList",
  },
  AreaTarResDemService: {
    label: "지역별 관광 자원 수요",
    role: "관광서비스·문화자원 수요",
    primaryOperation: "areaTarSvcDemList",
  },
  AreaTarDivService: {
    label: "지역별 관광 다양성",
    role: "관광객·소비·국제적 다양성",
    primaryOperation: "areaTouDivList",
  },
};

export const POLICY_INDICATORS = [
  {
    service: "AreaTarDivService" as const,
    operation: "areaTouDivList",
    param: "touDivIxCd",
    code: "31",
    valueField: "touDivIxVal",
    nameField: "touDivIxNm",
    label: "관광객 다양성",
  },
  {
    service: "AreaTarDivService" as const,
    operation: "areaExpDivList",
    param: "expDivIxCd",
    code: "32",
    valueField: "expDivIxVal",
    nameField: "expDivIxNm",
    label: "관광소비 다양성",
  },
  {
    service: "AreaTarDivService" as const,
    operation: "areaIntlDivList",
    param: "intlDivIxCd",
    code: "33",
    valueField: "intlDivIxVal",
    nameField: "intlDivIxNm",
    label: "국제적 다양성",
  },
  {
    service: "AreaTarDemDsService" as const,
    operation: "areaTarSjrnDsList",
    param: "tarSjrnDsIxCd",
    code: "21",
    valueField: "tarSjrnDsIxVal",
    nameField: "tarSjrnDsIxNm",
    label: "관광 체류 강도",
  },
  {
    service: "AreaTarDemDsService" as const,
    operation: "areaTarExpDsList",
    param: "tarExpDsIxCd",
    code: "22",
    valueField: "tarExpDsIxVal",
    nameField: "tarExpDsIxNm",
    label: "관광 소비 강도",
  },
  {
    service: "AreaTarResDemService" as const,
    operation: "areaTarSvcDemList",
    param: "tarSvcDemIxCd",
    code: "11",
    valueField: "tarSvcDemIxVal",
    nameField: "tarSvcDemIxNm",
    label: "관광서비스 수요",
  },
  {
    service: "AreaTarResDemService" as const,
    operation: "areaCulResDemList",
    param: "culResDemIxCd",
    code: "12",
    valueField: "culResDemIxVal",
    nameField: "culResDemIxNm",
    label: "문화자원 수요",
  },
] as const;

export function previousCompleteMonth(from = new Date()): string {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function priorMonth(baseYm: string): string {
  const year = Number(baseYm.slice(0, 4));
  const month = Number(baseYm.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isOfficialRegionCode(value: string): boolean {
  return /^(?:\d{2}|\d{5})$/.test(value);
}

export function analysisRegionCode(
  regionCode: string | undefined,
): string | undefined {
  if (!regionCode) return undefined;
  return regionCode.length === 5
    ? regionCode.slice(0, 2)
    : regionCode;
}

export function analysisDistrictCode(
  regionCode: string | undefined,
  districtCode: string | undefined,
): string | undefined {
  if (!regionCode) return undefined;
  if (!districtCode && regionCode.length === 5) return regionCode;
  if (!districtCode) return undefined;
  const analysisRegion = analysisRegionCode(regionCode);
  if (
    analysisRegion &&
    districtCode.startsWith(analysisRegion) &&
    districtCode.length >= 5
  ) {
    return districtCode.slice(0, 5);
  }
  if (districtCode.length === 3 && analysisRegion) {
    return `${analysisRegion}${districtCode}`;
  }
  return districtCode;
}

export function rawDistrictCode(
  regionCode: string | undefined,
  districtCode: string | undefined,
): string | undefined {
  if (!districtCode) return undefined;
  if (regionCode?.length === 5 && districtCode === regionCode) {
    return undefined;
  }
  const analysisRegion = analysisRegionCode(regionCode);
  if (
    analysisRegion &&
    districtCode.startsWith(analysisRegion) &&
    districtCode.length >= 5
  ) {
    return districtCode.slice(
      analysisRegion.length,
      analysisRegion.length + 3,
    );
  }
  return districtCode;
}
