/* 여행자가 직접 확인하면 적용할 수 있는 근거 공백.
 *
 * 이 목록에 없는 공백이 하나라도 있으면 그 안은 어느 실행 계약에도 들지 못한다.
 * 네 코드는 모두 "확인하지 못했다"이지 "확인해 보니 아니다"가 아니다 — 확인된
 * 부정은 공백이 아니라 탈락이고(`OFFICIALLY_CLOSED`, `CONCENTRATION_HIGH`) 애초에
 * 목록에 오르지 않는다. 그 차이가 여행자에게 중요하다. 닫혀 있다고 확인된 곳은
 * 확인을 한 번 더 받는다고 문이 열리지 않지만, 집중률 예측을 받지 못한 곳은 그냥
 * **아무도 모르는 곳**이다.
 *
 * 왜 파일 하나를 따로 두는가. 이 상수는 서버의 실행 계약(`application-snapshot.ts`)
 * 과 화면의 안전 판정(`app/traveler-safety.ts`)이 **함께** 봐야 한다. 둘이 각자
 * 목록을 들면 어긋나서, 버튼은 열리는데 서버가 거절하는 상태가 만들어진다.
 *
 * 그런데 계약 모듈은 세션 비밀을 읽으므로 `cloudflare:workers`까지 딸려 온다.
 * 화면 모듈이 계약 모듈에서 이 상수를 가져오면 그 서버 전용 바인딩이 브라우저
 * 묶음으로 끌려 들어가고, 클라이언트 번들이 통째로 로드에 실패한다 — 실제로
 * 그렇게 만들어 봤고 화면이 "화면을 불러오지 못했어요"만 남았다. 그래서 의존성이
 * 하나도 없는 이 파일에 상수만 둔다.
 */
export const SELF_CONFIRMABLE_GAP_CODES: ReadonlySet<string> = new Set([
  "OPERATING_HOURS_UNVERIFIED",
  "ACCESSIBILITY_UNVERIFIED",
  "CONCENTRATION_UNVERIFIED",
  "INDOOR_UNVERIFIED",
]);
