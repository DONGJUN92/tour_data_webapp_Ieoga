import type { Metadata } from "next";
import Link from "next/link";
import styles from "../legal-pages.module.css";

export const metadata: Metadata = {
  title: "접근성 안내",
  description:
    "이어가의 키보드, 화면읽기, 확대, 색상 대비 지원과 알려진 한계를 안내합니다.",
  alternates: { canonical: "/accessibility" },
};

export default function AccessibilityPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/">
          ← 이어가로 돌아가기
        </Link>
        <p className={styles.kicker}>ACCESSIBILITY</p>
        <h1>접근성 안내</h1>
        <p className={styles.summary}>
          여행 복구 기능은 키보드·화면읽기·확대 환경에서도 같은 결정을
          끝낼 수 있어야 합니다. 접근성 정보가 없는 관광지는 확인된
          후보처럼 표시하지 않습니다.
        </p>
      </header>

      <article className={styles.content}>
        <section>
          <h2>지원 목표</h2>
          <ul>
            <li>마우스 없이 모든 입력·선택·적용·도착 확인 수행</li>
            <li>논리적인 제목 구조, 레이블, 상태·오류 실시간 안내</li>
            <li>텍스트와 핵심 컨트롤 WCAG AA 수준 색상 대비</li>
            <li>200% 확대와 360px 화면에서 가로 스크롤 없는 핵심 흐름</li>
            <li>운영체제의 모션 감소 설정 존중</li>
          </ul>
        </section>

        <section>
          <h2>관광지 접근성 근거</h2>
          <p>
            유아차·휠체어·고령자 조건은 한국관광공사 무장애여행정보와
            관광지 상세 필드를 사용합니다. 필요한 근거가 확인되지 않으면
            자동 적용 가능한 대안에서 제외하거나 “확인 필요” 상태로
            명확히 구분합니다.
          </p>
        </section>

        <section>
          <h2>알려진 한계와 제보</h2>
          <p>
            공식 데이터와 현장 상황이 다를 수 있습니다. 출입구 경사,
            엘리베이터 고장, 임시 통제처럼 현장 확인이 필요한 문제는
            시설에 직접 문의해야 합니다.
          </p>
          <p>
            접근성 문제를 발견하면 사용한 기기·브라우저·화면과 수행하려던
            행동을{" "}
            <a
              href="https://github.com/DONGJUN92/tour_data_webapp_Ieoga/issues"
              rel="noreferrer"
              target="_blank"
            >
              이어가 공개 이슈 창구
            </a>
            에 알려주세요. 개인정보는 포함하지 마세요.
          </p>
        </section>
      </article>
    </main>
  );
}
