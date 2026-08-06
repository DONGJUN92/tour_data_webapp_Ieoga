"use client";

/* 경로 지도.
 *
 * 엔진은 이미 `routeGeometry`로 실제 보행·자차·대중교통·자전거 경로의 좌표열을
 * 응답에 실어 보내고 있었는데 화면에서 쓰는 곳이 하나도 없었다.
 *
 * 처음에는 타일 없이 선만 그렸다. 그런데 실제로 써 보면 **선만 있고 배경이 없어
 * 어디인지 알 수 없다.** 격자 위의 꺾인 선은 "여기서 저기로 간다"는 것만 말하고
 * 그곳이 강 건너인지 산 쪽인지 시내인지 알려 주지 않는다. 위기 순간에 필요한
 * 판단은 "이 방향이 내가 아는 그 방향인가"이므로 배경이 있어야 한다.
 *
 * 그래서 웹 메르카토르로 투영을 바꾸고 표준 타일을 배경에 깐다. 외부 지도
 * 라이브러리는 여전히 쓰지 않는다 — 타일 좌표 계산은 몇 줄이고, 라이브러리를
 * 넣으면 번들과 CSP가 함께 늘어난다. 타일은 `<image>`로 SVG 안에 놓아 경로·핀과
 * 같은 좌표계를 쓰므로 어긋날 수 없다.
 *
 * 타일 제공자는 환경변수로 바꿀 수 있게 두고 출처를 화면에 표기한다. 표기는
 * 선택이 아니라 이용약관이다. */
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

/* 타일 지도 배경.
   기본값은 표준 OSM 타일이다. 운영자가 국토지리정보원 등 다른 제공자로 바꿀 수
   있도록 주소와 출처 문구를 함께 상수로 둔다 — 출처 표기는 이용약관이다. */
const TILE_URL_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = "지도 © OpenStreetMap 기여자";
const TILE_SIZE = 256;
const MAX_ZOOM = 17;
const MIN_ZOOM = 3;

/* 위경도를 웹 메르카토르 세계 픽셀로. 타일 좌표계와 같은 식이라 배경 타일과
   경로가 정확히 겹친다. */
function worldX(longitude: number, zoom: number): number {
  return ((longitude + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function worldY(latitude: number, zoom: number): number {
  const clamped = Math.max(Math.min(latitude, 85.05112878), -85.05112878);
  const radians = (clamped * Math.PI) / 180;
  const merc = Math.log(Math.tan(radians) + 1 / Math.cos(radians));
  return (0.5 - merc / (2 * Math.PI)) * TILE_SIZE * 2 ** zoom;
}

function project(points: RoutePoint[]) {
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);

  /* 경로가 여백 안에 다 들어오는 가장 확대된 배율을 고른다. 너무 멀리서 보면
     골목이 한 점으로 뭉치고, 너무 가까우면 도착지가 화면 밖으로 나간다. */
  let zoom = MAX_ZOOM;
  while (zoom > MIN_ZOOM) {
    const spanX = worldX(maxLon, zoom) - worldX(minLon, zoom);
    const spanY = worldY(minLat, zoom) - worldY(maxLat, zoom);
    if (
      spanX <= VIEW_WIDTH - PADDING * 2 &&
      spanY <= VIEW_HEIGHT - PADDING * 2
    ) {
      break;
    }
    zoom -= 1;
  }

  const centerX = (worldX(minLon, zoom) + worldX(maxLon, zoom)) / 2;
  const centerY = (worldY(minLat, zoom) + worldY(maxLat, zoom)) / 2;
  const originX = centerX - VIEW_WIDTH / 2;
  const originY = centerY - VIEW_HEIGHT / 2;

  const toScreen = (point: RoutePoint) => ({
    x: worldX(point.longitude, zoom) - originX,
    y: worldY(point.latitude, zoom) - originY,
  });

  /* 화면을 덮는 타일 목록. 여백까지 채워야 경로 주변이 회색으로 잘리지 않는다. */
  const tiles: Array<{ key: string; href: string; x: number; y: number }> = [];
  const maxIndex = 2 ** zoom - 1;
  const firstTileX = Math.floor(originX / TILE_SIZE);
  const lastTileX = Math.floor((originX + VIEW_WIDTH) / TILE_SIZE);
  const firstTileY = Math.floor(originY / TILE_SIZE);
  const lastTileY = Math.floor((originY + VIEW_HEIGHT) / TILE_SIZE);
  for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
    for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
      /* 경도는 지구를 돌지만 위도는 그렇지 않다. 범위를 벗어난 세로 타일은
         존재하지 않으므로 요청하지 않는다. */
      if (tileY < 0 || tileY > maxIndex) continue;
      const wrappedX = ((tileX % (maxIndex + 1)) + maxIndex + 1) % (maxIndex + 1);
      tiles.push({
        key: `${zoom}-${tileX}-${tileY}`,
        href: TILE_URL_TEMPLATE.replace("{z}", String(zoom))
          .replace("{x}", String(wrappedX))
          .replace("{y}", String(tileY)),
        x: tileX * TILE_SIZE - originX,
        y: tileY * TILE_SIZE - originY,
      });
    }
  }

  return { toScreen, tiles, zoom };
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
    const { toScreen, tiles } = project(all);
    const line = thin(geometry, toScreen);
    return {
      tiles,
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
        {/* 지도 타일. 경로·핀과 같은 좌표계로 놓았으므로 어긋날 수 없다.
            타일이 늦게 오거나 실패해도 아래 경로는 그대로 보인다 — 배경이
            없어도 판단을 못 하게 되는 것보다 낫다. */}
        {shape.tiles.map((tile) => (
          <image
            key={tile.key}
            href={tile.href}
            x={tile.x}
            y={tile.y}
            width={TILE_SIZE}
            height={TILE_SIZE}
            /* 배경이 너무 선명하면 경로선이 묻힌다. 살짝 눌러 경로를 앞세운다. */
            opacity="0.82"
            preserveAspectRatio="none"
          />
        ))}

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
        {/* 타일 출처 표기는 이용약관이다. 경로 제공자 표기와 함께 적는다. */}
        <small>
          {language === "en"
            ? "Route drawn from the provider's returned path on a standard map background."
            : "경로 제공자가 돌려준 좌표를 지도 배경 위에 그렸습니다."}
          {` · ${TILE_ATTRIBUTION}`}
          {attribution ? ` · ${attribution}` : ""}
        </small>
      </figcaption>
    </figure>
  );
}
