import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(new URL("./alias-loader.mjs", import.meta.url));

const { env } = await import("./cloudflare-workers.stub.mjs");

/**
 * 로컬 사본(운영정보·경로)이 **외부 호출을 실제로 줄이는지** 검증한다.
 *
 * 이 시험이 필요한 이유는 실측으로는 확인할 수 없었기 때문이다. 측정을 반복하는
 * 동안 공사의 `detailIntro2`가 **일일 한도(HTTP 429)** 에 걸렸고, 그 상태에서는
 * 모든 후보가 운영정보 단계에서 떨어져 사본이 채워지지도, 쓰이지도 않는다.
 * 배포본과 로컬이 똑같이 429를 받았으므로 코드 문제가 아니라 상류 한도였다.
 *
 * 그래서 상류를 흉내로 두고 같은 요청을 두 번 보낸다. 1차는 사본을 채우고,
 * 2차는 사본만으로 판정해야 한다. 확인하는 것은 두 가지다 —
 * **2차의 `detailIntro2` 실제 호출이 0건**이고, 그러면서도 **추천이 그대로**
 * 나오는가. 하나라도 어긋나면 사본이 호출을 줄이지 못하거나(무의미) 판정을
 * 무너뜨리고 있다(위험).
 */

const MIGRATION = await readFile(
  new URL("../drizzle/0011_opposite_martin_li.sql", import.meta.url),
  "utf8",
);

/* 실제 SQLite를 D1 인터페이스로 감싼다. drizzle의 d1 드라이버가 쓰는 표면만
   구현한다 — `prepare().bind().all()/run()/raw()`와 `batch()`. */
function sqliteBackedD1(db) {
  const normalise = (rows) => rows.map((row) => ({ ...row }));
  const exec = (sql, params) => {
    const statement = db.prepare(sql);
    if (/^\s*(select|with)/i.test(sql)) {
      return { results: normalise(statement.all(...params)) };
    }
    statement.run(...params);
    return { results: [] };
  };
  const make = (sql, params = []) => ({
    sql,
    params,
    bind: (...next) => make(sql, next),
    all: async () => ({ success: true, ...exec(sql, params), meta: {} }),
    run: async () => ({ success: true, ...exec(sql, params), meta: {} }),
    first: async () => exec(sql, params).results[0] ?? null,
    raw: async () =>
      exec(sql, params).results.map((row) => Object.values(row)),
  });
  return {
    prepare: (sql) => make(sql),
    batch: async (statements) => {
      const out = [];
      for (const statement of statements) {
        out.push(await statement.run());
      }
      return out;
    },
  };
}

function ktoEnvelope(items) {
  return {
    response: {
      header: { resultCode: "0000", resultMsg: "OK" },
      body: {
        items: items.length ? { item: items } : "",
        totalCount: items.length,
        pageNo: 1,
        numOfRows: Math.max(1, items.length),
      },
    },
  };
}

/* 두 후보. 둘 다 가깝고 24시간 운영이라 사본이 있으면 그대로 통과해야 한다.
   `modifiedtime`이 있어야 사본의 신선도를 판정할 수 있으므로 반드시 넣는다. */
function nearbyItems() {
  return [
    {
      contentid: "snap-1",
      contenttypeid: "14",
      title: "사본 검증 문화관",
      addr1: "서울특별시 종로구",
      mapx: "126.9800",
      mapy: "37.5670",
      dist: "300",
      lDongRegnCd: "11",
      lDongSignguCd: "110",
      modifiedtime: "20260801103000",
    },
    {
      contentid: "snap-2",
      contenttypeid: "14",
      title: "사본 검증 전시관",
      addr1: "서울특별시 종로구",
      mapx: "126.9810",
      mapy: "37.5675",
      dist: "420",
      lDongRegnCd: "11",
      lDongSignguCd: "110",
      modifiedtime: "20260801104500",
    },
  ];
}

