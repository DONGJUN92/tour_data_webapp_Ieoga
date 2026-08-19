"use client";

import { useState } from "react";
import styles from "./PlacePhoto.module.css";

/* 후보 장소의 전경 사진 한 칸.

   공사 목록 응답에는 사진이 없는 콘텐츠가 흔하다. 예전에는 그럴 때 옅은
   상자에 분류 이름 한 단어("문화")만 크게 띄웠는데, 그러면 사진 칸이 비어
   있다는 사실보다 "문화"라는 글자가 먼저 읽혀 카드가 잘못 만들어진 것처럼
   보였다. 사진이 없는 것은 우리 실수가 아니라 원본 데이터의 사실이므로,
   깨진 자리가 아니라 **의도한 자리**로 보이게 그린다.

   내려가는 순서는 이렇다.

   1. `imageUrl` — 공사 `firstimage`(원본).
   2. `thumbnailUrl` — 공사 `firstimage2`(썸네일). 같은 목록 응답에 이미 실려
      오므로 외부 조회를 한 건도 더 쓰지 않는다. 원본만 비어 있고 썸네일은
      있는 콘텐츠가 실제로 있다.
   3. 분류 그림 자리표시 — 분류를 그림으로 보여 주고, 사진이 없다는 사실을
      작게 적는다. 없는 사진을 있는 척하지 않는다.

   주소가 죽어 있어 로딩이 실패하는 경우도 같은 순서로 내려간다. 그래서
   `onError`가 다음 후보로 넘기고, 마지막에는 자리표시에 닿는다. */

type Language = "ko" | "en";

const CATEGORY_ICON_PATHS: Record<string, string> = {
  /* 공원 — 나무 한 그루. */
  PARK: "M12 21v-4M12 17c-3 0-5.2-2.1-5.2-4.7 0-1.2.5-2.3 1.3-3.1-.2-.5-.3-1-.3-1.5C7.8 5.6 9.7 4 12 4s4.2 1.6 4.2 3.7c0 .5-.1 1-.3 1.5.8.8 1.3 1.9 1.3 3.1 0 2.6-2.2 4.7-5.2 4.7Z",
  /* 문화유산 — 기와 지붕과 기둥. */
  HERITAGE: "M3 9h18l-9-5-9 5ZM5 9v9M9.7 9v9M14.3 9v9M19 9v9M3 21h18",
  /* 식당 — 그릇과 젓가락. */
  FOOD: "M4 11h11a5.5 5.5 0 0 1-5.5 5.5H9.5A5.5 5.5 0 0 1 4 11ZM6 19.5h8M18 4l2 1.6L17.5 16",
  /* 문화 — 전시관 앞면. */
  CULTURE: "M4 10h16M4 10 12 4l8 6M7 10v8M12 10v8M17 10v8M3.5 21h17",
  /* 자연 — 산과 봉우리. */
  NATURE: "M3 19h18L14 7l-3.4 5.6L8.6 10 3 19ZM15.5 7.5 21 19",
  /* 체험관광 — 손과 반짝임. */
  EXPERIENCE:
    "M8 21v-4.5L6 14a2 2 0 0 1 2.9-2.7l1.1 1V4.5a1.5 1.5 0 0 1 3 0v5.6M13 10.1V9a1.5 1.5 0 0 1 3 0v1.6M16 10.6a1.5 1.5 0 0 1 3 0v3.9c0 3.6-2 6.5-5 6.5",
  /* 축제·공연·행사 — 표. */
  EVENT: "M3 8.5A2 2 0 0 0 3 15.5V19h18v-3.5a2 2 0 0 1 0-7V5H3v3.5ZM9 5v14",
  /* 레저스포츠 — 달리는 사람. */
  LEISURE:
    "M13.5 5.2a1.4 1.4 0 1 0 0-.1ZM12.6 8.4 9 10.5l1.6 3.2-2.3 6M10.6 13.7l4.4-1 1.7 2.3 2.8 1.4M9 10.5 5.5 9",
  /* 쇼핑 — 장바구니. */
  SHOPPING: "M5 8h14l-1.2 12.5H6.2L5 8ZM8.8 8V6a3.2 3.2 0 0 1 6.4 0v2",
  /* 숙박 — 침대. */
  ACCOMMODATION:
    "M3 19v-9M3 13h12a5 5 0 0 1 5 5v1M3 19h18M7.5 10.5a1.6 1.6 0 1 0 0-.1Z",
  /* 추천코스 — 이어진 길과 두 지점. */
  COURSE:
    "M6.5 8.2a2.2 2.2 0 1 0 0-.1ZM17.5 18.2a2.2 2.2 0 1 0 0-.1ZM6.5 10.5c0 4 11 2.5 11 5.5",
  /* 기타 관광 — 지도 핀. */
  OTHER: "M12 21s6.5-6.1 6.5-10.4A6.5 6.5 0 0 0 5.5 10.6C5.5 14.9 12 21 12 21Zm0-8.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z",
};

