const EARTH_RADIUS_METERS = 6_371_000;

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

export function haversineMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const fromLatitude = radians(from.latitude);
  const toLatitude = radians(to.latitude);

  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    EARTH_RADIUS_METERS *
    2 *
    Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
  );
}

/* 두 지점이 같은 곳인가.
 *
 * 좁게 잡았다. 공사 자료는 같은 장소를 같은 콘텐츠로 주므로 **이름이 같으면**
 * 같은 곳이고, 좌표는 "대전역"과 "대전역 동광장"처럼 표기가 갈리는 경우만
 * 잡는다. 60m는 역·공원처럼 넓은 지점의 대표 좌표가 자료마다 흔들리는 폭이고,
 * 이보다 넓히면 100m 떨어진 다른 식당까지 같은 곳으로 묶여 멀쩡한 후보가
 * 사라진다.
 *
 * 이 판별기가 필요한 곳은 하나다 — 여행자가 이미 출발지로 정한 곳이 코스의
 * 지점으로 다시 올라오는 것을 막는 자리. 후보끼리 서로 묶는 데에는 쓰지 않는다.
 *
 * 이 파일에 두는 이유는 번들이다. `lib/geo.ts`는 import가 없는 잎 모듈이어서
 * 화면에서 가져와도 서버 전용 모듈을 끌고 오지 않는다. */
export const SAME_SPOT_METERS = 60;

export function isSameSpot(
  a: { title?: string; latitude: number; longitude: number },
  b: { title?: string; latitude: number; longitude: number },
): boolean {
  const titleA = a.title?.trim();
  const titleB = b.title?.trim();
  if (titleA && titleB && titleA === titleB) return true;
  return haversineMeters(a, b) <= SAME_SPOT_METERS;
}

export function conservativeWalkingMinutes(distanceMeters: number): number {
  return Math.max(1, Math.ceil(distanceMeters / 60) + 4);
}

/* 자차의 보수 추정. 도심 평균 20km/h(=333m/분)로 직선거리를 환산하고 주차·도보
   접근에 6분을 더한다. 후보를 미리 걸러내는 용도이므로 실제보다 넉넉해야 하며,
   살아남은 후보의 이동시간은 실제 경로로 다시 계산해 덮어쓴다. */
export function conservativeDrivingMinutes(distanceMeters: number): number {
  return Math.max(1, Math.ceil(distanceMeters / 333) + 6);
}

/* 자전거는 도심 15km/h(=250m/분)에 주차·잠금 3분. */
export function conservativeCyclingMinutes(distanceMeters: number): number {
  return Math.max(1, Math.ceil(distanceMeters / 250) + 3);
}

/* 대중교통은 표정속도 18km/h(=300m/분)에 도보 접근·대기 12분을 더한다. 배차를
   모르는 단계이므로 넉넉해야 한다. 실제 소요시간은 카카오 응답으로 덮어쓴다. */
export function conservativeTransitMinutes(distanceMeters: number): number {
  return Math.max(1, Math.ceil(distanceMeters / 300) + 12);
}

/* 위의 `conservative*`와 **방향이 반대인** 추정. 이쪽은 "이 수단이 낼 수 있는
   최대 속도로 우회 없이 직선으로 갔을 때"의 시간, 즉 **하한**이다.

   두 추정을 방향에 맞게 써야 한다. 보수 추정은 넉넉하므로 후보를 걸러내고
   순위를 매기는 데 맞지만, 그것으로 "불가능"을 선언하면 실제로 갈 수 있는 곳을
   거부한다 — fail-closed가 깨지는 유일한 방향의 오류다. 그래서 규칙은 하나다:
   **거부는 하한으로, 제안은 상한으로.**

   속도값은 각 수단의 물리적·법적 상한에서 잡았다. 도보 5.1km/h는 지속 보행의
   상한이고, 자동차 120km/h는 고속도로 제한속도 110km/h에 여유를 더한 값이다.
   실제 도로 거리는 직선거리보다 짧을 수 없으므로 이 값으로 나눈 시간은 어떤
   경로로도 줄일 수 없다.

   이 값들은 아직 제공자 경로 실측으로 고정한 것이 아니다. 도시간 구간에서
   직선 기준 평균속도가 상한을 넘으면 하한이 하한이 아니게 되므로, 거리대·수단별
   실측으로 검증해야 한다. 그래서 여유를 크게 잡아 두었다. */
const OPTIMISTIC_METERS_PER_MINUTE = {
  walk: 85,
  bicycle: 500,
  transit: 1_667,
  car: 2_000,
} as const;

export type GeoTravelMode = keyof typeof OPTIMISTIC_METERS_PER_MINUTE;

/* 이동수단을 이 표의 키로 정규화한다. 모르는 값은 **보행**으로 본다 — 이 엔진의
   다른 계산(`travelModeLabel`, 수단별 보수 추정)이 모두 그렇게 하므로 여기서만
   다르게 굴면 같은 요청이 자리마다 다른 수단으로 계산된다.

   단순히 캐스팅으로 넘기면 값이 없는 요청에서 `undefined` 키를 읽어 `NaN`이
   전파된다. 실제로 그렇게 해서 "반경 NaNkm 안에서 후보를 찾았습니다"라는 문장이
   사용자에게 나갈 뻔했다. */
export function geoTravelMode(mode: string | undefined): GeoTravelMode {
  return mode === "car" || mode === "bicycle" || mode === "transit"
    ? mode
    : "walk";
}

export function optimisticTravelMinutes(
  distanceMeters: number,
  mode: GeoTravelMode,
): number {
  return distanceMeters / OPTIMISTIC_METERS_PER_MINUTE[mode];
}

/* 주어진 이동시간 예산으로 **어떤 경로로도 넘을 수 없는** 직선 도달 거리.
   후보 탐색 반경의 상한으로 쓴다 — 이 값보다 먼 곳은 탐색해 봐야 통과할 수
   없고, 이 값 안쪽을 빠뜨리면 갈 수 있는 곳을 놓친다. */
export function optimisticReachMeters(
  travelMinutes: number,
  mode: GeoTravelMode,
): number {
  return Math.max(0, travelMinutes) * OPTIMISTIC_METERS_PER_MINUTE[mode];
}

export function distanceBucket(distanceMeters: number): string {
  if (distanceMeters < 500) return "0-499m";
  if (distanceMeters < 1_000) return "500-999m";
  if (distanceMeters < 2_000) return "1-1.9km";
  if (distanceMeters < 5_000) return "2-4.9km";
  if (distanceMeters < 10_000) return "5-9.9km";
  return "10km+";
}

export function minutesBucket(minutes: number): string {
  if (minutes <= 15) return "0-15m";
  if (minutes <= 30) return "16-30m";
  if (minutes <= 60) return "31-60m";
  if (minutes <= 120) return "61-120m";
  return "121m+";
}
