export function timeBudgetBucket(minutes: number): string {
  if (minutes <= 30) return "15-30m";
  if (minutes <= 60) return "31-60m";
  if (minutes <= 120) return "61-120m";
  if (minutes <= 360) return "121-360m";
  if (minutes <= 720) return "361-720m";
  return "721-1440m";
}

export function distanceLimitBucket(meters: number): string {
  if (meters <= 1_000) return "0-1km";
  if (meters <= 3_000) return "1-3km";
  if (meters <= 5_000) return "3-5km";
  if (meters <= 10_000) return "5-10km";
  return "10-20km";
}

export function expiresInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
