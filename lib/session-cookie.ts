import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getOperationalSecret,
  releaseSecretTopologyStatus,
} from "@/lib/secret-policy";

const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const EMBED_SESSION_TTL_SECONDS = 10 * 60;
const EMBED_SESSION_SCOPE = "recover:open-window";

export type SessionSigningStatus = {
  available: boolean;
  releaseReady: boolean;
  source: "session_signing_key" | "unavailable";
  warning?: string;
};

/**
 * Returns only a stable, operator-provided secret. Deliberately do not create
 * an isolate-local random fallback: a cookie signed by one Worker isolate
 * must remain verifiable by every other isolate and after a deployment.
 */
export function getStableSessionSecret(): string | undefined {
  return getOperationalSecret("SESSION_SIGNING_KEY");
}

export function sessionSigningStatus(): SessionSigningStatus {
  const topology = releaseSecretTopologyStatus();
  const secretStatus = topology.secrets.SESSION_SIGNING_KEY;
  if (secretStatus.operationalReady) {
    return {
      available: true,
      releaseReady: secretStatus.operationalReady,
      source: "session_signing_key",
      warning: secretStatus.distinct
        ? undefined
        : `SESSION_SIGNING_KEY must not be reused as ${secretStatus.duplicateWith.join(
            ", ",
          )}.`,
    };
  }
  return {
    available: false,
    releaseReady: false,
    source: "unavailable",
    warning:
      "Session APIs are disabled until SESSION_SIGNING_KEY meets the published minimum length, placeholder, repetition, diversity, and separation policy.",
  };
}

function sessionSignature(sessionId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`ieoga-session-v1:${sessionId}`)
    .digest("base64url");
}

function embedSessionSignature(
  sessionId: string,
  expiresAtSeconds: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(
      `ieoga-embed-session-v1:${EMBED_SESSION_SCOPE}:${sessionId}:${expiresAtSeconds}`,
    )
    .digest("base64url");
}

export function createSessionCookieValue(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Invalid session identifier.");
  }
  const secret = getStableSessionSecret();
  if (!secret) {
    throw new Error("SESSION_SIGNING_KEY_UNAVAILABLE");
  }
  return `v1.${sessionId}.${sessionSignature(sessionId, secret)}`;
}

export function verifySessionCookieValue(
  value: string | undefined,
): string | undefined {
  const match = value?.match(
    /^v1\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/i,
  );
  if (!match) return undefined;
  const secret = getStableSessionSecret();
  if (!secret) return undefined;
  const expected = Buffer.from(
    sessionSignature(match[1], secret),
    "utf8",
  );
  const provided = Buffer.from(match[2], "utf8");
  return expected.length === provided.length &&
    timingSafeEqual(expected, provided)
    ? match[1]
    : undefined;
}

/**
 * A widget bearer lives only in iframe memory. It is deliberately distinct
 * from the first-party cookie and scoped to anonymous open-window recovery,
 * so Safari/Firefox cookie policy and legacy handling of CHIPS cannot create
 * either a compatibility failure or a global third-party session.
 */
export function createEmbedSessionToken(
  now = new Date(),
): { token: string; sessionId: string; expiresAt: string } {
  const secret = getStableSessionSecret();
  if (!secret) throw new Error("SESSION_SIGNING_KEY_UNAVAILABLE");
  const sessionId = crypto.randomUUID();
  const expiresAtSeconds =
    Math.floor(now.getTime() / 1_000) + EMBED_SESSION_TTL_SECONDS;
  const signature = embedSessionSignature(
    sessionId,
    expiresAtSeconds,
    secret,
  );
  return {
    token: `ev1.${sessionId}.${expiresAtSeconds}.${signature}`,
    sessionId,
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
  };
}

export function verifyEmbedSessionToken(
  value: string | null | undefined,
  now = new Date(),
): string | undefined {
  const match = value?.match(
    /^ev1\.([a-f0-9-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/i,
  );
  if (!match || !SESSION_ID_PATTERN.test(match[1])) return undefined;
  const secret = getStableSessionSecret();
  if (!secret) return undefined;
  const expiresAtSeconds = Number(match[2]);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= nowSeconds ||
    expiresAtSeconds > nowSeconds + EMBED_SESSION_TTL_SECONDS
  ) {
    return undefined;
  }
  const expected = Buffer.from(
    embedSessionSignature(match[1], expiresAtSeconds, secret),
    "utf8",
  );
  const provided = Buffer.from(match[3], "utf8");
  return expected.length === provided.length &&
    timingSafeEqual(expected, provided)
    ? match[1]
    : undefined;
}
