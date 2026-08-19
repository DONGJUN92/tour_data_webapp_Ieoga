"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { HALF_HOUR_TIMES, todayInKorea } from "../product-app-model";
import { ManualLocationPicker, type ManualPlace } from "../ManualLocationPicker";
import { CoursePreview } from "./CoursePreview";
import { withParticle } from "@/lib/text/korean";
import styles from "./plan.module.css";

type Step = "date" | "start" | "appointment" | "confirm";
type Language = "ko" | "en";
type PlanEntry = { place: ManualPlace; time: string; locked: boolean };

type CourseStopSummary = {
  contentId: string;
  contentTypeId: string;
  title: string;
  address?: string;
  latitude: number;
  longitude: number;
  imageUrl?: string;
  operatingHours?: string;
  restDate?: string;
  contact?: string;
  legMeters?: number;
  legMode?: "walk" | "transit" | "car";
};

type CourseSummary = {
  source: "official" | "assembled";
  contentId?: string;
  title: string;
  imageUrl?: string;
  stops: CourseStopSummary[];
};

/* 코스 지점에 시각을 붙인다.
 *
 * 계약은 시작 시각이 순서대로 **엄격히 증가**할 것을 요구하고, 화면의 시각은 30분
 * 격자를 쓴다. 오늘 날짜면 지금보다 넉넉히 뒤에서 시작해야 하고(과거 시각은 저장
 * 자체가 거절된다), 다른 날이면 오전 11시부터 시작한다.
 *
 * 마지막 지점을 잠근다. 그것이 여행자가 "꼭 지킬 곳"이 되고, 나중에 일정이 틀어졌을
 * 때 복구가 지켜야 할 다음 고정 일정이 된다 — 전부 잠그면 바꿀 수 있는 곳이 없어져
 * "한 곳만 바꿔 약속을 지킨다"가 성립하지 않는다. */
/* 지점 간격 120분 = 체류 60분 + 이동 여유 60분.
 *
 * 이 숫자는 재서 정했다. 코스로 만든 일정이 나중에 실제로 복구되는지 같은 지점
 * 목록으로 세 값을 돌려 봤다(2026-08-19, 종로 하루 코스, 도보):
 *   · 90분  → 대안 0곳  (`NEXT_FIXED_APPOINTMENT_AT_RISK` 27건)
 *   · 120분 → 대안 19곳
 *   · 150분 → 대안 19곳 (더 늘어나지 않는다)
 *
 * 90분은 체류 60분을 빼면 이동 여유가 30분뿐이라, 한 곳을 바꾼 뒤 다음 지점까지
 * 걸어갈 수 없다. 등록은 되지만 정작 복구가 되지 않으니 코스를 일정으로 삼는
 * 목적을 이루지 못한다. 150분은 하루를 늘리기만 하고 얻는 것이 없어 120분을 쓴다. */
const COURSE_STOP_GAP_MINUTES = 120;
const COURSE_MAX_STOPS = 5;

function courseStartMinutes(date: string, now = Date.now()): number {
  const todayKst = todayInKorea();
  if (date !== todayKst) return 11 * 60;
  /* 지금 시각(한국)을 분으로. 90분 뒤로 밀고 30분 격자에 올린다. */
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const nowMinutes = Number(value.hour) * 60 + Number(value.minute);
  return Math.ceil((nowMinutes + COURSE_STOP_GAP_MINUTES) / 30) * 30;
}

function minutesToClock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function coursePlanEntries(
  stops: CourseStopSummary[],
  date: string,
  now = Date.now(),
): PlanEntry[] {
  const used = stops.slice(0, COURSE_MAX_STOPS);
  const first = courseStartMinutes(date, now);
  const entries: PlanEntry[] = [];
  used.forEach((stop, index) => {
    const minutes = first + index * COURSE_STOP_GAP_MINUTES;
    /* 자정을 넘기면 그 지점부터는 넣지 않는다. 날짜를 넘긴 시각을 같은 날짜에
       붙이면 시각이 거꾸로 가고, 계약이 그것을 거절한다. */
    if (minutes >= 24 * 60) return;
    entries.push({
      place: {
        title: stop.title,
        latitude: stop.latitude,
        longitude: stop.longitude,
        address: stop.address,
        sourceLabel: "한국관광공사 국문 관광정보",
      },
      time: minutesToClock(minutes),
      locked: false,
    });
  });
  if (entries.length) entries[entries.length - 1].locked = true;
  return entries;
}

