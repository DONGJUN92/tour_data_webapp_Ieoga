import type { Metadata } from "next";
import Link from "next/link";

/* 랜딩. 로고와 질문 한 줄, 버튼 셋만 둔다.
 *
 * 설명 문구를 붙이기 시작하면 랜딩이 아니라 소개 페이지가 된다. 이 화면을 보는
 * 사람은 대개 길 위에 서 있고, 읽으러 온 것이 아니라 다음 행동을 고르러 왔다.
 *
 * 세 번째 버튼이 이 화면을 만든 진짜 이유다. 예전에는 "일정을 미리 등록하고
 * 싶다"는 입구가 없어서, 여행 전날 등록하려는 사람이 `일정이 틀어졌어요`를
 * 눌러야 했다. 앞뒤가 맞지 않았다.
 *
 * `/flow` 같은 직행 링크는 이 화면을 거치지 않는다 — 돌아오는 사람에게 탭을
 * 하나 더 물리지 않기 위해서다. */

export const metadata: Metadata = {
  title: "이어가 · 여행을 이어 주는 서비스",
  description:
    "일정이 틀어졌을 때, 시간이 비었을 때, 여행 일정을 등록할 때. 한국관광공사 공식 관광정보로 갈 수 있는 곳만 확인해 드립니다.",
};

const CHOICES = [
  {
    href: "/app",
    emoji: "🌧️",
    label: "일정이 틀어졌어요",
    hint: "다음 약속은 지키면서 한 곳만 바꿉니다",
  },
  {
    href: "/app?view=discover",
    emoji: "⏳",
    label: "시간이 비었어요",
    hint: "남은 시간에 다녀올 수 있는 곳을 찾습니다",
  },
  {
    href: "/plan",
    emoji: "🗓️",
    label: "여행 일정을 등록할래요",
    hint: "미리 적어 두면 틀어졌을 때 바로 복구합니다",
  },
] as const;

export default function Landing() {
  return (
    <main className="landing">
      <div className="landing-inner">
        <div className="landing-brand">
          <span className="landing-mark" aria-hidden="true">
            이
          </span>
          <div>
            <h1>이어가</h1>
            <p>여행을 이어 주는 서비스</p>
          </div>
        </div>

        <h2 className="landing-question">지금 어떤 상황인가요?</h2>

        <nav className="landing-choices" aria-label="시작할 기능">
          {CHOICES.map((choice) => (
            <Link key={choice.href} href={choice.href} className="landing-choice">
              <span className="landing-choice-emoji" aria-hidden="true">
                {choice.emoji}
              </span>
              <span className="landing-choice-text">
                <strong>{choice.label}</strong>
                <em>{choice.hint}</em>
              </span>
              <span className="landing-choice-arrow" aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </nav>
      </div>
    </main>
  );
}
