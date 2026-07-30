import { env as workerEnv } from "cloudflare:workers";

export function getRuntimeSecret(name: string): string | undefined {
  let value: unknown;

  try {
    value = (workerEnv as unknown as Record<string, unknown>)[name];
  } catch {
    value = undefined;
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  const processValue = process.env[name];
  return processValue?.trim() || undefined;
}
