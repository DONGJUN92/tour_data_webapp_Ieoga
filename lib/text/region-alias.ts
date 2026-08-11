/**
 * 시도 이름의 별칭.
 *
 * 공식 법정동 코드표의 시도 이름은 행정 통합·개칭을 그대로 반영한다.
 * 예를 들어 2026년 기준 목록에는 `전남광주통합특별시`가 있고 `광주광역시`와
 * `전라남도`는 개별 항목으로 나오지 않는다. 사용자는 여전히 "광주", "전남"
 * 으로 자기 지역을 찾는다. 목록에 없다고 넘기면 자기 지역을 못 찾는다.
 *
 * 여기서는 공식 이름을 바꾸지 않는다. 검색어를 공식 이름에 연결만 하고,
 * 화면에는 "입력한 이름이 어떤 공식 이름에 포함되는지" 알려 준다.
 */

type RegionAlias = {
  /** 공식 이름에 포함되는 검색어들 */
  aliases: string[];
  /** 통합·개칭으로 이름이 바뀐 경우 사용자에게 보여 줄 안내 */
  note?: string;
};

const ALIASES: Record<string, RegionAlias> = {
  전남광주통합특별시: {
    aliases: [
      "광주",
      "광주광역시",
      "광주시",
      "전남",
      "전라남도",
      "여수",
      "순천",
      "목포",
      "나주",
      "광양",
    ],
    note: "행정 통합으로 광주광역시와 전라남도가 하나의 공식 시도 코드로 묶였습니다.",
  },
  강원특별자치도: {
    aliases: ["강원", "강원도", "춘천", "강릉", "속초", "원주", "평창"],
  },
  전북특별자치도: {
    aliases: ["전북", "전라북도", "전주", "군산", "익산", "남원"],
  },
  제주특별자치도: { aliases: ["제주", "제주도", "서귀포"] },
  세종특별자치시: { aliases: ["세종", "세종시"] },
  서울특별시: { aliases: ["서울", "서울시"] },
  부산광역시: { aliases: ["부산", "해운대", "광안리"] },
  대구광역시: { aliases: ["대구"] },
  인천광역시: { aliases: ["인천", "송도", "강화"] },
  대전광역시: { aliases: ["대전", "유성", "둔산"] },
  울산광역시: { aliases: ["울산"] },
  경기도: { aliases: ["경기", "수원", "성남", "고양", "용인", "가평", "파주"] },
  충청북도: { aliases: ["충북", "청주", "충주", "제천", "단양"] },
  충청남도: { aliases: ["충남", "천안", "공주", "보령", "태안", "부여"] },
  경상북도: { aliases: ["경북", "경주", "안동", "포항", "울릉", "독도"] },
  경상남도: { aliases: ["경남", "창원", "통영", "거제", "남해", "진주"] },
};

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

/**
 * 공식 지역명을 유지하면서 여행자가 익숙하게 찾는 별칭을 함께 표시한다.
 * 영어 UI에서도 근거 없는 영문 번역을 만들지 않고 한국어 공식명임을 밝힌다.
 */
export function regionDisplayName(
  officialName: string,
  language: "ko" | "en" = "ko",
): string {
  const familiar = officialName.replace(
    "전남광주통합특별시",
    "전남광주통합특별시 (광주·전남)",
  );
  return language === "en" && familiar
    ? `Official Korean region: ${familiar}`
    : familiar;
}

/** 이 시도 이름에 대해 사용자에게 알려 줄 통합·개칭 안내. 없으면 undefined. */
export function regionNameNote(officialName: string): string | undefined {
  return ALIASES[officialName]?.note;
}

/**
 * 검색어가 이 시도에 해당하는지.
 *
 * 공식 이름의 부분 문자열이거나, 별칭 중 하나에 걸리면 참이다.
 */
export function regionMatchesQuery(
  officialName: string,
  query: string,
): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  if (normalize(officialName).includes(needle)) return true;
  const entry = ALIASES[officialName];
  if (!entry) return false;
  return entry.aliases.some((alias) => {
    const value = normalize(alias);
    return value.includes(needle) || needle.includes(value);
  });
}

/**
 * 검색어가 공식 이름이 아니라 별칭으로 걸렸을 때 보여 줄 문장.
 * 예: "‘광주’는 공식 코드에서 전남광주통합특별시에 포함됩니다."
 */
export function aliasHint(
  officialName: string,
  query: string,
): string | undefined {
  const needle = normalize(query);
  if (!needle) return undefined;
  if (normalize(officialName).includes(needle)) return undefined;
  if (!regionMatchesQuery(officialName, query)) return undefined;
  return `‘${query.trim()}’은 공식 코드에서 ${officialName}에 포함됩니다.`;
}
