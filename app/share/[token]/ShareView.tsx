"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { useEffect, useState } from "react";

export function ShareView({ token }: { token: string }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; proof: Record<string, unknown> }
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    fetch(`/api/v1/share/${encodeURIComponent(token)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          proof?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (!response.ok || !payload.proof) {
          throw new Error(
            payload.error?.message ?? "복구 증명서를 불러오지 못했습니다.",
          );
        }
        if (active) setState({ status: "ready", proof: payload.proof });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "복구 증명서를 불러오지 못했습니다.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  if (state.status === "loading") {
    return <p className="share-status">복구 증명서를 확인하고 있습니다.</p>;
  }
  if (state.status === "error") {
    return (
      <div className="share-status error" role="alert">
        <h1>공유 링크를 확인해주세요</h1>
        <p>{state.message}</p>
        <a href="/">이어가로 돌아가기</a>
      </div>
    );
  }

  const option =
    state.proof.option && typeof state.proof.option === "object"
      ? (state.proof.option as Record<string, unknown>)
      : {};
  return (
    <article className="share-proof">
      <p className="eyebrow">IEOGA RECOVERY PROOF</p>
      <h1>{String(option.title ?? "복구 대안")}</h1>
      <p className="share-lead">
        실제 한국관광공사 OpenAPI와 이어가 규칙으로 판정한 복구 기록입니다.
      </p>
      <div className="share-proof-facts">
        <dl>
          <dt>판정 상태</dt>
          <dd>{String(state.proof.decisionStatus ?? "미확인")}</dd>
        </dl>
        <dl>
          <dt>지역</dt>
          <dd>
            {String(state.proof.regionCode ?? "-")} ·{" "}
            {String(state.proof.districtCode ?? "-")}
          </dd>
        </dl>
        <dl>
          <dt>거리 구간</dt>
          <dd>{String(option.distanceBucket ?? "-")}</dd>
        </dl>
        <dl>
          <dt>이동시간 구간</dt>
          <dd>{String(option.travelMinutesBucket ?? "-")}</dd>
        </dl>
        <dl>
          <dt>접근성 근거</dt>
          <dd>{String(option.accessibilityStatus ?? "-")}</dd>
        </dl>
        <dl>
          <dt>규칙 버전</dt>
          <dd>{String(state.proof.ruleVersion ?? "-")}</dd>
        </dl>
      </div>
      <p className="share-notice">{String(state.proof.notice ?? "")}</p>
      <a className="primary-link" href="/">
        내 여행 복구하기
      </a>
    </article>
  );
}
