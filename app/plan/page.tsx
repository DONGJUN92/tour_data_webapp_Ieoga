import type { Metadata } from "next";
import { PlanWizard } from "./PlanWizard";

export const metadata: Metadata = {
  title: "여행 일정 등록 · 이어가",
  description:
    "여행 일정을 미리 적어 두면, 길에서 틀어졌을 때 바로 복구할 수 있습니다.",
  alternates: { canonical: "/plan" },
};

export default function PlanPage() {
  return <PlanWizard />;
}
