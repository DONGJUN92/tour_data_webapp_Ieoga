import { getStableSessionSecret } from "@/lib/session-cookie";
import {
  koreaLatitude,
  koreaLongitude,
} from "@/lib/validation/numbers";

export type RecoveryApplicationSnapshot = {
  contentId: string;
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  generatedAt: string;
};

async function encryptionKey(): Promise<CryptoKey | undefined> {
  const secret = getStableSessionSecret();
  if (!secret) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `ieoga-recovery-application-snapshot-v1:${secret}`,
    ),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function encoded(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decoded(value: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(value, "base64url")).buffer;
}

function additionalData(runId: string, optionId: string): ArrayBuffer {
  return Uint8Array.from(
    new TextEncoder().encode(`${runId}:${optionId}`),
  ).buffer;
}

export async function encryptApplicationSnapshot(
  snapshot: RecoveryApplicationSnapshot,
  runId: string,
  optionId: string,
): Promise<string | undefined> {
  const key = await encryptionKey();
  if (!key) return undefined;
  const latitude = koreaLatitude(snapshot.latitude);
  const longitude = koreaLongitude(snapshot.longitude);
  if (
    latitude === undefined ||
    longitude === undefined ||
    !snapshot.contentId.trim() ||
    !snapshot.title.trim() ||
    !snapshot.address.trim() ||
    !Number.isFinite(Date.parse(snapshot.generatedAt))
  ) {
    return undefined;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ ...snapshot, latitude, longitude }),
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: additionalData(runId, optionId),
    },
    key,
    plaintext,
  );
  return JSON.stringify({
    version: 1,
    iv: encoded(iv),
    ciphertext: encoded(new Uint8Array(ciphertext)),
  });
}

export async function decryptApplicationSnapshot(
  encrypted: string | null | undefined,
  runId: string,
  optionId: string,
  expected: { contentId: string; title: string },
): Promise<RecoveryApplicationSnapshot | undefined> {
  if (!encrypted) return undefined;
  const key = await encryptionKey();
  if (!key) return undefined;
  try {
    const envelope = JSON.parse(encrypted) as {
      version?: unknown;
      iv?: unknown;
      ciphertext?: unknown;
    };
    if (
      envelope.version !== 1 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      return undefined;
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decoded(envelope.iv),
        additionalData: additionalData(runId, optionId),
      },
      key,
      decoded(envelope.ciphertext),
    );
    const parsed = JSON.parse(
      new TextDecoder().decode(plaintext),
    ) as Record<string, unknown>;
    const latitude = koreaLatitude(parsed.latitude);
    const longitude = koreaLongitude(parsed.longitude);
    if (
      parsed.contentId !== expected.contentId ||
      parsed.title !== expected.title ||
      typeof parsed.address !== "string" ||
      !parsed.address.trim() ||
      typeof parsed.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.generatedAt)) ||
      latitude === undefined ||
      longitude === undefined
    ) {
      return undefined;
    }
    return {
      contentId: expected.contentId,
      title: expected.title,
      address: parsed.address.trim(),
      latitude,
      longitude,
      generatedAt: parsed.generatedAt,
    };
  } catch {
    return undefined;
  }
}
