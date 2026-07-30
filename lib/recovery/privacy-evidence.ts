type JsonRecord = Record<string, unknown>;

const FORBIDDEN_LOCATION_KEYS = new Set([
  "coordinate",
  "coordinates",
  "encodedpolyline",
  "geometry",
  "lat",
  "latitude",
  "lng",
  "lon",
  "longitude",
  "mapx",
  "mapy",
  "pathcoordinates",
  "polyline",
  "routegeometry",
  "routepoints",
]);

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isCoordinatePair(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    finiteNumber(value[0]) !== undefined &&
    finiteNumber(value[1]) !== undefined
  );
}

function isCoordinateObject(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const keys = new Set(Object.keys(record).map(normalizedKey));
  return (
    (keys.has("latitude") && keys.has("longitude")) ||
    (keys.has("lat") && (keys.has("lon") || keys.has("lng"))) ||
    (keys.has("mapx") && keys.has("mapy"))
  );
}

function isCoordinateSequence(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) => isCoordinatePair(entry) || isCoordinateObject(entry),
    )
  );
}

export function toPrivacySafeRouteEvidence(
  value: unknown,
): Record<string, unknown> | null {
  const route = asRecord(value);
  if (!route) return null;

  const safe: Record<string, unknown> = {};
  for (const key of [
    "status",
    "provider",
    "reason",
    "calculatedAt",
    "attribution",
  ]) {
    const next = stringValue(route[key]);
    if (next !== undefined) safe[key] = next;
  }
  for (const key of ["distanceMeters", "durationMinutes"]) {
    const next = finiteNumber(route[key]);
    if (next !== undefined) safe[key] = next;
  }

  if (Array.isArray(route.legs)) {
    safe.legs = route.legs.flatMap((entry) => {
      const leg = asRecord(entry);
      if (!leg) return [];
      const distanceMeters = finiteNumber(leg.distanceMeters);
      const durationMinutes = finiteNumber(leg.durationMinutes);
      if (distanceMeters === undefined && durationMinutes === undefined) {
        return [];
      }
      return [
        {
          ...(distanceMeters === undefined ? {} : { distanceMeters }),
          ...(durationMinutes === undefined ? {} : { durationMinutes }),
        },
      ];
    });
  }

  return safe;
}

function sanitize(value: unknown, key?: string): unknown {
  if (key && FORBIDDEN_LOCATION_KEYS.has(normalizedKey(key))) {
    return undefined;
  }
  if (key && normalizedKey(key) === "routeevidence") {
    return toPrivacySafeRouteEvidence(value);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    if (isCoordinateSequence(value)) return undefined;
    return value.flatMap((entry) => {
      const next = sanitize(entry);
      return next === undefined ? [] : [next];
    });
  }

  const record = asRecord(value);
  if (!record) return null;
  const safe: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (FORBIDDEN_LOCATION_KEYS.has(normalizedKey(entryKey))) continue;
    if (isCoordinateSequence(entryValue)) continue;
    const next =
      normalizedKey(entryKey) === "routeevidence"
        ? toPrivacySafeRouteEvidence(entryValue)
        : sanitize(entryValue, entryKey);
    if (next !== undefined) safe[entryKey] = next;
  }
  return safe;
}

export function toPrivacySafeRecoveryEvidence(value: unknown): unknown {
  return sanitize(value) ?? null;
}

export function toPrivacySafeContinuityProof(value: unknown): unknown {
  return toPrivacySafeRecoveryEvidence(value);
}
