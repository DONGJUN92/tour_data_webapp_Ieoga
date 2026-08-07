"use client";

/* 일정 등록 마법사. **한 화면에 한 질문**만 둔다.
 *
 * 예전에는 등록 입구가 복구 탭 안의 긴 폼 하나뿐이었다. 시각 드롭다운과 장소
 * 검색과 잠금 체크박스가 한꺼번에 펼쳐져 있어서, 처음 온 사람은 무엇부터
 * 채워야 하는지 알 수 없었다. 여기서는 한 번에 하나만 묻고, 답하면 다음으로
 * 넘어간다. 언제든 뒤로 갈 수 있고, 위 막대가 어디까지 왔는지 보여 준다. */

import Link from "next/link";
import { useMemo, useState } from "react";
import { HALF_HOUR_TIMES, todayInKorea } from "../product-app-model";
import { ManualLocationPicker, type ManualPlace } from "../ManualLocationPicker";
import styles from "./plan.module.css";

type Step = "date" | "start" | "appointment" | "confirm";

const STEPS: Step[] = ["date", "start", "appointment", "confirm"];

export function PlanWizard() {
  const [step, setStep] = useState<Step>("date");
  const [date, setDate] = useState(todayInKorea());
  const [start, setStart] = useState<ManualPlace | null>(null);
  /* 약속은 하나로 끝나지 않는다. 여행자가 원하는 만큼 이어 붙인다. */
  const [plan, setPlan] = useState<
    Array<{ place: ManualPlace; time: string; locked: boolean }>
  >([]);
  const [pending, setPending] = useState<ManualPlace | null>(null);
  const [pendingTime, setPendingTime] = useState("14:00");
  /* 잠금은 담을 때 고른다. 마지막을 자동으로 잠갔더니, 마지막 여행지가
     예약이 아닌 경우에도 복구가 손댈 수 없는 곳이 되었다. 기본값은 켜 둔다 —
     대개 마지막이 지켜야 할 약속이고, 잠긴 곳이 하나도 없으면 이 앱이 지킬
     대상 자체가 사라진다. */
  const [pendingLocked, setPendingLocked] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState("");

  const index = STEPS.indexOf(step);
  /* 뒤로 가면 **그 단계의 입력을 비운다.** 남겨 두었더니 다른 곳을 고르러
     돌아가도 이전 값이 그대로 보여, 무엇이 선택된 상태인지 알 수 없었다. */
  /* 뒤로 가기는 **한 걸음씩** 되돌린다.
   *
   * 예전에는 단계 전체를 비웠다. 그래서 세 번째 여행지를 넣다가 뒤로 가면
   * 출발지가 통째로 사라지고 담아 둔 목록만 남았다 — 화면에 1번이 없고 2번만
   * 남은 것이 이 때문이다. 담는 중이던 것을 먼저 취소하고, 담은 것이 있으면
   * 마지막 하나만 빼며, 둘 다 없을 때에만 이전 단계로 나간다. */
  const back = () => {
    setError("");
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
    /* 나가는 단계의 입력만 비운다. 앞 단계의 답은 건드리지 않는다. */
    if (target === "start") setStart(null);
    setStep(target);
  };
  const forward = () => {
    setError("");
    if (index < STEPS.length - 1) setStep(STEPS[index + 1]);
  };

  /* 약속 시각은 30분 단위로만 고른다. 여행자는 분 단위로 계획하지 않고,
     `type="time"`은 모바일에서 휠 두 개를 띄운다. */
  const times = useMemo(() => HALF_HOUR_TIMES, []);

  async function save() {
    if (!start || !plan.length) return;
    setSaving(true);
    setError("");
    try {
      /* 마지막 약속만 잠근다. 중간 정류지까지 잠그면 복구가 바꿀 수 있는 곳이
         하나도 남지 않아, 일정이 틀어져도 이 앱이 할 수 있는 일이 없어진다. */
      const nodes = [
        {
          id: "start",
          sequence: 0,
          type: "visit" as const,
          title: start.title,
          startAt: `${date}T09:00:00+09:00`,
          locked: false,
          reservation: false,
          location: {
            latitude: start.latitude,
            longitude: start.longitude,
            label: start.title,
          },
        },
        ...plan.map((entry, entryIndex) => {
          return {
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
          };
        }),
      ];
      const response = await fetch("/api/v1/itineraries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itinerary: {
            title: "오늘의 여행",
            timezone: "Asia/Seoul",
            audience: "general",
            nodes,
          },
        }),
      });
      const payload = (await response.json()) as {
        itinerary?: { id?: string };
        error?: { message?: string; cause?: string };
      };
      if (!response.ok) {
        throw new Error(
          [payload.error?.message, payload.error?.cause]
            .filter(Boolean)
            .join(" ") || "일정을 저장하지 못했습니다.",
        );
      }
      setSavedId(payload.itinerary?.id ?? "saved");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "일정을 저장하지 못했습니다.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (savedId) {
    return (
      <div className={styles.done}>
        <div className={styles.doneMark} aria-hidden="true">
          ✓
        </div>
        <h1>일정을 등록했어요</h1>
        <ol className={styles.route}>
          <li>
            <span>1</span>
            <strong>{start?.title}</strong>
          </li>
          {plan.map((entry, entryIndex) => (
            <li key={`${entry.place.title}-${entryIndex}`}>
              <span>{entryIndex + 2}</span>
              <div>
                <strong>{entry.place.title}</strong>
                <em>{entry.time}</em>
              </div>
            </li>
          ))}
        </ol>
        <Link className={styles.primary} href="/app">
          일정이 틀어지면 여기서 복구하기
        </Link>
        <Link className={styles.secondary} href="/">
          처음으로
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.wizard}>
      <header className={styles.head}>
        {index > 0 ? (
          <button type="button" className={styles.back} onClick={back}>
            ←<span className="sr-only">이전 단계</span>
          </button>
        ) : (
          <Link className={styles.back} href="/">
            ←<span className="sr-only">처음으로</span>
          </Link>
        )}
        <div
          className={styles.progress}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={index + 1}
          aria-label={`${STEPS.length}단계 중 ${index + 1}단계`}
        >
          {STEPS.map((entry, entryIndex) => (
            <span
              key={entry}
              className={entryIndex <= index ? styles.barDone : styles.bar}
            />
          ))}
        </div>
      </header>

      {step === "date" && (
        <section className={styles.step}>
          <h1>언제 가세요?</h1>
          <input
            type="date"
            className={styles.field}
            value={date}
            onChange={(event) => setDate(event.target.value)}
            aria-label="여행 날짜"
          />
          <button type="button" className={styles.primary} onClick={forward}>
            다음
          </button>
        </section>
      )}

      {step === "start" && (
        <section className={styles.step}>
          <h1>어디서 시작하세요?</h1>
          <ManualLocationPicker
            language="ko"
            heading="출발지 찾기"
            areaHint="시·군·구만 골라도 됩니다. 그 지역을 대표하는 지점에서 출발하는 것으로 잡습니다."
            onPick={(place) => {
              setStart(place);
              forward();
            }}
          />
          {start && <p className={styles.picked}>{start.title}</p>}
        </section>
      )}

      {step === "appointment" && (
        <section className={styles.step}>
          <h1>
            {plan.length === 0
              ? "꼭 지킬 약속이 있나요?"
              : /* 1번은 출발지이므로 `plan[0]`이 이미 2번이다. `+1`이면
                   목록에 2번이 보이는데 제목은 `2번째로 갈 곳`이라고 물어
                   화면 안에서 번호가 어긋났다. */
                `${plan.length + 2}번째로 갈 곳이 있나요?`}
          </h1>

          {/* 고른 곳과 시각을 **검색창보다 위에** 둔다. 아래에 두었더니 장소를
              고른 뒤에도 화면 끝에 가려 다음에 무엇을 해야 하는지 보이지
              않았다. */}
          {pending && (
            <div className={styles.pendingBlock}>
              <p className={styles.picked}>{pending.title}</p>
              <label className={styles.label} htmlFor="plan-appointment-time">
                몇 시 약속인가요?
              </label>
              <select
                id="plan-appointment-time"
                className={styles.field}
                value={pendingTime}
                onChange={(event) => setPendingTime(event.target.value)}
              >
                {times.map((time) => (
                  <option key={time.value} value={time.value}>
                    {time.label}
                  </option>
                ))}
              </select>
              <label className={styles.lockRow}>
                <input
                  type="checkbox"
                  checked={pendingLocked}
                  onChange={(event) => setPendingLocked(event.target.checked)}
                />
                <span>
                  <strong>이 일정은 못 바꿔요</strong>
                  <em>예약·공연·교통편처럼 시간을 옮길 수 없는 곳</em>
                </span>
              </label>
              <button
                type="button"
                className={styles.primary}
                onClick={() => {
                  setPlan((previous) => [
                    ...previous,
                    { place: pending, time: pendingTime, locked: pendingLocked },
                  ]);
                  setPending(null);
                  setPendingLocked(true);
                }}
              >
                이 곳을 일정에 담기
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
                    <em>
                      {entry.time}
                      {entry.locked ? " · 못 바꿈" : ""}
                    </em>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {!pending && (
            <ManualLocationPicker
              language="ko"
              heading={
                plan.length === 0 ? "약속 장소 찾기" : "갈 곳 찾기"
              }
              areaHint="시·군·구만 골라도 됩니다. 그 지역을 대표하는 지점을 기준으로 잡습니다."
              onPick={(place) => setPending(place)}
            />
          )}

          {plan.length > 0 && !pending && (
            <div className={styles.stepActions}>
              <button
                type="button"
                className={styles.primary}
                onClick={forward}
              >
                더 이상 등록할 여행지가 없어요
              </button>
            </div>
          )}
        </section>
      )}

      {step === "confirm" && (
        <section className={styles.step}>
          <h1>이렇게 등록할까요?</h1>
          <ol className={styles.route}>
            <li>
              <span>1</span>
              <strong>{start?.title}</strong>
            </li>
            {plan.map((entry, entryIndex) => (
              <li key={`${entry.place.title}-${entryIndex}`}>
                <span>{entryIndex + 2}</span>
                <div>
                  <strong>{entry.place.title}</strong>
                  <em>
                    {entry.time}
                    {entry.locked ? " · 못 바꿈" : ""}
                  </em>
                </div>
              </li>
            ))}
          </ol>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className={styles.primary}
            onClick={save}
            disabled={saving || !start || !plan.length}
          >
            {saving ? "등록하는 중…" : "이 일정으로 등록"}
          </button>
        </section>
      )}
    </div>
  );
}
