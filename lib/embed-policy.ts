import { getRuntimeSecret } from "@/lib/runtime-env";

const LOCAL_DEVELOPMENT_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export function parseEmbedAllowedOrigins(
  value: string | undefined,
  options: { includeSelf?: boolean; allowLocalDevelopment?: boolean } = {},
): string[] {
  const origins = new Set<string>(options.includeSelf ? ["'self'"] : []);
  for (const candidate of value?.split(",") ?? []) {
    const normalized = candidate.trim();
    if (!normalized || normalized.includes("*")) continue;
    try {
      const url = new URL(normalized);
      const secure = url.protocol === "https:";
      const localDevelopment =
        options.allowLocalDevelopment === true &&
        url.protocol === "http:" &&
        LOCAL_DEVELOPMENT_HOSTS.has(url.hostname);
      if (
        (secure || localDevelopment) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      ) {
        origins.add(url.origin);
      }
    } catch {
      // Invalid entries are ignored rather than widening the policy.
    }
  }
  return [...origins];
}

export function embedPolicyStatus(): {
  releaseReady: boolean;
  externalAllowedOriginCount: number;
} {
  const origins = parseEmbedAllowedOrigins(
    getRuntimeSecret("EMBED_ALLOWED_ORIGINS"),
  );
  return {
    releaseReady: origins.length > 0,
    externalAllowedOriginCount: origins.length,
  };
}
