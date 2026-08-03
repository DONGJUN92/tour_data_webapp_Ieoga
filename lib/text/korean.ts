/**
 * 한국어 표기 유틸.
 *
 * 화면에 `대전컨벤션센터(DCC)(으)로`, `성심당을(를)`처럼 조사 폴백이 노출되면
 * 서비스가 미완성으로 읽힌다. 장소명은 API에서 오므로 컴파일 시점에 조사를
 * 정할 수 없고, 괄호·영문 약어·숫자로 끝나는 이름이 흔하다. 그래서 마지막
 * 실질 음절의 종성을 실제로 계산해서 조사를 고른다.
 */

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JONGSEONG_COUNT = 28;

/** 숫자를 읽었을 때의 종성. 예: 1=일(ㄹ), 2=이(없음), 6=육(ㄱ) */
const DIGIT_FINAL: Record<string, string> = {
  "0": "ㅇ", // 영
  "1": "ㄹ", // 일
  "2": "", // 이
  "3": "ㅁ", // 삼
  "4": "", // 사
  "5": "", // 오
  "6": "ㄱ", // 육
  "7": "ㄹ", // 칠
  "8": "ㄹ", // 팔
  "9": "", // 구
};

/** 로마자 한 글자를 읽었을 때의 종성. 예: DCC=디시시(없음), L=엘(ㄹ) */
const LATIN_FINAL: Record<string, string> = {
  a: "", // 에이
  b: "", // 비
  c: "", // 시
  d: "", // 디
  e: "", // 이
  f: "ㅍ", // 에프
  g: "", // 지
  h: "", // 에이치
  i: "", // 아이
  j: "", // 제이
  k: "", // 케이
  l: "ㄹ", // 엘
  m: "ㅁ", // 엠
  n: "ㄴ", // 엔
  o: "", // 오
  p: "", // 피
  q: "", // 큐
  r: "ㄹ", // 아르
  s: "ㅅ", // 에스
  t: "", // 티
  u: "", // 유
  v: "", // 브이
  w: "", // 더블유
  x: "ㅅ", // 엑스
  y: "", // 와이
  z: "", // 제트
};

type FinalSound = { final: string; known: boolean };

function finalSoundOf(raw: string): FinalSound {
  // 괄호·따옴표·문장부호로 끝나는 이름이 많다. 예: `대전컨벤션센터(DCC)`
  const trimmed = raw
    .replace(/[\s.,!?;:·…"'”’)\]}』」》〉]+$/u, "")
    .replace(/[(\[{『「《〈]+$/u, "");
  const last = [...trimmed].pop();
  if (!last) return { final: "", known: false };

  const code = last.codePointAt(0) ?? 0;
  if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
    const index = (code - HANGUL_BASE) % JONGSEONG_COUNT;
    if (index === 0) return { final: "", known: true };
    const table = [
      "",
      "ㄱ",
      "ㄲ",
      "ㄳ",
      "ㄴ",
      "ㄵ",
      "ㄶ",
      "ㄷ",
      "ㄹ",
      "ㄺ",
      "ㄻ",
      "ㄼ",
      "ㄽ",
      "ㄾ",
      "ㄿ",
      "ㅀ",
      "ㅁ",
      "ㅂ",
      "ㅄ",
      "ㅅ",
      "ㅆ",
      "ㅇ",
      "ㅈ",
      "ㅊ",
      "ㅋ",
      "ㅌ",
      "ㅍ",
      "ㅎ",
    ];
    return { final: table[index] ?? "", known: true };
  }

  if (/[0-9]/.test(last)) {
    return { final: DIGIT_FINAL[last] ?? "", known: true };
  }

  if (/[a-zA-Z]/.test(last)) {
    return { final: LATIN_FINAL[last.toLowerCase()] ?? "", known: true };
  }

  return { final: "", known: false };
}

/** 마지막 음절에 받침이 있는지. 판정할 수 없으면 undefined. */
export function hasFinalConsonant(word: string): boolean | undefined {
  const sound = finalSoundOf(word);
  if (!sound.known) return undefined;
  return sound.final !== "";
}

export type ParticlePair =
  | "을/를"
  | "이/가"
  | "은/는"
  | "와/과"
  | "으로/로"
  | "이라/라"
  | "이에요/예요"
  | "아/야";

const PAIRS: Record<ParticlePair, { withFinal: string; withoutFinal: string }> =
  {
    "을/를": { withFinal: "을", withoutFinal: "를" },
    "이/가": { withFinal: "이", withoutFinal: "가" },
    "은/는": { withFinal: "은", withoutFinal: "는" },
    "와/과": { withFinal: "과", withoutFinal: "와" },
    "으로/로": { withFinal: "으로", withoutFinal: "로" },
    "이라/라": { withFinal: "이라", withoutFinal: "라" },
    "이에요/예요": { withFinal: "이에요", withoutFinal: "예요" },
    "아/야": { withFinal: "아", withoutFinal: "야" },
  };

/**
 * 이름에 붙는 조사만 돌려준다.
 *
 * `으로/로`는 ㄹ 받침이면 `로`를 쓴다. (서울로, 대전으로)
 * 종성을 판정할 수 없는 이름(기호로만 된 이름 등)은 받침 없는 쪽을 쓴다.
 * `(으)로`처럼 두 형태를 함께 노출하지는 않는다.
 */
export function particleFor(word: string, pair: ParticlePair): string {
  const sound = finalSoundOf(word);
  const spec = PAIRS[pair];
  if (!sound.known) return spec.withoutFinal;
  if (pair === "으로/로") {
    if (sound.final === "" || sound.final === "ㄹ") return spec.withoutFinal;
    return spec.withFinal;
  }
  return sound.final ? spec.withFinal : spec.withoutFinal;
}

/** 이름과 조사를 이어 붙인다. 예: withParticle("대전컨벤션센터(DCC)", "을/를") → "대전컨벤션센터(DCC)를" */
export function withParticle(word: string, pair: ParticlePair): string {
  return `${word}${particleFor(word, pair)}`;
}

/** 따옴표로 감싼 뒤 조사를 붙인다. 조사는 따옴표 밖의 실제 이름으로 판정한다. */
export function quotedWithParticle(
  word: string,
  pair: ParticlePair,
  quote: [string, string] = ["‘", "’"],
): string {
  return `${quote[0]}${word}${quote[1]}${particleFor(word, pair)}`;
}
