import {
  getConcentrationForecast,
  getDistricts,
  getHubTourism,
  getPolicyIndicator,
  getRegions,
  getRelatedTourism,
} from "./adapters";
import { callKto, ktoServiceKeyConfigured } from "./client";
import {
  POLICY_INDICATORS,
  previousCompleteMonth,
  priorMonth,
} from "./registry";
import { KtoError, type KtoAudit } from "./types";

/* 월 단위 데이터셋은 지난달이 아직 발행되지 않았을 수 있다. 실측 기준으로
   8월 초에 최신 기준월은 6월이었고, 7월은 모든 지표에서 0건이었다. 점검이
   기준월 하나만 보고 끝내면 발행 지연을 데이터 공백으로 보고하게 된다.
   실제 조회 경로(getPolicyBundle)가 3개월을 훑으므로 점검도 같은 창을 쓴다.
   그래야 점검 결과가 사용자가 화면에서 겪는 것과 같은 사실이 된다. */
const BASE_MONTH_ATTEMPTS = 3;

async function checkAcrossRecentMonths(
  baseYm: string,
  run: (baseYm: string) => Promise<{ audit: KtoAudit }>,
): Promise<{ audit: KtoAudit }> {
  let month = baseYm;
  let lastResult: { audit: KtoAudit } | undefined;
  for (let attempt = 0; attempt < BASE_MONTH_ATTEMPTS; attempt += 1) {
    const result = await run(month);
    if (result.audit.status !== "empty") return result;
    lastResult = result;
    month = priorMonth(month);
  }
  return lastResult!;
}

function failedAudit(
  apiName: KtoAudit["apiName"],
  operation: string,
  error: unknown,
): KtoAudit {
  if (error instanceof KtoError) return error.audit;
  return {
    apiName,
    operation,
    status: "error",
    latencyMs: 0,
    resultCount: 0,
    totalCount: 0,
    fieldsUsed: [],
    errorCode: "UNKNOWN",
    upstreamCalls: 1,
  };
}

export async function checkAllKtoServices(): Promise<{
  overall: "ready" | "degraded" | "unavailable";
  configured: boolean;
  probeScope?: {
    regionCode: string;
    regionName: string;
    districtCode?: string;
    districtName?: string;
  };
  sources: KtoAudit[];
  checkedAt: string;
}> {
  if (!ktoServiceKeyConfigured()) {
    return {
      overall: "unavailable",
      configured: false,
      sources: [],
      checkedAt: new Date().toISOString(),
    };
  }

  const sources: KtoAudit[] = [];
  let regionCode = "11";
  let regionName = "서울특별시";
  let districtCode = "11110";
  let districtName = "종로구";

  try {
    const regions = await getRegions();
    sources.push(regions.audit);
    const first =
      regions.items.find((item) => String(item.code) === "11") ??
      regions.items[0];
    if (first) {
      regionCode = String(first.code);
      regionName = String(first.name);
    }
    const districts = await getDistricts(regionCode);
    const firstDistrict = districts.items[0];
    if (firstDistrict) {
      const raw = String(firstDistrict.code);
      districtCode = `${regionCode}${raw}`;
      districtName = String(firstDistrict.name);
    }
  } catch (error) {
    sources.push(failedAudit("KorService2", "ldongCode2", error));
  }

  const baseYm = previousCompleteMonth();
  const diversity = POLICY_INDICATORS.find(
    (item) => item.service === "AreaTarDivService",
  )!;
  const demand = POLICY_INDICATORS.find(
    (item) => item.service === "AreaTarDemDsService",
  )!;
  const resource = POLICY_INDICATORS.find(
    (item) => item.service === "AreaTarResDemService",
  )!;

  const checks = [
    {
      service: "TarRlteTarService1" as const,
      operation: "areaBasedList1",
      run: () =>
        checkAcrossRecentMonths(baseYm, (month) =>
          getRelatedTourism({
            regionCode,
            districtCode,
            baseYm: month,
            numOfRows: 1,
          }),
        ),
    },
    {
      service: "TatsCnctrRateService" as const,
      operation: "tatsCnctrRatedList",
      run: () =>
        getConcentrationForecast({ regionCode, districtCode }),
    },
    {
      service: "KorWithService2" as const,
      operation: "ldongCode2",
      run: () =>
        callKto(
          "KorWithService2",
          "ldongCode2",
          { pageNo: 1, numOfRows: 1, lDongRegnCd: regionCode },
          { fieldsUsed: ["code", "name"] },
        ),
    },
    {
      service: "LocgoHubTarService1" as const,
      operation: "areaBasedList1",
      run: () =>
        checkAcrossRecentMonths(baseYm, (month) =>
          getHubTourism({ regionCode, districtCode, baseYm: month }),
        ),
    },
    {
      service: "AreaTarDivService" as const,
      operation: diversity.operation,
      run: () =>
        checkAcrossRecentMonths(baseYm, (month) =>
          getPolicyIndicator(diversity, {
            regionCode,
            districtCode,
            baseYm: month,
          }),
        ),
    },
    {
      service: "AreaTarDemDsService" as const,
      operation: demand.operation,
      run: () =>
        checkAcrossRecentMonths(baseYm, (month) =>
          getPolicyIndicator(demand, {
            regionCode,
            districtCode,
            baseYm: month,
          }),
        ),
    },
    {
      service: "AreaTarResDemService" as const,
      operation: resource.operation,
      run: () =>
        checkAcrossRecentMonths(baseYm, (month) =>
          getPolicyIndicator(resource, {
            regionCode,
            districtCode,
            baseYm: month,
          }),
        ),
    },
  ];

  for (let offset = 0; offset < checks.length; offset += 4) {
    const group = checks.slice(offset, offset + 4);
    const settled = await Promise.allSettled(group.map((check) => check.run()));
    settled.forEach((entry, index) => {
      const check = group[index];
      sources.push(
        entry.status === "fulfilled"
          ? entry.value.audit
          : failedAudit(check.service, check.operation, entry.reason),
      );
    });
  }

  const uniqueSources = new Map<string, KtoAudit>();
  for (const source of sources) {
    uniqueSources.set(source.apiName, source);
  }
  const normalized = [...uniqueSources.values()];
  const successfulCount = normalized.filter(
    (source) => source.status === "live" || source.status === "empty",
  ).length;
  const overall =
    successfulCount === 8 && normalized.length === 8
      ? "ready"
      : successfulCount > 0
        ? "degraded"
        : "unavailable";

  return {
    overall,
    configured: true,
    probeScope: {
      regionCode,
      regionName,
      districtCode,
      districtName,
    },
    sources: normalized,
    checkedAt: new Date().toISOString(),
  };
}
