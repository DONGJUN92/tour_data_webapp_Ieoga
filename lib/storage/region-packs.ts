import { env as workerEnv } from "cloudflare:workers";
import type { PolicyInsightPayload } from "@/lib/insights/service";

type RegionPackResult =
  | { stored: true; objectKey: string; checksum: string }
  | { stored: false };

function bucket(): R2Bucket | undefined {
  try {
    return (workerEnv as unknown as { REGION_PACKS?: R2Bucket }).REGION_PACKS;
  } catch {
    return undefined;
  }
}

function scopeKey(areaCode: string, districtCode?: string): string {
  return `${areaCode}/${districtCode ?? "_all"}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function putRegionPack(
  payload: PolicyInsightPayload,
): Promise<RegionPackResult> {
  const target = bucket();
  if (!target) return { stored: false };

  const body = JSON.stringify(payload);
  const checksum = await sha256(body);
  const scope = scopeKey(payload.areaCode, payload.districtCode);
  const objectKey = `region-packs/${payload.calculationVersion}/${payload.baseYm}/${scope}/${checksum}.json`;
  const activeKey = `region-packs/active/${scope}.json`;
  const options: R2PutOptions = {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      checksum,
      baseYm: payload.baseYm,
      generatedAt: payload.generatedAt,
    },
  };

  await target.put(objectKey, body, options);
  await target.put(activeKey, body, options);
  return { stored: true, objectKey, checksum };
}

export async function getRegionPack(params: {
  areaCode: string;
  districtCode?: string;
  maxAgeHours?: number;
}): Promise<PolicyInsightPayload | null> {
  const target = bucket();
  if (!target) return null;
  const object = await target.get(
    `region-packs/active/${scopeKey(params.areaCode, params.districtCode)}.json`,
  );
  if (!object) return null;

  const payload = (await object.json()) as PolicyInsightPayload;
  if (
    payload.areaCode !== params.areaCode ||
    (payload.districtCode ?? undefined) !==
      (params.districtCode ?? undefined)
  ) {
    return null;
  }
  const age =
    Date.now() - new Date(payload.generatedAt).getTime();
  const maxAgeMs = (params.maxAgeHours ?? 168) * 3_600_000;
  if (!Number.isFinite(age) || age > maxAgeMs) return null;
  return payload;
}