const STEPS: Step[] = ["date", "start", "appointment", "confirm"];
const START_TIME = "09:00";
const MIN_LEAD_MINUTES = 15;

function appointmentAt(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

function formatPlanDate(date: string, language: Language): string {
  const parsed = new Date(`${date}T12:00:00+09:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(parsed);
}

function firstPlanError(
  date: string,
  plan: PlanEntry[],
  language: Language,
  now = Date.now(),
): string {
  const t = (ko: string, en: string) => (language === "en" ? en : ko);
  if (!date || date < todayInKorea()) {
    return t(
      "오늘보다 이전 날짜에는 새 여행을 등록할 수 없습니다.",
      "A new trip cannot be scheduled in the past.",
    );
  }
  let previous = START_TIME;
  for (const entry of plan) {
    if (entry.time <= previous) {
      return t(
        `일정 시각은 앞 일정(${previous})보다 늦어야 합니다.`,
        `Each stop must be later than the previous stop (${previous}).`,
      );
    }
    if (
      date === todayInKorea() &&
      appointmentAt(date, entry.time) < now + MIN_LEAD_MINUTES * 60_000
    ) {
      return t(
        "오늘 일정은 현재 시각보다 최소 15분 뒤로 잡아 주세요.",
        "For today, schedule each new stop at least 15 minutes from now.",
      );
    }
    previous = entry.time;
  }
  if (!plan.some((entry) => entry.locked)) {
    return t(
      "이어가가 반드시 지킬 예약 또는 고정 일정을 하나 이상 잠가 주세요.",
      "Lock at least one booking or fixed appointment for IEOGA to protect.",
    );
  }
  return "";
}

export function PlanWizard() {
  const [language, setLanguage] = useState<Language>("ko");
  const [step, setStep] = useState<Step>("date");
  const [date, setDate] = useState(todayInKorea());
  const [start, setStart] = useState<ManualPlace | null>(null);
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [pending, setPending] = useState<ManualPlace | null>(null);
  const [pendingTime, setPendingTime] = useState("14:00");
  const [pendingLocked, setPendingLocked] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState("");
  /* 추천코스를 받아 일정으로 삼는 경로. 꼭 지킬 약속이 아직 없어서 무엇을 할지부터
     정하고 싶은 여행자를 위한 자리다. 새 단계를 만들지 않고 이 단계 안에서 처리한다
     — 단계 배열은 진행 표시와 뒤로가기 규칙이 함께 걸려 있다. */
  const [courseState, setCourseState] = useState<
    "idle" | "loading" | "ready" | "empty"
  >("idle");
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [courseNotes, setCourseNotes] = useState<string[]>([]);
  const [courseArea, setCourseArea] = useState<{
    regionCode: string;
    districtCode: string;
    regionName: string;
    districtName: string;
  } | null>(null);
  const [courseApplying, setCourseApplying] = useState("");
  /* 펼쳐서 동선과 지점을 보고 있는 코스. 화살표로 넘겨 본 뒤 일정으로 삼는다. */
  const [openedCourse, setOpenedCourse] = useState<CourseSummary | null>(null);
  const index = STEPS.indexOf(step);
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);
  const times = useMemo(() => HALF_HOUR_TIMES, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title =
      language === "en" ? "Register a trip · IEOGA" : "여행 일정 등록 · 이어가";
    return () => {
      document.documentElement.lang = "ko";
    };
  }, [language]);

  function clearError() {
    if (error) setError("");
  }

  function dateIsValid(): boolean {
    if (date && date >= todayInKorea()) return true;
    setError(
      tr(
        "오늘 또는 이후의 여행 날짜를 선택해 주세요.",
        "Choose today or a future travel date.",
      ),
    );
    return false;
  }

  function validatePending(): string {
    if (!pending) {
      return tr("먼저 장소를 선택해 주세요.", "Select a place first.");
    }
    const previousTime = plan.at(-1)?.time ?? START_TIME;
    if (pendingTime <= previousTime) {
      return tr(
        `이 장소는 앞 일정(${previousTime})보다 늦은 시각으로 잡아 주세요.`,
        `Schedule this stop later than the previous stop (${previousTime}).`,
      );
    }
    if (
      date === todayInKorea() &&
      appointmentAt(date, pendingTime) <
        Date.now() + MIN_LEAD_MINUTES * 60_000
    ) {
      return tr(
        "오늘 일정은 현재 시각보다 최소 15분 뒤로 잡아 주세요.",
        "For today, choose a time at least 15 minutes from now.",
      );
    }
    return "";
  }

  function addPending() {
    clearError();
    const validation = validatePending();
    if (validation || !pending) {
      setError(validation);
      return;
    }
    setPlan((previous) => [
      ...previous,
      { place: pending, time: pendingTime, locked: pendingLocked },
    ]);
    setPending(null);
    setPendingLocked(true);
    setPendingTime((current) => {
      const currentIndex = times.findIndex((time) => time.value === current);
      return times[Math.min(currentIndex + 2, times.length - 1)]?.value ?? current;
    });
  }

  async function requestCourses(area: {
    regionCode: string;
    districtCode: string;
    regionName: string;
    districtName: string;
  }) {
    clearError();
    /* 이 화면에서 시·군·구를 고르지 않았어도 앞 단계에서 이미 출발지를 정했다.
       그 위치의 행정구역으로 대신 조회한다 — 같은 것을 두 번 묻지 않는다.

       둘 다 없을 때만 시·도를 청한다. 검색으로 고른 장소는 행정구역 코드를 함께
       주지 않는 경우가 있어서, 그때는 물어보는 것이 추측하는 것보다 낫다. */
    const regionCode = area.regionCode || start?.areaCode || "";
    const districtCode = area.districtCode || start?.sigunguCode || "";
    if (!regionCode) {
      setError(
        tr(
          "코스를 추천하려면 시·도를 골라 주세요. 앞 단계에서 고른 장소에 행정구역 정보가 없었습니다.",
          "Choose a province to get courses — the place you picked earlier carried no administrative region.",
        ),
      );
      return;
    }
    const resolved = { ...area, regionCode, districtCode };
    setCourseArea(resolved);
    setCourseState("loading");
    setCourses([]);
    setCourseNotes([]);
    setOpenedCourse(null);
    try {
      const response = await fetch("/api/v1/courses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          regionCode,
          districtCode: districtCode || undefined,
          regionName: area.districtName || area.regionName || undefined,
          /* 앞 단계에서 정한 위치를 함께 보낸다. 서버가 그 지점에서 가장 가까운
             장소를 코스 기준점으로 삼으므로, 같은 시·군·구 안에서도 실제로 가까운
             곳들로 엮인다. */
          latitude: start?.latitude,
          longitude: start?.longitude,
          originLabel: start?.title,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        status?: string;
        courses?: CourseSummary[];
        notes?: string[];
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setCourseState("idle");
        setError(
          payload?.error?.message ??
            tr(
              "추천코스를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
              "Could not load courses. Please try again shortly.",
            ),
        );
        return;
      }
      const list = payload?.courses ?? [];
      setCourses(list);
      setCourseNotes(payload?.notes ?? []);
      setCourseState(list.length ? "ready" : "empty");
    } catch {
      setCourseState("idle");
      setError(
        tr(
          "추천코스를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
          "Could not load courses. Please try again shortly.",
        ),
      );
    }
  }

  /* 공식 코스는 목록 응답에 지점이 없다. 미리 보여 주려면 한 번 더 받아야 한다. */
  async function openCourse(course: CourseSummary) {
    clearError();
    if (course.stops.length > 0) {
      setOpenedCourse(course);
      return;
    }
    setCourseApplying(course.contentId ?? course.title);
    try {
      const response = await fetch("/api/v1/courses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          regionCode: courseArea?.regionCode,
          districtCode: courseArea?.districtCode,
          contentId: course.contentId,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        course?: { stops?: CourseStopSummary[] };
        notes?: string[];
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setError(
          payload?.error?.message ??
            tr(
              "코스의 지점 정보를 불러오지 못했습니다.",
              "Could not load the course stops.",
            ),
        );
        return;
      }
      if (payload?.notes?.length) setCourseNotes(payload.notes);
      setOpenedCourse({ ...course, stops: payload?.course?.stops ?? [] });
    } finally {
      setCourseApplying("");
    }
  }

  /* 고른 코스를 일정으로 삼는다. */
  async function applyCourse(course: CourseSummary) {
    clearError();
    setCourseApplying(course.contentId ?? course.title);
    try {
      let stops = course.stops;
      if (!stops.length && course.source === "official" && course.contentId) {
        const response = await fetch("/api/v1/courses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            regionCode: courseArea?.regionCode,
            districtCode: courseArea?.districtCode,
            contentId: course.contentId,
          }),
        });
        const payload = (await response.json().catch(() => null)) as {
          course?: { stops?: CourseStopSummary[] };
          notes?: string[];
          error?: { message?: string };
        } | null;
        if (!response.ok) {
          setError(
            payload?.error?.message ??
              tr(
                "코스의 지점 정보를 불러오지 못했습니다.",
                "Could not load the course stops.",
              ),
          );
          return;
        }
        stops = payload?.course?.stops ?? [];
        if (payload?.notes?.length) setCourseNotes(payload.notes);
      }
      const entries = coursePlanEntries(stops, date);
      if (entries.length < 1) {
        setError(
          tr(
            "이 코스에서 일정으로 옮길 수 있는 지점을 찾지 못했습니다.",
            "No usable stops were found in this course.",
          ),
        );
        return;
      }
      /* 출발지가 아직 없으면 코스의 첫 지점을 출발지로 쓴다. 코스만 받고 들어온
         여행자에게 출발지를 또 묻지 않는다. */
      if (!start) {
        setStart(entries[0].place);
        setPlan(entries.slice(1));
      } else {
        setPlan(entries);
      }
      setCourseState("idle");
      setCourses([]);
      setPending(null);
      setStep("confirm");
    } finally {
      setCourseApplying("");
    }
  }

  function review() {
    clearError();
    const validation = firstPlanError(date, plan, language);
    if (validation) {
      setError(validation);
      return;
    }
    setStep("confirm");
  }

  function back() {
    clearError();
    if (step === "appointment") {
      if (pending) {
        setPending(null);
        setPendingLocked(true);
        return;
      }
      if (plan.length) {
        setPlan((previous) => previous.slice(0, -1));
        return;
      }
    }
    if (index <= 0) return;
    const target = STEPS[index - 1];
    setPending(null);
    setPendingLocked(true);
    setStep(target);
  }

  async function save() {
    if (!start) return;
    const validation = firstPlanError(date, plan, language);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const nodes = [
        {
          id: "start",
          sequence: 0,
          type: "visit" as const,
          title: start.title,
          startAt: `${date}T${START_TIME}:00+09:00`,
          locked: false,
          reservation: false,
          location: {
            latitude: start.latitude,
            longitude: start.longitude,
            label: start.title,
          },
        },
        ...plan.map((entry, entryIndex) => ({
          id: `stop-${entryIndex + 1}`,
          sequence: entryIndex + 1,
          type: entry.locked ? ("reservation" as const) : ("visit" as const),
          title: entry.place.title,
          startAt: `${date}T${entry.time}:00+09:00`,
          locked: entry.locked,
          reservation: entry.locked,
          location: {
            latitude: entry.place.latitude,
            longitude: entry.place.longitude,
            label: entry.place.title,
          },
        })),
      ];
      const response = await fetch("/api/v1/itineraries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itinerary: {
            title: language === "en" ? "My trip" : "오늘의 여행",
            timezone: "Asia/Seoul",
            audience: "general",
            nodes,
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        itinerary?: { id?: string };
        requestId?: string;
        error?: { requestId?: string };
      } | null;
      if (!response.ok) {
        const requestId =
          response.headers.get("x-request-id") ||
          payload?.requestId ||
          payload?.error?.requestId;
        throw new Error(
          `${tr("일정을 저장하지 못했습니다.", "Could not save the itinerary.")}${
            requestId ? ` · ${tr("요청 ID", "Request ID")} ${requestId}` : ""
          }`,
        );
      }
      setSavedId(payload?.itinerary?.id ?? "saved");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : tr("일정을 저장하지 못했습니다.", "Could not save the itinerary."),
      );
    } finally {
      setSaving(false);
    }
  }

  const languageToggle = (
    <div className={styles.language} role="group" aria-label={tr("언어 선택", "Language")}>
      <button
        type="button"
        className={language === "ko" ? styles.languageOn : ""}
        aria-pressed={language === "ko"}
        onClick={() => setLanguage("ko")}
      >
        KO
      </button>
      <button
        type="button"
        className={language === "en" ? styles.languageOn : ""}
        aria-pressed={language === "en"}
        onClick={() => setLanguage("en")}
      >
        EN
      </button>
    </div>
  );

  if (savedId) {
    return (
      <div className={styles.done}>
        {languageToggle}
        <div className={styles.doneMark} aria-hidden="true">✓</div>
        <h1>{tr("일정을 등록했어요", "Your trip is registered")}</h1>
        <p className={styles.summaryDate}>{formatPlanDate(date, language)}</p>
        <ol className={styles.route}>
          <li>
            <span>1</span>
            <div><strong>{start?.title}</strong><em>{START_TIME}</em></div>
          </li>
          {plan.map((entry, entryIndex) => (
            <li key={`${entry.place.title}-${entryIndex}`}>
              <span>{entryIndex + 2}</span>
              <div>
                <strong>{entry.place.title}</strong>
                <em>{entry.time}{entry.locked ? tr(" · 잠금", " · locked") : ""}</em>
              </div>
            </li>
          ))}
        </ol>
        <Link className={styles.primary} href="/app">
          {tr("일정이 틀어지면 여기서 복구하기", "Recover this trip if plans change")}
        </Link>
        <Link className={styles.secondary} href="/">
          {tr("처음으로", "Home")}
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.wizard}>
      <header className={styles.head}>
        {index > 0 ? (
          <button type="button" className={styles.back} onClick={back}>
            ←<span className="sr-only">{tr("이전 단계", "Previous step")}</span>
          </button>
        ) : (
          <Link className={styles.back} href="/">
            ←<span className="sr-only">{tr("처음으로", "Home")}</span>
          </Link>
        )}
        <div
          className={styles.progress}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={index + 1}
          aria-label={tr(
            `${STEPS.length}단계 중 ${index + 1}단계`,
            `Step ${index + 1} of ${STEPS.length}`,
          )}
        >
          {STEPS.map((entry, entryIndex) => (
            <span
              key={entry}
              className={entryIndex <= index ? styles.barDone : styles.bar}
            />
          ))}
        </div>
        {languageToggle}
      </header>

      {step === "date" && (
        <section className={styles.step}>
          <h1>{tr("언제 가세요?", "When are you travelling?")}</h1>
          <label className={styles.label} htmlFor="plan-date">
            {tr("여행 날짜", "Travel date")}
          </label>
          <input
            id="plan-date"
            type="date"
            className={styles.field}
            value={date}
            min={todayInKorea()}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setDate(event.target.value);
              clearError();
            }}
          />
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              clearError();
              if (dateIsValid()) setStep("start");
            }}
          >
            {tr("다음", "Next")}
          </button>
        </section>
      )}

      {step === "start" && (
        <section className={styles.step}>
          <h1>{tr("어디서 시작하세요?", "Where does the trip start?")}</h1>
          <ManualLocationPicker
            language={language}
            purpose="saved_stop"
            heading={tr("출발지 찾기", "Find the starting point")}
            areaHint={tr(
              "시·군·구만 골라도 됩니다. 선택한 지역의 대표 지점을 사용합니다.",
              "You may choose only a city or district; its representative point will be used.",
            )}
            onPick={(place) => {
              setStart(place);
              clearError();
              setStep("appointment");
            }}
          />
        </section>
      )}

      {step === "appointment" && (
        <section className={styles.step}>
          <h1>
            {plan.length === 0
              ? tr("꼭 지킬 약속이 있나요?", "What appointment must be protected?")
              : tr(
                  `${plan.length + 2}번째로 갈 곳이 있나요?`,
                  `Add stop ${plan.length + 2}?`,
                )}
          </h1>
          <p className={styles.summaryDate}>{formatPlanDate(date, language)}</p>

          {pending && (
            <div className={styles.pendingBlock}>
              <p className={styles.picked}>{pending.title}</p>
              <label className={styles.label} htmlFor="plan-appointment-time">
                {tr("몇 시 약속인가요?", "What time is it?")}
              </label>
              <select
                id="plan-appointment-time"
                className={styles.field}
                value={pendingTime}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setPendingTime(event.target.value);
                  clearError();
                }}
              >
                {times.map((time) => (
                  <option key={time.value} value={time.value}>
                    {language === "en" ? time.value : time.label}
                  </option>
                ))}
              </select>
              <label className={styles.lockRow}>
                <input
                  type="checkbox"
                  checked={pendingLocked}
                  onChange={(event) => {
                    setPendingLocked(event.target.checked);
                    clearError();
                  }}
                />
                <span>
                  <strong>{tr("이 일정은 못 바꿔요", "Protect this appointment")}</strong>
                  <em>
                    {tr(
                      "예약·공연·교통편처럼 시간을 옮길 수 없는 일정",
                      "A booking, performance or transport departure that cannot move",
                    )}
                  </em>
                </span>
              </label>
              {error && <p className={styles.error} role="alert">{error}</p>}
              <button type="button" className={styles.primary} onClick={addPending}>
                {tr("이 곳을 일정에 담기", "Add this stop")}
              </button>
            </div>
          )}

          {plan.length > 0 && (
            <ol className={styles.route}>
              {plan.map((entry, entryIndex) => (
                <li key={`${entry.place.title}-${entryIndex}`}>
                  <span>{entryIndex + 2}</span>
                  <div>
                    <strong>{entry.place.title}</strong>
                    <em>{entry.time}{entry.locked ? tr(" · 잠금", " · locked") : ""}</em>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {!pending && (
            <ManualLocationPicker
              language={language}
              purpose="saved_stop"
              heading={tr(
                plan.length === 0 ? "약속 장소 찾기" : "갈 곳 찾기",
                plan.length === 0 ? "Find the appointment place" : "Find another stop",
              )}
              areaHint={tr(
                "시·군·구만 골라도 됩니다. 선택한 지역의 대표 지점을 사용합니다.",
                "You may choose only a city or district; its representative point will be used.",
              )}
              onPick={(place) => {
                setPending(place);
                clearError();
              }}
              /* 꼭 지킬 약속이 아직 없어 무엇을 할지부터 정하고 싶은 경우.
                 추천코스는 행정구역 단위로 제공되므로, 이 고르개에서 고른
                 시·군·구가 그대로 조회 조건이 된다. */
              onCourseRequest={plan.length === 0 ? requestCourses : undefined}
              courseBusy={courseState === "loading"}
            />
          )}

          {courseState === "empty" && (
            <div className={styles.courseBlock} role="status">
              <p className={styles.courseEmpty}>
                {tr(
                  "이 지역에서 엮을 수 있는 코스를 공사 관광정보에서 찾지 못했습니다. 없는 코스를 만들어 드리지는 않습니다.",
                  "We found nothing in the official tourism data to build a course from here. We do not invent one.",
                )}
              </p>
            </div>
          )}

          {courseState === "ready" && courses.length > 0 && (
            <div className={styles.courseBlock}>
              <h2 className={styles.courseHeading}>
                {courses[0].source === "official"
                  ? tr(
                      `${courseArea?.districtName ?? ""} 공사 공식 추천코스`,
                      "Official KTO travel courses",
                    )
                  : tr("이어가가 엮은 하루 코스", "A day course we assembled")}
              </h2>
              {/* 출처를 섞지 않는다. 공사가 만든 코스와 우리가 엮은 코스는 서로
                  다른 물건이고, 그 차이를 화면이 말하지 않으면 여행자는 둘 다
                  공사 코스로 읽는다. */}
              <p className={styles.courseSource}>
                {courses[0].source === "official"
                  ? tr(
                      "한국관광공사가 등록한 추천코스입니다.",
                      "Registered by the Korea Tourism Organization.",
                    )
                  : tr(
                      "지점은 모두 한국관광공사 관광정보이고, 엮은 순서는 이어가가 정했습니다. 공사 공식 추천코스가 아닙니다.",
                      "Every stop is official KTO tourism data; the order is ours. This is not an official KTO course.",
                    )}
              </p>
              {courseArea && !courseArea.districtName && start && (
                /* 어디를 기준으로 찾았는지 밝힌다. 여행자가 이 화면에서 지역을
                   고르지 않았으므로, 앞 단계의 장소를 썼다는 사실을 알려야 한다. */
                <p className={styles.courseNote}>
                  {tr(
                    `앞 단계에서 고른 ${withParticle(start.title, "을/를")} 기준으로 찾았습니다.`,
                    `Searched around ${start.title}, the place you picked earlier.`,
                  )}
                </p>
              )}
              {courseNotes.map((note) => (
                <p key={note} className={styles.courseNote}>
                  {note}
                </p>
              ))}
              {/* 예전에는 "구봉산 → 오백돈 → 장태산…"처럼 화살표로 이은 한 줄만
                  보여 줬다. 여행자는 그 이름들이 어디에 있고 몇 시에 여는지, 어떻게
                  가는지를 알 수 없어 고를 근거가 없었다. 동선 지도 한 장과 지점마다
                  사진·운영시간·이동 수단을 담은 카드로 바꾸고, 대안 목록과 같은
                  캐러셀로 넘겨 본다 — 조작을 새로 배우지 않게 한다. */}
              {!openedCourse && (
                <ul className={styles.courseList}>
                  {courses.map((course) => (
                    <li key={course.contentId ?? course.title}>
                      <strong>{course.title}</strong>
                      {course.stops.length > 0 && (
                        <em>
                          {tr(
                            `${course.stops.length}곳`,
                            `${course.stops.length} stops`,
                          )}
                        </em>
                      )}
                      <button
                        type="button"
                        className={styles.primary}
                        data-testid="plan-open-course"
                        disabled={Boolean(courseApplying)}
                        onClick={() => void openCourse(course)}
                      >
                        {courseApplying === (course.contentId ?? course.title)
                          ? tr("불러오는 중…", "Loading…")
                          : tr("코스 살펴보기", "Look at this course")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {openedCourse && (
                <div className={styles.coursePreview}>
                  <h3 className={styles.courseTitle}>{openedCourse.title}</h3>
                  <CoursePreview
                    course={openedCourse}
                    language={language}
                    onApply={() => void applyCourse(openedCourse)}
                    applying={Boolean(courseApplying)}
                    onBack={() => setOpenedCourse(null)}
                    canGoBack={courses.length > 1}
                  />
                </div>
              )}
              <p className={styles.courseNote}>
                {tr(
                  "지점별 머무는 시간은 공사가 제공하지 않아 이어가가 2시간 간격으로 잡았습니다. 일정이 틀어졌을 때 한 곳을 바꿔도 다음 지점에 닿을 수 있는 간격이에요. 다음 화면에서 시각을 고칠 수 있어요.",
                  "The agency does not publish per-stop durations, so we spaced them two hours apart — enough slack to swap one stop and still reach the next. You can adjust the times next.",
                )}
              </p>
            </div>
          )}

          {error && !pending && <p className={styles.error} role="alert">{error}</p>}
          {plan.length > 0 && !pending && (
            <div className={styles.stepActions}>
              <button type="button" className={styles.primary} onClick={review}>
                {tr("일정 검토하기", "Review the itinerary")}
              </button>
            </div>
          )}
        </section>
      )}

      {step === "confirm" && (
        <section className={styles.step}>
          <h1>{tr("이렇게 등록할까요?", "Register this itinerary?")}</h1>
          <p className={styles.summaryDate}>{formatPlanDate(date, language)}</p>
          <ol className={styles.route}>
            <li>
              <span>1</span>
              <div><strong>{start?.title}</strong><em>{START_TIME}</em></div>
            </li>
            {plan.map((entry, entryIndex) => (
              <li key={`${entry.place.title}-${entryIndex}`}>
                <span>{entryIndex + 2}</span>
                <div>
                  <strong>{entry.place.title}</strong>
                  <em>{entry.time}{entry.locked ? tr(" · 잠금", " · locked") : ""}</em>
                </div>
              </li>
            ))}
          </ol>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button
            type="button"
            className={styles.primary}
            onClick={() => void save()}
            disabled={saving || !start || !plan.length}
          >
            {saving
              ? tr("등록하는 중…", "Saving…")
              : tr("이 일정으로 등록", "Register this itinerary")}
          </button>
        </section>
      )}
    </div>
  );
}
