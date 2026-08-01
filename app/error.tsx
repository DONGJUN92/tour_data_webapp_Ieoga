"use client";

import Link from "next/link";
import styles from "./system-state.module.css";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className={styles.shell}>
      <section
        className={styles.card}
        role="alert"
        aria-labelledby="error-title"
      >
        <p className={styles.eyebrow}>RECOVERY ERROR</p>
        <h1 className={styles.title} id="error-title">
          화면을 불러오지 못했어요
        </h1>
        <p className={styles.description}>
          입력한 일정은 그대로 두었습니다. 잠시 후 다시 시도해 주세요.
          {error.digest ? ` 오류 번호: ${error.digest}` : ""}
        </p>
        <div className={styles.actions}>
          <button className={styles.primary} type="button" onClick={reset}>
            다시 시도
          </button>
          <Link className={styles.secondary} href="/">
            홈으로 돌아가기
          </Link>
        </div>
      </section>
    </main>
  );
}
