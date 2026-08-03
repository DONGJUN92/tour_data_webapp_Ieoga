import type { Metadata } from "next";
import PolicyFlow from "./PolicyFlow";

export const metadata: Metadata = {
  title: "지역 회복력",
  description:
    "한국관광공사 공식 정책 지표를 조회 시점 기준으로 확인하고, 데이터 공백을 개선 미션으로 봅니다.",
  alternates: { canonical: "/policy" },
};

export default function PolicyPage() {
  return <PolicyFlow />;
}
