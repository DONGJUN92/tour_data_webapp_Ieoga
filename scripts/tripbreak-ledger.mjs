/**
 * K-TRIPBREAK 실전 중단 시나리오 원장 수집기.
 *
 * 플레이북의 표본 구성대로 지역·사건·이용자·시간대를 조합해 배포본에 실제
 * 복구를 실행하고, 각 실행의 request ID·응답시간·결과·오추천 여부를 원장으로
 * 남긴다. 여기서 만드는 것은 측정 결과이지 판정이 아니다. 임계값 판정은
 * 서버의 `POST /api/v1/ops/evidence`가 하고, 최종 승인은 제출자가 아닌 독립
 * 감사자가 한다.
 *
 * 실행 예:
 *   node scripts/tripbreak-ledger.mjs --base https://... --count 5 --out ledger.json
 *
 * 공사 API 실호출이 발생한다. 시나리오 1건이 복구 1회를 포함하므로 개발계정
 * 일일 한도를 고려해 --count 로 나눠 실행할 수 있다. 장소 조회는 권역마다
 * 한 번만 하고 재사용해 호출량을 줄인다.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const args = { base: "", count: 100, out: "", start: 0, delayMs: 400 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--base") {
      args.base = value;
      i += 1;
    } else if (key === "--count") {
      args.count = Number(value);
      i += 1;
    } else if (key === "--out") {
      args.out = value;
      i += 1;
    } else if (key === "--start") {
      args.start = Number(value);
      i += 1;
    } else if (key === "--delay") {
      args.delayMs = Number(value);
      i += 1;
    }
  }
  if (!args.base) throw new Error("--base <배포 URL> 이 필요합니다.");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.base.replace(/\/$/, "");

/* 플레이북의 권역 구성: 수도권, 부산, 다른 광역시, 일반 시군, 산간, 도서.
   각 권역에서 바꿀 수 있는 장소와 다음 고정 장소를 한 쌍씩 쓴다. */
const REGIONS = [
  { class: "수도권", area: "11", changeable: "서울역사박물관", fixed: "세종문화회관" },
  { class: "부산", area: "26", changeable: "부산근현대역사관", fixed: "부산시민회관" },
  { class: "광역시", area: "27", changeable: "대구근대역사관", fixed: "대구콘서트하우스" },
  { class: "광역시", area: "29", changeable: "국립광주박물관", fixed: "광주문화예술회관" },
  { class: "일반시군", area: "42", changeable: "강릉오죽헌", fixed: "강릉아트센터" },
  { class: "산간", area: "43", changeable: "청주고인쇄박물관", fixed: "청주예술의전당" },
  { class: "도서", area: "50", changeable: "제주민속자연사박물관", fixed: "제주아트센터" },
];

const INCIDENTS = ["rain", "crowd", "delay", "less_walk"];
const AUDIENCES = ["general", "stroller", "wheelchair", "senior"];
/* 오전·점심·오후·저녁. 중단 발생 시각의 한국 시간 기준 시(hour). */
const TIME_SLOTS = [9, 12, 15, 18];

const cookieJar = new Map();

function updateCookies(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const pair = entry.split(";")[0];
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

async function request(pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (cookieJar.size) {
    headers.set(
      "Cookie",
      [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    );
  }
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 40_000),
  });
  updateCookies(response);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { status: response.status, body, elapsedMs: Date.now() - startedAt };
}

/* 서버는 중단 시각이 서버 시각과 5분 이상 벌어지면 409 INCIDENT_TIME_SKEWED로
   거절한다. "지금 여행이 끊겼다"가 이 제품의 전제이므로 과거·미래 시각을
   임의로 넣어 시간대를 만들 수 없다. 따라서 시간대 분포는 실행 시각을 따르며,
   플레이북의 오전·점심·오후·저녁 4분할을 채우려면 실제로 그 시간대에 나눠
   실행해야 한다. 원장에는 실행된 실제 시각대를 기록한다. */
function koreaSchedule() {
  const now = new Date();
  const kstHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  const occurredAt = new Date(now.getTime() - 60_000).toISOString();
  return {
    occurredAt,
    disruptedAt: occurredAt,
    fixedAt: new Date(now.getTime() + 3 * 3_600_000).toISOString(),
    kstHour,
    timeSlot:
      kstHour < 11
        ? "오전"
        : kstHour < 14
          ? "점심"
          : kstHour < 17
            ? "오후"
            : "저녁",
  };
}

const placeCache = new Map();

async function findPlace(keyword) {
  if (placeCache.has(keyword)) return placeCache.get(keyword);
  const result = await request(
    `/api/v1/places/search?keyword=${encodeURIComponent(keyword)}&purpose=saved_stop&fallback=auto`,
    { timeoutMs: 40_000 },
  );
  const place = result.body?.places?.find(
    (entry) => entry.retention === "persistable",
  );
  placeCache.set(keyword, place ?? null);
  return place ?? null;
}

