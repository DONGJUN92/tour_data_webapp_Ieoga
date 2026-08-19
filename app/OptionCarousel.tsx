"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./OptionCarousel.module.css";

/* 대안 목록을 가로로 넘겨 보는 캐러셀.

   세로로 길게 쌓으면 스무 곳을 훑는 동안 조건 입력이 화면에서 사라지고, 몇 곳이
   더 있는지도 알 수 없다. 가로 스크롤에 스크롤 스냅을 걸면 카드가 한 칸씩 딱
   맞게 멈추고, 손가락으로도 그대로 넘어간다. 움직임은 브라우저의 부드러운
   스크롤에 맡긴다 — 직접 프레임을 그리면 움직임을 줄이도록 설정한 기기에서
   그 설정을 우리가 따로 존중해야 하는데, 네이티브 스크롤은 그것을 이미 지킨다.

   빈 시간 탭과 일정 복구 탭이 같은 목록을 다루므로 두 화면이 이것을 함께 쓴다.
   예전에는 한쪽에만 캐러셀이 있어서 여행자가 화면마다 조작을 새로 배워야
   했다. 규칙을 한 곳에 두면 두 화면이 어긋날 수 없다. */

type Language = "ko" | "en";

function Chevron({ back }: { back?: boolean }) {
  /* 예전에는 `‹` `›` 글자를 그대로 썼다. 이 글자는 폰트마다 좌우 여백이 달라
     원 안에서 한쪽으로 밀려 보였다 — 글자 크기를 맞춰도 폰트가 바뀌면 다시
     어긋난다. 도형으로 그리면 폰트와 무관하게 정중앙에 온다. */
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={back ? "M15 5 8 12l7 7" : "M9 5l7 7-7 7"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function OptionCarousel({
  total,
  language,
  trackLabel,
  children,
  testId,
  /* 한 화면에 몇 칸을 보일지. 대안 목록은 두 칸이 맞지만, 코스처럼 한 칸이 지도
     한 장이거나 사진과 운영시간을 담은 카드일 때는 두 칸으로 쪼개면 둘 다 작아져
     읽을 수 없다. 순환·화살표·순번 표시는 그대로 함께 쓴다. */
  perView: requestedPerView = 2,
  /* 순번 문구를 바꿔 끼울 수 있게 둔다. 기본 문구는 "N곳 중 1·2번째"인데, 코스
     캐러셀의 첫 화면은 장소가 아니라 동선 지도라 "곳"으로 세면 틀린 말이 된다. */
  formatPosition,
}: {
  total: number;
  language: Language;
  trackLabel: string;
  children: ReactNode;
  testId?: string;
  perView?: 1 | 2;
  formatPosition?: (visible: number[], total: number) => string;
}) {
  const trackRef = useRef<HTMLUListElement>(null);
  /* 지금 몇 번째 후보를 보고 있는가. "9곳 중 2곳씩 보기"는 규칙만 알려 주고
     현재 위치를 알려 주지 않아, 여행자가 목록의 어디쯤인지 모른 채 화살표를
     눌렀다. 첫 칸의 번호와 한 화면에 보이는 칸 수를 스크롤 위치에서 읽는다. */
  const [firstVisible, setFirstVisible] = useState(0);
  const [perView, setPerView] = useState(1);
  /* 끝에서 처음으로 되돌아간 직후임을 알리는 표시. 되돌아가는 거리는 목록이
     길면 화면 열 개를 넘으므로, 부드럽게 쓸어 넘기면 무엇을 지나쳤는지 알 수
     없고 오래 걸린다. 즉시 옮기고 트랙을 아주 짧게 한 번 밝혀, 튄 것이 아니라
     처음으로 돌아왔음을 눈으로 알 수 있게 한다. */
  const [wrapped, setWrapped] = useState(false);

  /* 끝에 닿았는지 판정하는 기준.
     처음에는 12px 고정값이었다. 트랙에 포커스 테두리가 잘리지 않도록 안쪽 여백을
     두었는데 그만큼이 초기 `scrollLeft`로 잡혀 "뒤로 갈 수 있다"가 됐기 때문이다.

     그 고정값이 순환에서 깨졌다. 끝에서 처음으로 즉시 옮기면 스크롤 스냅이 위치를
     한 번 더 보정해 `scrollLeft`가 21px로 앉는데, 12보다 크므로 "처음이 아니다"로
     읽혀 왼쪽 화살표가 마지막으로 넘어가지 못했다(실측). 여백이 아니라 **한 칸 폭**
     을 기준으로 재면 여백·소수점·스냅 보정을 한꺼번에 흡수한다. */
  const edgeTolerance = (step: number) => Math.max(12, step * 0.4);

  /* 한 칸의 폭 + 사이 간격. 칸 폭은 화면 폭에 따라 달라지므로(좁은 화면에서는
     한 칸) 상수로 두지 않고 실제로 그려진 첫 칸에서 읽는다. */
  const stepWidth = (node: HTMLUListElement): number => {
    const card = node.firstElementChild as HTMLElement | null;
    if (!card) return node.clientWidth || 1;
    const gap = Number.parseFloat(getComputedStyle(node).columnGap || "0") || 0;
    return Math.max(1, card.offsetWidth + gap);
  };

  const updateScrollState = () => {
    const node = trackRef.current;
    if (!node) return;
    const step = stepWidth(node);
    setPerView(Math.max(1, Math.round(node.clientWidth / step)));
    setFirstVisible(Math.max(0, Math.round(node.scrollLeft / step)));
  };

  const scrollCards = (direction: 1 | -1) => {
    const node = trackRef.current;
    if (!node) return;
    const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
    const tolerance = edgeTolerance(stepWidth(node));
    const atEnd = node.scrollLeft >= maxScroll - tolerance;
    const atStart = node.scrollLeft <= tolerance;
    /* 끝에서 한 번 더 누르면 처음으로 잇는다. 예전에는 끝에서 버튼이 꺼져
       목록이 여기서 끝났다는 사실만 남았는데, 처음으로 돌아가려면 화살표를
       여덟 번 되눌러야 했다. */
    if (direction === 1 && atEnd) {
      node.scrollTo({ left: 0, behavior: "auto" });
      setWrapped(true);
    } else if (direction === -1 && atStart) {
      node.scrollTo({ left: maxScroll, behavior: "auto" });
      setWrapped(true);
    } else {
      node.scrollBy({ left: direction * node.clientWidth, behavior: "smooth" });
    }
    /* 부드러운 스크롤은 여러 프레임에 걸쳐 끝난다. 그 사이 `onScroll`이 계속
       오지만 마지막 프레임 뒤에는 오지 않는 브라우저가 있어, 끝에 닿았는데도
       위치 표시가 예전 값으로 남는 경우가 있다. 한 번 더 확인한다. */
    window.setTimeout(updateScrollState, 450);
  };

  useEffect(() => {
    updateScrollState();
    const node = trackRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    /* 창 크기가 바뀌면 보이는 칸 수와 스크롤 폭이 달라진다. */
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(node);
    return () => observer.disconnect();
  });

  useEffect(() => {
    if (!wrapped) return;
    const timer = window.setTimeout(() => setWrapped(false), 420);
    return () => window.clearTimeout(timer);
  }, [wrapped]);

  /* 지금 보이는 칸의 번호들. 마지막 화면에서는 스크롤이 끝에 붙으므로 실제로
     보이는 칸이 `firstVisible`보다 앞에서 시작한다 — 총 개수로 눌러 준다. */
  const shown = Math.min(perView, total);
  const start = Math.min(firstVisible, Math.max(0, total - shown)) + 1;
  const numbers = Array.from({ length: shown }, (_, index) => start + index);
  const pageable = total > shown;

  const positionLabel = formatPosition
    ? formatPosition(numbers, total)
    : !pageable
    ? language === "en"
      ? `${total} place${total === 1 ? "" : "s"} in total`
      : `총 ${total}곳`
    : language === "en"
      ? `${numbers[0]}–${numbers[numbers.length - 1]} of ${total}`
      : `${total}곳 중 ${numbers.join("·")}번째`;

  return (
    <div className={styles.carousel} data-testid={testId}>
      <div className={styles.head}>
        <span className={styles.count} aria-live="polite">
          {positionLabel}
        </span>
        {pageable && (
          <div className={styles.nav}>
            <button
              type="button"
              onClick={() => scrollCards(-1)}
              aria-label={
                language === "en" ? "Previous places" : "앞의 대안 보기"
              }
            >
              <Chevron back />
            </button>
            <button
              type="button"
              onClick={() => scrollCards(1)}
              aria-label={language === "en" ? "Next places" : "다음 대안 보기"}
            >
              <Chevron />
            </button>
          </div>
        )}
      </div>
      <ul
        className={`${styles.track} ${
          requestedPerView === 1 ? styles.trackSingle : ""
        } ${wrapped ? styles.trackWrapped : ""}`}
        ref={trackRef}
        onScroll={updateScrollState}
        tabIndex={0}
        aria-label={trackLabel}
      >
        {children}
      </ul>
    </div>
  );
}
