import Link from "next/link";
import styles from "./system-state.module.css";

export default function NotFound() {
  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="not-found-title">
        <p className={styles.eyebrow}>404</p>
        <h1 className={styles.title} id="not-found-title">
          요청한 페이지를 찾을 수 없어요
        </h1>
        <p className={styles.description}>
          주소가 바뀌었거나 사용할 수 없는 페이지입니다.
        </p>
        <div className={styles.actions}>
          <Link className={styles.primary} href="/">
            이어가 홈
          </Link>
        </div>
      </section>
    </main>
  );
}
