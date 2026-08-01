import type { Metadata } from "next";
import Link from "next/link";
import styles from "../legal-pages.module.css";

export const metadata: Metadata = {
  title: "개인정보·위치정보 처리 안내",
  description:
    "이어가가 여행 복구 과정에서 처리하는 위치, 일정, 익명 통계와 이용자의 권리를 설명합니다.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/">
          ← 이어가로 돌아가기
        </Link>
        <p className={styles.kicker}>PRIVACY &amp; LOCATION</p>
        <h1>개인정보·위치정보 처리 안내</h1>
        <p className={styles.summary}>
          이어가는 여행을 복구하는 데 필요한 정보만 처리하고, 위치의
          영구 저장과 동의 없는 정책 통계를 분리합니다. 이 페이지는 현재
          운영 코드의 실제 동작을 기준으로 작성했습니다.
        </p>
        <div className={styles.meta}>
          <span>시행일 2026-08-01</span>
          <span>운영 주체 이어가 공모전 참가팀</span>
          <span>익명 세션 기반</span>
        </div>
      </header>

      <article className={styles.content}>
        <section>
          <h2>1. 처리하는 정보</h2>
          <dl className={styles.table}>
            <dt>현재 위치</dt>
            <dd>
                이용자가 허용한 경우 브라우저에서 소수점 다섯 자리로 줄인
                좌표를 행정구역·관광지·보행경로·날씨 확인에 일시 사용합니다.
                현재 위치와 실제 이동경로는 D1 데이터베이스에 저장하지
                않습니다.
            </dd>
            <dt>이용자가 저장한 일정</dt>
            <dd>
                장소명, 일정 시각, 예약 여부와 일정 장소 좌표를 익명 세션에
                연결해 최대 30일, 활성 일정 10개까지 보관합니다. 새 일정을
                더 저장하면 가장 오래된 활성 일정과 그 장소 정보가 교체됩니다.
            </dd>
            <dt>복구 실행 기록</dt>
            <dd>
                사건 유형, 시도·시군구, 시간·거리 구간, 후보 수, 결과 상태,
                요청 ID와 사용된 데이터 출처를 일반화해 기록합니다.
            </dd>
            <dt>요청 한도 식별자</dt>
            <dd>
                과도한 자동 요청을 막기 위해 Cloudflare가 전달한 네트워크
                주소를 원문으로 저장하지 않고, 기능명·1분 구간과 함께
                SHA-256 해시한 식별자와 요청 횟수만 D1에 기록합니다.
            </dd>
            <dt>선택 동의 통계</dt>
            <dd>
                분석에 동의한 경우에만 일반화된 복구·완주 결과를 정책
                분석에 사용합니다. 정확한 위치와 30건 미만 집계는 공개하지
                않습니다.
            </dd>
          </dl>
        </section>

        <section>
          <h2>2. 이용 목적</h2>
          <ul>
            <li>현재 장소와 다음 고정 일정 사이의 실행 가능한 복구안 계산</li>
            <li>운영시간·기상·이동·접근성 등 필수 조건 확인</li>
            <li>이용자가 적용한 복구 일정의 저장, 도착 확인과 원래 일정 복귀</li>
            <li>오류 조사, 보안 대응과 공모전 심사 증거의 재현</li>
            <li>동의된 비식별 집계에 한한 지역 관광 공백 분석</li>
          </ul>
        </section>

        <section>
          <h2>3. 외부 제공자와 전송</h2>
          <p>
            기능 수행을 위해 필요한 최소 좌표·지역코드·검색어가 다음
            제공자에게 전송될 수 있습니다.
          </p>
          <ul>
            <li>한국관광공사 OpenAPI: 관광지·운영·접근성·정책 지표 확인</li>
            <li>관리형 지오코딩 제공자: 장소명과 행정구역 확인</li>
            <li>경로 제공자: 보행거리와 예상 소요시간 계산</li>
            <li>기상청 또는 날씨 제공자: 현재·예보 기상 확인</li>
          </ul>
          <p className={styles.notice}>
            공개 공유형 경로·날씨 엔드포인트는 현장 검증용입니다. 상용
            출시 전 관리형 제공자로 교체하고, 국외 처리 여부와 수탁자
            정보를 실제 계약에 맞춰 갱신해야 합니다.
          </p>
        </section>

        <section>
          <h2>4. 보관과 삭제</h2>
          <ul>
            <li>저장 일정과 익명 세션: 생성 후 최대 30일</li>
            <li>현재 위치·실제 경로: 영구 저장하지 않음</li>
            <li>
              요청 한도 해시: 각 1분 구간 종료 24시간 뒤를 만료 시점으로
              표시하고 정기 운영 동기화에서 삭제
            </li>
            <li>서비스 메모리 캐시: 제공자 보호를 위해 수 분간 일시 사용 가능</li>
            <li>세션 삭제 요청: 홈의 “내 익명 세션 삭제”에서 즉시 요청 가능</li>
          </ul>
        </section>

        <section>
          <h2>5. 이용자의 선택과 권리</h2>
          <ul>
            <li>위치 권한을 거부하고 장소명·주소를 직접 입력할 수 있습니다.</li>
            <li>분석 동의를 거부해도 여행 복구 기능을 사용할 수 있습니다.</li>
            <li>현재 브라우저에 연결된 일정·복구 기록의 삭제를 요청할 수 있습니다.</li>
            <li>근거가 미확인된 조건은 적용 전에 별도 확인해야 합니다.</li>
          </ul>
        </section>

        <section>
          <h2>6. 문의와 정식 출시 전 고지</h2>
          <p>
            개인정보·위치정보 관련 문의는{" "}
            <a
              href="https://github.com/DONGJUN92/tour_data_webapp_Ieoga/issues"
              rel="noreferrer"
              target="_blank"
            >
              이어가 공개 이슈 창구
            </a>
            로 접수할 수 있습니다.
          </p>
          <p className={styles.notice}>
            공모전 프로토타입의 공개 고지입니다. 정식 출시 전 운영자의
            법적 명칭·주소·개인정보 보호책임자·위치기반서비스 신고 여부와
            수탁자 계약을 법률 전문가와 확인해 최종 고지해야 합니다.
          </p>
        </section>
      </article>
    </main>
  );
}
