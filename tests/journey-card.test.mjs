import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/* 완료 화면의 "출발 전 저장한 판정 증명도 공유"를 지우고 카드 한 컷으로 바꿨다.
   그 버튼은 출발 전에 만든 판정 링크를 여행이 끝난 자리에서 한 번 더 내밀었다.
   받는 사람은 그것을 지금 쓸 수 있는 정보로 읽는데, 그 링크는 이미 지난 판정이다.

   카드는 이미지라서 화면 바깥으로 나간다. 화면에 적어 둔 경고는 이미지를 따라가지
   않으므로, 카드 자체가 자기 한계를 말해야 한다. 여기서 그것을 고정한다. */

test("완료 화면은 출발 전 판정 증명을 다시 공유하지 않는다", async () => {
  const source = await readFile(
    new URL("../app/flow/FlowApp.tsx", import.meta.url),
    "utf8",
  );
  /* 주석은 뺀다. 무엇을 왜 지웠는지 적어 둔 설명에 그 문구가 나오는 것은
     되살아난 것이 아니라 기록이다 — 기록까지 금지하면 다음 사람이 이유를
     모르고 되돌려 놓는다. */
  const flow = source.replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(
    !flow.includes("출발 전 저장한 판정 증명도 공유"),
    "여행이 끝난 자리에서 출발 전 판정을 다시 내밀어서는 안 된다",
  );
  assert.ok(
    !flow.includes("shareSavedProofLink"),
    "지운 버튼의 처리기가 죽은 코드로 남아서는 안 된다",
  );

  /* 증명 링크를 **만드는** 버튼도 이후에 지웠다.
     처음에는 "지난 기록이라고 스스로 밝히는 장치이므로 남긴다"고 판단했지만,
     여행자에게는 만들 이유가 없는 링크였다. 만드는 버튼과 그 한계를 적은 안내문이
     화면 두 덩어리를 차지하면서 정작 할 수 있는 일은 없었다. 증명 자체는 /app 탭의
     결과 공유에 남아 있어 심사에서 확인할 수 있다. */
  assert.doesNotMatch(flow, /data-testid="flow-create-historical-proof"/);
  assert.doesNotMatch(flow, /출발 전 판정 증명 링크 만들기/);
  assert.doesNotMatch(flow, /presentProofShareLink/);

  /* 새로 들어온 두 가지. */
  assert.match(flow, /data-testid="flow-share-journey-card"/);
  assert.match(flow, /map\.kakao\.com\/link\/map\//);
});

test("여행 카드는 지난 기록이라고 카드 안에서 밝힌다", async () => {
  const { buildJourneyCardSvg } = await import("../app/journey-card.ts");

  const svg = buildJourneyCardSvg({
    stops: [
      { title: "대전전통나래관", timeLabel: "오전 11:30", inserted: true },
      { title: "대전역 동광장", timeLabel: "오후 12:51" },
    ],
    headline: "여행을 이어 갔어요",
    subheadline: "대전전통나래관을 넣고 다음 약속을 지켰어요",
    footnote: "지난 여행 기록입니다. 지금의 영업·경로를 보장하지 않습니다.",
    language: "ko",
  });

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /대전전통나래관/);
  assert.match(svg, /오전 11:30/);
  /* 카드가 자기 한계를 말한다. */
  assert.match(svg, /지난 여행 기록입니다/);
  assert.match(svg, /한국관광공사 국문 관광정보/);

  /* 카드는 검증을 주장하지 않는다. 이미지 한 장이 "확인됨"이라고 말하면 그것을
     받은 사람은 지금 가도 된다고 읽는다. */
  for (const claim of ["검증", "확인됨", "안전", "지금 출발", "영업 중"]) {
    assert.ok(
      !svg.includes(claim),
      `카드가 "${claim}"을 주장해서는 안 된다`,
    );
  }
});

test("카드는 외부 출처를 한 건도 참조하지 않는다", async () => {
  const { buildJourneyCardSvg } = await import("../app/journey-card.ts");
  const svg = buildJourneyCardSvg({
    stops: [{ title: "한빛탑", timeLabel: "오후 2:00" }],
    headline: "여행을 이어 갔어요",
    subheadline: "한빛탑을 넣었어요",
    footnote: "지난 여행 기록입니다.",
    language: "ko",
  });

  /* 다른 출처의 그림을 합성하면 캔버스가 오염되어(cross-origin taint)
     `toDataURL`이 예외를 던진다. 원격 호스트가 CORS 헤더를 주지 않으면 우회할
     방법이 없으므로, 카드는 글자와 도형만으로 만든다. */
  assert.ok(!/<image/.test(svg), "카드에 원격 이미지를 넣어서는 안 된다");
  assert.ok(!/https?:\/\//.test(svg.replace(/xmlns="[^"]*"/g, "")));
  assert.ok(!/tile\.openstreetmap/.test(svg));
  assert.ok(!/@import|<foreignObject/.test(svg));
});

test("카드는 넘치는 글자를 잘라 카드 밖으로 흘리지 않는다", async () => {
  const { buildJourneyCardSvg } = await import("../app/journey-card.ts");
  const svg = buildJourneyCardSvg({
    stops: [
      {
        title: "아주아주아주아주아주아주아주아주아주긴이름의관광지입니다",
        timeLabel: "오후 2:00",
      },
    ],
    headline: "여행을 이어 갔어요",
    subheadline: "짧은 안내",
    footnote: "지난 여행 기록입니다.",
    language: "ko",
  });
  /* SVG는 자동 줄바꿈이 없다. 넘친 글자는 조용히 카드 밖에 그려지므로, 잘렸다는
     사실이 눈에 보이도록 줄임표를 남긴다. */
  assert.match(svg, /…/);
  assert.ok(!svg.includes("아주아주아주아주아주아주아주아주아주긴이름의관광지입니다"));
});

test("카드는 XML 특수문자를 그대로 흘려보내지 않는다", async () => {
  const { buildJourneyCardSvg } = await import("../app/journey-card.ts");
  const svg = buildJourneyCardSvg({
    stops: [{ title: 'A & B <tag>', timeLabel: '2:00 "pm"' }],
    headline: "Trip continued",
    subheadline: "x & y",
    footnote: "past record",
    language: "en",
  });
  /* 장소 이름은 공사 데이터에서 온다. 이스케이프하지 않으면 이름 하나가 카드
     전체를 깨뜨린다. */
  assert.ok(!/<tag>/.test(svg));
  assert.match(svg, /A &amp; B &lt;tag&gt;/);
  assert.match(svg, /&quot;pm&quot;/);
});
