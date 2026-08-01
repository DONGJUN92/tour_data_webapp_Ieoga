import type { Metadata } from "next";
import Link from "next/link";
import styles from "../legal-pages.module.css";

export const metadata: Metadata = {
  title: "서비스 이용약관",
  description: "이어가 여행 복구 서비스의 이용 조건과 안전 한계를 설명합니다.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/">
          ← 이어가로 돌아가기
        </Link>
        <p className={styles.kicker}>TERMS OF USE</p>
        <h1>서비스 이용약관</h1>
        <p className={styles.summary}>
          이어가는 공식 관광정보와 외부 경로·날씨 근거를 조합해 여행
          복구 판단을 돕습니다. 예약·결제·교통 운행을 대신 보장하지는
          않습니다.
        </p>
        <div className={styles.meta}>
          <span>시행일 2026-07-31</span>
          <span>웹 프로토타입</span>
        </div>
      </header>

      <article className={styles.content}>
        <section>
          <h2>1. 서비스 범위</h2>
          <p>
            이용자가 입력한 사건·현재 장소·다음 일정 조건을 바탕으로
            대체 관광지를 찾고, 거리·시간·운영·접근성 근거와 제외 이유를
            제공합니다. 대안의 적용, 도착 확인과 원래 일정 복귀를 보조합니다.
          </p>
        </section>

        <section>
          <h2>2. 반드시 다시 확인할 정보</h2>
          <ul>
            <li>관광지 운영시간, 휴무, 입장료, 예약·매진 여부</li>
            <li>휠체어·유아차 동선과 현장 지원 가능 여부</li>
            <li>대중교통 운행, 도로·보행로 통제와 실제 도착시간</li>
            <li>기상특보와 재난·응급 상황의 공식 안내</li>
          </ul>
          <p className={styles.notice}>
            응급·재난·신변 안전 상황에서는 이어가 추천보다 국가·지자체의
            재난 안내와 현장 관리자의 지시를 우선해야 합니다.
          </p>
        </section>

        <section>
          <h2>3. 결과 상태의 의미</h2>
          <dl className={styles.table}>
            <dt>검증됨</dt>
            <dd>필수 근거와 다음 일정 도착 조건을 현재 응답으로 확인한 상태</dd>
            <dt>확인 필요</dt>
            <dd>일부 근거가 없거나 조건부여서 이용자가 적용 전에 확인해야 하는 상태</dd>
            <dt>유효 후보 없음</dt>
            <dd>현재 입력과 근거로는 모든 필수 조건을 지키는 후보를 찾지 못한 상태</dd>
          </dl>
        </section>

        <section>
          <h2>4. 금지 행위</h2>
          <ul>
            <li>자동 요청으로 API·저장공간·외부 제공자의 정상 운영을 방해하는 행위</li>
            <li>세션·도착·정책 집계를 허위로 만들거나 조작하는 행위</li>
            <li>다른 이용자의 공유 증명에 무단 접근하거나 개인정보를 수집하는 행위</li>
            <li>공식 출처 표시를 제거해 이어가의 추론을 원 출처 사실처럼 유통하는 행위</li>
          </ul>
        </section>

        <section>
          <h2>5. 서비스 변경과 중단</h2>
          <p>
            OpenAPI, 경로, 날씨 또는 플랫폼 장애로 일부 기능이 제한될 수
            있습니다. 이어가는 장애를 정상 결과로 가장하지 않고, 확인하지
            못한 조건과 다음 행동을 표시하도록 운영합니다.
          </p>
        </section>

        <section>
          <h2>6. 문의</h2>
          <p>
            오류·안전 문제·권리 침해는{" "}
            <a
              href="https://github.com/DONGJUN92/tour_data_webapp_Ieoga/issues"
              rel="noreferrer"
              target="_blank"
            >
              공개 이슈 창구
            </a>
            로 알려주세요. 개인정보나 인증키는 공개 이슈에 입력하지 마세요.
          </p>
        </section>
      </article>
    </main>
  );
}
