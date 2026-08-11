import { getStableSessionSecret } from "@/lib/session-cookie";
import type { ItineraryRegistration } from "@/lib/recovery/schema";
import type { RecoveryMode } from "@/lib/recovery/types";
import {
  koreaLatitude,
  koreaLongitude,
} from "@/lib/validation/numbers";

export const APPLICATION_SAFETY_CONTRACT_VERSION = "2026-08-v2";

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
    status: "confirmed_open";
    checkedAt: string;
  };
  confirmationRequired: false;
  evidenceGapCodes: [];
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
      snapshot.availability.status === "confirmed_open" &&
      validTimestamp(snapshot.availability.checkedAt) &&
      snapshot.confirmationRequired === false &&
      Array.isArray(snapshot.evidenceGapCodes) &&
      snapshot.evidenceGapCodes.length === 0 &&
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
