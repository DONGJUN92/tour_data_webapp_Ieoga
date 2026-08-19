import { getStableSessionSecret } from "@/lib/session-cookie";
import { SELF_CONFIRMABLE_GAP_CODES } from "./self-confirmable-gaps";
import type { ItineraryRegistration } from "@/lib/recovery/schema";
import type { RecoveryMode } from "@/lib/recovery/types";
import {
  koreaLatitude,
  koreaLongitude,
} from "@/lib/validation/numbers";

/* v3에서 계약이 두 갈래가 됐다. 예전 계약은 "완전 검증된 안"만 담을 수 있었고,
   운영시간을 대조하지 못한 안이 목록에 오르자 그 안의 스냅숏이 만들어지지 않아
   **응답 전체가 저장 실패로 버려졌다.** 버전을 올려 예전에 저장된 스냅숏이 새
   규칙으로 읽히지 않게 한다 — 옛 계약은 다시 실행해야 한다. */
export const APPLICATION_SAFETY_CONTRACT_VERSION = "2026-08-v5";

/* 화면과 서버가 **같은 목록**을 봐야 하므로 상수는 의존성 없는 파일에 두고 여기서
   다시 내보낸다. 계약 모듈은 세션 비밀 때문에 서버 전용 바인딩을 끌고 오는데, 화면이
   그것을 통해 상수를 가져가면 클라이언트 묶음이 통째로 깨진다. */
export { SELF_CONFIRMABLE_GAP_CODES } from "./self-confirmable-gaps";

export type ItineraryImpactNodeSnapshot = {
  id: string;
  sequence: number;
  type: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  durationMinutes: number | null;
  locked: boolean;
  reservation: boolean;
  location: {
    label: string;
    latitude: number;
    longitude: number;
    areaCode: string | null;
    sigunguCode: string | null;
  } | null;
};

export type ItineraryImpactSnapshot = {
  itineraryId: string;
  disruptedNodeId: string;
  nextFixedNodeId: string;
  nodes: ItineraryImpactNodeSnapshot[];
  hash: string;
};

/**
 * 이 스냅숏이 어느 계약에 드는가. `undefined`면 어느 쪽도 아니므로 적용할 수
 * 없다. 저장·적용·검증이 같은 함수를 보게 해서, 한쪽만 느슨해지는 일을 막는다.
 */
export function applicationSnapshotClass(
  snapshot: Pick<
    RecoveryApplicationSnapshot,
    "availability" | "evidenceGapCodes" | "confirmationRequired"
  >,
): "verified" | "self_confirmed" | undefined {
  const gaps = Array.isArray(snapshot.evidenceGapCodes)
    ? snapshot.evidenceGapCodes
    : undefined;
  if (!gaps) return undefined;
  /* `confirmationRequired`도 함께 본다. 엔진은 근거 공백이 하나라도 있으면 이
     값을 참으로 세운다 — 즉 두 값은 원래 같은 사실의 두 표현이다. 예전에는
     여기서 공백만 보고 `confirmationRequired`는 바깥에서 따로 `=== false`로
     못박아, 운영시간 미확인 안이 계약을 만들지 못했다. 한 사실을 두 곳에서
     따로 판정하면 그 둘은 언젠가 어긋난다. 한 자리에서 함께 본다. */
  if (
    snapshot.availability.status === "confirmed_open" &&
    gaps.length === 0 &&
    snapshot.confirmationRequired === false
  ) {
    return "verified";
  }
  /* 두 번째 갈래는 `confirmed_open`도 받는다. 집중률 예측이나 무장애 정보를
     확인하지 못한 것은 운영시간과 무관한 공백이므로, 운영시간은 확인됐는데
     다른 하나가 비어 있는 안이 실제로 있다 — 예전 조건은 상태가 대조 불가일
     때만 받았으므로 그 안이 계약을 만들지 못했다.

     휴무로 확인된 곳은 여기 들 수 없다. 이 스냅숏의 `availability.status` 자체가
     `confirmed_closed`를 담을 수 없게 좁혀져 있어(아래 타입 참고) 구조적으로
     표현 불가하다. 그 좁힘을 풀지 않는다. */
  if (
    gaps.length > 0 &&
    gaps.every((code) => SELF_CONFIRMABLE_GAP_CODES.has(code)) &&
    snapshot.confirmationRequired === true
  ) {
    return "self_confirmed";
  }
  return undefined;
}

export type RecoveryApplicationSnapshot = {
  contentId: string;
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  generatedAt: string;
  contractVersion: typeof APPLICATION_SAFETY_CONTRACT_VERSION;
  ruleVersion: string;
  recoveryMode: RecoveryMode;
  availability: {
    /* 대조하지 못한 상태를 그대로 담는다. `confirmed_open`으로 눌러 적으면
       적용 시점에 무엇을 확인했는지 서버가 알 수 없다. */
    status: "confirmed_open" | "official_hours_unstructured" | "unknown";
    checkedAt: string;
  };
  /* 확인이 필요한 안인가. `self_confirmed` 계약에서는 참이다 — 리터럴
     `false`로 묶어 두면 그 계약을 아예 표현할 수 없다. */
  confirmationRequired: boolean;
  evidenceGapCodes: string[];
  visitStartAt: string;
  visitEndAt: string;
  nextFixed?: {
    nodeId: string;
    scheduledAt: string;
    estimatedArrivalAt: string;
    status: "preserved";
  };
  openWindow?: {
    windowStartAt: string;
    windowEndAt: string;
    status: "fits";
    returnMinutes: number;
    returnBasis: "next_place_route" | "origin_return_route";
    returnProvider: string;
    returnDistanceMeters: number;
    returnCalculatedAt: string;
    requiredBufferMinutes: number;
    leftoverMinutes: number;
  };
  itineraryImpact?: ItineraryImpactSnapshot;
};

