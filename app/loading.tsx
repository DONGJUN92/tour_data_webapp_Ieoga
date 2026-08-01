import styles from "./system-state.module.css";

export default function Loading() {
  return (
    <main className={styles.shell}>
      <div className={styles.status} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        <span>공식 관광 데이터를 확인하고 있어요.</span>
      </div>
    </main>
  );
}