function iconPath(code: string | undefined): string {
  if (!code) return CATEGORY_ICON_PATHS.OTHER;
  return CATEGORY_ICON_PATHS[code] ?? CATEGORY_ICON_PATHS.OTHER;
}

export function PlacePhoto({
  imageUrl,
  thumbnailUrl,
  title,
  categoryCode,
  categoryLabel,
  language,
  /* 사진 칸 아래에 지도가 붙는 카드에서는 아래쪽 둥근 모서리를 펴, 사진과
     지도가 한 덩어리로 보이게 한다. */
  joinBelow = false,
}: {
  imageUrl?: string;
  thumbnailUrl?: string;
  title: string;
  categoryCode?: string;
  categoryLabel?: string;
  language: Language;
  joinBelow?: boolean;
}) {
  const sources = [imageUrl, thumbnailUrl].filter(
    (value): value is string => Boolean(value && value.trim()),
  );
  const [attempt, setAttempt] = useState(0);

  /* 같은 자리에 다른 장소가 오면 실패 기록을 버린다. 앞 장소에서 사진이
     실패했다는 사실이 남아 있으면 새 장소의 사진을 시도조차 하지 않는다.

     이 되돌림을 효과로 두면 화면을 한 번 그린 뒤 다시 그리게 되고, 그 사이
     한 프레임 동안 앞 장소의 자리표시가 보인다. 리액트가 권하는 대로 그리는
     중에 바로잡아, 바뀐 주소가 처음부터 반영되게 한다. */
  const sourceKey = `${imageUrl ?? ""}|${thumbnailUrl ?? ""}`;
  const [seenKey, setSeenKey] = useState(sourceKey);
  if (seenKey !== sourceKey) {
    setSeenKey(sourceKey);
    setAttempt(0);
  }

  const source = sources[seenKey === sourceKey ? attempt : 0];
  const box = joinBelow ? `${styles.box} ${styles.boxJoined}` : styles.box;

  if (source) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element --
         `next/image`는 최적화 프록시를 거치는데 이 주소는 공사 서버의 원격
         호스트다. 프록시에 원격 호스트를 등록하면 우리 워커가 이미지 바이트를
         중계하게 되고, 요청당 외부 조회 예산과 무료 플랜 대역폭을 사진에 쓰게
         된다. 사진은 판정에 쓰이지 않는 보조 정보이므로 브라우저가 공사
         서버에서 직접, 지연 로딩으로 받는 편이 맞다. */
      <img
        className={`${box} ${styles.photo}`}
        src={source}
        alt={
          language === "en"
            ? `${title}, official photo from the Korea Tourism Organization`
            : `${title} 대표 사진 (한국관광공사 제공)`
        }
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setAttempt((current) => current + 1)}
      />
    );
  }

  return (
    <div
      className={`${box} ${styles.empty}`}
      role="img"
      aria-label={
        language === "en"
          ? `No official photo is provided for ${title}.`
          : `${title}의 공사 제공 사진이 없습니다.`
      }
      data-testid="place-photo-empty"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d={iconPath(categoryCode)}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {categoryLabel && (
        <span className={styles.emptyCategory}>{categoryLabel}</span>
      )}
      <span className={styles.emptyNote}>
        {language === "en" ? "No official photo" : "공사 제공 사진 없음"}
      </span>
    </div>
  );
}
