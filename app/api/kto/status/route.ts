import { jsonResponse } from "@/lib/http";
import { ktoServiceKeyConfigured } from "@/lib/kto/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = ktoServiceKeyConfigured();
  return jsonResponse(
    {
      mode: configured ? "configured" : "unavailable",
      configured,
      message: configured
        ? "한국관광공사 OpenAPI 서버 인증이 설정되어 있습니다. 공개 준비 상태는 저장된 운영 점검 결과를 사용하며, 8종 정밀 점검은 인증된 운영 API에서 실행합니다."
        : "한국관광공사 OpenAPI 서버 인증이 설정되지 않았습니다.",
    },
    { status: configured ? 200 : 503 },
  );
}
