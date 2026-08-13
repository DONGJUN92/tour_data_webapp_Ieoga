import { sourceLabelText } from "./status-labels";

export type TravelerLanguage = "ko" | "en";

/* These are diagnostic contract names. They belong in server logs and the
   persisted source ledger, but a traveler cannot act on them. Keep the list
   next to the one screen-boundary sanitizer so a newly added TourAPI call
   cannot accidentally leak through one component while another hides it. */
const KTO_SERVICE_IDS = [
  "KorService2",
  "TarRlteTarService1",
  "TatsCnctrRateService",
  "KorWithService2",
  "LocgoHubTarService1",
  "AreaTarDemDsService",
  "AreaTarResDemService",
  "AreaTarDivService",
] as const;

const KTO_OPERATION_IDS = [
  "ldongCode2",
  "locationBasedList2",
  "searchKeyword2",
  "detailIntro2",
  "detailCommon2",
  "areaBasedList1",
  "tatsCnctrRatedList",
  "detailWithTour2",
  "areaTouDivList",
  "areaExpDivList",
  "areaIntlDivList",
  "areaTarSjrnDsList",
  "areaTarExpDsList",
  "areaTarSvcDemList",
  "areaCulResDemList",
] as const;

const serviceAlternation = KTO_SERVICE_IDS.join("|");
const operationAlternation = KTO_OPERATION_IDS.join("|");
const servicePattern = new RegExp(`\\b(?:${serviceAlternation})\\b`, "i");
const operationPattern = new RegExp(`\\b(?:${operationAlternation})\\b`, "i");
const serviceShapePattern = /\b[A-Z][A-Za-z0-9]*Service\d*\b/;
const operationShapePattern =
  /\b[a-z][A-Za-z0-9]*(?:List|Detail|Code|Tour|Rated)\d*\b/;
const ktoErrorCodePattern = /\bKTO_[A-Z0-9_]+\b/;
const ktoContextPattern =
  /한국관광공사|Korea Tourism Organization|\bKTO(?:_|\b)/i;
const requestIdPattern =
  /(?:Request ID|요청 ID)\s*[:·]?\s*([A-Za-z0-9][\w-]*)/i;
const requestIdSuffixPattern =
  /\s*(?:·|-)?\s*(?:Request ID|요청 ID)\s*[:·]?\s*[A-Za-z0-9][\w-]*\s*$/i;
const genericTransportErrorPattern =
  /^(?:요청에 실패했습니다\.?|request failed\.?|failed to fetch|network ?error)(?:\s*\(\d{3}\))?$/i;

const KTO_LABEL: Record<TravelerLanguage, string> = {
  ko: "한국관광공사",
  en: "Korea Tourism Organization",
};

const KTO_ERROR_COPY: Record<TravelerLanguage, string> = {
  ko: "한국관광공사 관광정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  en: "Korea Tourism Organization data is temporarily unavailable. Please try again shortly.",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function travelerRequestId(value: unknown): string | undefined {
  const message = value instanceof Error ? value.message : text(value);
  return message.match(requestIdPattern)?.[1];
}

export function containsInternalKtoName(value: unknown): boolean {
  const message = value instanceof Error ? value.message : text(value);
  return (
    servicePattern.test(message) ||
    operationPattern.test(message) ||
    ktoErrorCodePattern.test(message) ||
    (ktoContextPattern.test(message) &&
      (serviceShapePattern.test(message) || operationShapePattern.test(message)))
  );
}

/**
 * Removes provider contract identifiers while retaining the useful sentence.
 * Request IDs are deliberately untouched so support can still correlate the
 * screen with server logs.
 */