type ImpactSourceNode = ItineraryRegistration["nodes"][number];

function canonicalImpactPayload(
  snapshot: Omit<ItineraryImpactSnapshot, "hash">,
): string {
  return JSON.stringify({
    itineraryId: snapshot.itineraryId,
    disruptedNodeId: snapshot.disruptedNodeId,
    nextFixedNodeId: snapshot.nextFixedNodeId,
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      sequence: node.sequence,
      type: node.type,
      title: node.title,
      startAt: node.startAt,
      endAt: node.endAt,
      durationMinutes: node.durationMinutes,
      locked: node.locked,
      reservation: node.reservation,
      location: node.location
        ? {
            label: node.location.label,
            latitude: node.location.latitude,
            longitude: node.location.longitude,
            areaCode: node.location.areaCode,
            sigunguCode: node.location.sigunguCode,
          }
        : null,
    })),
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizedImpactNode(
  node: ImpactSourceNode,
  fallbackSequence: number,
): ItineraryImpactNodeSnapshot | undefined {
  const location = node.location
    ? (() => {
        const latitude = koreaLatitude(node.location.latitude);
        const longitude = koreaLongitude(node.location.longitude);
        return latitude === undefined || longitude === undefined
          ? undefined
          : {
              label: node.location.label,
              latitude,
              longitude,
              areaCode: node.location.areaCode ?? null,
              sigunguCode: node.location.sigunguCode ?? null,
            };
      })()
    : null;
  if (node.location && !location) return undefined;
  return {
    id: node.id,
    sequence: node.sequence ?? fallbackSequence,
    type: node.type,
    title: node.title,
    startAt: node.startAt ?? null,
    endAt: node.endAt ?? null,
    durationMinutes: node.durationMinutes ?? null,
    locked: node.locked,
    reservation: node.reservation,
    location: location ?? null,
  };
}

export async function createItineraryImpactSnapshot(params: {
  itineraryId: string;
  disruptedNodeId: string;
  nextFixedNodeId: string;
  nodes: ImpactSourceNode[];
}): Promise<ItineraryImpactSnapshot | undefined> {
  const ordered = params.nodes
    .map((node, index) => normalizedImpactNode(node, index))
    .filter((node): node is ItineraryImpactNodeSnapshot => Boolean(node))
    .sort((a, b) => a.sequence - b.sequence);
  if (ordered.length !== params.nodes.length) return undefined;
  const disruptedIndex = ordered.findIndex(
    (node) => node.id === params.disruptedNodeId,
  );
  const nextFixedIndex = ordered.findIndex(
    (node) => node.id === params.nextFixedNodeId,
  );
  if (disruptedIndex < 0 || nextFixedIndex <= disruptedIndex) {
    return undefined;
  }
  const payload = {
    itineraryId: params.itineraryId,
    disruptedNodeId: params.disruptedNodeId,
    nextFixedNodeId: params.nextFixedNodeId,
    nodes: ordered.slice(disruptedIndex, nextFixedIndex + 1),
  };
  return {
    ...payload,
    hash: await sha256(canonicalImpactPayload(payload)),
  };
}

export async function itineraryImpactSnapshotIsValid(
  snapshot: ItineraryImpactSnapshot,
): Promise<boolean> {
  if (
    !snapshot.itineraryId ||
    !snapshot.disruptedNodeId ||
    !snapshot.nextFixedNodeId ||
    !Array.isArray(snapshot.nodes) ||
    snapshot.nodes.length < 2 ||
    !/^[a-f0-9]{64}$/.test(snapshot.hash)
  ) {
    return false;
  }
  const expected = await sha256(
    canonicalImpactPayload({
      itineraryId: snapshot.itineraryId,
      disruptedNodeId: snapshot.disruptedNodeId,
      nextFixedNodeId: snapshot.nextFixedNodeId,
      nodes: snapshot.nodes,
    }),
  );
  return expected === snapshot.hash;
}

