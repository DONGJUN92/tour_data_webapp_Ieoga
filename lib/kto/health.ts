import {
  getConcentrationForecast,
  getDistricts,
  getHubTourism,
  getPolicyIndicator,
  getRegions,
  getRelatedTourism,
} from "./adapters";
import { callKto, ktoServiceKeyConfigured } from "./client";
import { POLICY_INDICATORS, previousCompleteMonth } from "./registry";
import { KtoError, type KtoAudit } from "./types";

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
        getRelatedTourism({
          regionCode,
          districtCode,
          baseYm,
          numOfRows: 1,
        }),
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
        getHubTourism({ regionCode, districtCode, baseYm }),
    },
    {
      service: "AreaTarDivService" as const,
      operation: diversity.operation,
      run: () =>
        getPolicyIndicator(diversity, {
          regionCode,
          districtCode,
          baseYm,
        }),
    },
    {
      service: "AreaTarDemDsService" as const,
      operation: demand.operation,
      run: () =>
        getPolicyIndicator(demand, {
          regionCode,
          districtCode,
          baseYm,
        }),
    },
    {
      service: "AreaTarResDemService" as const,
      operation: resource.operation,
      run: () =>
        getPolicyIndicator(resource, {
          regionCode,
          districtCode,
          baseYm,
        }),
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
  const errorCount = normalized.filter(
    (source) => source.status === "error",
  ).length;
  const overall =
    errorCount === 0 && normalized.length === 8
      ? "ready"
      : errorCount < normalized.length
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
