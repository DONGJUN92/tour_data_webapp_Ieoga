/**
 * 지점명이 붙은 장소 검색어를 분해한다.
 *
 * 관광정보 `searchKeyword2`는 등록된 제목과의 문자열 유사도로 검색한다.
 * 그런데 한국의 프랜차이즈·분점 이름은 제목에 지점이 안 붙거나, 붙어도
 * 표기가 다르다. 예를 들어 `성심당 DCC점`을 그대로 넣으면 결과가 없고,
 * `성심당`만 넣으면 본점만, `DCC`만 넣으면 대전컨벤션센터만 나온다.
 * 사용자는 세 번 검색해도 자기가 찾는 지점에 도달하지 못한다.
 *
 * 그래서 검색어를 `기저명 + 지점 단서`로 쪼갠다. 기저명으로 관광정보를 다시
 * 조회하고, 지점 단서는 (1) 결과 제목·주소 가중치와 (2) 지점 단서를 좌표로
 * 바꿔 그 주변을 다시 훑는 앵커로 쓴다.
 */

/** 지점 단서로 자주 쓰이는 시설 종류. `롯데백화점점`처럼 붙여 쓴 경우도 잡는다. */
const LANDMARK_WORDS = [
  "백화점",
  "면세점",
  "아웃렛",
  "몰",
  "복합몰",
  "컨벤션",
  "컨벤션센터",
  "전시장",
  "역",
  "터미널",
  "공항",
  "휴게소",
  "캠퍼스",
  "대학교",
  "병원",
  "호텔",
  "리조트",
  "타워",
  "센터",
  "시장",
  "공원",
  "월드",
  "랜드",
];

const BRANCH_SUFFIX = /(직영점|본점|분점|지점|점)$/u;

export type BranchQuery = {
  raw: string;
  /** 지점 단서를 떼어낸 상호. `성심당 DCC점` → `성심당` */
  base: string;
  /** 지점 단서. `성심당 DCC점` → `DCC`. 없으면 undefined */
  branch?: string;
  /** 지점 단서를 좌표 앵커로 조회할 때 쓰는 검색어. `DCC` → `DCC` */
  anchorKeyword?: string;
  /** 원문에 `~점` 형태의 지점 표기가 있었는지 */
  hasBranchSuffix: boolean;
};