export function sanitizeTravelerText(
  value: unknown,
  language: TravelerLanguage = "ko",
): string {
  const original = text(value);
  if (!original) return "";
  const hadInternalName = containsInternalKtoName(original);
  const provider = KTO_LABEL[language];
  const operation = `(?:${operationAlternation})`;
  const service = `(?:${serviceAlternation})`;
  let safe = original
    .replace(
      new RegExp(
        `(?:한국관광공사|Korea Tourism Organization)\\s+(?:OpenAPI|TourAPI)?\\s*${operation}`,
        "gi",
      ),
      provider,
    )
    .replace(
      new RegExp(`${service}(?:[.:/\\s-]+${operation})?`, "gi"),
      provider,
    )
    .replace(new RegExp(operation, "gi"), provider)
    .replace(/한국관광공사\s+(?:OpenAPI|TourAPI)/gi, "한국관광공사")
    .replace(
      /Korea Tourism Organization\s+(?:OpenAPI|TourAPI)/gi,
      "Korea Tourism Organization",
    )
    .replace(
      /한국관광공사(?:의)?\s+한국관광공사/g,
      "한국관광공사",
    )
    .replace(
      /Korea Tourism Organization(?:'s)?\s+Korea Tourism Organization/gi,
      "Korea Tourism Organization",
    );
  if (hadInternalName) {
    safe = safe
      .replace(new RegExp(serviceShapePattern.source, "g"), provider)
      .replace(new RegExp(operationShapePattern.source, "g"), provider)
      .replace(/한국관광공사(?:의)?\s+한국관광공사/g, "한국관광공사")
      .replace(
        /Korea Tourism Organization(?:'s)?\s+Korea Tourism Organization/gi,
        "Korea Tourism Organization",
      );
  }
  if (ktoErrorCodePattern.test(safe)) {
    const requestId = travelerRequestId(original);
    safe = `${KTO_ERROR_COPY[language]}${
      requestId
        ? ` · ${language === "en" ? "Request ID" : "요청 ID"} ${requestId}`
        : ""
    }`;
  }
  if (language === "en" && /[가-힣]/u.test(safe)) {
    return /한국관광공사/u.test(original) && /20\s*km/i.test(original)
      ? "Candidates are checked within the maximum 20 km search range supported by Korea Tourism Organization data."
      : hadInternalName
        ? "Korea Tourism Organization data reported a limitation. Review the verification details before relying on this option."
        : "Official data reported a limitation. Review the verification details before relying on this option.";
  }
  return safe;
}

/** A source label safe for traveler-facing ledgers and cards. */
export function travelerSourceLabel(
  value: unknown,
  language: TravelerLanguage = "ko",
): string {
  const source = text(value);
  if (!source) return language === "en" ? "Official data" : "공식 데이터";
  if (containsInternalKtoName(source)) {
    return KTO_LABEL[language];
  }
  return sourceLabelText(source, language);
}

/**
 * Converts an exception into actionable copy without discarding its request
 * ID. Meaningful server guidance (for example a rate-limit instruction) is
 * retained; generic HTTP/status text and internal TourAPI names are replaced.
 */
export function travelerErrorText(
  error: unknown,
  language: TravelerLanguage,
  fallbackEn: string,
  fallbackKo: string,
): string {
  const raw = error instanceof Error ? error.message.trim() : text(error);
  const requestId = travelerRequestId(raw);
  const withoutRequestId = raw.replace(requestIdSuffixPattern, "").trim();
  let message: string;

  if (containsInternalKtoName(withoutRequestId)) {
    message = KTO_ERROR_COPY[language];
  } else if (
    !withoutRequestId ||
    genericTransportErrorPattern.test(withoutRequestId)
  ) {
    message = language === "en" ? fallbackEn : fallbackKo;
  } else {
    const sanitized = sanitizeTravelerText(withoutRequestId, language);
    message =
      language === "en" && /[가-힣]/u.test(sanitized)
        ? fallbackEn
        : sanitized;
  }

  if (!requestId) return message;
  return `${message} · ${language === "en" ? "Request ID" : "요청 ID"} ${requestId}`;
}
