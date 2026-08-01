const FALLBACK_SITE_URL =
  "https://ieoga-national-travel-resilience.sans5-poems-5045.workers.dev";

export function resolveSiteUrl(candidate: string | undefined): string {
  if (!candidate) return FALLBACK_SITE_URL;

  try {
    const url = new URL(candidate);
    const secure = url.protocol === "https:";
    const localHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!secure && !localHttp) {
      return FALLBACK_SITE_URL;
    }
    return url.origin;
  } catch {
    return FALLBACK_SITE_URL;
  }
}

export const SITE_URL = resolveSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