function squash(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** 검색어 정규화: 공백 제거 + 소문자 + 유니코드 정규화 */
export function normalizeName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

/**
 * 지점 단서를 분리한다.
 *
 * 분리하지 못하면 `base`는 원문과 같고 `branch`는 undefined다. 그 경우
 * 호출부는 예전과 동일하게 동작한다.
 */
export function parseBranchQuery(keyword: string): BranchQuery {
  const raw = squash(keyword);
  if (!raw) {
    return { raw, base: raw, hasBranchSuffix: false };
  }

  // `성심당(DCC점)` / `성심당 [DCC점]` 처럼 괄호에 지점을 넣는 표기
  // (프로젝트 TS 타깃이 ES2017이라 이름 붙은 캡처 그룹은 쓸 수 없다)
  const bracketed = raw.match(
    /^(.+?)\s*[([{『「]\s*([^)\]}』」]+?)\s*[)\]}』」]\s*$/u,
  );
  if (bracketed) {
    const base = squash(bracketed[1]);
    const inner = squash(bracketed[2]);
    const branch = squash(inner.replace(BRANCH_SUFFIX, ""));
    if (base && branch) {
      return {
        raw,
        base,
        branch,
        anchorKeyword: branch,
        hasBranchSuffix: BRANCH_SUFFIX.test(inner),
      };
    }
  }

  const tokens = raw.split(" ");

  // `성심당 DCC점`, `스타벅스 대전역점` — 마지막 토큰이 `~점`으로 끝난다.
  //
  // 다만 `백화점`, `면세점`처럼 시설 이름 자체가 `점`으로 끝나는 경우가 있다.
  // 그때 접미사를 떼면 `롯데백화점`이 `롯데백화`가 되어 앵커 조회가 실패한다.
  // 그래서 토큰이 시설 이름으로 끝나면 그대로 지점 단서로 쓴다.
  const endsWithLandmark = (value: string) =>
    LANDMARK_WORDS.some((word) => value.endsWith(word));

  if (
    tokens.length >= 2 &&
    BRANCH_SUFFIX.test(tokens[tokens.length - 1]) &&
    !endsWithLandmark(tokens[tokens.length - 1])
  ) {
    const last = tokens[tokens.length - 1];
    const branch = squash(last.replace(BRANCH_SUFFIX, ""));
    const base = squash(tokens.slice(0, -1).join(" "));
    if (base) {
      // `성심당 본점`처럼 지점 단서가 사라지는 경우는 기저명만 남긴다.
      if (!branch) {
        return { raw, base, hasBranchSuffix: true };
      }
      return {
        raw,
        base,
        branch,
        anchorKeyword: branch,
        hasBranchSuffix: true,
      };
    }
  }

  // 붙여 쓴 경우: `성심당롯데백화점점`, `성심당DCC점`
  if (tokens.length === 1 && BRANCH_SUFFIX.test(raw)) {
    const stripped = raw.replace(BRANCH_SUFFIX, "");
    for (const word of LANDMARK_WORDS) {
      const index = stripped.lastIndexOf(word);
      if (index > 0) {
        const base = squash(stripped.slice(0, index));
        const branch = squash(stripped.slice(index));
        if (base && branch) {
          return {
            raw,
            base,
            branch,
            anchorKeyword: branch,
            hasBranchSuffix: true,
          };
        }
      }
    }
    // 로마자 약어가 뒤에 붙은 경우: `성심당DCC점`
    const abbreviation = stripped.match(/^(.*[가-힣])([A-Za-z0-9]{2,6})$/u);
    if (abbreviation) {
      return {
        raw,
        base: squash(abbreviation[1]),
        branch: squash(abbreviation[2]),
        anchorKeyword: squash(abbreviation[2]),
        hasBranchSuffix: true,
      };
    }
  }

  // 지점 표기가 없어도 마지막 토큰이 시설 이름이면 지점 단서로 본다.
  // `성심당 롯데백화점`, `투썸플레이스 대전역`
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    if (endsWithLandmark(last)) {
      const base = squash(tokens.slice(0, -1).join(" "));
      if (base) {
        return {
          raw,
          base,
          branch: last,
          anchorKeyword: last,
          hasBranchSuffix: false,
        };
      }
    }
  }

  return { raw, base: raw, hasBranchSuffix: BRANCH_SUFFIX.test(raw) };
}

/**
 * 지점 단서가 결과에 실제로 나타나는지 본다.
 *
 * 제목에 있으면 확실하고(`성심당 DCC점`), 주소에만 있어도 근거가 된다
 * (`대전컨벤션센터 1층`). 지점 단서가 없으면 0을 돌려준다.
 */
export function branchAffinity(
  query: BranchQuery,
  title: string,
  address: string,
): number {
  if (!query.branch) return 0;
  const branch = normalizeName(query.branch);
  if (!branch) return 0;
  const name = normalizeName(title);
  const where = normalizeName(address);
  if (name.includes(branch)) return 1;
  if (where.includes(branch)) return 0.6;

  /* 지점 단서가 정확히 안 맞아도 지역만은 맞아야 한다. `스타벅스 대전역점`을
     물었을 때 `스타벅스 강릉강문해변점`이 1순위로 올라오면 안 된다.
     지점 단서의 앞 두 글자(대개 지역명)가 제목이나 주소에 있으면 부분
     점수를 준다. 정확히 찾은 것은 아니므로 값은 낮게 둔다. */
  const prefix = branch.slice(0, 2);
  if (prefix.length === 2 && (name.includes(prefix) || where.includes(prefix))) {
    return 0.3;
  }
  return 0;
}

/** 기저명이 결과 제목에 들어 있는지. 앵커 주변 결과를 걸러낼 때 쓴다. */
export function matchesBase(query: BranchQuery, title: string): boolean {
  const base = normalizeName(query.base);
  if (base.length < 2) return false;
  return normalizeName(title).includes(base);
}
