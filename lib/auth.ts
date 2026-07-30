import { getRuntimeSecret } from "./runtime-env";

async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(result);
}

export async function secureEqual(
  provided: string,
  expected: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([digest(provided), digest(expected)]);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

type AuthenticationResult =
  | "authorized"
  | "missing_configuration"
  | "unauthorized";

async function authenticateBearer(
  authorization: string | null,
  secretName: "PARTNER_API_KEY" | "OPS_API_KEY",
): Promise<AuthenticationResult> {
  const expected = getRuntimeSecret(secretName);
  if (!expected) return "missing_configuration";
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return "unauthorized";
  return (await secureEqual(match[1].trim(), expected))
    ? "authorized"
    : "unauthorized";
}

export function authenticatePartner(
  authorization: string | null,
): Promise<AuthenticationResult> {
  return authenticateBearer(authorization, "PARTNER_API_KEY");
}

export function authenticateOps(
  authorization: string | null,
): Promise<AuthenticationResult> {
  return authenticateBearer(authorization, "OPS_API_KEY");
}
