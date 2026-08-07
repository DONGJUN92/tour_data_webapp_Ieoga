import type { Metadata } from "next";
import { ProductApp } from "../ProductApp";

/* 앱 본체는 `/app`으로 옮겼다. `/`는 로고와 버튼 셋만 있는 랜딩이다.
 *
 * 예전에는 `/`가 곧 이 화면이어서, 처음 들어온 사람이 **이 앱이 뭘 해 주는지
 * 알기 전에 일정 입력 폼부터 읽어야 했다.** 탭은 위에 있었지만 아래 내용이
 * 이미 "여행 복구"로 정해져 있었으므로, 탭은 선택지가 아니라 기본값이었다. */

export const metadata: Metadata = {
  title: "여행이 틀어졌을 때, 다음 예약을 지키는 앱",
  description:
    "비가 오거나 길이 막혀 일정이 틀어졌을 때, 깨진 한 곳만 바꿔 다음 예약을 지킵니다. 한국관광공사 OpenAPI로 갈 수 있는 곳만 검증해 보여 드립니다.",
};

export default function AppHome() {
  return <ProductApp />;
}
