"use client";

import { useEffect, useState } from "react";
import styles from "./offline.module.css";

type OfflineStep = {
  title: string;
  role?: string;
  scheduledAt?: string;
  estimatedArrivalAt?: string;
  durationMinutes?: number;
  locked?: boolean;
  reservation?: boolean;
  status?: string;
};

type OfflineSnapshot = {
  kind: "journey" | "itinerary" | "recovery";
  savedAt: string;
  expiresAt: string;
  title?: string;
  status?: string;
  steps?: OfflineStep[];
  options?: Array<{
    title: string;
    travelToMinutes?: number;
    stayMinutes?: number;
    returnMinutes?: number;
    leftoverMinutes?: number;
    confirmationRequired?: boolean;
  }>;
};

type OfflineSnapshotBundle = {
  schemaVersion: 2;
  snapshots: Partial<
    Record<OfflineSnapshot["kind"], OfflineSnapshot>
  >;
};

function formatTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function OfflineJourneySnapshot() {
  const [bundle, setBundle] = useState<OfflineSnapshotBundle | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/__offline/journey-snapshot", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as OfflineSnapshotBundle;
      })
      .then(setBundle)
      .catch(() => setBundle(null))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) {
    return <p className={styles.snapshotStatus}>저장된 안전 사본을 확인 중입니다.</p>;
  }
  const snapshots = bundle
    ? Object.values(bundle.snapshots).filter(
        (value): value is OfflineSnapshot => Boolean(value),
      )
    : [];
  if (snapshots.length === 0) {
    return (
      <p className={styles.snapshotStatus}>
        이 기기에 저장된 일정 사본이 없습니다. 온라인에서 일정이나 복구 결과를
        한 번 확인하면 좌표와 주소를 제외한 사본을 최대 24시간 보관합니다.
      </p>
    );
  }

  return (
    <section className={styles.snapshot} aria-labelledby="offline-snapshot-title">
      <h2 id="offline-snapshot-title">마지막으로 확인한 안전 사본</h2>
      <p className={styles.snapshotMeta}>
        위치 좌표, 주소, 세션 식별자는 저장하지 않았습니다.
      </p>
      {snapshots.map((snapshot) => (
        <div className={styles.snapshotGroup} key={snapshot.kind}>
          <h3>
            {snapshot.kind === "journey"
              ? "진행 중인 복구 일정"
              : snapshot.kind === "itinerary"
                ? "등록한 원래 일정"
                : "최근 복구 후보"}
          </h3>
          <p className={styles.snapshotMeta}>{formatTime(snapshot.savedAt)} 저장</p>
          {snapshot.steps && (
            <ol className={styles.stepList}>
              {snapshot.steps.map((step, index) => (
                <li key={`${step.title}-${index}`}>
                  <strong>{step.title}</strong>
                  <span>
                    {formatTime(step.scheduledAt) ??
                      formatTime(step.estimatedArrivalAt) ??
                      "시각 미정"}
                    {step.durationMinutes ? ` · ${step.durationMinutes}분` : ""}
                    {step.locked || step.reservation ? " · 고정 일정" : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {snapshot.options && (
            <ul className={styles.stepList}>
              {snapshot.options.map((option, index) => (
                <li key={`${option.title}-${index}`}>
                  <strong>{option.title}</strong>
                  <span>
                    이동 {option.travelToMinutes ?? "?"}분 · 체류 {option.stayMinutes ?? "?"}분
                    {option.returnMinutes !== undefined
                      ? ` · 복귀 ${option.returnMinutes}분`
                      : ""}
                  </span>
                  {option.confirmationRequired && (
                    <em>온라인 공식 정보 재확인 전에는 출발하지 마세요.</em>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <p className={styles.warning}>
        이 사본은 마지막 온라인 확인 시점의 정보입니다. 운영시간·날씨·교통은
        바뀔 수 있으므로 연결이 복구되면 반드시 다시 검증하세요.
      </p>
    </section>
  );
}
