import Link from "next/link";
import styles from "../system-state.module.css";

export const metadata = {
  title: "오프라인",
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="offline-title">
        <p className={styles.eyebrow}>OFFLINE</p>
        <h1 className={styles.title} id="offline-title">
          인터넷 연결을 확인해 주세요
        </h1>
        <p className={styles.description}>
          새 관광지와 이동 시간은 실시간 공식 데이터를 확인해야 합니다. 연결이
          복구되면 저장된 화면으로 돌아가 다시 시도해 주세요.
        </p>
        <div className={styles.actions}>
          <Link className={styles.primary} href="/">
            홈으로 돌아가기
          </Link>
          <Link className={styles.secondary} href="/sources">
            데이터 출처 보기
          </Link>
        </div>
      </section>
    </main>
  );
}
