import type { Metadata } from "next";
import { ProductApp } from "./ProductApp";

export const metadata: Metadata = {
  title: "여행이 틀어졌을 때, 다음 예약을 지키는 앱",
  description:
    "비가 오거나 길이 막혀 일정이 틀어졌을 때, 깨진 한 곳만 바꿔 다음 예약을 지킵니다. 한국관광공사 OpenAPI로 갈 수 있는 곳만 검증해 보여 드립니다.",
};

export default function Home() {
  return <ProductApp />;
}
