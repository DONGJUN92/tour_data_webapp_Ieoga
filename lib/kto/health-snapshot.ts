import { KTO_SERVICES } from "@/lib/kto/registry";
import type { KtoServiceName } from "@/lib/kto/types";

export const REQUIRED_KTO_HEALTH_SOURCES = Object.keys(
  KTO_SERVICES,
) as KtoServiceName[];

type HealthSource = {
  apiName: string;
  status: string;
  checkedAt: string;
};

export function hasExactKtoHealthSourceSet(
  sources: Array<{ apiName: string }>,
): boolean {
  if (sources.length !== REQUIRED_KTO_HEALTH_SOURCES.length) return false;
  const names = new Set(sources.map((source) => source.apiName));
  return (
    names.size === REQUIRED_KTO_HEALTH_SOURCES.length &&
    REQUIRED_KTO_HEALTH_SOURCES.every((name) => names.has(name))
  );
}

export type StoredKtoHealthEvaluation = {
  expectedSourceCount: number;
  sourceCount: number;
  requiredPresentCount: number;
  exactSourceSet: boolean;
  missingSources: KtoServiceName[];
  unexpectedSources: string[];
  duplicateSources: string[];
  staleSources: KtoServiceName[];
  errorSources: KtoServiceName[];
  invalidStatusSources: KtoServiceName[];
  oldestCheckedAt?: string;
  latestCheckedAt?: string;
  allFresh: boolean;
  ready: boolean;
};

export function evaluateStoredKtoHealth(
  sources: HealthSource[],
  maxAgeMs: number,
  now = Date.now(),
): StoredKtoHealthEvaluation {
  const expected = new Set<string>(REQUIRED_KTO_HEALTH_SOURCES);
  const grouped = new Map<string, HealthSource[]>();
  for (const source of sources) {
    const rows = grouped.get(source.apiName) ?? [];
    rows.push(source);
    grouped.set(source.apiName, rows);
  }
  const missingSources = REQUIRED_KTO_HEALTH_SOURCES.filter(
    (name) => !grouped.has(name),
  );
  const unexpectedSources = [...grouped.keys()].filter(
    (name) => !expected.has(name),
  );
  const duplicateSources = [...grouped.entries()]
    .filter(([, rows]) => rows.length !== 1)
    .map(([name]) => name);
  const requiredRows = REQUIRED_KTO_HEALTH_SOURCES.flatMap(
    (name) => grouped.get(name) ?? [],
  );
  const parsedTimes = requiredRows
    .map((source) => Date.parse(source.checkedAt))
    .filter(Number.isFinite);
  const exactSourceSet =
    missingSources.length === 0 &&
    unexpectedSources.length === 0 &&
    duplicateSources.length === 0 &&
    sources.length === REQUIRED_KTO_HEALTH_SOURCES.length;
  const staleSources = REQUIRED_KTO_HEALTH_SOURCES.filter((name) => {
    const row = grouped.get(name)?.[0];
    if (!row) return false;
    const checkedAt = Date.parse(row.checkedAt);
    return (
      !Number.isFinite(checkedAt) ||
      now - checkedAt > maxAgeMs ||
      checkedAt > now + 5 * 60_000
    );
  });
  const errorSources = REQUIRED_KTO_HEALTH_SOURCES.filter(
    (name) => grouped.get(name)?.[0]?.status === "error",
  );
  const invalidStatusSources = REQUIRED_KTO_HEALTH_SOURCES.filter((name) => {
    const row = grouped.get(name)?.[0];
    if (!row) return false;
    return (
      row.status !== "live" &&
      row.status !== "empty" &&
      row.status !== "error"
    );
  });
  const allRequiredTimestampsValid =
    requiredRows.length === REQUIRED_KTO_HEALTH_SOURCES.length &&
    parsedTimes.length === REQUIRED_KTO_HEALTH_SOURCES.length;
  const oldestCheckedAt = allRequiredTimestampsValid
    ? new Date(Math.min(...parsedTimes)).toISOString()
    : undefined;
  const latestCheckedAt = parsedTimes.length
    ? new Date(Math.max(...parsedTimes)).toISOString()
    : undefined;
  const allFresh = exactSourceSet && staleSources.length === 0;
  return {
    expectedSourceCount: REQUIRED_KTO_HEALTH_SOURCES.length,
    sourceCount: sources.length,
    requiredPresentCount:
      REQUIRED_KTO_HEALTH_SOURCES.length - missingSources.length,
    exactSourceSet,
    missingSources,
    unexpectedSources,
    duplicateSources,
    staleSources,
    errorSources,
    invalidStatusSources,
    oldestCheckedAt,
    latestCheckedAt,
    allFresh,
    ready:
      allFresh &&
      errorSources.length === 0 &&
      invalidStatusSources.length === 0,
  };
}
