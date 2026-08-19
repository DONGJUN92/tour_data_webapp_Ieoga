"use client";

import { OptionCarousel } from "../OptionCarousel";
import { PlacePhoto } from "../PlacePhoto";
import { RouteMap, type RouteMapMarker, type RoutePoint } from "../RouteMap";
import { ktoTourismCategory } from "@/lib/kto/category";
import styles from "./course-preview.module.css";

/* 코스를 여행자가 이해할 수 있게 보여 준다.
 *
 * 예전에는 "구봉산(대전) → 오백돈 대전본점 → 장태산자연휴양림 → 평송청소년문화센터"
 * 처럼 이름을 화살표로 이은 한 줄이었다. 그 줄로는 고를 수가 없다 — 어디에 있는지,
 * 몇 시에 여는지, 어떻게 가는지를 하나도 알 수 없기 때문이다.
 *
 * 첫 화면은 동선 지도, 그다음부터 지점 카드 하나씩. 마지막 지점에서 오른쪽을 한 번
 * 더 누르면 처음 화면으로 돌아온다. 캐러셀은 대안 목록과 **같은 것**을 쓴다 —
 * 화살표·순환·순번 표시가 같으므로 여행자가 조작을 새로 배우지 않는다.
 *
 * 지도의 선에 대해. 이것은 지점 좌표를 순서대로 이은 직선이고 실제 이동 경로가
 * 아니다. 경로 조회는 요청당 외부 조회 예산을 쓰므로 계획 단계에서 지점마다 쓰지
 * 않는다 — 실제 경로는 일정이 틀어져 복구할 때 조회한다. 그 사실을 지도 아래에
 * 적어, 그려진 선을 경로로 오해하지 않게 한다. */

type Language = "ko" | "en";

type CourseStop = {
  contentId: string;
  contentTypeId: string;
  title: string;
  address?: string;
  latitude: number;
  longitude: number;
  imageUrl?: string;
  operatingHours?: string;
  restDate?: string;
  contact?: string;
  legMeters?: number;
  legMode?: "walk" | "transit" | "car";
};

type Course = {
  source: "official" | "assembled";
  title: string;
  stops: CourseStop[];
};

const MODE_LABEL: Record<
  "walk" | "transit" | "car",
  { ko: string; en: string }
> = {
  walk: { ko: "걸어서", en: "on foot" },
  transit: { ko: "대중교통으로", en: "by transit" },
  car: { ko: "차로", en: "by car" },
};

function readableDistance(meters: number, language: Language): string {
  if (meters < 1_000) {
    return language === "en" ? `${meters} m` : `${meters}m`;
  }
  const km = (meters / 1_000).toFixed(1);
  return language === "en" ? `${km} km` : `${km}km`;
}

