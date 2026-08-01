import { getRuntimeSecret } from "@/lib/runtime-env";

export const RELEASE_SECRET_NAMES = [
  "SESSION_SIGNING_KEY",
  "OPS_API_KEY",
  "PARTNER_API_KEY",
  "RELEASE_AUDITOR_API_KEY",
] as const;

export type ReleaseSecretName = (typeof RELEASE_SECRET_NAMES)[number];

export type ReleaseSecretEntry = {
  configured: boolean;
  minimumLengthMet: boolean;
  qualityPolicyMet: boolean;
  distinct: boolean;
  operationalReady: boolean;
  rejectionReasons: Array<
    | "minimum_length"
    | "known_placeholder"
    | "low_character_diversity"
    | "repeated_run"
    | "short_repeating_cycle"
  >;
  duplicateWith: ReleaseSecretName[];
};

export type ReleaseSecretTopologyStatus = {
  minimumBytes: 32;
  qualityPolicy: "minimum_length_placeholder_repetition_and_diversity";
  releaseReady: boolean;
  allConfigured: boolean;
  allMinimumLengthMet: boolean;
  allQualityPolicyMet: boolean;
  pairwiseDistinct: boolean;
  secrets: Record<ReleaseSecretName, ReleaseSecretEntry>;
};

const MINIMUM_SECRET_BYTES = 32;

function byteLength(value: string | undefined): number {
  return value ? new TextEncoder().encode(value).byteLength : 0;
}

function hasShortRepeatingCycle(value: string): boolean {
  const characters = [...value];
  for (
    let period = 1;
    period <= Math.min(16, Math.floor(characters.length / 2));
    period += 1
  ) {
    if (
      characters.every(
        (character, index) => character === characters[index % period],
      )
    ) {
      return true;
    }
  }
  return false;
}

function secretRejectionReasons(
  value: string | undefined,
): ReleaseSecretEntry["rejectionReasons"] {
  if (!value) return ["minimum_length"];
  const reasons: ReleaseSecretEntry["rejectionReasons"] = [];
  if (byteLength(value) < MINIMUM_SECRET_BYTES) {
    reasons.push("minimum_length");
  }
  if (
    /(?:^|[-_:])(change-?me|replace-?me|placeholder|example|dummy|sample|test(?:ing)?|secret|password|your[-_a-z]*)(?:$|[-_:])/i.test(
      value,
    )
  ) {
    reasons.push("known_placeholder");
  }
  if (new Set([...value]).size < 8) {
    reasons.push("low_character_diversity");
  }
  if (/(.)\1{7,}/u.test(value)) {
    reasons.push("repeated_run");
  }
  if (hasShortRepeatingCycle(value)) {
    reasons.push("short_repeating_cycle");
  }
  return [...new Set(reasons)];
}

export function releaseSecretTopologyStatus(): ReleaseSecretTopologyStatus {
  const values = Object.fromEntries(
    RELEASE_SECRET_NAMES.map((name) => [name, getRuntimeSecret(name)]),
  ) as Record<ReleaseSecretName, string | undefined>;
  const secrets = Object.fromEntries(
    RELEASE_SECRET_NAMES.map((name) => {
      const value = values[name];
      const duplicateWith = value
        ? RELEASE_SECRET_NAMES.filter(
            (candidate) =>
              candidate !== name && values[candidate] === value,
          )
        : [];
      const configured = Boolean(value);
      const minimumLengthMet =
        byteLength(value) >= MINIMUM_SECRET_BYTES;
      const rejectionReasons = secretRejectionReasons(value);
      const qualityPolicyMet = rejectionReasons.length === 0;
      const distinct = duplicateWith.length === 0;
      return [
        name,
        {
          configured,
          minimumLengthMet,
          qualityPolicyMet,
          distinct,
          operationalReady: qualityPolicyMet && distinct,
          rejectionReasons,
          duplicateWith,
        },
      ];
    }),
  ) as Record<ReleaseSecretName, ReleaseSecretEntry>;
  const allConfigured = RELEASE_SECRET_NAMES.every(
    (name) => secrets[name].configured,
  );
  const allMinimumLengthMet = RELEASE_SECRET_NAMES.every(
    (name) => secrets[name].minimumLengthMet,
  );
  const allQualityPolicyMet = RELEASE_SECRET_NAMES.every(
    (name) => secrets[name].qualityPolicyMet,
  );
  const pairwiseDistinct = RELEASE_SECRET_NAMES.every(
    (name) => secrets[name].distinct,
  );
  return {
    minimumBytes: 32,
    qualityPolicy:
      "minimum_length_placeholder_repetition_and_diversity",
    releaseReady:
      allConfigured && allQualityPolicyMet && pairwiseDistinct,
    allConfigured,
    allMinimumLengthMet,
    allQualityPolicyMet,
    pairwiseDistinct,
    secrets,
  };
}

export function getOperationalSecret(
  name: ReleaseSecretName,
): string | undefined {
  const topology = releaseSecretTopologyStatus();
  return topology.secrets[name].operationalReady
    ? getRuntimeSecret(name)
    : undefined;
}
