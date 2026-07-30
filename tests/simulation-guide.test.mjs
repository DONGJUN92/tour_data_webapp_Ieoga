import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

test("simulation guide exposes four traveler-first recovery steps", async () => {
  const component = await source("app/SimulationGuide.tsx");

  assert.equal(
    [...component.matchAll(/data-guide-step=\{index \+ 1\}/g)].length,
    1,
  );
  assert.match(component, /원래 여행을 먼저 저장해요/);
  assert.match(component, /지금 있는 곳을 편하게 찾아요/);
  assert.match(component, /여행이 끊긴 이유를 한 번만 눌러요/);
  assert.match(component, /복구한 여행을 끝까지 이어가요/);
  assert.match(component, /다음 예약과 남은 원래 일정까지 완주/);
});

test("simulation guide has accessible dialog and loading contracts", async () => {
  const component = await source("app/SimulationGuide.tsx");

  assert.match(component, /role="dialog"/);
  assert.match(component, /aria-modal="true"/);
  assert.match(component, /aria-labelledby=\{titleId\}/);
  assert.match(component, /aria-describedby=\{descriptionId\}/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /event\.key !== "Tab"/);
  assert.match(component, /aria-busy=\{isLoading\}/);
  assert.match(component, /disabled=\{isLoading\}/);
  assert.match(component, /실제 장소를 찾는 중…/);
});

test("practice CTA is injected and location guidance requires no coordinates", async () => {
  const component = await source("app/SimulationGuide.tsx");

  assert.match(component, /onLoadPracticeItinerary: \(\) => void/);
  assert.match(component, /onClick=\{onLoadPracticeItinerary\}/);
  assert.match(component, /실제 장소로 연습 일정 불러오기/);
  assert.match(component, /위·경도는 입력하지 않아도 돼요/);
  assert.match(component, /onDismiss \?\? onClose/);
});
