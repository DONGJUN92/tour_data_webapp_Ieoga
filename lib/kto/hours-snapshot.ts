import { getDb } from "@/db";
import { placeHoursSnapshots } from "@/db/schema";
import { inArray, lt, sql } from "drizzle-orm";
import type { KtoItem } from "./types";

/**
 * 상세 운영정보 원문의 로컬 사본.
 *
 * 왜 있는가는 표 정의(`db/schema.ts`)에 적어 두었다. 요약하면 호출 예산이다 —
 * Cloudflare 무료 플랜은 요청당 **외부** 호출을 50건으로 막지만 D1은 내부
 * 서비스라 1,000건까지 허용한다. 후보 검증에 드는 외부 호출이 운영정보 1건 +
 * 경로 1건이었으므로, 운영정보를 여기서 읽으면 같은 예산으로 볼 수 있는 후보가
 * 두 배가 된다.
 *
 * 지키는 선이 두 개 있다.
 *
 * 첫째, **판정이 아니라 원문을 저장한다.** 읽은 뒤에는 매번
 * `evaluateAvailabilityItem`을 그 요청의 실제 체류 구간에 다시 돌린다. 그래서
 * 저장된 "09:00~18:00"이 밤 10시 요청에서는 여전히 닫힘으로 판정된다.
 *
 * 둘째, **신선도를 시간이 아니라 공사의 변경 시각으로 판정한다.** 후보 탐색
 * 응답에 각 콘텐츠의 `modifiedtime`이 들어 있고, 그 값이 저장 당시와 같다면 지금
 * 다시 불러도 같은 응답이 온다는 뜻이다. 다르면 즉시 무효다. 시간 상한은 그 위에
 * 얹는 안전장치다 — `modifiedtime`이 운영시간 변경을 항상 반영한다고 보장할 수는
 * 없기 때문이다.
 */

/* 시간 상한. `modifiedtime`이 같아도 이 기간이 지나면 다시 부른다. */
const SNAPSHOT_TTL_DAYS = 7;

export type HoursSnapshotKey = {
  contentId: string;
  contentTypeId: string;
  /* 후보 탐색 응답의 `modifiedtime`. 없으면 신선도를 판정할 수 없으므로 이
     후보는 사본을 쓰지 않고 실시간으로 부른다. */
  sourceModifiedAt?: string;
};

export type HoursSnapshotHit = {
  item: KtoItem;
  fetchedAt: string;
  sourceModifiedAt: string;
};

function bucket(): boolean {
  try {
    getDb();
    return true;
  } catch {
    /* D1 바인딩이 없는 환경(단위 시험 등)에서는 조용히 사본 없이 동작한다.
       사본은 최적화이지 정확성의 조건이 아니다. */
    return false;
  }
}

/**
 * 후보들의 사본을 **한 번의 질의로** 읽는다.
 *
 * 후보마다 따로 읽으면 내부 예산은 넉넉해도 무료 플랜의 CPU 상한(10ms)에서
 * 불리하고, D1 왕복이 응답 시간에 그대로 쌓인다. `IN`으로 한 번에 읽는다.
 */
export async function readHoursSnapshots(
  keys: HoursSnapshotKey[],
): Promise<Map<string, HoursSnapshotHit>> {
  const hits = new Map<string, HoursSnapshotHit>();
  /* 신선도를 판정할 수 있는 후보만 조회한다. `modifiedtime`이 없는 후보는
     사본이 있어도 그것이 최신인지 확인할 방법이 없다. */
  const validatable = keys.filter((key) => key.sourceModifiedAt);
  if (!validatable.length || !bucket()) return hits;

  const nowIso = new Date().toISOString();
  try {
    const rows = await getDb()
      .select({
        contentId: placeHoursSnapshots.contentId,
        sourceModifiedAt: placeHoursSnapshots.sourceModifiedAt,
        payload: placeHoursSnapshots.payload,
        fetchedAt: placeHoursSnapshots.fetchedAt,
        expiresAt: placeHoursSnapshots.expiresAt,
      })
      .from(placeHoursSnapshots)
      .where(
        inArray(
          placeHoursSnapshots.contentId,
          validatable.map((key) => key.contentId),
        ),
      );

    const expectedByContentId = new Map(
      validatable.map((key) => [key.contentId, key.sourceModifiedAt]),
    );
    for (const row of rows) {
      /* 공사가 알린 변경 시각이 저장 당시와 다르면 사본은 낡은 것이다. */
      if (row.sourceModifiedAt !== expectedByContentId.get(row.contentId)) {
        continue;
      }
      if (row.expiresAt <= nowIso) continue;
      let item: KtoItem;
      try {
        item = JSON.parse(row.payload) as KtoItem;
      } catch {
        continue;
      }
      if (!item || typeof item !== "object") continue;
      hits.set(row.contentId, {
        item,
        fetchedAt: row.fetchedAt,
        sourceModifiedAt: row.sourceModifiedAt,
      });
    }
  } catch {
    /* 사본을 읽지 못하면 실시간 호출로 돌아간다. 결과의 정확성은 그대로이고
       달라지는 것은 이 요청이 볼 수 있는 후보 수뿐이다. */
    return new Map();
  }
  return hits;
}

export type HoursSnapshotWrite = HoursSnapshotKey & {
  item: KtoItem;
};

/**
 * 이번 요청이 **실시간으로 이미 받아 온** 응답을 사본으로 남긴다.
 *
 * 추가 외부 호출이 없다. 사람이 많이 가는 지역부터 더워지므로 예열 순서가 저절로
 * 맞고, 크론으로 전국을 미리 채우려 애쓰지 않아도 된다.
 */
export async function writeHoursSnapshots(
  writes: HoursSnapshotWrite[],
): Promise<number> {
  const rows = writes.filter((write) => write.sourceModifiedAt);
  if (!rows.length || !bucket()) return 0;
  const now = Date.now();
  const expiresAt = new Date(
    now + SNAPSHOT_TTL_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const fetchedAt = new Date(now).toISOString();
  try {
    /* 하나의 문장으로 묶어 내부 호출을 한 건만 쓴다. 같은 콘텐츠가 다시 오면
       덮어쓴다 — 최신 원문과 최신 변경 시각이 항상 옳다. */
    await getDb()
      .insert(placeHoursSnapshots)
      .values(
        rows.map((write) => ({
          contentId: write.contentId,
          contentTypeId: write.contentTypeId,
          sourceModifiedAt: write.sourceModifiedAt as string,
          payload: JSON.stringify(write.item),
          fetchedAt,
          expiresAt,
        })),
      )
      .onConflictDoUpdate({
        target: placeHoursSnapshots.contentId,
        set: {
          contentTypeId: sql`excluded.content_type_id`,
          sourceModifiedAt: sql`excluded.source_modified_at`,
          payload: sql`excluded.payload`,
          fetchedAt: sql`excluded.fetched_at`,
          expiresAt: sql`excluded.expires_at`,
        },
      });
    return rows.length;
  } catch {
    /* 사본을 남기지 못해도 이번 응답은 이미 실시간 근거로 완성되어 있다. */
    return 0;
  }
}

/** 만료된 사본 정리. 시간당 크론에서 부른다. */
export async function purgeExpiredHoursSnapshots(): Promise<number> {
  if (!bucket()) return 0;
  try {
    const result = await getDb()
      .delete(placeHoursSnapshots)
      .where(lt(placeHoursSnapshots.expiresAt, new Date().toISOString()));
    return (result as unknown as { meta?: { changes?: number } }).meta
      ?.changes ?? 0;
  } catch {
    return 0;
  }
}
