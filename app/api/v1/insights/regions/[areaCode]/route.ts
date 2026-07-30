import { NextRequest } from "next/server";
import {
  persistPolicySnapshot,
  persistRegionPackMetadata,
} from "@/lib/db/repository";
import { jsonResponse } from "@/lib/http";
import { buildPolicyInsight } from "@/lib/insights/service";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import {
  getRegionPack,
  putRegionPack,
} from "@/lib/storage/region-packs";
import { isOfficialRegionCode } from "@/lib/kto/registry";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ areaCode: string }> },
) {
  const { areaCode } = await context.params;
  const districtCode =
    request.nextUrl.searchParams.get("sigunguCode") || undefined;
  if (
    !isOfficialRegionCode(areaCode) ||
    (districtCode && !/^\d{5}$/.test(districtCode))
  ) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_REGION_SCOPE",
          message: "시도·시군구 코드를 확인해주세요.",
        },
      },
      { status: 400 },
    );
  }

  const rate = allowRequest(requestRateKey(request, "insights"), 10);
  if (!rate.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "정책 데이터 조회가 많습니다. 잠시 후 다시 시도해주세요.",
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return response;
  }

  const pack = await getRegionPack({ areaCode, districtCode });
  if (pack) {
    return jsonResponse({
      ...pack,
      delivery: "versioned_region_pack",
    });
  }

  const payload = await buildPolicyInsight({ areaCode, districtCode });
  const regionPack = await putRegionPack(payload);
  await persistPolicySnapshot({
    regionCode: areaCode,
    districtCode,
    baseMonth: payload.baseYm,
    status: payload.status,
    coveragePercent: payload.coverage.percent,
    metrics: {
      metricCount: payload.metrics.length,
      hubCount: payload.hubs.length,
    },
    sourceLedger: payload.sourceLedger,
    calculationVersion: payload.calculationVersion,
    r2Key: regionPack.stored ? regionPack.objectKey : undefined,
  });
  if (regionPack.stored) {
    await persistRegionPackMetadata({
      regionCode: areaCode,
      districtCode,
      baseMonth: payload.baseYm,
      calculationVersion: payload.calculationVersion,
      objectKey: regionPack.objectKey,
      checksum: regionPack.checksum,
      status: payload.status,
      coveragePercent: payload.coverage.percent,
      sourceUpdatedAt: payload.generatedAt,
    });
  } else {
    payload.warnings.push(
      "버전된 전국 지역팩 저장소가 일시적으로 비활성화되어 현재 응답은 OpenAPI 직접 조회로 제공됩니다.",
    );
  }
  return jsonResponse({
    ...payload,
    delivery: regionPack.stored ? "live_and_persisted" : "live_direct",
  });
}
