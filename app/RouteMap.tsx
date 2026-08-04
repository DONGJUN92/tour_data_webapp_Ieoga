"use client";

/* 경로 지도.
 *
 * 엔진은 이미 `routeGeometry`로 실제 보행·자차·대중교통·자전거 경로의 좌표열을
 * 응답에 실어 보내고 있었는데 화면에서 쓰는 곳이 하나도 없었다. 여행자는
 * "1,018m 15분"이라는 숫자만 보고 그 길이 어디로 가는지 알 수 없었다.
 *
 * 외부 지도 라이브러리를 쓰지 않는다. 이 앱은 Cloudflare Workers에서 서비스되고
 * 지도 타일을 붙이면 (1) 타일 제공자 약관과 출처 표기가 또 하나 늘고 (2) 번들이
 * 커지고 (3) 오프라인·저속 회선에서 빈 회색 사각형이 남는다. 필요한 것은
 * "어디로 얼마나 가는가"의 공간 감각이므로, 좌표열을 그대로 SVG 폴리라인으로
 * 그리고 출발·도착·경유를 표시하는 것으로 충분하다. 의존성 0, CSP 안전,
 * 서버 렌더 가능.
 *
 * 타일 배경이 없으므로 "지도"라고 단정하지 않는다. 화면 문구는 "경로 개요"다. */

import { useMemo } from "react";
import styles from "./RouteMap.module.css";

export type RoutePoint = { latitude: number; longitude: number };

export type RouteMapMarker = {
  point: RoutePoint;
  label: string;
  kind: "origin" | "replacement" | "waypoint" | "destination";
};

type Props = {
  geometry: RoutePoint[];
  markers: RouteMapMarker[];
  /* 경로를 계산한 수단. 선 모양을 바꿔 도보와 자차를 눈으로 구분한다. */
  mode?: "walk" | "car" | "transit" | "bicycle";
  attribution?: string;
  /* 스크린리더가 읽을 요약. 선 그림은 읽을 수 없으므로 문장이 필수다. */
  summary: string;
  language?: "ko" | "en";
};

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 360;
const PADDING = 34;

const MODE_STROKE: Record<NonNullable<Props["mode"]>, string> = {
  walk: "6 7",
  bicycle: "12 6",
  transit: "18 6",
  car: "",
};

/* 위경도를 화면 좌표로 옮긴다. 웹 메르카토르까지 갈 필요는 없다 — 이 경로는
   길어도 20km 안쪽이고, 그 범위에서 경도 축을 위도의 코사인으로 눌러 주면
   종횡비 왜곡이 눈에 보이지 않는다. 반대로 그 보정을 빼면 한국 위도에서 동서가
   약 20% 늘어나 길이 실제보다 옆으로 퍼져 보인다. */
function project(points: RoutePoint[]) {
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const midLat = (minLat + maxLat) / 2;
  const lonScale = Math.cos((midLat * Math.PI) / 180);

  const spanX = Math.max((maxLon - minLon) * lonScale, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  /* 한 축으로만 늘리면 경로 모양이 찌그러진다. 좁은 쪽에 여백을 주고 비율을
     유지한다. */
  const scale = Math.min(
    (VIEW_WIDTH - PADDING * 2) / spanX,
    (VIEW_HEIGHT - PADDING * 2) / spanY,
  );
  const offsetX = (VIEW_WIDTH - spanX * scale) / 2;
  const offsetY = (VIEW_HEIGHT - spanY * scale) / 2;

  return (point: RoutePoint) => ({
    x: offsetX + (point.longitude - minLon) * lonScale * scale,
    /* SVG는 위쪽이 0이므로 위도를 뒤집는다. */
    y: offsetY + (maxLat - point.latitude) * scale,
  });
}

/* 좌표열이 수천 개 오면 path가 불필요하게 커진다. 화면에서 1px도 움직이지 않는
   점은 버린다. 모양은 그대로이고 문자열은 크게 줄어든다. */
function thin(points: RoutePoint[], toScreen: (point: RoutePoint) => { x: number; y: number }) {
  const kept: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    const screen = toScreen(point);
    const previous = kept[kept.length - 1];
    if (
      previous &&
      Math.abs(previous.x - screen.x) < 1 &&
      Math.abs(previous.y - screen.y) < 1
    ) {
      continue;
    }
    kept.push(screen);
  }
  return kept;
}

export function RouteMap({
  geometry,
  markers,
  mode = "walk",
  attribution,
  summary,
  language = "ko",
}: Props) {
  const shape = useMemo(() => {
    const all = [...geometry, ...markers.map((marker) => marker.point)].filter(
      (point) =>
        Number.isFinite(point.latitude) && Number.isFinite(point.longitude),
    );
    if (all.length < 2) return null;
    const toScreen = project(all);
    const line = thin(geometry, toScreen);
    return {
      path: line.length
        ? line
            .map(
              (point, index) =>
                `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
            )
            .join(" ")
        : "",
      pins: markers.map((marker) => ({
        ...marker,
        screen: toScreen(marker.point),
      })),
    };
  }, [geometry, markers]);

  if (!shape) return null;

  return (
    <figure className={styles.wrap}>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className={styles.canvas}
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* 배경 격자. 타일 지도가 아니므로 축척을 암시하지 않는 중립적인 무늬만
            둔다. 격자에 거리 의미를 주면 없는 정보를 주장하게 된다. */}
        <defs>
          <pattern
            id="route-grid"
            width="32"
            height="32"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M32 0H0V32"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.08"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect
          width={VIEW_WIDTH}
          height={VIEW_HEIGHT}
          fill="url(#route-grid)"
          className={styles.grid}
        />

        {shape.path && (
          <>
            {/* 밑선을 굵게 깔아 격자 위에서도 경로가 끊겨 보이지 않게 한다. */}
            <path d={shape.path} className={styles.routeHalo} />
            <path
              d={shape.path}
              className={styles.route}
              strokeDasharray={MODE_STROKE[mode] || undefined}
            />
          </>
        )}

        {shape.pins.map((pin, index) => (
          <g
            key={`${pin.kind}-${index}`}
            transform={`translate(${pin.screen.x.toFixed(1)} ${pin.screen.y.toFixed(1)})`}
          >
            <circle r={pin.kind === "waypoint" ? 5 : 8} className={styles[pin.kind]} />
            {pin.kind !== "waypoint" && (
              <circle r={3} className={styles.pinCore} />
            )}
          </g>
        ))}
      </svg>

      <figcaption className={styles.caption}>
        <ol className={styles.legend}>
          {markers.map((marker, index) => (
            <li key={`${marker.kind}-${index}`}>
              <span className={styles[`dot_${marker.kind}`]} aria-hidden="true" />
              {marker.label}
            </li>
          ))}
        </ol>
        {/* 타일 지도가 아님을 분명히 한다. 축척·방위를 보장하지 않는다. */}
        <small>
          {language === "en"
            ? "Route outline from the provider's returned path. Not a scaled map."
            : "경로 제공자가 돌려준 좌표를 그대로 이은 경로 개요입니다. 축척·방위를 보장하는 지도가 아닙니다."}
          {attribution ? ` · ${attribution}` : ""}
        </small>
      </figcaption>
    </figure>
  );
}
