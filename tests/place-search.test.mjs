import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./alias-loader.mjs", import.meta.url));

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const { searchPlaces } = await import("../lib/location/place-search.ts");

function ktoEnvelope(items) {
  return {
    response: {
      header: { resultCode: "0000", resultMsg: "OK" },
      body: {
        items: items.length ? { item: items } : "",
        totalCount: items.length,
        pageNo: 1,
        numOfRows: items.length,
      },
    },
  };
}

async function withProviderEnv(fetchImpl, run) {
  const originalFetch = globalThis.fetch;
  const previous = {
    kto: process.env.KTO_SERVICE_KEY,
    kakao: process.env.KAKAO_REST_API_KEY,
    forward: process.env.FORWARD_GEOCODE_URL,
  };
  process.env.KTO_SERVICE_KEY = "place-search-test-key";
  process.env.FORWARD_GEOCODE_URL =
    "https://managed-geocoder.test/search";
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ["KTO_SERVICE_KEY", previous.kto],
      ["KAKAO_REST_API_KEY", previous.kakao],
      ["FORWARD_GEOCODE_URL", previous.forward],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a strong KTO match remains the primary saved-stop result", async () => {
  const calls = [];
  const result = await withProviderEnv(
    async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify(
          ktoEnvelope([
            {
              contentid: "kto-1",
              contenttypeid: "12",
              title: "국립현대미술관 서울",
              addr1: "서울 종로구 삼청로 30",
              mapy: "37.5786",
              mapx: "126.9801",
              lDongRegnCd: "11",
              lDongSignguCd: "11010",
            },
          ]),
        ),
        { status: 200 },
      );
    },
    () =>
      searchPlaces({
        keyword: "국립현대미술관 서울",
        purpose: "saved_stop",
        fallback: "auto",
      }),
  );

  assert.equal(result.usedFallback, false);
  assert.equal(result.places[0].provider, "kto");
  assert.equal(result.places[0].retention, "persistable");
  assert.equal(calls.length, 1);
});

test("saved-stop search falls back to a persistable forward geocoder", async () => {
  const result = await withProviderEnv(
    async (input) => {
      const url = String(input);
      if (url.includes("apis.data.go.kr")) {
        return new Response(JSON.stringify(ktoEnvelope([])), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify([
          {
            place_id: 991,
            name: "광화문 D타워",
            display_name: "광화문 D타워, 종로구, 서울",
            lat: "37.5713",
            lon: "126.9788",
            address: { building: "광화문 D타워" },
          },
        ]),
        { status: 200 },
      );
    },
    () =>
      searchPlaces({
        keyword: "광화문 D타워",
        purpose: "saved_stop",
        fallback: "auto",
      }),
  );

  assert.equal(result.usedFallback, true);
  assert.equal(result.fallbackProvider, "forward_geocoder");
  assert.equal(result.places[0].retention, "persistable");
  assert.equal(result.places[0].title, "광화문 D타워");
});

test("current-origin search uses Kakao only as an ephemeral fallback", async () => {
  const originalKakao = process.env.KAKAO_REST_API_KEY;
  process.env.KAKAO_REST_API_KEY = "kakao-test-key";
  try {
    const result = await withProviderEnv(
      async (input, init) => {
        const url = String(input);
        if (url.includes("apis.data.go.kr")) {
          return new Response(JSON.stringify(ktoEnvelope([])), {
            status: 200,
          });
        }
        assert.match(init?.headers?.Authorization ?? "", /^KakaoAK /);
        return new Response(
          JSON.stringify({
            documents: [
              {
                id: "kakao-1",
                place_name: "서울역",
                road_address_name: "서울 용산구 한강대로 405",
                x: "126.9707",
                y: "37.5547",
                place_url: "https://place.map.kakao.com/1",
              },
            ],
          }),
          { status: 200 },
        );
      },
      () =>
        searchPlaces({
          keyword: "서울역",
          purpose: "current_origin",
          fallback: "force",
        }),
    );

    assert.equal(result.fallbackProvider, "kakao_local");
    const kakao = result.places.find(
      (place) => place.provider === "kakao_local",
    );
    assert.ok(kakao);
    assert.equal(kakao.retention, "ephemeral");
  } finally {
    if (originalKakao === undefined) {
      delete process.env.KAKAO_REST_API_KEY;
    } else {
      process.env.KAKAO_REST_API_KEY = originalKakao;
    }
  }
});

test("normal user UI contains no latitude or longitude input fields", async () => {
  const product = await readFile(
    path.join(ROOT, "app/ProductApp.tsx"),
    "utf8",
  );
  assert.doesNotMatch(product, /좌표 직접 입력|placeholder="37\.5665"|placeholder="126\.9780"/);
  assert.match(product, /purpose=saved_stop/);
  assert.match(product, /purpose:\s*"current_origin"/);
  assert.match(product, /다른 지도에서/);
});
