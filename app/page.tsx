import type { Metadata } from "next";
import { ProductApp } from "./ProductApp";

export const metadata: Metadata = {
  title: "이어가(IEOGA) | 전국 여행 중단 회복 서비스",
  description:
    "한국관광공사 OpenAPI를 활용해 전국 어디서든 여행 중단 상황에 적용 가능한 다음 일정을 찾고 지역 관광 회복 정책 근거를 만드는 서비스",
};

export default function Home() {
  return <ProductApp />;
}