test("로컬 사본이 있으면 같은 요청의 운영정보 외부 호출이 0건이 된다", async () => {
  const previousKey = process.env.KTO_SERVICE_KEY;
  const previousRouting = process.env.ROUTING_BASE_URL;
  const previousWeather = process.env.WEATHER_API_URL;
  const previousDb = env.DB;
  const originalFetch = globalThis.fetch;

  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION.replaceAll("--> statement-breakpoint", ""));
  env.DB = sqliteBackedD1(db);
  process.env.KTO_SERVICE_KEY = "snapshot-cache-key";
  process.env.ROUTING_BASE_URL = "https://managed-routing.test/route";
  process.env.WEATHER_API_URL = "https://managed-weather.test/forecast";

  const counts = { intro: 0, route: 0 };
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === "managed-routing.test") {
      counts.route += 1;
      return Response.json({
        code: "Ok",
        routes: [
          {
            distance: 300,
            duration: 300,
            legs: [{ distance: 300, duration: 300 }],
            geometry: {
              coordinates: [
                [126.978, 37.5665],
                [126.98, 37.567],
              ],
            },
          },
        ],
      });
    }
    if (url.hostname === "managed-weather.test") {
      return Response.json({
        current: {
          time: "2026-08-04T10:00",
          temperature_2m: 24,
          apparent_temperature: 24,
          precipitation: 0,
          rain: 0,
          showers: 0,
          weather_code: 1,
          wind_speed_10m: 3,
        },
        hourly: { precipitation_probability: [10] },
      });
    }
    const [, service, operation] =
      url.pathname.match(/\/B551011\/([^/]+)\/([^/]+)$/) ?? [];
    if (service === "KorService2" && operation === "locationBasedList2") {
      return Response.json(ktoEnvelope(nearbyItems()));
    }
    if (service === "KorService2" && operation === "detailIntro2") {
      counts.intro += 1;
      return Response.json(
        ktoEnvelope([
          {
            usetimeculture: "24시간",
            restdateculture: "연중무휴",
            infocenter: "02-000-0000",
          },
        ]),
      );
    }
    return Response.json(ktoEnvelope([]));
  };

  try {
    const { recoverTrip } = await import("../lib/recovery/engine.ts");
    const request = () => {
      const now = Date.now();
      return {
        origin: {
          latitude: 37.5665,
          longitude: 126.978,
          label: "현재 위치",
          areaCode: "11",
          sigunguCode: "11110",
        },
        incident: "delay",
        availableMinutes: 180,
        audience: "general",
        indoorOnly: false,
        travelMode: "walk",
        safetyBufferMinutes: 15,
        minimumStayMinutes: 30,
        analyticsConsent: false,
        openWindow: {
          departureAt: new Date(now).toISOString(),
          availableUntil: new Date(now + 180 * 60_000).toISOString(),
          plannedStayMinutes: 60,
        },
      };
    };

    const cold = await recoverTrip(request(), "snapshot-cold", {
      deadlineAt: Date.now() + 20_000,
    });
    const coldIntro = counts.intro;
    assert.ok(
      cold.options.length > 0,
      `1차에서 추천이 나와야 한다. status=${cold.status}, 사유=${JSON.stringify(cold.rejectionSummary)}`,
    );
    assert.ok(
      coldIntro > 0,
      "1차는 운영정보를 실제로 조회해야 한다(사본이 비어 있으므로)",
    );

    /* 사본이 실제로 남았는지 표에서 직접 확인한다. */
    const stored = db
      .prepare("SELECT content_id, source_modified_at FROM place_hours_snapshots")
      .all();
    assert.ok(
      stored.length > 0,
      "1차 응답의 원문이 사본으로 저장되지 않았다",
    );
    assert.equal(
      stored.find((row) => row.content_id === "snap-1")?.source_modified_at,
      "20260801103000",
      "공사가 알린 콘텐츠 수정 시각이 그대로 저장되어야 신선도를 판정할 수 있다",
    );

    counts.intro = 0;
    const warm = await recoverTrip(request(), "snapshot-warm", {
      deadlineAt: Date.now() + 20_000,
    });

    assert.equal(
      counts.intro,
      0,
      `2차는 사본만으로 판정해야 하는데 운영정보를 ${counts.intro}건 조회했다`,
    );
    assert.ok(
      warm.options.length >= cold.options.length,
      `사본을 써도 추천 수가 줄어서는 안 된다. 1차 ${cold.options.length}곳, 2차 ${warm.options.length}곳`,
    );
    /* 원장이 사실을 말해야 한다 — 조회하지 않았으므로 실제 호출은 0건이다. */
    const warmIntroAudits = (warm.sourceLedger ?? []).filter(
      (audit) => audit.operation === "detailIntro2",
    );
    assert.ok(warmIntroAudits.length > 0, "원장에 운영정보 판정이 남아야 한다");
    assert.ok(
      warmIntroAudits.every((audit) => audit.upstreamCalls === 0),
      "사본으로 판정한 항목의 실제 호출 수는 0이어야 한다",
    );
    assert.ok(
      (warm.warnings ?? []).some((warning) =>
        /운영시간은 이미 받아 둔 공식 원문으로 판정했습니다/.test(warning),
      ),
      "사본을 썼다는 사실을 결과에서 밝혀야 한다",
    );
    /* 판정의 출처가 근거에 실려야 한다. */
    assert.ok(
      warm.options.some(
        (option) =>
          option.continuityProof?.availabilityEvidence?.evidenceSource ===
          "snapshot",
      ),
      "사본으로 판정한 후보의 근거에 출처가 남아야 한다",
    );
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    env.DB = previousDb;
    if (previousKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = previousKey;
    if (previousRouting === undefined) delete process.env.ROUTING_BASE_URL;
    else process.env.ROUTING_BASE_URL = previousRouting;
    if (previousWeather === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = previousWeather;
  }
});

