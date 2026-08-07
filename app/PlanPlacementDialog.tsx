"use client";

/* "시간이 비었어요"에서 찾은 곳을 일정에 넣을 때 **어디에 넣을지 묻는** 자리.
 *
 * 예전에는 빈 자리를 찾아 조용히 채웠다. 이미 적어 둔 일정이 있으면 그 자리가
 * 없어 아무 일도 일어나지 않았고, 있더라도 사용자가 모르는 사이에 일정이
 * 바뀌었다. 버튼 한 번으로 남의 일정을 덮어쓰면 되돌릴 방법이 없다.
 *
 * 화면 셋(여행 복구·등록 없이 찾기)이 같은 선택을 하므로 컴포넌트도 하나만
 * 둔다. 정류지 목록의 모양이 화면마다 달라서 `stops`는 최소 형태로만 받는다. */

import { administrativeUnit, sameAdministrativeArea } from "./product-app-model";

export type PlanCandidate = {
  title: string;
  address: string;
  contentTypeId?: string;
};

export type PlanTargetStop = {
  id: string;
  title: string;
  address: string;
};

export type PlanPlacement =
  | { kind: "prepend" }
  | { kind: "append" }
  | { kind: "replace"; stopId: string }
  | { kind: "reset" };

type Props = {
  place: PlanCandidate;
  /* "대신 넣기"로 고를 수 있는 정류지. 출발지는 빠진다. */
  stops: PlanTargetStop[];
  /* 같은 지역인지 볼 때 쓰는 목록. 출발지도 포함한다 — 출발지가 대전인데
     대안도 대전이면 그것은 같은 지역이다. */
  areaStops?: PlanTargetStop[];
  language: "ko" | "en";
  onChoose: (placement: PlanPlacement) => void;
  onCancel: () => void;
  className?: string;
};

export function PlanPlacementDialog({
  place,
  stops,
  areaStops,
  language,
  onChoose,
  onCancel,
  className,
}: Props) {
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);
  const filled = stops.filter((stop) => stop.title.trim());
  /* 시·군 단위로 본다. 구까지 따지면 같은 대전 안에서 서구와 유성구가 다른
     지역으로 갈려 "기존 일정을 지울까요"를 묻게 된다. */
  const areaPool = (areaStops ?? stops).filter((stop) => stop.title.trim());
  const sameArea = areaPool.some((stop) =>
    sameAdministrativeArea(stop.address, place.address),
  );
  const placeUnit = administrativeUnit(place.address);
  const planUnit =
    areaPool.map((stop) => administrativeUnit(stop.address)).find(Boolean) ?? "";

  return (
    <section
      className={className ?? "plan-merge"}
      role="group"
      aria-label={tr("일정에 넣을 위치 선택", "Choose where to add this")}
    >
      <h3 className="plan-merge-title">
        {tr(
          `'${place.title}'을(를) 어디에 넣을까요?`,
          `Where should “${place.title}” go?`,
        )}
      </h3>

      {sameArea ? (
        <>
          <p className="plan-merge-note">
            {tr(
              `이미 ${placeUnit || "같은 지역"}에 적어 둔 일정이 있습니다.`,
              `You already have a plan in ${placeUnit || "the same area"}.`,
            )}
          </p>
          <div className="plan-merge-actions">
            <button type="button" onClick={() => onChoose({ kind: "prepend" })}>
              {tr("일정 맨 앞에 추가", "Add before the plan")}
            </button>
            <button type="button" onClick={() => onChoose({ kind: "append" })}>
              {tr("일정 맨 뒤에 추가", "Add after the plan")}
            </button>
          </div>
          <p className="plan-merge-note">
            {tr("또는 적어 둔 일정을 이 곳으로 바꿉니다.", "Or replace one of these.")}
          </p>
          <div className="plan-merge-actions">
            {filled.map((stop) => (
              <button
                key={stop.id}
                type="button"
                onClick={() => onChoose({ kind: "replace", stopId: stop.id })}
              >
                {tr(`'${stop.title}' 대신 넣기`, `Replace “${stop.title}”`)}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="plan-merge-note">
            {tr(
              `적어 둔 일정은 ${planUnit || "다른 지역"}이고 이 곳은 ${placeUnit || "다른 지역"}입니다. 기존 일정을 삭제하고 이 곳으로 새로 시작할까요?`,
              `Your plan is in ${planUnit || "another area"} and this place is in ${placeUnit || "a different area"}. Clear the plan and start here?`,
            )}
          </p>
          <div className="plan-merge-actions">
            <button type="button" onClick={() => onChoose({ kind: "reset" })}>
              {tr("예, 삭제하고 새로 시작", "Yes, clear and start here")}
            </button>
            <button type="button" onClick={() => onChoose({ kind: "append" })}>
              {tr("아니요, 그대로 두고 뒤에 추가", "No, keep it and add at the end")}
            </button>
          </div>
        </>
      )}

      {/* 두 갈래 모두에 취소를 둔다. 무엇을 고를지 정하지 못한 사용자가 화면을
          벗어날 방법이 없으면 그것도 강요다. */}
      <button type="button" className="plan-merge-cancel" onClick={onCancel}>
        {tr("취소", "Cancel")}
      </button>
    </section>
  );
}