export function CoursePreview({
  course,
  language,
  onApply,
  applying,
  onBack,
  /* 돌아갈 목록이 있는가. 코스가 하나뿐이면 「다른 코스 보기」를 눌러도 같은
     화면으로 돌아오므로, 있으나 없으나인 버튼을 두지 않는다. */
  canGoBack,
}: {
  course: Course;
  language: Language;
  onApply: () => void;
  applying: boolean;
  onBack: () => void;
  canGoBack: boolean;
}) {
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);
  const stops = course.stops;
  if (!stops.length) return null;

  const geometry: RoutePoint[] = stops.map((stop) => ({
    latitude: stop.latitude,
    longitude: stop.longitude,
  }));
  const markers: RouteMapMarker[] = stops.map((stop, index) => ({
    point: { latitude: stop.latitude, longitude: stop.longitude },
    label: `${index + 1}. ${stop.title}`,
    kind:
      index === 0
        ? "origin"
        : index === stops.length - 1
          ? "destination"
          : "waypoint",
  }));
  const totalMeters = stops.reduce(
    (sum, stop) => sum + (stop.legMeters ?? 0),
    0,
  );

  return (
    <>
      <OptionCarousel
        /* 화면 수 = 동선 한 장 + 지점 수. */
        total={stops.length + 1}
        language={language}
        perView={1}
        testId="course-preview-carousel"
        trackLabel={tr(
          "코스 동선과 지점. 좌우로 넘길 수 있습니다.",
          "The course route and its stops. Scroll left and right.",
        )}
        formatPosition={(visible) => {
          const at = visible[0] ?? 1;
          if (at === 1) {
            return tr(
              `동선 한눈에 · 지점 ${stops.length}곳`,
              `Route overview · ${stops.length} stops`,
            );
          }
          return tr(
            `${stops.length}곳 중 ${at - 1}번째 지점`,
            `Stop ${at - 1} of ${stops.length}`,
          );
        }}
      >
        <li className={styles.screen}>
          <RouteMap
            geometry={geometry}
            markers={markers}
            mode="walk"
            language={language}
            attribution={tr(
              "지점 좌표를 순서대로 이은 선입니다. 실제 이동 경로가 아니며, 경로는 일정이 틀어졌을 때 조회합니다.",
              "A line connecting the official coordinates in order — not a routed path. Routes are calculated when a trip is disrupted.",
            )}
            summary={tr(
              `${stops.map((stop) => stop.title).join(", ")} 순서로 이동하는 코스 동선입니다. 지점 사이 직선거리 합계는 약 ${readableDistance(totalMeters, "ko")}입니다.`,
              `Course route through ${stops.map((stop) => stop.title).join(", ")}. The straight-line distance between stops totals about ${readableDistance(totalMeters, "en")}.`,
            )}
          />
          <dl className={styles.summary}>
            <div>
              <dt>{tr("지점", "Stops")}</dt>
              <dd>{tr(`${stops.length}곳`, `${stops.length}`)}</dd>
            </div>
            <div>
              <dt>{tr("직선거리 합계", "Straight-line total")}</dt>
              <dd>{readableDistance(totalMeters, language)}</dd>
            </div>
          </dl>
        </li>

        {stops.map((stop, index) => {
          const category = ktoTourismCategory({
            contenttypeid: stop.contentTypeId,
          });
          return (
            <li className={styles.screen} key={stop.contentId}>
              <PlacePhoto
                imageUrl={stop.imageUrl}
                title={stop.title}
                categoryCode={category.code}
                categoryLabel={
                  language === "en" ? category.labelEn : category.labelKo
                }
                language={language}
              />
              <div className={styles.stopBody}>
                <span className={styles.stopOrder}>
                  {tr(`${index + 1}번째 지점`, `Stop ${index + 1}`)}
                </span>
                <h4 className={styles.stopTitle}>{stop.title}</h4>
                {stop.address && (
                  <p className={styles.stopAddress}>{stop.address}</p>
                )}
                <dl className={styles.stopFacts}>
                  <div>
                    <dt>{tr("운영시간", "Hours")}</dt>
                    {/* 없는 값을 있는 척하지 않는다. 카드가 비어 있는 것과 "공사
                        정보에 없다"는 것은 여행자에게 다른 뜻이다. */}
                    <dd>
                      {stop.operatingHours ??
                        tr("공사 정보에 없어요", "Not in the official data")}
                    </dd>
                  </div>
                  {stop.restDate && (
                    <div>
                      <dt>{tr("휴무", "Closed")}</dt>
                      <dd>{stop.restDate}</dd>
                    </div>
                  )}
                  {stop.contact && (
                    <div>
                      <dt>{tr("문의", "Phone")}</dt>
                      <dd>{stop.contact}</dd>
                    </div>
                  )}
                  {index > 0 && stop.legMeters !== undefined && (
                    <div>
                      <dt>{tr("앞 지점에서", "From the previous stop")}</dt>
                      <dd>
                        {tr(
                          `${MODE_LABEL[stop.legMode ?? "walk"].ko} ${readableDistance(stop.legMeters, "ko")} (직선거리 기준)`,
                          `${readableDistance(stop.legMeters, "en")} ${MODE_LABEL[stop.legMode ?? "walk"].en} (straight-line)`,
                        )}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            </li>
          );
        })}
      </OptionCarousel>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.apply}
          data-testid="plan-use-course"
          disabled={applying}
          onClick={onApply}
        >
          {applying
            ? tr("일정으로 옮기는 중…", "Adding to your trip…")
            : tr("이 코스로 일정 만들기", "Use this course")}
        </button>
        {canGoBack && (
          <button type="button" className={styles.back} onClick={onBack}>
            {tr("다른 코스 보기", "See other courses")}
          </button>
        )}
      </div>
    </>
  );
}