test("공사가 알린 수정 시각이 달라지면 사본을 쓰지 않고 다시 조회한다", async () => {
  const previousKey = process.env.KTO_SERVICE_KEY;
  const previousDb = env.DB;
  const originalFetch = globalThis.fetch;
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION.replaceAll("--> statement-breakpoint", ""));
  env.DB = sqliteBackedD1(db);
  process.env.KTO_SERVICE_KEY = "snapshot-stale-key";

  try {
    const { readHoursSnapshots, writeHoursSnapshots } = await import(
      "../lib/kto/hours-snapshot.ts"
    );
    await writeHoursSnapshots([
      {
        contentId: "snap-1",
        contentTypeId: "14",
        sourceModifiedAt: "20260801103000",
        item: { usetimeculture: "24시간" },
      },
    ]);

    /* 같은 수정 시각이면 쓴다. */
    const fresh = await readHoursSnapshots([
      {
        contentId: "snap-1",
        contentTypeId: "14",
        sourceModifiedAt: "20260801103000",
      },
    ]);
    assert.equal(fresh.size, 1, "수정 시각이 같으면 사본을 써야 한다");

    /* 공사가 콘텐츠를 고쳤으면(수정 시각이 달라졌으면) 쓰지 않는다. 이것이
       "며칠 지났으니 아마 괜찮다"는 추측과 이 설계를 구분하는 지점이다. */
    const stale = await readHoursSnapshots([
      {
        contentId: "snap-1",
        contentTypeId: "14",
        sourceModifiedAt: "20260815090000",
      },
    ]);
    assert.equal(
      stale.size,
      0,
      "공사가 알린 수정 시각이 다르면 사본을 무효로 봐야 한다",
    );

    /* 수정 시각을 모르는 후보도 쓰지 않는다 — 최신인지 확인할 방법이 없다. */
    const unknown = await readHoursSnapshots([
      { contentId: "snap-1", contentTypeId: "14" },
    ]);
    assert.equal(
      unknown.size,
      0,
      "수정 시각이 없으면 신선도를 판정할 수 없으므로 사본을 쓰지 않아야 한다",
    );
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    env.DB = previousDb;
    if (previousKey === undefined) delete process.env.KTO_SERVICE_KEY;
    else process.env.KTO_SERVICE_KEY = previousKey;
  }
});
