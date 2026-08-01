import { getStoredHealthSnapshot, persistHealth } from "@/lib/db/repository";
import { evaluateStoredKtoHealth } from "./health-snapshot";
import { checkAllKtoServices } from "./health";

/* The contest verifies that KTO OpenAPI calls actually reach the agency's
   servers during the development period, so the deployment probes all eight
   services on a schedule rather than only when an operator asks. The interval
   is a compromise: frequent enough to keep the readiness panel honest and to
   leave a continuous call trail, sparse enough not to eat the daily quota a
   development key allows. */
export const HEALTH_REFRESH_INTERVAL_MS = 3 * 3_600_000;

/* A stored probe older than this is reported as stale rather than current. */
export const HEALTH_STALE_AFTER_MS = 6 * 3_600_000;

/* Guards against several requests probing at once inside one isolate. */
let inFlight: Promise<unknown> | null = null;
let lastAttemptAt = 0;

export async function latestHealthCheckedAt(): Promise<string | undefined> {
  try {
    const snapshot = await getStoredHealthSnapshot();
    const evaluation = evaluateStoredKtoHealth(
      snapshot,
      Number.POSITIVE_INFINITY,
    );
    return evaluation.exactSourceSet && evaluation.staleSources.length === 0
      ? evaluation.oldestCheckedAt
      : undefined;
  } catch {
    return undefined;
  }
}

export function isOlderThan(
  checkedAt: string | undefined,
  maxAgeMs: number,
): boolean {
  if (!checkedAt) return true;
  const parsed = Date.parse(checkedAt);
  if (!Number.isFinite(parsed)) return true;
  const now = Date.now();
  return parsed > now + 5 * 60_000 || now - parsed > maxAgeMs;
}

/* Probes all eight services and stores the result. Returns false when the
   probe was skipped because a recent one already covers the window. */
export async function refreshKtoHealth(options?: {
  force?: boolean;
  minIntervalMs?: number;
}): Promise<boolean> {
  const minIntervalMs = options?.minIntervalMs ?? HEALTH_REFRESH_INTERVAL_MS;

  if (!options?.force) {
    const checkedAt = await latestHealthCheckedAt();
    if (!isOlderThan(checkedAt, minIntervalMs)) return false;
  }

  /* Coalesce concurrent callers onto one probe. */
  if (inFlight) {
    await inFlight.catch(() => undefined);
    return false;
  }
  /* Never re-probe faster than a tenth of the interval, even on errors, so a
     failing upstream cannot turn into a request-rate call storm. */
  if (!options?.force && Date.now() - lastAttemptAt < minIntervalMs / 10) {
    return false;
  }

  lastAttemptAt = Date.now();
  const task = (async () => {
    const result = await checkAllKtoServices();
    if (result.sources.length) {
      const persistence = await persistHealth(result.sources);
      if (!persistence.persisted) {
        throw new Error(
          `KTO_HEALTH_PERSISTENCE_FAILED:${persistence.reason}`,
        );
      }
    }
    return result;
  })();
  inFlight = task;
  try {
    await task;
    return true;
  } finally {
    inFlight = null;
  }
}
