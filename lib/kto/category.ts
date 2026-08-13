import type { KtoItem } from "./types";

/* KorService2의 공식 대·중분류를 앱 필터에 맞게 묶은 분류다. 도시공원은
   대분류상 문화관광(VE)이지만 공식 중분류 VE02/VE03에 들어 있으므로, 대분류만
   쓰면 사용자가 공원을 찾을 수 없다. 장소명 추측 없이 lclsSystm1~3만 사용한다. */
export const KTO_TOURISM_CATEGORIES = [
  { code: "PARK", labelKo: "공원", labelEn: "Parks" },
  { code: "HERITAGE", labelKo: "문화유산", labelEn: "Heritage" },
  { code: "FOOD", labelKo: "식당", labelEn: "Food" },
  { code: "CULTURE", labelKo: "문화", labelEn: "Culture" },
  { code: "NATURE", labelKo: "자연", labelEn: "Nature" },
  { code: "EXPERIENCE", labelKo: "체험관광", labelEn: "Experiences" },
  { code: "EVENT", labelKo: "축제·공연·행사", labelEn: "Events" },
  { code: "LEISURE", labelKo: "레저스포츠", labelEn: "Leisure sports" },
  { code: "SHOPPING", labelKo: "쇼핑", labelEn: "Shopping" },
  { code: "ACCOMMODATION", labelKo: "숙박", labelEn: "Accommodation" },
  { code: "COURSE", labelKo: "추천코스", labelEn: "Travel courses" },
] as const;

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
