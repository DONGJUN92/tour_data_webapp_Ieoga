import type { Metadata } from "next";
import FlowApp from "./FlowApp";

export const metadata: Metadata = {
  title: "이어가 · 지금 바로 복구",
  description:
    "일정을 등록하지 않아도, 지금 상황과 다음 약속만 알려주면 예약을 지키는 복구안을 찾습니다.",
  alternates: { canonical: "/flow" },
};

export default function FlowPage() {
  return <FlowApp />;
}
