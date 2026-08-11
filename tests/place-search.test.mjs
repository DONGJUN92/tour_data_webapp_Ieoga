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

test("blank, null and out-of-domain official coordinates are rejected", async () => {
  const result = await withProviderEnv(
    async () =>
      new Response(
        JSON.stringify(
          ktoEnvelope([
            {
              contentid: "blank-coordinate",
              contenttypeid: "12",
              title: "빈 좌표 장소",
              mapy: null,
              mapx: "",
            },
            {
              contentid: "zero-coordinate",
              contenttypeid: "12",
              title: "영점 좌표 장소",
              mapy: "0",
              mapx: "0",
            },
            {
              contentid: "valid-coordinate",
              contenttypeid: "14",
              title: "검증 좌표 문화관",
              addr1: "서울특별시",
              mapy: "37.57",
              mapx: "126.98",
            },
          ]),
        ),
        { status: 200 },
      ),
    () =>
      searchPlaces({
        keyword: "검증 좌표 문화관",
        purpose: "saved_stop",
        fallback: "auto",
      }),
  );

  assert.deepEqual(
    result.places.map((place) => place.providerId),
    ["valid-coordinate"],
  );
});

test("place query never coerces blank coordinates to zero", async () => {
  const { placeSearchQuerySchema } = await import(
    "../lib/location/place-query.ts"
  );
  assert.equal(
    placeSearchQuerySchema.safeParse({
      keyword: "광화문",
      purpose: "current_origin",
      fallback: "auto",
      latitude: "",
      longitude: "",
    }).success,
    false,
  );
  assert.equal(
    placeSearchQuerySchema.safeParse({
      keyword: "광화문",
      purpose: "current_origin",
      fallback: "auto",
      latitude: undefined,
      longitude: undefined,
    }).success,
    true,
  );
  assert.equal(
    placeSearchQuerySchema.safeParse({
      keyword: "광화문",
      purpose: "current_origin",
      fallback: "auto",
      areaCode: "11",
      sigunguCode: "26110",
    }).success,
    false,
  );
  assert.equal(
    placeSearchQuerySchema.safeParse({
      keyword: "광화문",
      purpose: "saved_stop",
      fallback: "auto",
      areaCode: "99",
    }).success,
    false,
  );
  assert.equal(
    placeSearchQuerySchema.safeParse({
      keyword: "광화문",
      purpose: "saved_stop",
      fallback: "auto",
      sigunguCode: "11110",
    }).success,
    false,
  );
});

test("all place keywords and current-origin coordinates are accepted only in JSON POST and costly searches fail closed", async () => {
  const [placeRoute, recoverRoute, limiter, discover, product, picker] = await Promise.all([
    readFile(
      path.join(ROOT, "app/api/v1/places/search/route.ts"),
      "utf8",
    ),
    readFile(path.join(ROOT, "app/api/v1/recover/route.ts"), "utf8"),
    readFile(path.join(ROOT, "lib/durable-rate-limit.ts"), "utf8"),
    readFile(path.join(ROOT, "app/DiscoverWindowPanel.tsx"), "utf8"),
    readFile(path.join(ROOT, "app/ProductApp.tsx"), "utf8"),
    readFile(path.join(ROOT, "app/ManualLocationPicker.tsx"), "utf8"),
  ]);
  assert.match(placeRoute, /SENSITIVE_QUERY_PARAMETERS_FORBIDDEN/);
  assert.match(placeRoute, /status: 405/);
  assert.match(placeRoute, /Allow", "POST"/);
  assert.match(placeRoute, /JSON_CONTENT_TYPE_REQUIRED/);
  assert.match(placeRoute, /export async function POST[\s\S]*request\.json\(\)/);
  assert.match(placeRoute, /allowDurableRequest\(/);
  assert.match(placeRoute, /isKnownAdministrativeScope\(/);
  assert.match(placeRoute, /UNKNOWN_REGION_SCOPE/);
  assert.match(placeRoute, /REGION_REFERENCE_UNAVAILABLE/);
  assert.match(recoverRoute, /allowDurableRequest\(/);
  assert.match(limiter, /unavailable:\s*true/);
  assert.match(limiter, /allowed:\s*false/);
  for (const source of [discover, product, picker]) {
    assert.doesNotMatch(source, /\/api\/v1\/places\/search\?/);
  }
  assert.match(
    discover,
    /fetchJson\("\/api\/v1\/places\/search",\s*\{[\s\S]*method: "POST"/,
  );
  assert.match(
    product,
    /fetchJson\("\/api\/v1\/places\/search",\s*\{[\s\S]*method: "POST"/,
  );
});

test("normal UI has one purpose-aware POST place picker and no coordinate fields", async () => {
  const [product, picker, wizard] = await Promise.all([
    readFile(path.join(ROOT, "app/ProductApp.tsx"), "utf8"),
    readFile(path.join(ROOT, "app/ManualLocationPicker.tsx"), "utf8"),
    readFile(path.join(ROOT, "app/plan/PlanWizard.tsx"), "utf8"),
  ]);
  assert.doesNotMatch(product, /좌표 직접 입력|placeholder="37\.5665"|placeholder="126\.9780"/);
  assert.match(picker, /purpose\?: "current_origin" \| "saved_stop"/);
  assert.match(picker, /purpose = "current_origin"/);
  assert.match(picker, /postJson\("\/api\/v1\/places\/search"/);
  assert.doesNotMatch(picker, /\/api\/v1\/places\/search\?/);
  assert.equal((wizard.match(/purpose="saved_stop"/g) ?? []).length, 2);
  assert.equal((product.match(/<ManualLocationPicker/g) ?? []).length, 1);
});