/**
 * 치명적 오추천 판정.
 *
 * 플레이북 기준: 폐업·휴무·목적 불일치·접근성 불일치, 그리고 고정 예약
 * 도착시간을 지키지 못하는 대안을 적용 가능으로 표시한 경우. 미확인 조건이
 * 화면에 드러난 후보는 오추천이 아니라 정상 동작이므로 제외한다.
 */
function criticalFalsePositives(option) {
  const reasons = [];
  const presentedAsApplicable =
    !option.confirmationRequired && !(option.evidenceGaps?.length > 0);
  if (!presentedAsApplicable) return reasons;

  if (option.purposePreservation?.status === "changed_visit_category") {
    reasons.push("목적 불일치를 적용 가능으로 표시");
  }
  if (option.availability?.status === "closed") {
    reasons.push("휴무·폐업을 적용 가능으로 표시");
  }
  const route = option.continuity?.route ?? option.route;
  if (route && route.status !== "routed") {
    reasons.push("경로 미확인 후보를 적용 가능으로 표시");
  }
  if (option.continuity && option.continuity.arrivalSafe === false) {
    reasons.push("고정 예약 도착시간 위반을 적용 가능으로 표시");
  }
  if (
    option.accessibility &&
    option.accessibility.status === "not_supported"
  ) {
    reasons.push("접근성 불일치를 적용 가능으로 표시");
  }
  return reasons;
}

function buildScenarios(total) {
  const scenarios = [];
  for (let index = 0; index < total; index += 1) {
    const region = REGIONS[index % REGIONS.length];
    const incident = INCIDENTS[index % INCIDENTS.length];
    const audience = AUDIENCES[Math.floor(index / 2) % AUDIENCES.length];
    const hour = TIME_SLOTS[Math.floor(index / 3) % TIME_SLOTS.length];
    scenarios.push({
      scenarioId: `tb-${String(index + 1).padStart(3, "0")}`,
      region,
      incident,
      audience,
      hour,
      indoorOnly: incident === "rain",
    });
  }
  return scenarios;
}

async function runScenario(scenario) {
  const schedule = koreaSchedule();
  const changeable = await findPlace(scenario.region.changeable);
  const fixed = await findPlace(scenario.region.fixed);
  const base = {
    scenario_id: scenario.scenarioId,
    run_at: new Date().toISOString(),
    deployment_url: baseUrl,
    region_class: scenario.region.class,
    area_code: scenario.region.area,
    incident: scenario.incident,
    audience: scenario.audience,
    has_fixed_appointment: true,
    time_slot: schedule.timeSlot,
    kst_hour: schedule.kstHour,
  };
  if (!changeable || !fixed) {
    return {
      ...base,
      result_status: "setup_failed",
      notes: "공식 장소 조회 실패",
      option_count: 0,
      response_ms: 0,
      critical_false_positive: 0,
    };
  }

  const itineraryId = randomUUID();
  const itinerary = {
    id: itineraryId,
    title: `K-TRIPBREAK ${scenario.scenarioId}`,
    timezone: "Asia/Seoul",
    audience: scenario.audience,
    nodes: [
      {
        id: "tb-changeable",
        sequence: 1,
        type: "visit",
        title: changeable.title,
        startAt: schedule.disruptedAt,
        durationMinutes: 50,
        locked: false,
        reservation: false,
        location: {
          latitude: changeable.latitude,
          longitude: changeable.longitude,
          label: changeable.address || changeable.title,
          areaCode: changeable.regionCode,
          sigunguCode: changeable.districtCode,
        },
      },
      {
        id: "tb-fixed",
        sequence: 2,
        type: "reservation",
        title: fixed.title,
        startAt: schedule.fixedAt,
        locked: true,
        reservation: true,
        location: {
          latitude: fixed.latitude,
          longitude: fixed.longitude,
          label: fixed.address || fixed.title,
          areaCode: fixed.regionCode,
          sigunguCode: fixed.districtCode,
        },
      },
    ],
  };

  const saved = await request("/api/v1/itineraries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itinerary, analyticsConsent: false }),
  });
  if (saved.status !== 201) {
    return {
      ...base,
      result_status: "setup_failed",
      notes: `일정 저장 실패 ${saved.status}`,
      option_count: 0,
      response_ms: 0,
      critical_false_positive: 0,
    };
  }

  const recovery = await request("/api/v1/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      origin: {
        latitude: changeable.latitude,
        longitude: changeable.longitude,
        label: changeable.title,
        areaCode: changeable.regionCode,
        sigunguCode: changeable.districtCode,
      },
      incident: scenario.incident,
      availableMinutes: 150,
      maxDistanceMeters: 5_000,
      audience: scenario.audience,
      indoorOnly: scenario.indoorOnly,
      radiusMeters: 5_000,
      safetyBufferMinutes: 15,
      minimumStayMinutes: 30,
      analyticsConsent: false,
      itinerary: {
        ...itinerary,
        occurredAt: schedule.occurredAt,
        disruptedNodeId: "tb-changeable",
        nextFixedNodeId: "tb-fixed",
      },
    }),
    timeoutMs: 40_000,
  });

  const body = recovery.body ?? {};
  const options = Array.isArray(body.options) ? body.options : [];
  const falsePositives = options.flatMap((option) =>
    criticalFalsePositives(option),
  );
  /* 후보 0개는 실패가 아니다. 서버 계약상 빈 결과는 rejectionSummary로
     스스로 원인을 말해야 하고, 그러지 못한 경우에만 실패로 센다. */
  const rejectionSummary = Array.isArray(body.rejectionSummary)
    ? body.rejectionSummary
    : [];
  const explainedEmpty = options.length === 0 && rejectionSummary.length > 0;

  return {
    ...base,
    request_id: body.requestId ?? null,
    rule_version: body.ruleVersion ?? null,
    http_status: recovery.status,
    result_status:
      recovery.status !== 200
        ? "error"
        : options.length > 0
          ? "options_presented"
          : explainedEmpty
            ? "explained_no_option"
            : "unexplained_no_option",
    option_count: options.length,
    response_ms: recovery.elapsedMs,
    persistence: body.persistence?.status ?? null,
    recovery_status: body.status ?? null,
    rejected_count: body.rejectedCount ?? 0,
    rejection_summary: rejectionSummary,
    source_ledger_count: Array.isArray(body.sourceLedger)
      ? body.sourceLedger.length
      : 0,
    counterfactual_offered: Boolean(body.counterfactual),
    purpose_preserved: options.filter(
      (option) =>
        option.purposePreservation &&
        option.purposePreservation.status !== "changed_visit_category",
    ).length,
    evidence_gap_visible: options.filter(
      (option) => (option.evidenceGaps?.length ?? 0) > 0,
    ).length,
    critical_false_positive: falsePositives.length,
    critical_false_positive_reasons: falsePositives,
    notes: recovery.status !== 200 ? JSON.stringify(body).slice(0, 200) : "",
  };
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

