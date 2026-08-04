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
