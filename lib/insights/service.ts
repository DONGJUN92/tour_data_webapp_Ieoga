import {
  getHubTourism,
  getPolicyBundle,
} from "@/lib/kto/adapters";
import { previousCompleteMonth } from "@/lib/kto/registry";
import { KtoError, type KtoAudit } from "@/lib/kto/types";

export const POLICY_CALCULATION_VERSION = "policy-evidence-2026.07-v1";

function numberValue(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export type PolicyInsightPayload = {
  scope: "nationwide";
  areaCode: string;
  districtCode?: string;
  regionName: string;
  districtName: string;
  status: "live" | "degraded" | "data_gap";
  coverage: {
    available: number;
    expected: number;
    percent: number;
    meaning: string;
  };
  baseYm: string;
  metrics: Array<{
    key: string;
    label: string;
    officialName: string;
    value: number | null;
    valueRaw: string;
    source: string;
    operation: string;
    baseYm: string;
  }>;
  hubs: Array<{
    name: string;
    rank: number | null;
    category: string;
    latitude: number | null;
    longitude: number | null;
  }>;
  sourceLedger: KtoAudit[];
  warnings: string[];
  generatedAt: string;
  calculationVersion: string;
};

export async function buildPolicyInsight(params: {
  areaCode: string;
  districtCode?: string;
}): Promise<PolicyInsightPayload> {
  const baseYm = previousCompleteMonth();
  const [hubSettled, policySettled] = await Promise.allSettled([
    params.districtCode
      ? getHubTourism({
          regionCode: params.areaCode,
          districtCode: params.districtCode,
          baseYm,
        })
      : Promise.resolve(undefined),
    getPolicyBundle({
      regionCode: params.areaCode,
      districtCode: params.districtCode,
      startingBaseYm: baseYm,
    }),
  ]);

  const sourceLedger: KtoAudit[] = [];
  const warnings: string[] = [];
  let hubs: PolicyInsightPayload["hubs"] = [];
  let regionName = "";
  let districtName = "";

  if (hubSettled.status === "fulfilled" && hubSettled.value) {
    sourceLedger.push(hubSettled.value.audit);
    hubs = hubSettled.value.items.slice(0, 20).map((item) => ({
      name: String(item.hubTatsNm ?? ""),
      rank: numberValue(item.hubRank),
      category: String(item.hubCtgryMclsNm ?? ""),
      latitude: numberValue(item.mapY),
      longitude: numberValue(item.mapX),
    }));
    const first = hubSettled.value.items[0];
    regionName = String(first?.areaNm ?? "");
    districtName = String(first?.signguNm ?? "");
  } else if (params.districtCode) {
    const error =
      hubSettled.status === "rejected" ? hubSettled.reason : undefined;
    sourceLedger.push(
      error instanceof KtoError
        ? error.audit
        : {
            apiName: "LocgoHubTarService1",
            operation: "areaBasedList1",
            status: "error",
            latencyMs: 0,
            resultCount: 0,
            totalCount: 0,
            fieldsUsed: [],
            errorCode: "UNKNOWN",
          },
    );
    warnings.push("중심 관광지 정보를 확인하지 못했습니다.");
  } else {
    sourceLedger.push({
      apiName: "LocgoHubTarService1",
      operation: "areaBasedList1",
      status: "not_required",
      latencyMs: 0,
      resultCount: 0,
      totalCount: 0,
      fieldsUsed: [],
    });
    warnings.push(
      "기초지자체 중심 관광지는 시군구를 선택한 경우에만 조회합니다.",
    );
  }

  let policyBaseYm = baseYm;
  const metrics: PolicyInsightPayload["metrics"] = [];
  if (policySettled.status === "fulfilled") {
    policyBaseYm = policySettled.value.baseYm;
    for (const entry of policySettled.value.results) {
      sourceLedger.push(entry.audit);
      const rawValue = String(
        entry.item?.[entry.indicator.valueField] ?? "",
      );
      metrics.push({
        key: entry.indicator.code,
        label: entry.indicator.label,
        officialName: String(
          entry.item?.[entry.indicator.nameField] ??
            entry.indicator.label,
        ),
        value: numberValue(rawValue),
        valueRaw: rawValue,
        source: entry.indicator.service,
        operation: entry.indicator.operation,
        baseYm: String(entry.item?.baseYm ?? policyBaseYm),
      });
      if (!regionName) regionName = String(entry.item?.areaNm ?? "");
      if (!districtName) districtName = String(entry.item?.signguNm ?? "");
    }
  } else {
    warnings.push("정책 지표 묶음을 확인하지 못했습니다.");
  }

  const expectedEvidenceCount = params.districtCode ? 8 : 7;
  const availableEvidenceCount =
    (hubs.length ? 1 : 0) +
    metrics.filter((metric) => metric.value !== null).length;
  const coveragePercent = Math.round(
    (availableEvidenceCount / expectedEvidenceCount) * 100,
  );
  const status =
    availableEvidenceCount === 0
      ? "data_gap"
      : availableEvidenceCount === expectedEvidenceCount
        ? "live"
        : "degraded";

  return {
    scope: "nationwide",
    areaCode: params.areaCode,
    districtCode: params.districtCode,
    regionName,
    districtName,
    status,
    coverage: {
      available: availableEvidenceCount,
      expected: expectedEvidenceCount,
      percent: coveragePercent,
      meaning:
        params.districtCode
          ? "한국관광공사 중심관광지 1개 근거와 정책 세부지표 7개 중 실제 값이 확인된 비율입니다. 관광지 품질 점수가 아닙니다."
          : "한국관광공사 정책 세부지표 7개 중 실제 값이 확인된 비율입니다. 관광지 품질 점수가 아닙니다.",
    },
    baseYm: policyBaseYm,
    metrics,
    hubs,
    sourceLedger,
    warnings,
    generatedAt: new Date().toISOString(),
    calculationVersion: POLICY_CALCULATION_VERSION,
  };
}
