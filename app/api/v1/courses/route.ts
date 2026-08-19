import { NextRequest } from "next/server";
import { z } from "zod";
import { allowDurableRequest } from "@/lib/durable-rate-limit";
import { jsonResponse } from "@/lib/http";
import { allowRequest, requestRateKey } from "@/lib/rate-limit";
import {
  getAreaCourses,
  getAreaPlaces,
  getCourseStops,
  getTourismCommonDetail,
} from "@/lib/kto/adapters";
import type { KtoAudit, KtoItem } from "@/lib/kto/types";
import {
  assembleLocalCourse,
  type CoursePlan,
  type CourseStop,
} from "@/lib/course/plan";

export const dynamic = "force-dynamic";

/* 여행을 처음 계획하는 자리에서 추천코스를 받는다.
 *
 * 두 갈래를 **출처를 밝혀** 돌려준다. 공사 공식 추천코스가 있는 지역이면 그것을,
 * 없는 지역이면 그 지역의 실제 공사 관광정보로 우리가 엮은 하루 코스를 준다.
 * 2026-08-19 실측으로 공식 코스는 16개 시·도 중 11곳·전국 53건이고 서울·대전·
 * 울산·제주·세종은 0건이므로, 두 번째 갈래가 없으면 주요 도시에서 기능이 아니다.
 *
 * 어느 쪽도 없으면 빈 목록을 정상 응답으로 돌려준다. 없는 코스를 만들어 채우지
 * 않는다 — 이 앱의 다른 모든 화면과 같은 규칙이다. */

const requestSchema = z
  .object({
    regionCode: z
      .string()
      .trim()
      .regex(/^\d{2}(?:\d{3})?$/)
      .optional(),
    districtCode: z
      .string()
      .trim()
      .regex(/^\d{5}$/)
      .optional(),
    regionName: z.string().trim().min(1).max(40).optional(),
    /* 코스 하나의 구성 지점까지 받아 온다. 목록만 필요할 때는 비워 둔다. */
    contentId: z
      .string()
      .trim()
      .regex(/^\d{1,12}$/)
      .optional(),
  })
  .strict();

/* 코스 하나를 일정으로 만드는 비용은 1(지점 목록) + N(지점별 좌표)이다. 실측
   중앙값이 7지점이므로, 무료 플랜의 요청당 외부 조회 50건 안에서 안전하게
   다루려면 상한이 필요하다. 넘치는 지점은 조용히 버리지 않고 밝힌다. */
const MAX_RESOLVED_STOPS = 10;

