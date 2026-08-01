import type { MetadataRoute } from "next";
import { SITE_URL } from "./site-config";

const PUBLIC_ROUTES = [
  "/",
  "/flow",
  "/policy",
  "/sources",
  "/privacy",
  "/terms",
  "/accessibility",
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return PUBLIC_ROUTES.map((route, index) => ({
    url: new URL(route, SITE_URL).toString(),
    lastModified: now,
    changeFrequency: index === 0 ? "daily" : "weekly",
    priority: index === 0 ? 1 : 0.8,
  }));
}