async function encryptionKey(): Promise<CryptoKey | undefined> {
  const secret = getStableSessionSecret();
  if (!secret) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `ieoga-recovery-application-snapshot-v2:${secret}`,
    ),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function encoded(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decoded(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Invalid base64url snapshot field.");
  }
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function additionalData(runId: string, optionId: string): ArrayBuffer {
  return Uint8Array.from(
    new TextEncoder().encode(`${runId}:${optionId}`),
  ).buffer;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function snapshotIsValid(
  snapshot: RecoveryApplicationSnapshot,
): Promise<boolean> {
  const latitude = koreaLatitude(snapshot.latitude);
  const longitude = koreaLongitude(snapshot.longitude);
  const registered = snapshot.recoveryMode === "registered_itinerary";
  const openWindow = snapshot.recoveryMode === "open_window";
  return Boolean(
    latitude !== undefined &&
      longitude !== undefined &&
      snapshot.contentId.trim() &&
      snapshot.title.trim() &&
      snapshot.address.trim() &&
      validTimestamp(snapshot.generatedAt) &&
      snapshot.contractVersion === APPLICATION_SAFETY_CONTRACT_VERSION &&
      snapshot.ruleVersion.trim() &&
      (registered || openWindow) &&
      /* 두 갈래 중 하나여야 한다.

         (1) 완전 검증: 운영시간이 확인됐고 근거 공백이 없다. 바로 적용된다.
         (2) 운영시간 미확인: 상태가 대조 불가이고, 공백이 운영시간 **하나뿐**
             이다. 이 갈래는 적용 시점에 여행자의 동의를 따로 요구한다.

         휴무로 확인된 곳(`confirmed_closed`)은 어느 갈래에도 들지 못한다 —
         확인하지 못한 것이 아니라 확인된 사실이기 때문이다. 접근성 등 다른
         공백이 섞여 있어도 마찬가지다. */
      applicationSnapshotClass(snapshot) !== undefined &&
      validTimestamp(snapshot.availability.checkedAt) &&
      validTimestamp(snapshot.visitStartAt) &&
      validTimestamp(snapshot.visitEndAt) &&
      Date.parse(snapshot.visitEndAt) > Date.parse(snapshot.visitStartAt) &&
      (!registered ||
        (snapshot.nextFixed?.status === "preserved" &&
          validTimestamp(snapshot.nextFixed.scheduledAt) &&
          validTimestamp(snapshot.nextFixed.estimatedArrivalAt) &&
          Boolean(
            snapshot.itineraryImpact &&
              (await itineraryImpactSnapshotIsValid(
                snapshot.itineraryImpact,
              )),
          ))) &&
      (!openWindow ||
        (snapshot.openWindow?.status === "fits" &&
          validTimestamp(snapshot.openWindow.windowStartAt) &&
          validTimestamp(snapshot.openWindow.windowEndAt) &&
          validTimestamp(snapshot.openWindow.returnCalculatedAt) &&
          typeof snapshot.openWindow.returnProvider === "string" &&
          snapshot.openWindow.returnProvider.length > 0 &&
          Number.isFinite(snapshot.openWindow.returnDistanceMeters) &&
          snapshot.openWindow.returnDistanceMeters >= 0 &&
          Number.isFinite(snapshot.openWindow.returnMinutes) &&
          snapshot.openWindow.returnMinutes >= 0 &&
          Number.isFinite(snapshot.openWindow.requiredBufferMinutes) &&
          snapshot.openWindow.requiredBufferMinutes >= 0 &&
          Number.isFinite(snapshot.openWindow.leftoverMinutes) &&
          snapshot.openWindow.leftoverMinutes >=
            snapshot.openWindow.requiredBufferMinutes))
  );
}

export async function encryptApplicationSnapshot(
  snapshot: RecoveryApplicationSnapshot,
  runId: string,
  optionId: string,
): Promise<string | undefined> {
  const key = await encryptionKey();
  if (!key || !(await snapshotIsValid(snapshot))) return undefined;
  const latitude = koreaLatitude(snapshot.latitude) as number;
  const longitude = koreaLongitude(snapshot.longitude) as number;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ ...snapshot, latitude, longitude }),
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: additionalData(runId, optionId),
    },
    key,
    plaintext,
  );
  return JSON.stringify({
    version: 2,
    iv: encoded(iv),
    ciphertext: encoded(new Uint8Array(ciphertext)),
  });
}

export async function decryptApplicationSnapshot(
  encrypted: string | null | undefined,
  runId: string,
  optionId: string,
  expected: { contentId: string; title: string },
): Promise<RecoveryApplicationSnapshot | undefined> {
  if (!encrypted) return undefined;
  const key = await encryptionKey();
  if (!key) return undefined;
  try {
    const envelope = JSON.parse(encrypted) as {
      version?: unknown;
      iv?: unknown;
      ciphertext?: unknown;
    };
    if (
      envelope.version !== 2 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      return undefined;
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decoded(envelope.iv),
        additionalData: additionalData(runId, optionId),
      },
      key,
      decoded(envelope.ciphertext),
    );
    const parsed = JSON.parse(
      new TextDecoder().decode(plaintext),
    ) as RecoveryApplicationSnapshot;
    if (
      parsed.contentId !== expected.contentId ||
      parsed.title !== expected.title ||
      !(await snapshotIsValid(parsed))
    ) {
      return undefined;
    }
    return {
      ...parsed,
      address: parsed.address.trim(),
      latitude: koreaLatitude(parsed.latitude) as number,
      longitude: koreaLongitude(parsed.longitude) as number,
    };
  } catch {
    return undefined;
  }
}
