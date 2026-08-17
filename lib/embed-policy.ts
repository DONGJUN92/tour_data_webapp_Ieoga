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
  /* 파트너 임베드를 **정식 출시**할 준비가 됐는지. 계약된 파트너의 정확한
     origin이 하나도 없으면 임베드를 열 수 없으므로 false가 맞다. 출시 증빙
     보고서(/api/v1/release/evidence)의 판정 기준으로만 쓴다. */
  releaseReady: boolean;
  /* 지금 외부 사이트에 실제로 열려 있는지. 위젯과 파트너 API 자체는 이 값과
     무관하게 동작하며, false는 "고장"이 아니라 "제휴처가 아직 없어 허용
     범위를 가장 좁게 두었다"는 뜻이다. 서비스 건강 상태(health/ready)는 이
     사실을 그대로 공개하되 degraded 판정에는 쓰지 않는다. */
  externalEmbeddingEnabled: boolean;
  externalAllowedOriginCount: number;
} {
  const origins = parseEmbedAllowedOrigins(
    getRuntimeSecret("EMBED_ALLOWED_ORIGINS"),
  );
  return {
    releaseReady: origins.length > 0,
    externalEmbeddingEnabled: origins.length > 0,
    externalAllowedOriginCount: origins.length,
  };
}
