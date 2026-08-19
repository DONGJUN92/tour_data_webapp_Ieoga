import type { KtoItem } from "./types";

/* KorService2의 공식 대·중분류를 앱 필터에 맞게 묶은 분류다. 도시공원은
   대분류상 문화관광(VE)이지만 공식 중분류 VE02/VE03에 들어 있으므로, 대분류만
   쓰면 사용자가 공원을 찾을 수 없다. 장소명 추측 없이 lclsSystm1~3만 사용한다. */
export const KTO_TOURISM_CATEGORIES = [
  { code: "PARK", labelKo: "공원", labelEn: "Parks", alternative: true },
  { code: "HERITAGE", labelKo: "문화유산", labelEn: "Heritage", alternative: true },
  { code: "FOOD", labelKo: "식당", labelEn: "Food", alternative: true },
  { code: "CULTURE", labelKo: "문화", labelEn: "Culture", alternative: true },
  { code: "NATURE", labelKo: "자연", labelEn: "Nature", alternative: true },
  { code: "EXPERIENCE", labelKo: "체험관광", labelEn: "Experiences", alternative: true },
  { code: "EVENT", labelKo: "축제·공연·행사", labelEn: "Events", alternative: true },
  { code: "LEISURE", labelKo: "레저스포츠", labelEn: "Leisure sports", alternative: true },
  { code: "SHOPPING", labelKo: "쇼핑", labelEn: "Shopping", alternative: true },
  { code: "ACCOMMODATION", labelKo: "숙박", labelEn: "Accommodation", alternative: true },
  /* 추천코스는 **대안 여행지가 아니다.**

     코스는 여러 지점을 잇는 경로이고 공식 소요시간이 몇 시간이다(실측 7시간).
     "지금 비어 있는 두 시간에 다녀올 한 곳"으로는 성립하지 않는다. 그래서 대안
     후보 분류에서 빼되, 공식 분류 자체에서 지우지는 않는다 — 코스는 여행을
     **처음 계획할 때** 쓰는 것이고, 일정 만들기 화면의 "코스 추천 받기"가 바로
     그 자리에서 이 분류를 쓴다. */
  { code: "COURSE", labelKo: "추천코스", labelEn: "Travel courses", alternative: false },
] as const;

/* 대안 여행지를 고르는 화면에 보여 줄 분류만. 세 화면이 각자 걸러내면 한 곳이
   빠져 화면마다 고를 수 있는 것이 달라진다. */
export const ALTERNATIVE_TOURISM_CATEGORIES = KTO_TOURISM_CATEGORIES.filter(
  (category) => category.alternative,
);

/* 대안 후보로 쓰지 않는 콘텐츠 유형. 분류 코드가 아니라 공사 `contentTypeId`로
   판정한다 — 분류는 신분류 코드에서 유도되므로 값이 비면 `OTHER`로 떨어지는데,
   코스는 그때도 코스이기 때문이다. */
export const NON_ALTERNATIVE_CONTENT_TYPE_IDS: ReadonlySet<string> = new Set([
  "25",
]);

export type KtoTourismCategoryCode =
  | (typeof KTO_TOURISM_CATEGORIES)[number]["code"]
  | "OTHER";

export type KtoTourismCategory = {
  code: KtoTourismCategoryCode;
  labelKo: string;
  labelEn: string;
  source:
    | "KorService2.lclsSystm2"
    | "KorService2.lclsSystm1"
    | "KorService2.contenttypeid";
  officialLevel1Code?: string;
  officialLevel2Code?: string;
  officialLevel3Code?: string;
};

const CATEGORY_BY_CODE = new Map(
  KTO_TOURISM_CATEGORIES.map((category) => [category.code, category]),
);

const CONTENT_TYPE_FALLBACK: Record<
  string,
  Exclude<KtoTourismCategoryCode, "OTHER">
> = {
  /* 12는 공원뿐 아니라 거리·골목·복합 관광시설까지 포괄하는 `관광지`다.
     공식 신분류가 없을 때 자연으로 좁혀 쓰면 필터 숫자가 거짓이 되므로
     fallback을 두지 않는다. */
  "14": "CULTURE",
  "15": "EVENT",
  "25": "COURSE",
  "28": "LEISURE",
  "32": "ACCOMMODATION",
  "38": "SHOPPING",
  "39": "FOOD",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function ktoTourismCategory(
  item: KtoItem,
): KtoTourismCategory {
  const officialLevel1Code = text(item.lclsSystm1).toUpperCase();
  const officialLevel2Code = text(item.lclsSystm2).toUpperCase();
  const officialLevel3Code = text(item.lclsSystm3).toUpperCase();
  const officialCodes = {
    officialLevel1Code: officialLevel1Code || undefined,
    officialLevel2Code: officialLevel2Code || undefined,
    officialLevel3Code: officialLevel3Code || undefined,
  };
  const appCode = ["VE02", "VE03", "NA04"].includes(officialLevel2Code)
    ? "PARK"
    : officialLevel1Code === "HS"
      ? "HERITAGE"
      : officialLevel1Code === "FD"
        ? "FOOD"
        : officialLevel1Code === "VE"
          ? "CULTURE"
          : officialLevel1Code === "NA"
            ? "NATURE"
            : officialLevel1Code === "EX"
              ? "EXPERIENCE"
              : officialLevel1Code === "EV"
                ? "EVENT"
                : officialLevel1Code === "LS"
                  ? "LEISURE"
                  : officialLevel1Code === "SH"
                    ? "SHOPPING"
                    : officialLevel1Code === "AC"
                      ? "ACCOMMODATION"
                      : officialLevel1Code === "C01"
                        ? "COURSE"
                        : officialLevel1Code;
  const official = CATEGORY_BY_CODE.get(
    appCode as Exclude<KtoTourismCategoryCode, "OTHER">,
  );
  if (official) {
    return {
      ...official,
      source: appCode === "PARK"
        ? "KorService2.lclsSystm2"
        : "KorService2.lclsSystm1",
      ...officialCodes,
    };
  }

  const fallbackCode = CONTENT_TYPE_FALLBACK[text(item.contenttypeid)];
  const fallback = fallbackCode
    ? CATEGORY_BY_CODE.get(fallbackCode)
    : undefined;
  if (fallback) {
    return {
      ...fallback,
      source: "KorService2.contenttypeid",
      ...officialCodes,
    };
  }

  return {
    code: "OTHER",
    labelKo: "기타 관광",
    labelEn: "Other tourism",
    source: officialLevel1Code
      ? "KorService2.lclsSystm1"
      : "KorService2.contenttypeid",
    ...officialCodes,
  };
}
