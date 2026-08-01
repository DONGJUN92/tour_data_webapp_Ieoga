import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getOperationalSecret,
  releaseSecretTopologyStatus,
} from "@/lib/secret-policy";

const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;

export type SessionSigningStatus = {
  available: boolean;
  releaseReady: boolean;
  source: "session_signing_key" | "ops_api_key_fallback" | "unavailable";
  warning?: string;
};

/**
 * Returns only a stable, operator-provided secret. Deliberately do not create
 * an isolate-local random fallback: a cookie signed by one Worker isolate
 * must remain verifiable by every other isolate and after a deployment.
 */
export function getStableSessionSecret(): string | undefined {
  return (
    getOperationalSecret("SESSION_SIGNING_KEY") ??
    getOperationalSecret("OPS_API_KEY")
  );
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
  if (topology.secrets.OPS_API_KEY.operationalReady) {
    return {
      available: true,
      releaseReady: false,
      source: "ops_api_key_fallback",
      warning:
        "OPS_API_KEY is being reused for session signing. Configure a distinct CSPRNG-generated SESSION_SIGNING_KEY that meets the published minimum policy before release.",
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
