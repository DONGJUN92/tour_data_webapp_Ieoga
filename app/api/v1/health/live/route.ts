import { publicJsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return publicJsonResponse(
    {
      status: "live",
      service: "ieoga",
      scope: "nationwide",
      checkedAt: new Date().toISOString(),
    },
    { maxAge: 0 },
  );
}
