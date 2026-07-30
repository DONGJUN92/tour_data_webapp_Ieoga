import { env as workerEnv } from "cloudflare:workers";
import {
  forwardGeocodeProviderConfig,
  reverseGeocodeProviderConfig,
  routingProviderConfig,
  weatherProviderConfig,
  type ProviderMode,
} from "@/lib/external-providers";

export type RuntimeBindingStatus = {
  d1: boolean;
  r2: boolean;
};

export type ExternalProviderStatus = {
  reverseGeocoding: ProviderMode;
  forwardGeocoding: ProviderMode;
  walkingRouting: ProviderMode;
  weather: ProviderMode;
};

export function runtimeBindingStatus(): RuntimeBindingStatus {
  try {
    const bindings = workerEnv as unknown as {
      DB?: D1Database;
      REGION_PACKS?: R2Bucket;
    };
    return {
      d1: Boolean(bindings.DB),
      r2: Boolean(bindings.REGION_PACKS),
    };
  } catch {
    return { d1: false, r2: false };
  }
}

export function externalProviderStatus(): ExternalProviderStatus {
  return {
    reverseGeocoding: reverseGeocodeProviderConfig().mode,
    forwardGeocoding: forwardGeocodeProviderConfig().mode,
    walkingRouting: routingProviderConfig().mode,
    weather: weatherProviderConfig().mode,
  };
}
