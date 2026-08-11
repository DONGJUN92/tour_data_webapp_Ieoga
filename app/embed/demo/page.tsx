import type { Metadata } from "next";
import styles from "./demo.module.css";

/* 파트너 사이트를 모사한 데모 호스트.
 *
 * 기획 16장은 "지역 공식 관광웹·숙박앱·교통앱 안에서 브랜드를 유지한 채 실행"을
 * 요구한다. 위젯만 만들어 두면 "정말 남의 사이트 안에서 도는가"를 보여줄 수 없어,
 * 실제로 iframe 안에 넣은 화면을 함께 둔다. 이 페이지의 브랜드·색·문구는 전부
 * 가상의 파트너 것이고, 이어가는 오른쪽 카드 안에만 존재한다.
 *
 * 가상의 숙박 사업자를 쓴다. 실제 존재하는 사업자 이름을 쓰면 제휴가 있는 것처럼
 * 읽히고, 기획 15.7의 "협력의향을 계약처럼 표현하지 않는다"에 어긋난다. */

export const metadata: Metadata = {
  title: "파트너 임베드 데모",
  description:
    "숙박 사업자 사이트 안에 이어가 복구 위젯을 넣은 모사 화면입니다. 가상의 파트너입니다.",
  robots: { index: false, follow: false },
};

export default function EmbedDemoPage() {
  return (
    <main className={styles.host}>
      <div className={styles.banner} role="note">
        <strong>이 페이지는 심사용 모사 화면입니다.</strong> 아래 &lsquo;해운대
        블루스테이&rsquo;는 실제로 존재하지 않는 가상의 숙박 사업자이며, 이어가와
        제휴 관계가 있음을 뜻하지 않습니다. 오른쪽 카드만 이어가가 제공하는
        임베드 위젯이고, 나머지 화면은 파트너 측 예시입니다.
      </div>

      <header className={styles.hostHead}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            BS
          </span>
          <span>
            <b>해운대 블루스테이</b>
            <small>가상 숙박 사업자 · 예시</small>
          </span>
        </div>
        <nav className={styles.hostNav} aria-label="파트너 예시 메뉴">
          <span>객실</span>
          <span>부대시설</span>
          <span aria-current="page">주변 여행</span>
          <span>예약 확인</span>
        </nav>
      </header>

      <div className={styles.layout}>
        <section className={styles.hostBody}>
          <h1>투숙객 전용 · 주변 여행 안내</h1>
          <p>
            체크인 전이나 체크아웃 후에 남는 시간, 비가 와서 일정이 틀어진 날에
            무엇을 할 수 있는지 안내합니다.
          </p>
          <div className={styles.hostCards}>
            <article>
              <h2>조식 이용 안내</h2>
              <p>2층 다이닝 · 07:00~10:00</p>
            </article>
            <article>
              <h2>수영장 운영</h2>
              <p>실내 · 09:00~21:00</p>
            </article>
            <article>
              <h2>셔틀 시간표</h2>
              <p>해운대역 방면 매시 정각</p>
            </article>
          </div>
          <p className={styles.hostFoot}>
            파트너 측 콘텐츠 예시 영역입니다. 실제 파트너는 이 자리에 자신의
            콘텐츠를 그대로 둔 채 오른쪽 위젯만 삽입합니다.
          </p>
        </section>

        <aside className={styles.slot}>
          <p className={styles.slotLabel}>
            파트너가 삽입한 이어가 위젯 (iframe)
          </p>
          {/* 파트너는 자기 사이트가 이미 아는 좌표를 쿼리로 넘긴다. 위젯이 위치
              권한을 다시 묻지 않아도 되므로 마찰이 줄어든다. 여기서는 해운대
              좌표를 예시로 넘긴다. */}
          <iframe
            className={styles.frame}
            src="/embed/recover?lat=35.15866&lng=129.1604&area=26&sigungu=26350&label=%ED%98%84%EC%9E%AC%20%EC%88%99%EC%86%8C%20%EC%A3%BC%EB%B3%80&host=%ED%95%B4%EC%9A%B4%EB%8C%80%20%EB%B8%94%EB%A3%A8%EC%8A%A4%ED%85%8C%EC%9D%B4"
            title="이어가 복구 위젯"
            loading="lazy"
            allow="geolocation"
          />
          <details className={styles.snippet}>
            <summary>삽입 코드</summary>
            <pre>{`<iframe
  src="https://ieoga-national-travel-resilience.sans5-poems-5045.workers.dev/embed/recover?lat=35.15866&lng=129.1604&area=26&sigungu=26350&host=파트너명"
  title="이어가 복구 위젯"
  width="420" height="720" loading="lazy"
  allow="geolocation"
  style="border:1px solid #e5e8eb;border-radius:16px"></iframe>`}</pre>
            <p>
              좌표를 넘기지 않으면 위젯이 방문자에게 위치 권한을 직접 요청합니다.
              브라우저 위치 좌표는 URL에 남기지 않고 POST 본문으로만 전송합니다.
            </p>
          </details>
        </aside>
      </div>
    </main>
  );
}