function text(item: KtoItem, key: string): string {
  const value = item[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizedImage(value: string): string | undefined {
  if (!value) return undefined;
  return value.startsWith("http://") ? `https://${value.slice(7)}` : value;
}

function toCourseSummary(item: KtoItem): CoursePlan | undefined {
  const contentId = text(item, "contentid");
  const title = text(item, "title");
  if (!contentId || !title) return undefined;
  return {
    source: "official",
    contentId,
    title,
    imageUrl: normalizedImage(
      text(item, "firstimage") || text(item, "firstimage2"),
    ),
    stops: [],
  };
}

export async function POST(request: NextRequest) {
  const burst = allowRequest(requestRateKey(request, "courses"), 20);
  if (!burst.allowed) {
    const response = jsonResponse(
      {
        error: {
          code: "RATE_LIMITED",
          message: "코스 조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(burst.retryAfterSeconds));
    return response;
  }
  const durable = await allowDurableRequest(request, "courses", 20);
  if (!durable.allowed) {
    return jsonResponse(
      {
        error: {
          code: durable.unavailable
            ? "RATE_LIMIT_UNAVAILABLE"
            : "RATE_LIMITED",
          message: durable.unavailable
            ? "코스 조회 한도를 확인할 수 없어 안전하게 중단했습니다."
            : "코스 조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: durable.unavailable ? 503 : 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        error: {
          code: "INVALID_JSON",
          message: "코스 조회 요청 형식을 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: {
          code: "INVALID_COURSE_REQUEST",
          message: "지역 코드를 확인해 주세요.",
        },
      },
      { status: 400 },
    );
  }
  const input = parsed.data;
  if (!input.regionCode) {
    return jsonResponse(
      {
        error: {
          code: "REGION_REQUIRED",
          message:
            "코스를 추천하려면 시·도를 먼저 골라 주세요. 추천코스는 행정구역 단위로 제공됩니다.",
        },
      },
      { status: 400 },
    );
  }

  const ledger: KtoAudit[] = [];
  const notes: string[] = [];

  /* ---- 코스 하나의 구성 지점 채우기 ---- */
  if (input.contentId) {
    let stopsResult;
    try {
      stopsResult = await getCourseStops(input.contentId);
    } catch {
      return jsonResponse(
        {
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message:
              "한국관광공사 코스 상세 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
          },
        },
        { status: 503 },
      );
    }
    ledger.push(stopsResult.audit);
    const rows = stopsResult.items
      .map((item) => ({
        subContentId: text(item, "subcontentid"),
        subName: text(item, "subname"),
        order: Number(item.subnum ?? 0),
      }))
      .filter((row) => row.subContentId)
      .sort((a, b) => a.order - b.order);
    if (rows.length > MAX_RESOLVED_STOPS) {
      notes.push(
        `이 코스는 지점이 ${rows.length}곳입니다. 요청당 조회 한도 안에서 앞의 ${MAX_RESOLVED_STOPS}곳만 좌표를 확인했습니다.`,
      );
    }

    /* 지점 좌표는 `detailInfo2`에 없어 지점마다 한 번 더 조회해야 한다. */
    const stops: CourseStop[] = [];
    for (const row of rows.slice(0, MAX_RESOLVED_STOPS)) {
      try {
        const detail = await getTourismCommonDetail(row.subContentId);
        ledger.push(detail.audit);
        const item = detail.items[0];
        if (!item) continue;
        const latitude = Number(item.mapy);
        const longitude = Number(item.mapx);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
        stops.push({
          contentId: row.subContentId,
          contentTypeId: text(item, "contenttypeid"),
          title: text(item, "title") || row.subName,
          address: text(item, "addr1") || undefined,
          latitude,
          longitude,
          imageUrl: normalizedImage(
            text(item, "firstimage") || text(item, "firstimage2"),
          ),
        });
      } catch {
        /* 한 지점을 못 받아도 코스 전체를 버리지 않는다. 몇 곳을 확인했는지는
           아래에서 밝힌다. */
      }
    }
    if (stops.length !== rows.length) {
      notes.push(
        `코스의 ${rows.length}개 지점 중 좌표를 확인한 ${stops.length}곳만 일정에 넣을 수 있습니다.`,
      );
    }
    return jsonResponse({
      status: stops.length >= 2 ? "ready" : "insufficient",
      course: {
        source: "official" as const,
        contentId: input.contentId,
        title: "",
        regionCode: input.regionCode,
        districtCode: input.districtCode,
        stops,
      },
      notes,
      sourceLedger: ledger,
    });
  }

  /* ---- 지역의 코스 목록 ---- */
  let official;
  try {
    official = await getAreaCourses({
      regionCode: input.regionCode,
      districtCode: input.districtCode,
    });
    ledger.push(official.audit);
  } catch {
    return jsonResponse(
      {
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message:
            "한국관광공사 추천코스를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 503 },
    );
  }

  const courses = official.items
    .map(toCourseSummary)
    .filter((course): course is CoursePlan => Boolean(course));

  if (courses.length) {
    return jsonResponse({
      status: "official",
      courses,
      notes,
      sourceLedger: ledger,
    });
  }

  /* 공식 코스가 없는 지역. 그 지역의 실제 공사 장소로 하루 코스를 엮는다.
     장소는 모두 공사 콘텐츠이고, 엮은 순서가 우리 것이라는 사실을 밝힌다. */
  notes.push(
    "이 지역에는 한국관광공사가 등록한 공식 추천코스가 없습니다. 같은 지역의 공사 관광정보로 하루 코스를 엮어 드립니다.",
  );
  try {
    const [sights, culture, meals] = await Promise.all([
      getAreaPlaces({
        regionCode: input.regionCode,
        districtCode: input.districtCode,
        contentTypeId: "12",
        numOfRows: 30,
      }),
      getAreaPlaces({
        regionCode: input.regionCode,
        districtCode: input.districtCode,
        contentTypeId: "14",
        numOfRows: 15,
      }),
      getAreaPlaces({
        regionCode: input.regionCode,
        districtCode: input.districtCode,
        contentTypeId: "39",
        numOfRows: 20,
      }),
    ]);
    ledger.push(sights.audit, culture.audit, meals.audit);
    const assembled = assembleLocalCourse({
      sights: [...sights.items, ...culture.items],
      meals: meals.items,
      regionName: input.regionName ?? "이 지역",
      regionCode: input.regionCode,
      districtCode: input.districtCode,
    });
    if (!assembled) {
      return jsonResponse({
        status: "empty",
        courses: [],
        notes: [
          ...notes,
          "이 지역에서 하루 코스를 엮을 만한 공사 관광정보를 찾지 못했습니다. 없는 코스를 만들어 드리지는 않습니다.",
        ],
        sourceLedger: ledger,
      });
    }
    return jsonResponse({
      status: "assembled",
      courses: [assembled],
      notes,
      sourceLedger: ledger,
    });
  } catch {
    return jsonResponse(
      {
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message:
            "한국관광공사 관광정보를 불러오지 못해 코스를 엮지 못했습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 503 },
    );
  }
}
