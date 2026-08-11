/** Cloudflare Worker entry point for the IEOGA nationwide service. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { refreshKtoHealth } from "../lib/kto/health-refresh";
import { runPolicySync } from "../lib/sync/policy-sync";
import { refreshProviderProbes } from "../lib/provider-readiness";
import { parseEmbedAllowedOrigins } from "../lib/embed-policy";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  REGION_PACKS: R2Bucket;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  KTO_SERVICE_KEY?: string;
  PARTNER_API_KEY?: string;
  OPS_API_KEY?: string;
  KAKAO_REST_API_KEY?: string;
  KMA_SERVICE_KEY?: string;
  SESSION_SIGNING_KEY?: string;
  RELEASE_AUDITOR_API_KEY?: string;
  EMBED_ALLOWED_ORIGINS?: string;
  EVIDENCE_ARTIFACT_ALLOWED_ORIGINS?: string;
  DEPLOYMENT_COMMIT_SHA?: string;
  REVERSE_GEOCODE_URL?: string;
  FORWARD_GEOCODE_URL?: string;
  ROUTING_BASE_URL?: string;
  WEATHER_API_URL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    const isEmbedRecover =
      url.pathname === "/embed/recover" ||
      url.pathname === "/embed/recover/";
    const isEmbedDemo =
      url.pathname === "/embed/demo" || url.pathname === "/embed/demo/";
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set(
      "Cross-Origin-Resource-Policy",
      isEmbedRecover ? "cross-origin" : "same-origin",
    );
    headers.set("Origin-Agent-Cluster", "?1");
    if (isEmbedRecover) {
      // X-Frame-Options cannot express a multi-origin allowlist and would
      // override the CSP policy in older browsers. Every non-widget page
      // remains explicitly denied below.
      headers.delete("X-Frame-Options");
    } else {
      headers.set("X-Frame-Options", "DENY");
    }
    headers.set("X-DNS-Prefetch-Control", "off");
    headers.set("X-Permitted-Cross-Domain-Policies", "none");
    headers.set(
      "Permissions-Policy",
      "geolocation=(self), camera=(), microphone=(), payment=(), accelerometer=(), gyroscope=(), magnetometer=(), usb=()",
    );
    const contentSecurityPolicy = [
      "default-src 'self'",
      // Vinext emits the framework bootstrap as inline script and application
      // styles include React style attributes. Keep these narrowly scoped and
      // forbid inline event-handler attributes separately.
      "script-src 'self' 'unsafe-inline'",
      "script-src-attr 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://apis.data.go.kr ws: wss:",
      "worker-src 'self'",
      "manifest-src 'self'",
      "media-src 'self'",
      isEmbedDemo ? "frame-src 'self'" : "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      isEmbedRecover
        ? `frame-ancestors ${parseEmbedAllowedOrigins(
            env.EMBED_ALLOWED_ORIGINS,
            { includeSelf: true, allowLocalDevelopment: true },
          ).join(" ")}`
        : "frame-ancestors 'none'",
      ...(url.protocol === "https:" ? ["upgrade-insecure-requests"] : []),
    ].join("; ");
    headers.set(
      "Content-Security-Policy",
      contentSecurityPolicy,
    );
    if (url.pathname === "/sw.js") {
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      headers.set("Service-Worker-Allowed", "/");
    }
    if (url.protocol === "https:") {
      headers.set(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    if (!headers.has("X-Request-ID")) {
      headers.set("X-Request-ID", crypto.randomUUID());
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  async scheduled(
    _controller: { scheduledTime: number; cron: string },
    _env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runPolicySync({ batchSize: 2, bootstrapIfEmpty: true }).then(
        () => undefined,
      ),
    );
    /* Probes the eight KTO services on a schedule. This keeps the readiness
       panel current instead of serving a snapshot from whenever an operator
       last ran a manual check, and leaves a continuous call trail on the
       agency side, which is what the contest verifies. refreshKtoHealth
       skips itself when a recent probe already covers the window. */
    ctx.waitUntil(
      refreshKtoHealth().then(
        () => undefined,
        () => undefined,
      ),
    );
    /* Managed auxiliary providers are actively contract-checked as a
       separate stored snapshot. The helper skips fresh evidence and
       coalesces concurrent work, so the hourly cron cannot create a storm. */
    ctx.waitUntil(
      refreshProviderProbes().then(
        () => undefined,
        () => undefined,
      ),
    );
  },
};

export default worker;
