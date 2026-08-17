import {
  getHubTourism,
  getPolicyBundle,
} from "@/lib/kto/adapters";
import { previousCompleteMonth } from "@/lib/kto/registry";
import { KtoError, type KtoAudit } from "@/lib/kto/types";
import { strictFiniteNumber } from "@/lib/validation/numbers";

export const POLICY_CALCULATION_VERSION = "policy-evidence-2026.07-v1";

function numberValue(
  value: unknown,
  options: {
    minimum?: number;
    maximum?: number;
    integer?: boolean;
  } = {},
): number | null {
  return strictFiniteNumber(value, options) ?? null;
}

export type PolicyInsightPayload = {
  scope: "nationwide";
  areaCode: string;
  districtCode?: string;
  regionName: string;
  districtName: string;
  /* `data_gap`은 "공사에 값이 없다"는 판정이고 `upstream_unavailable`은
     "우리가 조회하지 못했다"는 판정이다. 둘을 한 값으로 뭉치면 조회 실패를
     공사 데이터 공백으로 보고하게 된다. */
  status: "live" | "degraded" | "data_gap" | "upstream_unavailable";
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
      ? /* 중심 관광지의 기준월은 어댑터가 정한다. 직전 달을 못박으면 아직
           발행되지 않은 달로 고정되어, 정책팩을 매월 1일 이후에 만들 때마다
           중심 관광지가 0개인 팩이 저장됐다. 정책 지표는 자체 하강 루프가
           있어 살아남았기 때문에 같은 화면에서 지표만 채워지고 중심 관광지만
           비는 상태로 보였다. */
        getHubTourism({
          regionCode: params.areaCode,
          districtCode: params.districtCode,
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
      rank: numberValue(item.hubRank, {
        minimum: 1,
        maximum: 100_000,
        integer: true,
      }),
      category: String(item.hubCtgryMclsNm ?? ""),
      latitude: numberValue(item.mapY, {
        minimum: 32,
        maximum: 39.8,
      }),
      longitude: numberValue(item.mapX, {
        minimum: 124,
        maximum: 132,
      }),
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
            /* 클라이언트 밖에서 난 실패라 실제 호출 수를 알 수 없다. 적게
               세는 쪽으로 틀리면 예산이 넘치므로 한 건으로 본다. */
            upstreamCalls: 1,
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
      /* 부르지 않기로 한 호출이므로 예산을 쓰지 않았다. */
      upstreamCalls: 0,
    });
    /* 예전 문구는 "시군구를 선택한 경우에만 조회합니다"에서 끝나 사용자가
       다음에 무엇을 할 수 있는지 알 수 없었다. 이제 시군구 선택 화면이
       있으므로 그 행동을 문장에 담는다. */
    warnings.push(
      "시군구를 고르면 그 지역의 중심 관광지 지표까지 함께 확인할 수 있습니다.",
    );
  }

  let policyBaseYm = baseYm;
  /* 값이 비어 있는 이유가 우리 쪽 호출 실패인가. 이 값이 참일 때 화면이
     "공사 데이터 공백"이라고 말하면, 심사 주체인 공사에 있는 데이터를 없다고
     보고하는 셈이 된다. */
  let policyUpstreamFailed = false;
  const metrics: PolicyInsightPayload["metrics"] = [];
  if (policySettled.status === "fulfilled") {
    policyUpstreamFailed = policySettled.value.upstreamFailed;
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
        value: numberValue(rawValue, {
          minimum: 0,
          maximum: 1_000_000_000,
        }),
        valueRaw: rawValue,
        source: entry.indicator.service,
        operation: entry.indicator.operation,
        baseYm: String(entry.item?.baseYm ?? policyBaseYm),
      });
      if (!regionName) regionName = String(entry.item?.areaNm ?? "");
      if (!districtName) districtName = String(entry.item?.signguNm ?? "");
    }
  } else {
    policyUpstreamFailed = true;
    warnings.push("정책 지표 묶음을 확인하지 못했습니다.");
  }
  /* 중심 관광지 호출도 같은 기준으로 본다. */
  const hubUpstreamFailed = sourceLedger.some(
    (audit) =>
      audit.apiName === "LocgoHubTarService1" && audit.status === "error",
  );
  const upstreamFailed = policyUpstreamFailed || hubUpstreamFailed;
  if (upstreamFailed) {
    warnings.push(
      "일부 공식 지표를 조회하지 못했습니다. 값이 비어 있는 것은 이어가의 조회 실패 때문이며, 한국관광공사에 해당 데이터가 없다는 뜻이 아닙니다.",
    );
  }

  const expectedEvidenceCount = params.districtCode ? 8 : 7;
  const availableEvidenceCount =
    (hubs.length ? 1 : 0) +
    metrics.filter((metric) => metric.value !== null).length;
  const coveragePercent = Math.round(
    (availableEvidenceCount / expectedEvidenceCount) * 100,
  );
  /* `data_gap`은 "공사에 값이 없다"는 판정이므로, 우리 호출이 실패했을 때는
     쓰지 않는다. 이 구분이 없던 동안 화면은 조회 실패를 공사 데이터 공백으로
     표기하고 개선 미션까지 발행했다. */
  const status =
    upstreamFailed && availableEvidenceCount < expectedEvidenceCount
      ? "upstream_unavailable"
      : availableEvidenceCount === 0
        ? "data_gap"
        : availableEvidenceCount === expectedEvidenceCount
          ? "live"
          : "degraded";

  return {
    scope: "nationwide",
    areaCode: params.areaCode,
    districtCode: params.districtCode,
    regionName,
    /* 시도 단위 조회에서는 시군구 이름이 없다. 원천 필드가 `_`나 공백만
       담고 있는 경우가 있어 화면에 `대전광역시 _`로 찍혔다. */
    districtName: /[가-힣A-Za-z0-9]/.test(districtName) ? districtName : "",
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