const scenarios = buildScenarios(args.count + args.start).slice(args.start);
const rows = [];
console.log(`대상 ${baseUrl} · 시나리오 ${scenarios.length}건`);

for (const [index, scenario] of scenarios.entries()) {
  const row = await runScenario(scenario);
  rows.push(row);
  console.log(
    `[${index + 1}/${scenarios.length}] ${row.scenario_id} ${row.region_class}/${row.incident}/${row.audience} → ${row.result_status} 후보 ${row.option_count} ${row.response_ms}ms 오추천 ${row.critical_false_positive}`,
  );
  if (args.delayMs) await new Promise((r) => setTimeout(r, args.delayMs));
}

const completed = rows.filter((row) => row.result_status !== "setup_failed");
const succeeded = completed.filter(
  (row) =>
    row.result_status === "options_presented" ||
    row.result_status === "explained_no_option",
);
const latencies = completed
  .map((row) => row.response_ms)
  .filter((value) => value > 0);
const presentedOptions = rows.reduce((sum, row) => sum + (row.option_count ?? 0), 0);
const preservedOptions = rows.reduce(
  (sum, row) => sum + (row.purpose_preserved ?? 0),
  0,
);

const summary = {
  deploymentUrl: baseUrl,
  measuredAt: new Date().toISOString(),
  sampleSize: rows.length,
  completedCount: completed.length,
  regionsCovered: [...new Set(rows.map((row) => row.area_code))],
  scenarioSuccessRate: completed.length
    ? Number(((succeeded.length / completed.length) * 100).toFixed(2))
    : 0,
  purposePreservationRate: presentedOptions
    ? Number(((preservedOptions / presentedOptions) * 100).toFixed(2))
    : 0,
  criticalFalsePositiveCount: rows.reduce(
    (sum, row) => sum + (row.critical_false_positive ?? 0),
    0,
  ),
  medianMs: percentile(latencies, 0.5),
  p95Ms: percentile(latencies, 0.95),
  optionsPresented: presentedOptions,
};

console.log("\n=== 집계 ===");
console.log(JSON.stringify(summary, null, 2));

if (args.out) {
  writeFileSync(args.out, JSON.stringify({ summary, rows }, null, 2), "utf8");
  console.log(`\n원장 저장: ${args.out}`);
}
