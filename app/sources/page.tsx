import type { Metadata } from "next";
import SourcesFlow from "./SourcesFlow";

export const metadata: Metadata = {
  title: "데이터 출처",
  description:
    "이어가가 사용하는 한국관광공사 OpenAPI 8종과 각 데이터가 바꾸는 판단, 그리고 현재 응답 상태입니다.",
  alternates: { canonical: "/sources" },
};

export default function SourcesPage() {
  return <SourcesFlow />;
}
