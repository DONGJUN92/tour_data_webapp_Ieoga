export function strictFiniteNumber(
  value: unknown,
  options: {
    minimum?: number;
    maximum?: number;
    integer?: boolean;
  } = {},
): number | undefined {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (typeof value !== "number" && typeof value !== "string")
  ) {
    return undefined;
  }
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    (options.integer && !Number.isInteger(parsed)) ||
    (options.minimum !== undefined && parsed < options.minimum) ||
    (options.maximum !== undefined && parsed > options.maximum)
  ) {
    return undefined;
  }
  return parsed;
}

export function koreaLatitude(value: unknown): number | undefined {
  return strictFiniteNumber(value, { minimum: 32, maximum: 39.8 });
}

export function koreaLongitude(value: unknown): number | undefined {
  return strictFiniteNumber(value, { minimum: 124, maximum: 132 });
}
