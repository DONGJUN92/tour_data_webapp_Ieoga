"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JourneyExecution } from "@/lib/recovery/execution";
import { WeatherGlanceStrip } from "./WeatherGlanceStrip";
import { ManualLocationPicker, type ManualPlace } from "./ManualLocationPicker";
import DiscoverWindowPanel from "./DiscoverWindowPanel";
import { RouteMap, type RouteMapMarker, type RoutePoint } from "./RouteMap";
import { ActiveJourneyCockpit } from "./ActiveJourneyCockpit";
import {
  PlanPlacementDialog,
  type PlanCandidate,
  type PlanPlacement,
} from "./PlanPlacementDialog";
import { LaunchEvidencePanel } from "./LaunchEvidencePanel";
import { PolicyMissionPanel } from "./PolicyMissionPanel";
import { SimulationGuide } from "./SimulationGuide";
import { ReferenceTimePicker } from "./ReferenceTimePicker";
import {
  formatReferenceTime,
  resolveReferenceTime,
  type ReferenceTimeMode,
} from "./reference-time";

import {
  AUDIENCES_EN,
  Audience,
  Counterfactual,
  DataContribution,
  District,
  GUIDE_STORAGE_KEY,
  HealthResponse,
  INCIDENTS,
  INCIDENTS_EN,
  Incident,
  JourneyPlan,
  JourneyStop,
  Language,
  LoadState,
  LocationMode,
  OPEN_APIS,
  POLICY_APIS,
  PlaceSearchResult,
  RecoveryOption,
  RecoveryResponse,
  Region,
  ScheduleDiff,
  TabId,
  TRAVEL_MODES,
  ABLATION_SOURCES,
  type TravelMode,
  asRecord,
  compactValue,
  emptyJourneyDraft,
  formatCoverage,
  formatCrowd,
  formatDate,
  formatIsoTime,
  formatMetricLabel,
  formatReferenceDate,
  formatStopTime,
  humanizeStatus,
  inferRecoveryContext,
  itineraryContract,
  makeStop,
  appointmentMinutesFromNow,
  normalizeDistricts,
  normalizeJourneyExecution,
  normalizeJourneyPlan,
  normalizePlaceResults,
  normalizeRegions,
  practiceJourneySchedule,
  readText,
  sourceDecisionEffect,
  sourceName,
  sourceStatus,
  statusTone,
  stopTypeFromTourismContent,
  todayInKorea,
  fetchJson,
  OPTION_SORTS,
  filterOptionsByTourismCategory,
  sortOptionsByCrowd,
  tourismCategoryCounts,
  type OptionSort,
  HALF_HOUR_TIMES,
  toHalfHour,
} from "./product-app-model";
import { quotedWithParticle, withParticle } from "@/lib/text/korean";
import { regionDisplayName } from "@/lib/text/region-alias";
import { sourceLabelText, statusLabel } from "@/lib/text/status-labels";
import {
  sanitizeTravelerText,
  travelerErrorText,
} from "@/lib/text/traveler-facing";
import {
  authoritativeExecutionMatchesApply,
  executionMatchesAppliedRecovery,
  executionPreservesLockedAppointment,
  optionApplicationSafety,
} from "./traveler-safety";

const ABLATION_SOURCE_EN: Record<string, { label: string; lost: string }> = {
  TarRlteTarService1: {
    label: "Related-destination evidence",
    lost: "Co-visit evidence disappears, so IEOGA cannot prove purpose preservation or use that ranking signal.",
  },
  TatsCnctrRateService: {
    label: "Visitor concentration forecast",
    lost: "Future concentration evidence disappears, so IEOGA cannot verify crowd avoidance or adjust the ranking.",
  },
  KorWithService2: {
    label: "Barrier-free tourism data",
    lost: "Official accessibility evidence disappears, so every option remains unverified for mobility needs.",
  },
};

const PURPOSE_LABEL_EN: Record<string, string> = {
  "지금 비어 있는 시간": "Open time now",
  "관광 명소": "Sightseeing",
  "문화·전시 관람": "Culture and exhibitions",
  "축제·공연 관람": "Festivals and performances",
  "여행 코스 체험": "Touring route",
  "레포츠·체험": "Leisure activity",
  숙박: "Accommodation",
  "쇼핑·시장 방문": "Shopping or market visit",
  식사: "Meal",
  "관광 방문": "Tourism visit",
  이동: "Transfer",
  "관광·체험": "Sightseeing or activity",
};

function purposeLabelText(value: string | undefined, language: Language): string {
  if (language === "ko") return value || "여행 경험";
  return PURPOSE_LABEL_EN[value ?? ""] || "Travel experience";
}

function contributionSourceText(value: unknown, language: Language): string {
  const source = String(value ?? "").trim();
  const labels: Record<string, { ko: string; en: string }> = {
    KorService2: {
      ko: "한국관광공사 국문 관광정보",
      en: "Korea Tourism Organization · official Korean tourism data",
    },
    TarRlteTarService1: {
      ko: "한국관광공사 연관 관광지",
      en: "Korea Tourism Organization · related destinations",
    },
    TatsCnctrRateService: {
      ko: "한국관광공사 관광지 집중률 예측",
      en: "Korea Tourism Organization · visitor concentration forecast",
    },
    KorWithService2: {
      ko: "한국관광공사 무장애 여행정보",
      en: "Korea Tourism Organization · barrier-free travel data",
    },
    "TMAP 보행자 경로안내": {
      ko: "TMAP 보행자 경로안내",
      en: "TMAP pedestrian routing",
    },
    "TMAP 자동차 경로안내": {
      ko: "TMAP 자동차 경로안내",
      en: "TMAP driving route",
    },
    "카카오맵 대중교통 길찾기": {
      ko: "카카오맵 대중교통 길찾기",
      en: "KakaoMap public-transit routing",
    },
    "카카오맵 자전거 길찾기": {
      ko: "카카오맵 자전거 길찾기",
      en: "KakaoMap bicycle routing",
    },
    "OpenStreetMap Routing": {
      ko: "OpenStreetMap 경로",
      en: "OpenStreetMap routing",
    },
    "기상청 단기예보": {
      ko: "기상청 단기예보",
      en: "Korea Meteorological Administration forecast",
    },
    "Open-Meteo": { ko: "Open-Meteo", en: "Open-Meteo" },
  };
  const exact = labels[source];
  if (exact) return exact[language];
  const known = Object.entries(labels).find(([key]) => source.includes(key));
  if (known) return known[1][language];
  if (language === "en") return sourceLabelText(source, "en");
  return source || "공식 데이터";
}

function contributionDecisionText(
  contribution: DataContribution,
  language: Language,
): string {
  if (language === "ko") {
    return contribution.decision || "복구 조건 판정에 사용했습니다.";
  }
  const source = String(contribution.source ?? "");
  if (source === "KorService2") {
    return contribution.decision?.includes("운영")
      ? "Verified whether the place is officially open for the proposed stay."
      : "Verified the official place, coordinates, distance and tourism-content type.";
  }
  if (source === "TarRlteTarService1") {
    return "Used related-destination evidence to preserve the original travel purpose.";
  }
  if (source === "TatsCnctrRateService") {
    return "Used the concentration forecast for crowd avoidance and ordering.";
  }
  if (source === "KorWithService2") {
    return "Verified the required accessibility route in official barrier-free data.";
  }
  if (source.includes("TMAP") || source.includes("카카오맵") || source.includes("Routing")) {
    return "Calculated the real route and arrival buffer through the next protected appointment.";
  }
  if (source.includes("기상청") || source.includes("Open-Meteo")) {
    return contribution.status === "unavailable"
      ? "The weather provider did not return usable evidence; the limitation is disclosed."
      : "Recorded current weather evidence for this recovery decision.";
  }
  return "Used this source to verify a required recovery condition.";
}

function contributionEffectText(value: unknown, language: Language): string {
  const effect = String(value ?? "");
  const labels: Record<string, { ko: string; en: string }> = {
    verified: { ko: "검증 근거", en: "Verified evidence" },
    excluded: { ko: "제외 근거", en: "Exclusion evidence" },
    ranked: { ko: "순위에 반영", en: "Affected ordering" },
    bounded: { ko: "판단 범위 설정", en: "Bounded the decision" },
  };
  return labels[effect]?.[language] ?? statusLabel(value, language);
}

function compactLocalizedValue(value: unknown, language: Language): string {
  if (language === "ko") return compactValue(value);
  if (value === null || value === undefined || value === "") return "Not verified";
  if (typeof value === "boolean") return value ? "Verified" : "Not verified";
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (typeof value === "string") {
    return /[가-힣]/u.test(value)
      ? "See the official Korean data"
      : statusLabel(value, "en");
  }
  const record = asRecord(value);
  const english = readText(record, ["noteEn", "labelEn", "descriptionEn"]);
  if (english) return english;
  const status = readText(record, ["status", "value"]);
  return status ? statusLabel(status, "en") : "See the official evidence";
}

function counterfactualReasonText(
  counterfactual: Counterfactual,
  language: Language,
): string {
  if (language === "ko") {
    return (
      counterfactual.reason ||
      "다음 예약을 지키면서 가능한 최소 조건 조정을 계산했습니다."
    );
  }
  const relaxation = counterfactual.requiredRelaxation;
  if (!relaxation) {
    return "IEOGA calculated the smallest condition change that may produce a safe alternative.";
  }
  const amount = relaxation.amount ?? 0;
  if (relaxation.constraint === "available_time") {
    return `At least ${amount} more minute${amount === 1 ? "" : "s"} are needed before the next booking.`;
  }
  if (relaxation.constraint === "minimum_stay") {
    return `The minimum stay must be reduced by ${amount} minute${amount === 1 ? "" : "s"} before this place can be verified.`;
  }
  if (relaxation.constraint === "safety_buffer") {
    return `The booking safety buffer would need to change by ${amount} minute${amount === 1 ? "" : "s"}.`;
  }
  if (relaxation.constraint === "indoor_requirement") {
    return "Outdoor options must be included before this place can be verified.";
  }
  return "One required condition must change before this place can be verified.";
}

function relaxationDescriptionText(
  counterfactual: Counterfactual,
  language: Language,
): string {
  const relaxation = counterfactual.requiredRelaxation;
  if (language === "ko") return relaxation?.description || "조건 조정 필요";
  if (!relaxation) return "Condition change required";
  const current = relaxation.currentLimit;
  const required = relaxation.requiredLimit;
  if (relaxation.constraint === "available_time") {
    return `Available time: ${current ?? 0} min → ${required ?? 0} min`;
  }
  if (relaxation.constraint === "minimum_stay") {
    return `Minimum stay: ${current ?? 0} min → ${required ?? 0} min`;
  }
  if (relaxation.constraint === "safety_buffer") {
    return `Safety buffer: ${current ?? 0} min → ${required ?? 0} min`;
  }
  if (relaxation.constraint === "indoor_requirement") {
    return "Indoor-only: on → include outdoor options";
  }
  return "Adjust one required condition";
}

function weatherSourceInfo(
  evidence: unknown,
  language: Language,
): { label: string; url?: string } {
  const record = asRecord(evidence);
  const provider = readText(record, ["provider", "source"]);
  if (provider === "kma_short_term" || provider.includes("기상청")) {
    return {
      label:
        language === "en"
          ? "Korea Meteorological Administration · short-term forecast"
          : "기상청 단기예보",
      url: "https://www.weather.go.kr/",
    };
  }
  if (provider === "open_meteo" || provider.includes("Open-Meteo")) {
    return { label: "Open-Meteo", url: "https://open-meteo.com/" };
  }
  return {
    label: language === "en" ? "Weather source not recorded" : "기상 출처 미기록",
  };
}

function formatLocalizedDay(value: string | undefined, language: Language) {
  if (!value) {
    return language === "en" ? "Date unavailable" : "날짜 정보 없음";
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00+09:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatLocalizedDateTime(value: string | undefined, language: Language) {
  if (!value) return language === "en" ? "Time unavailable" : "시각 정보 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function ProductApp() {
  const [activeTab, setActiveTab] = useState<TabId>("recover");
  /* 대안 목록의 정렬 축. 집중률을 점수에 녹여 두면 왜 이 순서인지 알 수 없고
     되돌릴 수도 없다. 축을 고른 행위가 곧 동의가 되게 한다. */
  const [optionSort, setOptionSort] = useState<OptionSort>("recommended");
  const [optionCategory, setOptionCategory] = useState("all");
  const [language, setLanguage] = useState<Language>("ko");
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);
  const [regions, setRegions] = useState<Region[]>([]);
  const [regionState, setRegionState] = useState<LoadState>("loading");
  const [regionError, setRegionError] = useState("");

  const [journeyDraft, setJourneyDraft] = useState<JourneyPlan>(emptyJourneyDraft);
  /* "시간이 비었어요"에서 넘어온 장소. 초안이 비어 있으면 바로 넣고, 이미
     적어 둔 일정이 있으면 어디에 넣을지 물어본다. */
  const [placeToPlan, setPlaceToPlan] = useState<PlanCandidate | null>(null);
  const [journeyPlan, setJourneyPlan] = useState<JourneyPlan | null>(null);
  const [journeyState, setJourneyState] = useState<"loading" | "ready">("loading");
  const [journeySaveState, setJourneySaveState] = useState<LoadState>("idle");
  const [journeyEditing, setJourneyEditing] = useState(false);
  const [journeyError, setJourneyError] = useState("");
  const [journeyPlaceStopId, setJourneyPlaceStopId] = useState("");
  const [journeyPlaceState, setJourneyPlaceState] = useState<LoadState>("idle");
  const [journeyPlaceError, setJourneyPlaceError] = useState("");
  const [journeyPlaceResults, setJourneyPlaceResults] = useState<PlaceSearchResult[]>([]);
  const [affectedStopId, setAffectedStopId] = useState("");
  const [nextFixedStopId, setNextFixedStopId] = useState("");

  const [areaCode, setAreaCode] = useState("");
  const [districts, setDistricts] = useState<District[]>([]);
  const [sigunguCode, setSigunguCode] = useState("");

  const [locationMode, setLocationMode] = useState<LocationMode>("unselected");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [originLabel, setOriginLabel] = useState("");
  const [geoState, setGeoState] = useState<LoadState>("idle");
  const [geoMessage, setGeoMessage] = useState("");
  const [geoAttribution, setGeoAttribution] = useState("");
  const originSelectionCurrent = Boolean(
    latitude.trim() &&
      longitude.trim() &&
      geoState === "success" &&
      originLabel.trim() &&
      (locationMode === "automatic" || locationMode === "manual"),
  );
  const [incident, setIncident] = useState<Incident>("rain");
  const [referenceTimeMode, setReferenceTimeMode] =
    useState<ReferenceTimeMode>("now");
  const [referenceTimeLocal, setReferenceTimeLocal] = useState("");
  const [referenceClockMs, setReferenceClockMs] = useState(0);
  const [submittedReferenceTime, setSubmittedReferenceTime] = useState<{
    mode: ReferenceTimeMode;
    iso: string;
  } | null>(null);
  const [availableMinutes, setAvailableMinutes] = useState(90);
  const [travelMode, setTravelMode] = useState<TravelMode>("walk");
  const [safetyBufferMinutes, setSafetyBufferMinutes] = useState(15);
  const [minimumStayMinutes, setMinimumStayMinutes] = useState(30);
  const [audience, setAudience] = useState<Audience>("general");
  /* 우천이면 실내 조건을 기본으로 켠다. 엔진이 더 이상 우천을 이유로 실내를
     강제하지 않으므로(명시적으로 보낸 값이 이긴다) 그 기본값을 화면이 만들어야
     한다. 사용자가 끄면 그 선택이 유지되며, 그때 비로소 실외 후보까지 검토된다. */
  const [indoorOnly, setIndoorOnly] = useState(true);
  const [indoorTouched, setIndoorTouched] = useState(false);
  /* 심사용 제거실험. 끈 서비스는 이 요청에서 호출되지 않고, 응답의 ablation이
     무엇을 끄고 얻은 수치인지 함께 적는다. */
  const [disabledSources, setDisabledSources] = useState<string[]>([]);
  const [analyticsConsent, setAnalyticsConsent] = useState(false);
  const [deleteState, setDeleteState] = useState<LoadState>("idle");
  const [deleteMessage, setDeleteMessage] = useState("");

  /* 언어를 바꾸면 화면은 영어가 되는데 탭 제목은 한국어로 남아 있었다.
     서버 메타데이터는 요청 시점에 정해지므로 클라이언트에서 맞춰 준다. */
  useEffect(() => {
    document.documentElement.lang = language;
    const original = document.title;
    if (language === "en") {
      document.title = "IEOGA | Keep your next booking when a stop breaks";
    }
    return () => {
      document.documentElement.lang = "ko";
      document.title = original;
    };
  }, [language]);

  const [recoverState, setRecoverState] = useState<LoadState>("idle");
  const [recoverError, setRecoverError] = useState("");
  const [recovery, setRecovery] = useState<RecoveryResponse | null>(null);
  const recoveryCategoryCounts = useMemo(
    () => tourismCategoryCounts(recovery?.options ?? []),
    [recovery],
  );
  const filteredRecoveryOptions = useMemo(
    () =>
      filterOptionsByTourismCategory(
        recovery?.options ?? [],
        optionCategory,
      ),
    [optionCategory, recovery],
  );
  const sortedRecoveryOptionGroups = useMemo(
    () => sortOptionsByCrowd(filteredRecoveryOptions, optionSort),
    [filteredRecoveryOptions, optionSort],
  );
  const displayedRecoveryOptions = useMemo(
    () => [
      ...sortedRecoveryOptionGroups.ranked,
      ...sortedRecoveryOptionGroups.unranked,
    ],
    [sortedRecoveryOptionGroups],
  );
  const [shareMessages, setShareMessages] = useState<Record<string, string>>({});
  const [appliedOptionId, setAppliedOptionId] = useState("");
  const [applyingOptionId, setApplyingOptionId] = useState("");
  const [outcomeMessage, setOutcomeMessage] = useState("");
  const [outcomePriority, setOutcomePriority] =
    useState<"polite" | "assertive">("polite");
  const [activeExecution, setActiveExecution] =
    useState<JourneyExecution | null>(null);
  const [executionState, setExecutionState] =
    useState<"loading" | "ready">("loading");
  const [guideOpen, setGuideOpen] = useState(false);
  const [practiceState, setPracticeState] = useState<LoadState>("idle");
  const [practiceError, setPracticeError] = useState("");
  const [practiceReady, setPracticeReady] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const appliedPlanRef = useRef<HTMLDivElement>(null);
  const recoveryFormRef = useRef<HTMLFormElement>(null);
  const recoverRequestGenerationRef = useRef(0);
  const applyInFlightRef = useRef(false);
  const applyRequestGenerationRef = useRef(0);
  const geolocationRequestGenerationRef = useRef(0);

  const [insightRegions, setInsightRegions] = useState<Region[]>([]);
  const [insightListState, setInsightListState] = useState<LoadState>("idle");
  const [insightListError, setInsightListError] = useState("");
  const [insightAreaCode, setInsightAreaCode] = useState("");
  const [insightDistricts, setInsightDistricts] = useState<District[]>([]);
  const [insightSigunguCode, setInsightSigunguCode] = useState("");
  const [insightDistrictState, setInsightDistrictState] = useState<LoadState>("idle");
  const [insightDetailState, setInsightDetailState] = useState<LoadState>("idle");
  const [insightDetailError, setInsightDetailError] = useState("");
  const [insightDetail, setInsightDetail] = useState<Record<string, unknown> | null>(null);

  const [healthState, setHealthState] = useState<LoadState>("idle");
  const [healthError, setHealthError] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const view = url.searchParams.get("view");
    /* 탭을 추가할 때 이 목록을 같이 늘리지 않으면 공유된 링크가 조용히 첫 탭으로
       떨어진다. 화면은 있는데 링크로는 닿지 않는 상태가 된다. */
    if (
      view === "recover" ||
      view === "discover" ||
      view === "insights" ||
      view === "transparency"
    ) {
      setActiveTab(view);
    }
  }, []);

  useEffect(() => {
    let live = true;
    fetchJson("/api/v1/itineraries")
      .then((payload) => {
        if (!live) return;
        const stored = normalizeJourneyPlan(payload);
        if (stored) {
          const context = inferRecoveryContext(stored);
          setJourneyPlan(stored);
          setJourneyDraft(stored);
          setAffectedStopId(context.affectedStopId);
          setNextFixedStopId(context.nextFixedStopId);
          setAudience(stored.audience);
        } else {
          setJourneyDraft((current) => ({
            ...current,
            date: todayInKorea(),
          }));
        }
      })
      .catch(() => {
        if (!live) return;
        setJourneyDraft((current) => ({
          ...current,
          date: todayInKorea(),
        }));
      })
      .finally(() => {
        if (live) setJourneyState("ready");
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    fetchJson("/api/v1/journey/active")
      .then((payload) => {
        if (!live) return;
        const execution = normalizeJourneyExecution(payload);
        setActiveExecution(execution);
        if (execution) {
          setAppliedOptionId(execution.sourceOptionId);
        }
      })
      .catch(() => {
        if (live) setActiveExecution(null);
      })
      .finally(() => {
        if (live) setExecutionState("ready");
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (
      journeyState !== "ready" ||
      executionState !== "ready" ||
      journeyPlan ||
      activeExecution
    ) {
      return;
    }
    if (window.localStorage.getItem(GUIDE_STORAGE_KEY) !== "seen") {
      setGuideOpen(true);
    }
  }, [activeExecution, executionState, journeyPlan, journeyState]);

  useEffect(() => {
    let live = true;
    fetchJson("/api/v1/regions")
      .then((payload) => {
        if (!live) return;
        const next = normalizeRegions(payload);
        setRegions(next);
        setRegionState("success");
        if (!next.length) setRegionError("현재 시도 목록을 불러오지 못했습니다.");
      })
      .catch((error: Error) => {
        if (!live) return;
        setRegionState("error");
        setRegionError(error.message);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!areaCode) return;
    let live = true;
    fetchJson(`/api/v1/regions/${encodeURIComponent(areaCode)}/districts`)
      .then((payload) => {
        if (!live) return;
        setDistricts(normalizeDistricts(payload));
      })
      .catch(() => {
        if (!live) return;
        setDistricts([]);
      });
    return () => {
      live = false;
    };
  }, [areaCode]);

  useEffect(() => {
    if (!insightAreaCode) return;
    let live = true;
    fetchJson(`/api/v1/regions/${encodeURIComponent(insightAreaCode)}/districts`)
      .then((payload) => {
        if (!live) return;
        setInsightDistricts(normalizeDistricts(payload));
        setInsightDistrictState("success");
      })
      .catch(() => {
        if (!live) return;
        setInsightDistricts([]);
        setInsightDistrictState("error");
      });
    return () => {
      live = false;
    };
  }, [insightAreaCode]);

  const selectedRegion = useMemo(
    () => regions.find((region) => region.code === areaCode),
    [regions, areaCode],
  );
  const selectedDistrict = useMemo(
    () => districts.find((district) => district.code === sigunguCode),
    [districts, sigunguCode],
  );
  const selectedInsightRegion = useMemo(
    () => insightRegions.find((region) => region.code === insightAreaCode),
    [insightRegions, insightAreaCode],
  );
  const selectedAffectedStop = useMemo(
    () => journeyPlan?.stops.find((stop) => stop.id === affectedStopId),
    [journeyPlan, affectedStopId],
  );
  const eligibleNextFixedStops = useMemo(() => {
    if (!journeyPlan) return [];
    const affectedIndex = journeyPlan.stops.findIndex(
      (stop) => stop.id === affectedStopId,
    );
    return journeyPlan.stops.filter(
      (stop, index) =>
        index > affectedIndex &&
        (stop.fixed || stop.type === "reservation"),
    );
  }, [journeyPlan, affectedStopId]);
  const selectedNextFixedStop = useMemo(
    () => journeyPlan?.stops.find((stop) => stop.id === nextFixedStopId),
    [journeyPlan, nextFixedStopId],
  );
  const preservedOriginalStops = useMemo(() => {
    if (!journeyPlan || !selectedAffectedStop || !selectedNextFixedStop) {
      return [];
    }
    const affectedIndex = journeyPlan.stops.findIndex(
      (stop) => stop.id === selectedAffectedStop.id,
    );
    const nextFixedIndex = journeyPlan.stops.findIndex(
      (stop) => stop.id === selectedNextFixedStop.id,
    );
    return journeyPlan.stops.slice(affectedIndex + 1, nextFixedIndex);
  }, [journeyPlan, selectedAffectedStop, selectedNextFixedStop]);
  const appliedOption = useMemo(
    () => recovery?.options.find((option) => option.id === appliedOptionId),
    [recovery, appliedOptionId],
  );
  const recoveryPersisted =
    recovery?.persistence.status === "persisted" &&
    recovery.persistence.runId === recovery.requestId;
  const appliedScheduleDiff = useMemo(
    () => appliedOption?.scheduleDiff ?? recovery?.scheduleDiff,
    [appliedOption, recovery],
  );
  const appliedProof = useMemo(
    () => asRecord(appliedOption?.continuityProof ?? appliedOption?.proof),
    [appliedOption],
  );
  const appliedRouteEvidence = useMemo(
    () => asRecord(appliedProof?.routeEvidence),
    [appliedProof],
  );
  const appliedWeatherEvidence = useMemo(
    () => asRecord(appliedProof?.weatherEvidence),
    [appliedProof],
  );
  const nextAppointmentMinutes = useMemo(
    () => {
      if (!journeyPlan || !selectedNextFixedStop || referenceClockMs <= 0) {
        return null;
      }
      const reference = resolveReferenceTime(
        referenceTimeMode,
        referenceTimeLocal,
        language,
        referenceClockMs,
      );
      return appointmentMinutesFromNow(
        journeyPlan.date,
        selectedNextFixedStop.time,
        reference.ok ? reference.timestamp : referenceClockMs,
      );
    },
    [
      journeyPlan,
      language,
      referenceTimeLocal,
      referenceTimeMode,
      referenceClockMs,
      selectedNextFixedStop,
    ],
  );

  useEffect(() => {
    const refresh = () => setReferenceClockMs(Date.now());
    const initial = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  function invalidateRecoveryForReferenceTime() {
    /* 이미 요청 중이어도 이전 기준 시각의 응답은 도착 즉시 버린다. */
    recoverRequestGenerationRef.current += 1;
    setRecovery(null);
    setRecoverState("idle");
    setRecoverError("");
    setSubmittedReferenceTime(null);
    setAppliedOptionId("");
    setOptionCategory("all");
    setOptionSort("recommended");
  }

  function changeReferenceTimeMode(mode: ReferenceTimeMode) {
    setReferenceClockMs(Date.now());
    setReferenceTimeMode(mode);
    invalidateRecoveryForReferenceTime();
  }

  function changeReferenceTimeLocal(value: string) {
    setReferenceClockMs(Date.now());
    setReferenceTimeLocal(value);
    invalidateRecoveryForReferenceTime();
  }

  useEffect(() => {
    if (!journeyPlan || !affectedStopId) return;
    if (!eligibleNextFixedStops.some((stop) => stop.id === nextFixedStopId)) {
      setNextFixedStopId(eligibleNextFixedStops[0]?.id ?? "");
    }
  }, [journeyPlan, affectedStopId, eligibleNextFixedStops, nextFixedStopId]);

  useEffect(() => {
    if (nextAppointmentMinutes === null) return;
    setAvailableMinutes(
      Math.min(1440, Math.max(15, nextAppointmentMinutes)),
    );
  }, [nextAppointmentMinutes, nextFixedStopId]);

  function dismissSimulationGuide() {
    window.localStorage.setItem(GUIDE_STORAGE_KEY, "seen");
    setGuideOpen(false);
  }

  async function findPracticePlace(
    keywords: string[],
  ): Promise<PlaceSearchResult> {
    for (const keyword of keywords) {
      try {
        const payload = await fetchJson("/api/v1/places/search", {
          method: "POST",
          body: JSON.stringify({
            keyword,
            purpose: "saved_stop",
            fallback: "auto",
          }),
        });
        const place = normalizePlaceResults(payload).find(
          (candidate) => candidate.retention !== "ephemeral",
        );
        if (place) return place;
      } catch {
        // Try the next official place name before reporting a failure.
      }
    }
    throw new Error(
      "실제 장소를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  async function loadPracticeItinerary() {
    setPracticeState("loading");
    setPracticeError("");
    try {
      const [firstPlace, fixedPlace] = await Promise.all([
        findPracticePlace([
          "서울역사박물관",
          "국립현대미술관 서울",
        ]),
        findPracticePlace(["세종문화회관", "경복궁"]),
      ]);
      const schedule = practiceJourneySchedule();
      const practicePlan: JourneyPlan = {
        id: "new-journey",
        title: tr("이어가 사용 연습", "IEOGA practice itinerary"),
        date: schedule.date,
        audience: "general",
        savedAt: "",
        stops: [
          makeStop({
            id: "practice-stop-changeable",
            time: schedule.firstTime,
            type: stopTypeFromTourismContent(firstPlace.contentTypeId),
            title: firstPlace.title,
            address: firstPlace.address ?? "",
            fixed: false,
            latitude: firstPlace.latitude,
            longitude: firstPlace.longitude,
            areaCode: firstPlace.areaCode,
            sigunguCode: firstPlace.sigunguCode,
          }),
          makeStop({
            id: "practice-stop-fixed",
            time: schedule.fixedTime,
            type: "reservation",
            title: fixedPlace.title,
            address: fixedPlace.address ?? "",
            fixed: true,
            reservationCode: tr("연습용 고정 일정", "Practice fixed appointment"),
            latitude: fixedPlace.latitude,
            longitude: fixedPlace.longitude,
            areaCode: fixedPlace.areaCode,
            sigunguCode: fixedPlace.sigunguCode,
          }),
        ],
      };
      setJourneyDraft(practicePlan);
      setJourneyEditing(false);
      setJourneyError("");
      setPracticeReady(true);
      setPracticeState("success");
      window.localStorage.setItem(GUIDE_STORAGE_KEY, "seen");
      setGuideOpen(false);
      window.setTimeout(() => {
        document
          .querySelector(".journey-builder")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    } catch (error) {
      setPracticeState("error");
      setPracticeError(
        travelerErrorText(
          error,
          language,
          "Could not load real places for the practice itinerary.",
          "실제 장소를 불러오지 못했습니다.",
        ),
      );
    }
  }

  function updateJourneyStop(stopId: string, patch: Partial<JourneyStop>) {
    setJourneyDraft((current) => ({
      ...current,
      stops: current.stops.map((stop) =>
        stop.id === stopId ? { ...stop, ...patch } : stop,
      ),
    }));
  }

  function addJourneyStop() {
    setJourneyDraft((current) => ({
      ...current,
      stops: [...current.stops, makeStop()],
    }));
  }

  function removeJourneyStop(stopId: string) {
    setJourneyDraft((current) => ({
      ...current,
      stops: current.stops.filter((stop) => stop.id !== stopId),
    }));
    if (journeyPlaceStopId === stopId) {
      setJourneyPlaceStopId("");
      setJourneyPlaceResults([]);
      setJourneyPlaceState("idle");
    }
  }

  async function searchJourneyStopPlace(
    stopId: string,
    fallback: "auto" | "force" = "auto",
  ) {
    const stop = journeyDraft.stops.find((item) => item.id === stopId);
    const keyword = stop?.title.trim() ?? "";
    setJourneyPlaceStopId(stopId);
    setJourneyPlaceResults([]);
    setJourneyPlaceError("");
    if (keyword.length < 2) {
      setJourneyPlaceState("error");
      setJourneyPlaceError(
        tr(
          "장소명을 두 글자 이상 입력한 뒤 확인해 주세요.",
          "Enter at least two characters for the place name.",
        ),
      );
      return;
    }
    setJourneyPlaceState("loading");
    try {
      const payload = await fetchJson("/api/v1/places/search", {
        method: "POST",
        body: JSON.stringify({
          keyword,
          purpose: "saved_stop",
          fallback,
        }),
      });
      const next = normalizePlaceResults(payload).slice(0, 8);
      setJourneyPlaceResults(next);
      setJourneyPlaceState("success");
    } catch (error) {
      setJourneyPlaceState("error");
      setJourneyPlaceError(
        travelerErrorText(
          error,
          language,
          "Could not verify official place information.",
          "공식 관광지 정보를 확인하지 못했습니다.",
        ),
      );
    }
  }

  function selectJourneyStopPlace(stopId: string, place: PlaceSearchResult) {
    /* 공식 관광정보에 없는 장소도 일정에 넣을 수 있어야 한다.
       여행자의 일정에는 백화점·카페·친구 집처럼 관광 데이터에 없는 곳이 당연히
       들어간다. 예전에는 카카오 로컬 결과를 고르면 아무 일도 일어나지 않고
       좌표가 비어서, 저장할 때 "장소 검색 결과에서 선택해 주세요"만 반복됐다 —
       방금 선택했는데 그 안내가 나오니 무엇을 하라는 건지 알 수 없다.

       제공자의 장소 데이터베이스를 그대로 보관하지는 않는다. 사용자가 고른
       **이름과 좌표, 행정구역 코드만** 남기고 제공자의 주소 문자열·상세 URL·
       내부 식별자는 저장하지 않는다. 좌표는 세상에 대한 사실이고, 그것이
       일정을 세우는 데 필요한 전부다. */
    const officialTourism = place.retention !== "ephemeral";
    const currentStop = journeyDraft.stops.find(
      (stop) => stop.id === stopId,
    );
    updateJourneyStop(stopId, {
      title: place.title,
      /* 공식 관광정보가 아니면 제공자의 주소 문자열을 저장하지 않는다. */
      address: officialTourism ? (place.address ?? "") : "",
      latitude: place.latitude,
      longitude: place.longitude,
      areaCode: place.areaCode,
      sigunguCode: place.sigunguCode,
      ...(currentStop?.type === "reservation"
        ? {}
        : { type: stopTypeFromTourismContent(place.contentTypeId) }),
    });
    setJourneyPlaceResults([]);
    setJourneyPlaceState("idle");
    setJourneyPlaceError("");
  }

  async function saveJourney(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJourneyError("");
    const completeStops = journeyDraft.stops.filter(
      (stop) => stop.title.trim() && stop.time,
    );
    if (!journeyDraft.title.trim() || !journeyDraft.date) {
      setJourneyError(
        tr(
          "여행 이름과 날짜를 입력해 주세요.",
          "Enter a trip name and travel date.",
        ),
      );
      return;
    }
    if (completeStops.length < 2) {
      setJourneyError(
        tr(
          "바꿀 수 있는 일정과 그 뒤에 지킬 일정을 포함해 두 곳 이상 입력해 주세요.",
          "Add at least two stops: one that can change and a later appointment to protect.",
        ),
      );
      return;
    }
    const stopWithoutLocation = completeStops.find(
      (stop) =>
        typeof stop.latitude !== "number" ||
        typeof stop.longitude !== "number",
    );
    if (stopWithoutLocation) {
      setJourneyError(
        language === "en"
          ? `Select “${stopWithoutLocation.title}” from the place-search results so its location can be verified.`
          : `${quotedWithParticle(stopWithoutLocation.title, "을/를")} 장소 검색 결과에서 선택해 주세요.`,
      );
      return;
    }
    const orderedStops = [...completeStops].sort((a, b) =>
      a.time.localeCompare(b.time),
    );
    const fixedStops = orderedStops.filter(
      (stop) => stop.fixed || stop.type === "reservation",
    );
    if (!fixedStops.length) {
      setJourneyError(
        tr(
          "반드시 지켜야 할 예약 또는 고정 일정 하나 이상을 잠가 주세요.",
          "Lock at least one booking or fixed appointment that IEOGA must protect.",
        ),
      );
      return;
    }
    const firstChangeableIndex = orderedStops.findIndex(
      (stop) => !stop.fixed && stop.type !== "reservation",
    );
    const nextFixed = orderedStops.find(
      (stop, index) =>
        index > firstChangeableIndex &&
        (stop.fixed || stop.type === "reservation"),
    );
    if (firstChangeableIndex < 0 || !nextFixed) {
      setJourneyError(
        tr(
          "변경 가능한 일정 뒤에 도착해야 할 예약 또는 고정 일정을 배치해 주세요.",
          "Place a protected booking or fixed appointment after a changeable stop.",
        ),
      );
      return;
    }
    if (
      typeof nextFixed.latitude !== "number" ||
      typeof nextFixed.longitude !== "number"
    ) {
      setJourneyError(
        tr(
          "다음 고정 일정의 도착 가능성을 계산하려면 장소 검색 결과에서 위치를 선택해 주세요.",
          "Select the next fixed appointment from place-search results so arrival can be verified.",
        ),
      );
      return;
    }

    const plan: JourneyPlan = {
      ...journeyDraft,
      id:
        journeyDraft.id === "new-journey"
          ? crypto.randomUUID()
          : journeyDraft.id,
      title: journeyDraft.title.trim(),
      stops: orderedStops.map((stop) => ({
        ...stop,
        title: stop.title.trim(),
        address: stop.address.trim(),
      })),
      savedAt: new Date().toISOString(),
    };
    setJourneySaveState("loading");
    try {
      const payload = await fetchJson("/api/v1/itineraries", {
        method: "POST",
        body: JSON.stringify({
          itinerary: itineraryContract(plan),
          audience: plan.audience,
        }),
      });
      const stored = normalizeJourneyPlan(payload) ?? plan;
      const context = inferRecoveryContext(stored);
      setJourneyPlan(stored);
      setJourneyDraft(stored);
      setAffectedStopId(context.affectedStopId);
      setNextFixedStopId(context.nextFixedStopId);
      setAudience(stored.audience);
      setJourneyEditing(false);
      setPracticeReady(false);
      setJourneySaveState("success");
    } catch {
      setJourneySaveState("error");
      setJourneyError(
        tr(
          "일정을 저장하지 못했습니다. 입력을 확인한 뒤 다시 시도해 주세요.",
          "Could not save the itinerary. Check the entries and try again.",
        ),
      );
    }
  }

  async function deleteMyData() {
    if (
      !window.confirm(
        tr(
          "이 기기에 연결된 일정과 복구 기록을 삭제할까요? 삭제한 기록은 되돌릴 수 없습니다.",
          "Delete the itinerary and recovery history linked to this device? This cannot be undone.",
        ),
      )
    ) {
      return;
    }
    setDeleteState("loading");
    setDeleteMessage("");
    try {
      await fetchJson("/api/v1/privacy/session", { method: "DELETE" });
      const fresh = emptyJourneyDraft();
      fresh.date = todayInKorea();
      setJourneyPlan(null);
      setJourneyDraft(fresh);
      setJourneyEditing(false);
      setRecovery(null);
      setRecoverState("idle");
      setAffectedStopId("");
      setNextFixedStopId("");
      setAppliedOptionId("");
      setActiveExecution(null);
      setPracticeReady(false);
      setDeleteState("success");
      setDeleteMessage("일정과 복구 기록을 삭제했습니다.");
    } catch (error) {
      setDeleteState("error");
      setDeleteMessage(
        error instanceof Error ? error.message : "내 데이터를 삭제하지 못했습니다.",
      );
    }
  }

  /* 고른 위치대로 초안을 고친다. 화면에서 갈라 두면 갈리므로 한 곳에 모은다. */
  function applyPlanPlacement(
    place: PlanCandidate,
    placement: PlanPlacement,
  ) {
    const fresh = () =>
      makeStop({
        title: place.title,
        address: place.address,
        type: stopTypeFromTourismContent(place.contentTypeId),
      });
    setJourneyDraft((previous) => {
      if (placement.kind === "reset") {
        /* 다른 지역이라 지우기로 했다. 지켜야 할 약속 자리는 남겨 둔다 —
           그것을 채워야 복구 판정이 돌아간다. */
        return {
          ...previous,
          stops: [fresh(), makeStop({ type: "reservation", fixed: true })],
        };
      }
      if (placement.kind === "replace") {
        return {
          ...previous,
          stops: previous.stops.map((stop) =>
            stop.id === placement.stopId
              ? {
                  ...stop,
                  title: place.title,
                  address: place.address,
                  type: stopTypeFromTourismContent(place.contentTypeId),
                }
              : stop,
          ),
        };
      }
      /* 1번 정류지는 **출발지**다. `prepend`는 "일정 맨 앞"이지 "출발지보다
         앞"이 아니다. `[fresh(), ...stops]`로 넣었더니 고른 여행지가 1번을
         차지하고 출발지가 뒤로 밀렸다 — 화면에서 확인된 증상이 이것이다.
         출발지 다음, 즉 2번 자리에 넣는다. */
      const afterOrigin = previous.stops.length ? 1 : 0;
      const next = [...previous.stops];
      next.splice(
        placement.kind === "prepend" ? afterOrigin : next.length,
        0,
        fresh(),
      );
      return { ...previous, stops: next };
    });
    /* 편집기가 접혀 있으면 바뀐 일정이 보이지 않는다. 사용자가 방금 고른
       결과는 반드시 눈에 보여야 한다 — 이것이 "아무 일도 안 일어난다"의
       원인이었다. */
    setJourneyEditing(true);
    setPlaceToPlan(null);
  }

  function changeTab(tab: TabId) {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    if (tab === "recover") url.searchParams.delete("view");
    else url.searchParams.set("view", tab);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    if (tab === "transparency" && healthState === "idle") void loadHealth();
    window.requestAnimationFrame(() => {
      document.getElementById("main-content")?.focus({ preventScroll: false });
    });
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs: TabId[] = ["recover", "discover"];
    const currentIndex = tabs.indexOf(activeTab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    const nextTab = tabs[nextIndex];
    changeTab(nextTab);
    window.requestAnimationFrame(() => {
      document.getElementById(`tab-${nextTab}`)?.focus();
    });
  }

  function changeInsightArea(nextAreaCode: string) {
    setInsightAreaCode(nextAreaCode);
    setInsightDistricts([]);
    setInsightSigunguCode("");
    setInsightDistrictState(nextAreaCode ? "loading" : "idle");
    setInsightDetail(null);
    setInsightDetailState("idle");
  }

  function requestGeolocation() {
    const requestGeneration = ++geolocationRequestGenerationRef.current;
    setGeoMessage("");
    setGeoAttribution("");
    if (!navigator.geolocation) {
      setLocationMode("manual");
      setGeoState("error");
      setGeoMessage(
        tr(
          "이 브라우저에서는 현재 위치 기능을 지원하지 않습니다. 장소를 직접 입력해 주세요.",
          "This browser does not support location detection. Search for your current place instead.",
        ),
      );
      return;
    }
    setGeoState("loading");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (requestGeneration !== geolocationRequestGenerationRef.current) return;
        const nextLatitude = position.coords.latitude.toFixed(5);
        const nextLongitude = position.coords.longitude.toFixed(5);
        setLatitude(nextLatitude);
        setLongitude(nextLongitude);
        setGeoMessage(
          tr(
            "현재 위치의 행정구역을 확인하고 있습니다.",
            "Resolving the official Korean region for your current location.",
          ),
        );
        void fetchJson("/api/v1/location/resolve", {
          method: "POST",
          body: JSON.stringify({
            latitude: Number(nextLatitude),
            longitude: Number(nextLongitude),
          }),
        })
          .then((payload) => {
            if (requestGeneration !== geolocationRequestGenerationRef.current) return;
            const record = asRecord(payload);
            const resolved = asRecord(record?.location) ?? asRecord(record?.data) ?? record;
            const resolvedAreaCode = readText(resolved, ["areaCode", "regionCode"]);
            const resolvedDistrictCode = readText(resolved, ["sigunguCode", "districtCode"]);
            const areaName = readText(resolved, ["areaName", "regionName"]);
            const districtName = readText(resolved, ["districtName", "sigunguName"]);
            setAreaCode(resolvedAreaCode);
            setSigunguCode(resolvedDistrictCode);
            setOriginLabel(
              readText(resolved, ["label"]) || tr("내 현재 위치", "My current location"),
            );
            setGeoAttribution(readText(resolved, ["attribution"]));
            setLocationMode("automatic");
            setGeoState("success");
            setGeoMessage(
              language === "en"
                ? `Location set. ${regionDisplayName([areaName, districtName].filter(Boolean).join(" "), language) || "Official Korean region unavailable"}. Exact coordinates are used only for this recovery calculation.`
                : `${withParticle([areaName, districtName].filter(Boolean).join(" ") || "현재 지역", "으로/로")} 자동 입력했어요. 정확한 좌표는 복구 계산에만 사용합니다.`,
            );
          })
          .catch(() => {
            if (requestGeneration !== geolocationRequestGenerationRef.current) return;
            setLocationMode("manual");
            setGeoState("error");
            setGeoMessage(
              tr(
                "현재 위치는 확인했지만 행정구역을 자동 판별하지 못했습니다. 아래에서 장소를 직접 입력해 주세요.",
                "Your coordinates were detected, but the official region could not be resolved. Search for your current place below.",
              ),
            );
          });
      },
      (error) => {
        if (requestGeneration !== geolocationRequestGenerationRef.current) return;
        setLocationMode("manual");
        setGeoState("error");
        setGeoMessage(
          error.code === error.PERMISSION_DENIED
            ? tr(
                "위치 권한을 사용하지 않습니다. 아래에서 현재 장소를 직접 입력해 주세요.",
                "Location permission was not used. Search for your current place below.",
              )
            : tr(
                "현재 위치를 확인하지 못했습니다. 아래에서 현재 장소를 직접 입력해 주세요.",
                "Your current location could not be resolved. Search for your current place below.",
              ),
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 },
    );
  }

  function useManualLocation() {
    geolocationRequestGenerationRef.current += 1;
    setLocationMode("manual");
    setGeoState("idle");
    setLatitude("");
    setLongitude("");
    setOriginLabel("");
    setGeoAttribution("");
    setGeoMessage(
      tr(
        "현재 장소명이나 주소를 검색해 주세요.",
        "Search for your current place or address.",
      ),
    );
  }

  function resetLocationSelection() {
    geolocationRequestGenerationRef.current += 1;
    setLocationMode("unselected");
    setGeoState("idle");
    setLatitude("");
    setLongitude("");
    setOriginLabel("");
    setAreaCode("");
    setSigunguCode("");
    setGeoMessage("");
    setGeoAttribution("");
  }

  async function submitRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecoverError("");
    if (!journeyPlan || !selectedAffectedStop || !selectedNextFixedStop) {
      setRecoverState("error");
      setRecoverError(
        tr(
          "먼저 원래 일정과 다음 고정 일정을 선택해 주세요.",
          "Select the disrupted stop and the next fixed appointment first.",
        ),
      );
      return;
    }
    const requestNowMs = Date.now();
    const requestReferenceTime = resolveReferenceTime(
      referenceTimeMode,
      referenceTimeLocal,
      language,
      requestNowMs,
    );
    if (!requestReferenceTime.ok) {
      setRecoverState("error");
      setRecoverError(requestReferenceTime.message);
      return;
    }
    const requestNextAppointmentMinutes = appointmentMinutesFromNow(
      journeyPlan.date,
      selectedNextFixedStop.time,
      requestReferenceTime.timestamp,
    );
    if (
      requestNextAppointmentMinutes === null ||
      requestNextAppointmentMinutes > 1440
    ) {
      setRecoverState("error");
      setRecoverError(
        tr(
          "다음 예약은 조회 기준 시각 뒤이면서 현재부터 24시간 이내여야 합니다. 일정 시각을 다시 확인해 주세요.",
          "The next booking must be after the reference time and within 24 hours of now. Check the schedule time.",
        ),
      );
      return;
    }
    if (
      requestNextAppointmentMinutes <= safetyBufferMinutes
    ) {
      setRecoverState("error");
      setRecoverError(
        tr(
          "다음 예약까지 남은 시간이 남겨 두기로 한 여유보다 짧습니다. 일정 시각을 확인하거나 긴급 지원을 이용해 주세요.",
          "There is less time left than the safety buffer required before your next booking. Check its time or use urgent travel support.",
        ),
      );
      return;
    }
    const lat = latitude.trim() ? Number(latitude) : Number.NaN;
    const lng = longitude.trim() ? Number(longitude) : Number.NaN;
    if (
      !Number.isFinite(lat) ||
      lat < 32 ||
      lat > 39.8 ||
      !Number.isFinite(lng) ||
      lng < 124 ||
      lng > 132
    ) {
      setRecoverState("error");
      setRecoverError(
        tr(
          "현재 위치를 자동으로 확인하거나 장소명·주소 검색 결과에서 선택해 주세요.",
          "Use your current location or select a place from the search results.",
        ),
      );
      return;
    }
    if (
      requestNextAppointmentMinutes < 15 ||
      !Number.isFinite(minimumStayMinutes) ||
      minimumStayMinutes < 10 ||
      minimumStayMinutes > 180
    ) {
      setRecoverState("error");
      setRecoverError(
        tr(
          "쓸 수 있는 시간은 15~1,440분, 머무는 시간은 10~180분 사이로 넣어 주세요.",
          "Enter 15–1,440 minutes available and a 10–180 minute stay.",
        ),
      );
      return;
    }

    setRecoverState("loading");
    setRecovery(null);
    setAppliedOptionId("");
    setOptionCategory("all");
    setOptionSort("recommended");
    setOutcomeMessage("");
    const requestGeneration = ++recoverRequestGenerationRef.current;
    /* 결과에는 서버가 확정해 돌려준 기준 시각만 표시한다. 클라이언트 선택값을
       먼저 보여 주면 서버가 보정·거절한 시각을 확정값처럼 오해하게 된다. */
    setSubmittedReferenceTime(null);
    try {
      const payload = await fetchJson("/api/v1/recover", {
        method: "POST",
        body: JSON.stringify({
          origin: {
            latitude: lat,
            longitude: lng,
            label: originLabel.trim() || tr("사용자 지정 위치", "User-selected location"),
            areaCode: areaCode || undefined,
            sigunguCode: sigunguCode || undefined,
          },
          incident,
          referenceTime:
            referenceTimeMode === "now"
              ? { mode: "current" }
              : { mode: "assumed", at: requestReferenceTime.iso },
          /* 제출 순간의 동일한 기준 시각에서 다시 계산한다. 기준 시각 변경 직후
             React effect가 아직 표시용 state를 갱신하지 않았어도 오래된 시간을
             서버로 보내지 않는다. */
          availableMinutes: requestNextAppointmentMinutes,
          audience,
          indoorOnly,
          travelMode,
          disabledSources: disabledSources.length ? disabledSources : undefined,
          safetyBufferMinutes,
          minimumStayMinutes,
          analyticsConsent,
          itinerary: itineraryContract(
            journeyPlan,
            selectedAffectedStop.id,
            selectedNextFixedStop.id,
            requestReferenceTime.iso,
          ),
        }),
      });
      const record = asRecord(payload);
      if (requestGeneration !== recoverRequestGenerationRef.current) return;
      const persistence = asRecord(record?.persistence);
      const responseReferenceTime = asRecord(record?.referenceTime);
      const authoritativeReferenceAt = readText(responseReferenceTime, [
        "at",
      ]);
      const response: RecoveryResponse = {
        requestId: readText(record, ["requestId"]) || "",
        status: readText(record, ["status"]) || "unknown",
        persistence: {
          status:
            readText(persistence, ["status"]) === "persisted"
              ? "persisted"
              : "failed",
          runId: readText(persistence, ["runId"]) || undefined,
        },
        scope: record?.scope,
        options: Array.isArray(record?.options) ? (record.options as RecoveryOption[]) : [],
        rejectedCount:
          typeof record?.rejectedCount === "number" ? (record.rejectedCount as number) : undefined,
        sourceLedger: Array.isArray(record?.sourceLedger) ? record.sourceLedger : [],
        warnings: Array.isArray(record?.warnings)
          ? record.warnings.filter((warning): warning is string => typeof warning === "string")
          : [],
        generatedAt: readText(record, ["generatedAt"]) || undefined,
        counterfactual: asRecord(record?.counterfactual) as Counterfactual | undefined,
        ablation: asRecord(record?.ablation) as
          | RecoveryResponse["ablation"]
          | undefined,
        scheduleDiff: asRecord(record?.scheduleDiff) as ScheduleDiff | undefined,
        dataContributions: Array.isArray(record?.dataContributions)
          ? (record.dataContributions as DataContribution[])
          : [],
        recoveryMode: readText(record, ["recoveryMode"]) || undefined,
        itinerarySummary: asRecord(record?.itinerarySummary) ?? undefined,
      };
      setSubmittedReferenceTime(
        authoritativeReferenceAt
          ? {
              mode:
                readText(responseReferenceTime, ["mode"]) === "assumed"
                  ? "scheduled"
                  : "now",
              iso: authoritativeReferenceAt,
            }
          : null,
      );
      setRecovery(response);
      setRecoverState("success");
      window.setTimeout(() => resultRef.current?.focus({ preventScroll: false }), 40);
    } catch (error) {
      if (requestGeneration !== recoverRequestGenerationRef.current) return;
      setRecoverState("error");
      setRecoverError(
        travelerErrorText(
          error,
          language,
          "The recovery request failed. Check the inputs and try again.",
          "여행 복구 요청에 실패했습니다.",
        ),
      );
    }
  }

  function applyCounterfactualRelaxation() {
    const relaxation = recovery?.counterfactual?.requiredRelaxation;
    if (!relaxation || typeof relaxation.requiredLimit !== "number") {
      return;
    }
    if (relaxation.constraint === "available_time") {
      setAvailableMinutes(relaxation.requiredLimit);
    } else if (relaxation.constraint === "minimum_stay") {
      setMinimumStayMinutes(relaxation.requiredLimit);
    } else if (relaxation.constraint === "safety_buffer") {
      setSafetyBufferMinutes(relaxation.requiredLimit);
    } else if (relaxation.constraint === "indoor_requirement") {
      setIndoorTouched(true);
      setIndoorOnly(false);
    } else {
      return;
    }
    window.setTimeout(() => recoveryFormRef.current?.requestSubmit(), 0);
  }

  async function loadInsightDetail() {
    if (!insightAreaCode) {
      setInsightDetailState("error");
      setInsightDetailError("먼저 확인할 시도를 선택해 주세요.");
      return;
    }
    setInsightDetailState("loading");
    setInsightDetailError("");
    setInsightDetail(null);
    try {
      const query = insightSigunguCode
        ? `?sigunguCode=${encodeURIComponent(insightSigunguCode)}`
        : "";
      const payload = await fetchJson(
        `/api/v1/insights/regions/${encodeURIComponent(insightAreaCode)}${query}`,
      );
      setInsightDetail(asRecord(payload) ?? { data: payload });
      setInsightDetailState("success");
    } catch (error) {
      setInsightDetailState("error");
      setInsightDetailError(error instanceof Error ? error.message : "정책 데이터를 불러오지 못했습니다.");
    }
  }

  async function loadInsightRegions() {
    if (insightListState === "loading") return;
    setInsightListState("loading");
    setInsightListError("");
    try {
      const next = normalizeRegions(await fetchJson("/api/v1/insights/regions"));
      setInsightRegions(next);
      setInsightListState("success");
      if (!next.length) setInsightListError("공개할 수 있는 지역 집계가 아직 없습니다.");
    } catch (error) {
      setInsightListState("error");
      setInsightListError(error instanceof Error ? error.message : "전국 현황을 불러오지 못했습니다.");
    }
  }

  async function loadHealth() {
    setHealthState("loading");
    setHealthError("");
    try {
      /* readiness는 "준비되지 않음"을 503으로 알린다. 오케스트레이터가 읽는
         관례이고, 그 응답의 본문은 완전하다. 이걸 요청 실패로 처리하면
         공사 8종이 멀쩡한데도 화면이 전부 오류로 뒤집힌다. 실제로 그랬다.
         본문에 readiness 계약(`overall`)이 있으면 상태로 읽는다. */
      const response = await fetch("/api/v1/health/ready", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = asRecord(await response.json().catch(() => null));
      const overall = readText(payload, ["overall", "status"]);
      if (!overall) {
        const nestedError = asRecord(payload?.error);
        throw new Error(
          readText(nestedError, ["message", "detail"]) ||
            `연결 상태를 확인하지 못했습니다. (${response.status})`,
        );
      }
      const sourceHealth = asRecord(payload?.sourceHealth);
      setHealth({
        overall,
        sources: Array.isArray(payload?.sources)
          ? payload.sources.flatMap((source) => {
              const record = asRecord(source);
              return record ? [record] : [];
            })
          : [],
        checkedAt:
          readText(sourceHealth, ["checkedAt"]) ||
          readText(payload, ["checkedAt"]) ||
          undefined,
        stale: Boolean(sourceHealth?.stale),
      });
      setHealthState("success");
    } catch (error) {
      setHealthState("error");
      setHealthError(error instanceof Error ? error.message : "연결 상태를 확인하지 못했습니다.");
    }
  }

  async function shareRecoveryOption(option: RecoveryOption) {
    /* 공유는 계속 막는다. 적용과 공유는 다른 일이다 — 적용은 내가 감수하는
       선택이고, 공유는 "이 경로는 공식 근거로 검증됐다"는 증명서를 다른 사람에게
       건네는 것이다. 확인하지 못한 것이 있는 결과에 그 증명서를 붙이면 받는
       사람이 속는다. */
    const safety = optionApplicationSafety(option, language);
    if (!safety.canApply) {
      setShareMessages((current) => ({
        ...current,
        [option.id]:
          language === "en"
            ? "This option is closed or unverified, so it cannot be applied or shared as a verified record."
            : "휴무 또는 미확인 후보는 일정에 적용하거나 검증 기록으로 공유할 수 없습니다.",
      }));
      return;
    }
    if (!originSelectionCurrent) {
      setRecoverState("error");
      setRecoverError(
        tr(
          "현재 위치를 자동으로 확인하거나 검색 결과에서 장소를 다시 선택해 주세요.",
          "Use your current location or select the place again from the search results.",
        ),
      );
      return;
    }
    if (!recovery?.requestId || !option.id || !recoveryPersisted) {
      setShareMessages((current) => ({
        ...current,
        [option.id]:
          tr(
            "저장이 확인된 복구 실행만 공유할 수 있습니다. 복구를 다시 실행해 주세요.",
            "Only a verified saved recovery can be shared. Run recovery again.",
          ),
      }));
      return;
    }
    setShareMessages((current) => ({
      ...current,
      [option.id]: tr("공유 링크 생성 중", "Creating share link"),
    }));
    try {
      const payload = asRecord(
        await fetchJson("/api/v1/share", {
          method: "POST",
          body: JSON.stringify({
            runId: recovery.requestId,
            optionId: option.id,
          }),
        }),
      );
      const relativeUrl = readText(payload, ["url"]);
      if (!relativeUrl) {
        throw new Error(
          tr("공유 링크를 확인하지 못했습니다.", "The share link was not returned."),
        );
      }
      const absoluteUrl = new URL(relativeUrl, window.location.origin).toString();
      const usedNativeShare = "share" in navigator;
      if (usedNativeShare) {
        await navigator.share({
          title: `${language === "en" ? "IEOGA" : "이어가"} · ${option.title}`,
          text: tr(
            "내 원래 일정과 다음 예약을 지키는 여행 복구안입니다.",
            "A verified travel recovery that protects my original itinerary and next booking.",
          ),
          url: absoluteUrl,
        });
      } else {
        await navigator.clipboard.writeText(absoluteUrl);
      }
      setShareMessages((current) => ({
        ...current,
        [option.id]: usedNativeShare
          ? tr("공유 완료", "Shared")
          : tr("7일 공유 링크 복사 완료", "7-day share link copied"),
      }));
    } catch (error) {
      setShareMessages((current) => ({
        ...current,
        [option.id]:
          travelerErrorText(
            error,
            language,
            "Could not create the share link.",
            "공유 링크 생성 실패",
          ),
      }));
    }
  }

  async function applyRecoveryOption(option: RecoveryOption) {
    const safety = optionApplicationSafety(option, language);
    if (!safety.canApply) {
      setOutcomePriority("assertive");
      setOutcomeMessage(safety.reasons.join(" "));
      return;
    }
    if (!recovery?.requestId || !option.id || !recoveryPersisted) {
      setOutcomePriority("assertive");
      setOutcomeMessage(
        tr(
          "저장이 확인된 복구 실행만 적용하거나 결과를 기록할 수 있습니다. 복구를 다시 실행해 주세요.",
          "Only a verified saved recovery can be applied or recorded. Run recovery again.",
        ),
      );
      return;
    }
    if (applyInFlightRef.current) {
      setOutcomePriority("polite");
      setOutcomeMessage(
        tr(
          "다른 복구안의 서버 활성 상태를 확인하고 있습니다. 확인이 끝난 뒤 다시 선택해 주세요.",
          "Another recovery is being verified with the server. Choose again after that check finishes.",
        ),
      );
      return;
    }

    const expected = {
      runId: recovery.requestId,
      optionId: option.id,
    };
    const requestGeneration = ++applyRequestGenerationRef.current;
    let reconciledActiveExecution = false;
    applyInFlightRef.current = true;
    setApplyingOptionId(option.id);
    setOutcomePriority("polite");
    setOutcomeMessage(
      tr("여행 연속성 기록을 저장하고 있습니다.", "Saving the journey-continuity record."),
    );
    try {
      const payload = await fetchJson(
        `/api/v1/recover/${encodeURIComponent(expected.runId)}/apply`,
        {
          method: "POST",
          body: JSON.stringify({ optionId: option.id }),
        },
      );
      const applyExecution = normalizeJourneyExecution(payload);
      /* POST의 200/201만으로는 성공으로 보지 않는다. A를 적용하고 B로
         교체한 뒤 A를 다시 누르면 과거 A 버전이 반환될 수 있다. 같은 요청
         세대 안에서 authoritative active를 반드시 다시 읽는다. */
      const activePayload = await fetchJson("/api/v1/journey/active");
      const execution = normalizeJourneyExecution(activePayload);

      if (requestGeneration !== applyRequestGenerationRef.current) {
        throw new Error(
          tr(
            "더 최근의 적용 요청이 있어 이 응답을 사용하지 않았습니다. 현재 활성 일정을 확인해 주세요.",
            "A newer apply request exists, so this response was ignored. Check the currently active itinerary.",
          ),
        );
      }
      if (
        !authoritativeExecutionMatchesApply(
          applyExecution,
          execution,
          expected,
        )
      ) {
        /* authoritative GET이 다른 active를 돌려주면 그 실행을 화면에
           복원한다. 오래된 A를 성공처럼 보여 준 뒤 PATCH가 실패하는 것보다,
           실제로 활성인 B로 즉시 돌아가는 것이 정직하다. */
        if (execution?.status === "active") {
          setActiveExecution(execution);
          setAppliedOptionId(execution.sourceOptionId);
          reconciledActiveExecution = true;
        }
        const activeTitle = recovery.options.find(
          (candidate) => candidate.id === execution?.sourceOptionId,
        )?.title;
        throw new Error(
          activeTitle
            ? tr(
                `이전에 적용한 '${activeTitle}' 일정이 아직 서버의 활성 일정입니다. 방금 누른 복구안은 적용하지 않았으며 실제 활성 일정으로 돌아갑니다.`,
                `“${activeTitle}” is still the server's active itinerary. The option you just chose was not applied, and IEOGA returned to the actual active itinerary.`,
              )
            : tr(
                "서버의 실제 활성 일정이 방금 누른 복구안과 달라 적용하지 않았습니다. 최신 상황으로 복구를 다시 실행해 주세요.",
                "The server's active itinerary differs from the option you just chose, so it was not applied. Run recovery again from the latest situation.",
              ),
        );
      }
      if (!executionMatchesAppliedRecovery(execution, expected)) {
        throw new Error(
          tr(
            "서버가 이 복구안을 현재 활성 일정으로 확인하지 않아 적용하지 않았습니다.",
            "The server did not confirm this recovery as the current active itinerary, so it was not applied.",
          ),
        );
      }
      if (!journeyPlan || !selectedNextFixedStop) {
        throw new Error(
          language === "en"
            ? "The protected appointment contract is missing. Run recovery again."
            : "잠근 다음 일정의 원본 계약이 없습니다. 복구를 다시 실행해 주세요.",
        );
      }
      if (
        !executionPreservesLockedAppointment(execution, {
          id: selectedNextFixedStop.id,
          startAt: `${journeyPlan.date}T${selectedNextFixedStop.time}:00+09:00`,
          title: selectedNextFixedStop.title,
          locked: selectedNextFixedStop.fixed,
          reservation: selectedNextFixedStop.type === "reservation",
        })
      ) {
        throw new Error(
          language === "en"
            ? "Safety verification stopped the update because the protected appointment ID or time changed in the server response."
            : "안전 검증이 적용을 중단했습니다. 서버 응답에서 원래 잠근 약속의 ID 또는 시각이 달라졌습니다.",
        );
      }
      setAppliedOptionId(option.id);
      setActiveExecution(execution);
      setOutcomePriority("polite");
      setOutcomeMessage(
        tr(
          "복구 일정이 새 버전으로 저장되었습니다. 지금부터 순서대로 안내합니다.",
          "The recovery itinerary was saved as a new version. Follow the steps below in order.",
        ),
      );
      window.setTimeout(
        () =>
          document
            .querySelector<HTMLElement>(".active-journey-cockpit")
            ?.focus({ preventScroll: false }),
        40,
      );
    } catch (error) {
      if (requestGeneration === applyRequestGenerationRef.current) {
        setOutcomePriority("assertive");
        setOutcomeMessage(
          travelerErrorText(
            error,
            language,
            "Could not save the outcome. Try again shortly.",
            "결과 기록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          ),
        );
      }
    } finally {
      if (requestGeneration === applyRequestGenerationRef.current) {
        applyInFlightRef.current = false;
        setApplyingOptionId("");
      }
      if (reconciledActiveExecution) {
        window.setTimeout(
          () =>
            document
              .querySelector<HTMLElement>(".active-journey-cockpit")
              ?.focus({ preventScroll: false }),
          40,
        );
      }
    }
  }

  const insightMetrics = useMemo<
    { key: string; label: string; value: unknown; meta?: string }[]
  >(() => {
    if (!insightDetail) return [];
    if (Array.isArray(insightDetail.metrics)) {
      return insightDetail.metrics.flatMap((entry, index) => {
        const row = asRecord(entry);
        const label = readText(row, ["label", "officialName", "name", "key"]);
        if (!row || !label) return [];
        return [
          {
            key: readText(row, ["key"]) || `${label}-${index}`,
            label,
            value: row.value ?? row.valueRaw,
            meta: [readText(row, ["source"]), formatReferenceDate(readText(row, ["baseYm"]) || undefined)]
              .filter(Boolean)
              .join(" · "),
          },
        ];
      });
    }
    const ignored = new Set(["sources", "sourceLedger", "warnings", "region", "district", "scope", "datasets"]);
    const metrics = asRecord(insightDetail.metrics);
    const source = metrics ?? insightDetail;
    return Object.entries(source)
      .filter(([key, value]) => !ignored.has(key) && ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 10)
      .map(([key, value]) => ({ key, label: formatMetricLabel(key), value }));
  }, [insightDetail]);

  const insightSources = useMemo(() => {
    const candidates = insightDetail?.sources ?? insightDetail?.sourceLedger ?? insightDetail?.datasets;
    return Array.isArray(candidates) ? candidates : [];
  }, [insightDetail]);

  const insightHubs = useMemo(() => {
    if (!Array.isArray(insightDetail?.hubs)) return [];
    return insightDetail.hubs.slice(0, 8).flatMap((entry, index) => {
      const row = asRecord(entry);
      const name = readText(row, ["name", "title"]);
      if (!row || !name) return [];
      return [
        {
          name,
          rank: readText(row, ["rank"]) || String(index + 1),
          category: readText(row, ["category"]) || "분류 미제공",
        },
      ];
    });
  }, [insightDetail]);

  const insightCoverage = useMemo(() => asRecord(insightDetail?.coverage), [insightDetail]);
  const hasExecution = Boolean(activeExecution);

  return (
    <div
      className={`product-shell ${hasExecution ? "has-active-execution" : ""}`}
      lang={language}
    >
      <a className="skip-link" href="#main-content">
        {language === "en" ? "Skip to main content" : "본문으로 바로가기"}
      </a>

      <SimulationGuide
        isOpen={guideOpen}
        isLoading={practiceState === "loading"}
        loadError={practiceError}
        language={language}
        onClose={() => setGuideOpen(false)}
        onDismiss={dismissSimulationGuide}
        onLoadPracticeItinerary={() => void loadPracticeItinerary()}
      />

      <header className="product-header">
        <a
          className="product-brand"
          href="/"
          aria-label={language === "en" ? "IEOGA home" : "이어가 홈"}
        >
          <span className="product-brand-mark" aria-hidden="true">
            {language === "en" ? "I" : "이"}
          </span>
          <span>
            <strong>{language === "en" ? "IEOGA" : "이어가"}</strong>
            <small>{language === "en" ? "Keep your trip going" : "여행을 이어 주는 서비스"}</small>
          </span>
        </a>

        {/* 탭 두 개와 `/flow` 링크를 한 줄로 보여 준다.
            `/flow`는 다른 화면이라 탭이 아니다 — 탭은 같은 화면 안의 패널을
            여는 것이고, 링크는 화면을 옮긴다. 그래서 `role="tablist"` 안에
            넣지 않고 형제로 두되, 겉보기에는 같은 줄에 놓는다. 안쪽 래퍼는
            `display: contents`라 기존 배치가 그대로 유지된다. */}
        <div
          className="desktop-nav"
          role="navigation"
          aria-label={language === "en" ? "Main navigation" : "주요 메뉴"}
        >
        <nav
          className="desktop-nav-tabs"
          aria-label={language === "en" ? "Views" : "화면 전환"}
          role="tablist"
          onKeyDown={handleTabKeyDown}
        >
          <button
            id="tab-recover"
            role="tab"
            aria-selected={activeTab === "recover"}
            aria-controls="panel-recover"
            tabIndex={activeTab === "recover" ? 0 : -1}
            className={activeTab === "recover" ? "is-active" : ""}
            onClick={() => changeTab("recover")}
            data-testid="nav-recover"
          >
            {language === "en" ? "My plan broke" : "일정이 틀어졌어요"}
          </button>
          <button
            id="tab-discover"
            role="tab"
            aria-selected={activeTab === "discover"}
            aria-controls="panel-discover"
            tabIndex={activeTab === "discover" ? 0 : -1}
            className={activeTab === "discover" ? "is-active" : ""}
            onClick={() => changeTab("discover")}
            data-testid="nav-discover"
          >
            {language === "en" ? "I have free time" : "시간이 비었어요"}
          </button>
        </nav>
        {/* `등록 없이 복구`를 탭에서 뺐다.
            상황으로 이름을 붙이니 그 탭과 `일정이 틀어졌어요`가 **같은 상황**을
            가리킨다는 것이 드러났다 — 둘 다 일정이 틀어진 사람이고, 다른 것은
            상황이 아니라 일정을 미리 등록했는지 여부다. 그래서 탭을 둘로 줄이고
            등록 여부는 이 탭 안에서 한 번 묻는다. */}
        </div>

        <div className="header-actions">
          <div
            className="language-toggle"
            role="group"
            aria-label={language === "en" ? "Language" : "언어 선택"}
          >
            <button
              type="button"
              className={language === "ko" ? "is-active" : ""}
              aria-pressed={language === "ko"}
              onClick={() => setLanguage("ko")}
            >
              KO
            </button>
            <button
              type="button"
              className={language === "en" ? "is-active" : ""}
              aria-pressed={language === "en"}
              onClick={() => setLanguage("en")}
            >
              EN
            </button>
          </div>
          <button
            className="header-guide"
            onClick={() => {
              setPracticeError("");
              setGuideOpen(true);
            }}
          >
            {language === "en" ? "Getting started" : "처음 사용 가이드"}
          </button>
          {/* Bridge recovery is the fast path: it needs no registered
              itinerary, so it is the primary entry rather than the tab. */}
          {/* `지금 바로 복구` 버튼을 헤더에서 뺐다. 탭 줄로 옮겼으므로 같은
              곳으로 가는 길이 둘이 될 이유가 없고, 이 버튼은 820px 미만에서
              숨겨져 휴대폰에서는 보이지도 않았다. */}
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        {activeTab === "recover" && (
          <section
            id="panel-recover"
            role="tabpanel"
            aria-labelledby="tab-recover"
            className="page-section"
          >
            {/* 등록 여부를 여기서 한 번 묻는다.
                예전에는 이것이 `등록 없이 복구`라는 별도 탭이었다. 그런데 탭을
                상황으로 이름 붙이니 그 탭과 이 탭이 **같은 상황**(일정이
                틀어짐)을 가리킨다는 것이 드러났다 — 다른 것은 상황이 아니라
                일정을 미리 넣어 두었는지 여부다. 상황이 같은데 입구가 둘이면
                사용자는 어느 쪽인지 매번 판단해야 한다.

                기본값은 "있어요"다. 아래 폼이 그대로 보이므로 늘 쓰던 사람은
                클릭이 늘지 않는다. */}
            <div className="plan-branch" role="group" aria-label={language === "en" ? "How to start" : "시작 방법"}>
              <span className="plan-branch-question">
                {language === "en"
                  ? "Do you have a plan saved here?"
                  : "여기에 저장해 둔 일정이 있나요?"}
              </span>
              <div className="plan-branch-choices">
                <span className="plan-branch-current" aria-current="true">
                  {language === "en" ? "Yes — edit it below" : "네, 아래에서 고칠게요"}
                </span>
                <a href="/flow" data-testid="plan-branch-flow">
                  {language === "en"
                    ? "No — answer three questions instead"
                    : "아니요, 세 번만 답하고 찾을게요"}
                </a>
              </div>
            </div>

            {executionState === "loading" && (
              <div className="execution-loading" role="status">
                <span className="loading-ring dark" aria-hidden="true" />
                {language === "en"
                  ? "Checking for an active recovery journey."
                  : "진행 중인 복구 여행을 확인하고 있습니다."}
              </div>
            )}
            {placeToPlan && (
              <PlanPlacementDialog
                place={placeToPlan}
                /* 첫 정류지는 출발지다. "대신 넣기" 목록에서 뺀다 — 거기에
                   여행지를 넣으면 "지금 있는 곳에서 출발한다"는 전제가 깨져
                   이동 시간이 0으로 잡힌다. 지역 판정에는 그대로 쓴다. */
                stops={journeyDraft.stops.slice(1).map((stop) => ({
                  id: stop.id,
                  title: stop.title,
                  address: stop.address,
                }))}
                areaStops={journeyDraft.stops.map((stop) => ({
                  id: stop.id,
                  title: stop.title,
                  address: stop.address,
                }))}
                language={language}
                onChoose={(placement) =>
                  applyPlanPlacement(placeToPlan, placement)
                }
                onCancel={() => setPlaceToPlan(null)}
              />
            )}

            {activeExecution && (
              <>
                {outcomeMessage && (
                  <p
                    className={`execution-transition-notice ${outcomePriority === "assertive" ? "is-error" : ""}`}
                    role={outcomePriority === "assertive" ? "alert" : "status"}
                    aria-live={outcomePriority}
                    aria-atomic="true"
                  >
                    {outcomeMessage}
                  </p>
                )}
                <ActiveJourneyCockpit
                  execution={activeExecution}
                  language={language}
                  onChange={setActiveExecution}
                /* 동선이 꼬여 다음 고정 일정을 지킬 수 없을 때, 사용자를
                     지금 조건을 다시 입력하는 자리로 데려간다. 과거 결과는
                     지워 A→B→A처럼 오래된 실행을 다시 고르지 않게 한다. */
                  onRecoverAgain={() => {
                    setActiveExecution(null);
                    setAppliedOptionId("");
                    setRecovery(null);
                    setRecoverState("idle");
                    setOutcomeMessage("");
                    changeTab("recover");
                    window.requestAnimationFrame(() => {
                      recoveryFormRef.current?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      });
                      recoveryFormRef.current?.focus({ preventScroll: true });
                    });
                  }}
                /* 실행을 접고 복구안 목록으로 되돌아간다. `recovery`는
                     그대로 두어 다른 대안을 고를 수 있게 하되, 다음 적용은
                     반드시 authoritative active와 다시 대조한다. */
                  onBack={() => {
                    setActiveExecution(null);
                    setAppliedOptionId("");
                    setOutcomeMessage("");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  onCloseCompleted={() => {
                    setActiveExecution(null);
                    setAppliedOptionId("");
                    setRecovery(null);
                    setRecoverState("idle");
                    setOutcomeMessage("");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                />
              </>
            )}
            <div className="hero-grid">
              <div className="hero-copy">
                <p className="section-kicker">
                  {language === "en"
                    ? "Nationwide · while you are still travelling"
                    : "전국 어디서든, 여행 중에 바로"}
                </p>
                <h1>
                  {language === "en" ? "When plans break," : "여행이 흔들려도,"}
                  <br />
                  <em>
                    {language === "en"
                      ? "keep what matters."
                      : "목적은 이어지도록."}
                  </em>
                </h1>
                <p>
                  {language === "en" ? (
                    <>
                      When rain, a delay or a crowd breaks your day, IEOGA{" "}
                      <strong>changes only the one stop that broke</strong> and
                      keeps your next booking.
                    </>
                  ) : (
                    <>
                      비가 오거나 길이 막혀 일정이 틀어졌을 때, 이어가는{" "}
                      <strong>깨진 한 곳만 바꿔</strong> 다음 예약을 지켜
                      드립니다.
                    </>
                  )}
                </p>
                <p className="hero-promise">
                  {language === "en"
                    ? "No itinerary needed. Ten seconds to start."
                    : "일정을 미리 등록하지 않아도 됩니다. 10초면 시작할 수 있어요."}
                </p>
              </div>
              <aside className="scope-card" aria-label={language === "en" ? "Service coverage" : "서비스 범위"}>
                <span className="scope-orbit" aria-hidden="true">
                  <i />
                  {language === "en" ? "KR" : "전국"}
                </span>
                <div>
                  <p>{language === "en" ? "All Korean cities and districts" : "전국 시도·시군구"}</p>
                  <strong>
                    {regionState === "success" && regions.length
                      ? language === "en"
                        ? `${regions.length} regions connected`
                        : `${regions.length}개 광역권 연결`
                      : language === "en"
                        ? "Connecting tourism data"
                        : "관광정보 연결 중"}
                  </strong>
                  <small>
                    {language === "en"
                      ? "Region coverage follows the official tourism API response."
                      : "지역 목록은 공식 관광정보 API 응답 기준으로 표시합니다."}
                  </small>
                </div>
              </aside>
            </div>

            <ol className="journey-steps" aria-label={language === "en" ? "IEOGA journey steps" : "이어가 사용 단계"}>
              <li className={!journeyPlan || journeyEditing ? "is-current" : "is-complete"}>
                <b>1</b>
                <span>
                  <strong>{language === "en" ? "Save your plan" : "원래 일정 등록"}</strong>
                  <small>{language === "en" ? "Lock reservations" : "예약·고정 일정 잠금"}</small>
                </span>
              </li>
              <li className={journeyPlan && !journeyEditing ? "is-current" : ""}>
                <b>2</b>
                <span>
                  <strong>{language === "en" ? "Report disruption" : "돌발상황 입력"}</strong>
                  <small>{language === "en" ? "Location and constraints" : "현재 위치·필수 조건"}</small>
                </span>
              </li>
              <li className={appliedOptionId ? "is-current" : ""}>
                <b>3</b>
                <span>
                  <strong>{language === "en" ? "Continue the trip" : "복구 적용·도착 확인"}</strong>
                  <small>{language === "en" ? "Prove you finished" : "끝까지 마쳤다는 기록"}</small>
                </span>
              </li>
            </ol>

            {journeyState === "loading" && (
              <div className="journey-loading" role="status">
                <span className="loading-ring dark" aria-hidden="true" />
                {language === "en"
                  ? "Loading your saved itinerary."
                  : "저장된 여행 일정을 확인하고 있습니다."}
              </div>
            )}

            {journeyState === "ready" && (!journeyPlan || journeyEditing) && (
              <form className="journey-builder" onSubmit={saveJourney} noValidate>
                <div className="journey-builder-heading">
                  <div>
                    <p>TRIP CONTINUITY SETUP</p>
                    <h2>
                      {language === "en"
                        ? "First, tell us what must stay unchanged."
                        : "먼저, 원래 일정에서 반드시 지킬 것을 알려주세요."}
                    </h2>
                    <span>
                      {language === "en"
                        ? "Your itinerary and saved place coordinates remain in your session until deletion or expiry. Live location is handled separately."
                        : "일정과 일정 장소 좌표는 삭제 또는 만료 전까지 세션에 저장됩니다. 복구 시 흔들린 구간과 다음 고정 일정만 계산에 사용합니다."}
                    </span>
                  </div>
                  {journeyPlan && (
                    <button
                      type="button"
                      className="text-action"
                      onClick={() => {
                        setJourneyEditing(false);
                        setJourneyDraft(journeyPlan);
                        setJourneyError("");
                      }}
                    >
                      {language === "en" ? "Cancel editing" : "편집 취소"}
                    </button>
                  )}
                </div>

                {practiceReady && (
                  <div className="practice-ready" role="status">
                    <span aria-hidden="true">✓</span>
                    <div>
                      <strong>
                        {language === "en"
                          ? "A practice trip with real places is ready"
                          : "실제 관광지로 연습 일정이 준비됐어요"}
                      </strong>
                      <p>
                        {language === "en"
                          ? "Change any place or time, then start this itinerary to practise the real recovery flow."
                          : "장소와 시간은 자유롭게 바꿀 수 있어요. 아래의 ‘이 일정으로 여행 시작’을 누르면 실제 복구 흐름을 연습합니다."}
                      </p>
                    </div>
                  </div>
                )}

                <details className="journey-advanced">
                  <summary>
                    {language === "en"
                      ? "Change the date or mobility support"
                      : "오늘이 아니거나 이동 배려 설정이 필요해요"}
                  </summary>
                  <div className="journey-meta-grid">
                    <label>
                      <span>{language === "en" ? "Trip name" : "여행 이름"} <i>{language === "en" ? "Required" : "필수"}</i></span>
                      <input
                        value={journeyDraft.title}
                        onChange={(event) =>
                          setJourneyDraft((current) => ({
                            ...current,
                            title: event.target.value,
                          }))
                        }
                        maxLength={60}
                        placeholder={language === "en" ? "e.g. Seoul museums and an evening show" : "예: 서울 미술관과 저녁 공연"}
                        required
                      />
                    </label>
                    <label>
                      <span>{language === "en" ? "Travel date" : "여행 날짜"} <i>{language === "en" ? "Required" : "필수"}</i></span>
                      <input
                        type="date"
                        value={journeyDraft.date}
                        onChange={(event) =>
                          setJourneyDraft((current) => ({
                            ...current,
                            date: event.target.value,
                          }))
                        }
                        required
                      />
                    </label>
                    <label>
                      <span>{language === "en" ? "Mobility support" : "이동 도움"}</span>
                      {/* 예전에는 유아차·휠체어·고령자를 각각 고르게 했다.
                          그런데 판정은 갈리지 않았다 — 휠체어와 고령자는 조회
                          필드도 필수 항목도 완전히 같았고 유아차만 달랐다.
                          결과를 바꾸지 않는 선택을 세 개 늘어놓으면 고르는
                          수고만 는다. 켜고 끄는 하나로 줄인다. */}
                      <label className="assist-toggle">
                        <input
                          type="checkbox"
                          checked={journeyDraft.audience !== "general"}
                          onChange={(event) =>
                            setJourneyDraft((current) => ({
                              ...current,
                              audience: (event.target.checked
                                ? "assisted"
                                : "general") as Audience,
                            }))
                          }
                        />
                        <span>
                          <strong>
                            {language === "en"
                              ? AUDIENCES_EN.assisted
                              : "이동 도움이 필요해요"}
                          </strong>
                          <small>
                            {language === "en"
                              ? "For a stroller, wheelchair or walking aid. We check step-free access and indoor movement in official accessibility data."
                              : "유아차·휠체어·보행보조 등 계단 없는 동선이 필요한 경우입니다. 공식 무장애여행정보에서 출입 동선과 내부 이동을 확인합니다."}
                          </small>
                        </span>
                      </label>
                    </label>
                  </div>
                </details>

                <div className="schedule-builder">
                  <div className="schedule-builder-title">
                    <div>
                      <strong>{language === "en" ? "Original itinerary" : "원래 여행 일정"}</strong>
                      <span>
                        {language === "en"
                          ? "Enter stops in order and lock bookings, performances and transport that cannot move."
                          : "순서대로 입력하고 예약·공연·교통편처럼 바꿀 수 없는 일정은 잠가 주세요."}
                      </span>
                    </div>
                    <button type="button" onClick={addJourneyStop}>
                      {language === "en" ? "+ Add stop" : "+ 일정 추가"}
                    </button>
                  </div>

                  <div className="schedule-edit-list">
                    {journeyDraft.stops.map((stop, index) => (
                      <article
                        className={[
                          "schedule-edit-card",
                          stop.fixed ? "is-locked" : "",
                          !journeyPlan && index === 0
                            ? "is-primary-changeable"
                            : "",
                          !journeyPlan && index === 1
                            ? "is-primary-fixed"
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        key={stop.id}
                      >
                        <div className="schedule-index" aria-hidden="true">
                          {String(index + 1).padStart(2, "0")}
                        </div>
                        <div className="schedule-edit-fields">
                          {!journeyPlan && index < 2 && (
                            <div className="schedule-card-guide">
                              <strong>
                                {index === 0
                                  ? tr(
                                      "지금 문제가 생길 수 있는 일정",
                                      "The stop that may need to change",
                                    )
                                  : tr(
                                      "반드시 지켜야 할 다음 일정",
                                      "The next appointment to protect",
                                    )}
                              </strong>
                              <span>
                                {index === 0
                                  ? tr(
                                      "이 장소만 바꾸고 여행 목적은 유지해요.",
                                      "IEOGA changes only this stop and keeps the trip's purpose.",
                                    )
                                  : tr(
                                      "이어가가 이 시각까지 도착하는 복구안만 보여줘요.",
                                      "Only recovery options that reach this appointment on time are shown.",
                                    )}
                              </span>
                            </div>
                          )}
                          <div className="schedule-primary-fields">
                            <label>
                              <span>{tr("시각", "Time")}</span>
                              {/* 여행자는 분 단위로 계획하지 않는다. 시와 분을
                                  각각 조작하는 입력은 위기 순간에 쓰는 도구로서
                                  문턱이 높다. 30분 단위 드롭다운 하나로 줄인다. */}
                              <select
                                value={toHalfHour(stop.time)}
                                onChange={(event) =>
                                  updateJourneyStop(stop.id, { time: event.target.value })
                                }
                                required
                              >
                                <option value="">{tr("시각을 고르세요", "Choose a time")}</option>
                                {HALF_HOUR_TIMES.map((entry) => (
                                  <option key={entry.value} value={entry.value}>
                                    {language === "en" ? entry.value : entry.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>{tr("일정 유형", "Stop type")}</span>
                              <select
                                value={stop.type}
                                onChange={(event) =>
                                  updateJourneyStop(stop.id, {
                                    type: event.target.value as JourneyStop["type"],
                                    fixed:
                                      event.target.value === "reservation"
                                        ? true
                                        : stop.fixed,
                                  })
                                }
                              >
                                <option value="visit">{tr("관광·방문", "Sightseeing")}</option>
                                <option value="reservation">{tr("예약·공연", "Booking or event")}</option>
                                <option value="meal">{tr("식사", "Meal")}</option>
                                <option value="transit">{tr("교통", "Transport")}</option>
                                <option value="stay">{tr("숙소", "Accommodation")}</option>
                                <option value="other">{tr("기타", "Other")}</option>
                              </select>
                            </label>
                            <label className="schedule-title-field">
                              <span>{tr("장소·일정명", "Place or appointment")}</span>
                              <input
                                value={stop.title}
                                onChange={(event) =>
                                  updateJourneyStop(stop.id, {
                                    title: event.target.value,
                                    latitude: undefined,
                                    longitude: undefined,
                                    areaCode: undefined,
                                    sigunguCode: undefined,
                                  })
                                }
                                /* 이 입력은 폼 안에 있다. Enter를 그냥 두면
                                   장소를 찾는 대신 **폼이 제출되어** "일정을
                                   저장할 수 없습니다"가 뜬다 — 방금 이름을
                                   적었는데 저장 실패가 나오니 무엇을 하라는
                                   건지 알 수 없다. Enter는 검색으로 돌린다. */
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  void searchJourneyStopPlace(stop.id);
                                }}
                                maxLength={80}
                                placeholder={tr(
                                  "예: 국립현대미술관 서울",
                                  "e.g. National Museum of Modern and Contemporary Art, Seoul",
                                )}
                                required
                              />
                            </label>
                            <button
                              type="button"
                              className="verify-place-button"
                              onClick={() => void searchJourneyStopPlace(stop.id)}
                              disabled={
                                journeyPlaceState === "loading" &&
                                journeyPlaceStopId === stop.id
                              }
                            >
                              {typeof stop.latitude === "number"
                                ? tr("장소 확인됨", "Place verified")
                                : journeyPlaceState === "loading" &&
                                    journeyPlaceStopId === stop.id
                                  ? tr("확인 중…", "Checking…")
                                  : tr("장소 찾기", "Find place")}
                            </button>
                          </div>

                          <div className="schedule-lock-row">
                            <label>
                              <input
                                type="checkbox"
                                checked={stop.fixed}
                                onChange={(event) =>
                                  updateJourneyStop(stop.id, {
                                    fixed: event.target.checked,
                                  })
                                }
                              />
                              <span>
                                <strong>{tr("이 일정 잠금", "Protect this appointment")}</strong>
                                <small>
                                  {tr(
                                    "복구안은 이 일정의 장소나 시각을 변경하지 않습니다.",
                                    "Recovery can never change this appointment's place or time.",
                                  )}
                                </small>
                              </span>
                            </label>
                            {stop.address && <span className="verified-address">{stop.address}</span>}
                            {journeyDraft.stops.length > 2 && (
                              <button
                                type="button"
                                className="remove-stop"
                                onClick={() => removeJourneyStop(stop.id)}
                                aria-label={
                                  language === "en"
                                    ? `Remove ${stop.title || `stop ${index + 1}`}`
                                    : `${stop.title || `${index + 1}번 일정`} 삭제`
                                }
                              >
                                {tr("삭제", "Remove")}
                              </button>
                            )}
                          </div>

                          {journeyPlaceStopId === stop.id &&
                            journeyPlaceState === "error" && (
                              <p className="place-search-message is-error" role="alert">
                                {journeyPlaceError}
                              </p>
                            )}
                          {journeyPlaceStopId === stop.id &&
                            journeyPlaceState === "success" &&
                            journeyPlaceResults.length === 0 && (
                              <div className="place-search-message">
                                <span>
                                  {tr(
                                    "일치하는 장소를 찾지 못했습니다.",
                                    "No matching place was found.",
                                  )}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void searchJourneyStopPlace(
                                      stop.id,
                                      "force",
                                    )
                                  }
                                >
                                  {tr(
                                    "주소·다른 지도에서 다시 찾기",
                                    "Search by address or another map",
                                  )}
                                </button>
                              </div>
                            )}
                          {journeyPlaceStopId === stop.id &&
                            journeyPlaceResults.length > 0 && (
                              <ul className="place-results journey-place-results">
                                {journeyPlaceResults.map((place) => (
                                  <li
                                    key={
                                      place.providerId ||
                                      place.contentId ||
                                      `${place.title}-${place.latitude}`
                                    }
                                  >
                                    <button
                                      type="button"
                                      onClick={() => selectJourneyStopPlace(stop.id, place)}
                                    >
                                      <span>
                                        <strong lang={language === "en" && place.provider === "kto" ? "ko" : undefined}>
                                          {place.title}
                                        </strong>
                                        <small lang={language === "en" && place.provider === "kto" ? "ko" : undefined}>
                                          {place.address || tr("주소 정보 없음", "Address unavailable")}
                                        </small>
                                        {language === "en" && place.provider === "kto" && (
                                          <small>KTO official Korean place name and address</small>
                                        )}
                                        {place.sourceLabel && (
                                          <small>{sourceLabelText(place.sourceLabel, language)}</small>
                                        )}
                                      </span>
                                      <b>{tr("이 장소 선택", "Select this place")}</b>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          {journeyPlaceStopId === stop.id &&
                            journeyPlaceResults.length > 0 && (
                              <button
                                type="button"
                                className="place-fallback-button"
                                onClick={() =>
                                  void searchJourneyStopPlace(
                                    stop.id,
                                    "force",
                                  )
                                }
                              >
                                {tr(
                                  "찾는 장소가 없어요 · 주소로 더 찾기",
                                  "Can't find it? Search more address sources",
                                )}
                              </button>
                            )}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>

                {journeyError && (
                  <div className="notice is-error" role="alert">
                    <strong>
                      {tr("일정을 저장할 수 없습니다.", "The itinerary cannot be saved.")}
                    </strong>
                    <p>{journeyError}</p>
                  </div>
                )}
                <button
                  type="submit"
                  className="primary-action journey-save"
                  disabled={journeySaveState === "loading"}
                >
                  {journeySaveState === "loading"
                    ? tr("잠근 일정을 저장하고 있어요…", "Saving protected appointments…")
                    : tr("이 일정으로 여행 시작", "Start with this itinerary")}
                  <span aria-hidden="true">→</span>
                </button>
              </form>
            )}

            {journeyPlan && !journeyEditing && (
              <section className="journey-context" aria-labelledby="journey-context-title">
                <div className="journey-context-heading">
                  <div>
                    <p>{language === "en" ? "Saved trip" : "저장한 오늘 일정"}</p>
                    <h2 id="journey-context-title">{journeyPlan.title}</h2>
                    <span>
                      {formatLocalizedDay(journeyPlan.date, language)} ·{" "}
                      {language === "en"
                        ? `${journeyPlan.stops.filter((stop) => stop.fixed).length} protected`
                        : `잠긴 일정 ${journeyPlan.stops.filter((stop) => stop.fixed).length}개`}
                    </span>
                  </div>
                  <div className="journey-context-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setJourneyDraft(journeyPlan);
                        setJourneyEditing(true);
                        setJourneyError("");
                      }}
                    >
                      {tr("원래 일정 편집", "Edit original itinerary")}
                    </button>
                    <button
                      type="button"
                      className="danger-text"
                      onClick={() => void deleteMyData()}
                      disabled={deleteState === "loading"}
                    >
                      {deleteState === "loading"
                        ? tr("삭제 중…", "Deleting…")
                        : tr("내 데이터 삭제", "Delete my data")}
                    </button>
                  </div>
                </div>
                <ol className="saved-timeline">
                  {journeyPlan.stops.map((stop) => (
                    <li key={stop.id} className={stop.fixed ? "is-locked" : ""}>
                      <time>{formatStopTime(stop.time)}</time>
                      <span>
                        <strong>{stop.title}</strong>
                        <small>{stop.address || tr("위치 설명 없음", "Location unavailable")}</small>
                      </span>
                      <b>
                        {stop.fixed
                          ? tr("잠금", "Protected")
                          : tr("변경 가능", "Can change")}
                      </b>
                    </li>
                  ))}
                </ol>
                {deleteMessage && (
                  <p
                    className={`form-message ${deleteState === "error" ? "is-error" : "is-success"}`}
                    role={deleteState === "error" ? "alert" : "status"}
                  >
                    {deleteMessage}
                  </p>
                )}
              </section>
            )}

            <div
              className="region-ribbon"
              aria-label={tr("현재 연결된 전국 시도 범위", "Connected Korean regions")}
            >
              <span>{tr("전국 범위", "Coverage")}</span>
              <div>
                {regionState === "loading" && (
                  <small>{tr("시도 목록을 불러오는 중입니다.", "Loading regions…")}</small>
                )}
                {regionState === "error" && <small>{regionError}</small>}
                {regionState === "success" &&
                  regions.map((region) => <b key={region.code}>{region.name}</b>)}
              </div>
            </div>

            <div className="service-grid" hidden={!journeyPlan || journeyEditing}>
              <form
                className="recovery-form"
                ref={recoveryFormRef}
                tabIndex={-1}
                onSubmit={submitRecovery}
                noValidate
              >
                <div className="panel-heading">
                  <span>01</span>
                  <div>
                    <p>{language === "en" ? "Step 1 · what happened" : "1단계 · 무슨 일이 있었나요"}</p>
                    <h2>
                      {language === "en"
                        ? "What changed right now?"
                        : "지금 어떤 일정이 틀어졌나요?"}
                    </h2>
                  </div>
                </div>

                <fieldset className="form-group itinerary-link-fieldset compact-contract-fieldset">
                  <legend>{tr("이어갈 일정", "Itinerary segment")}</legend>
                  {selectedAffectedStop && selectedNextFixedStop && (
                    <div className="continuity-contract">
                      <span>
                        <b>{tr("지금 변경할 곳", "Stop to change now")}</b>
                        <strong>{selectedAffectedStop.title}</strong>
                      </span>
                      <i aria-hidden="true">→</i>
                      <span className="is-locked">
                        <b>{tr("반드시 도착", "Appointment to protect")}</b>
                        <strong>{selectedNextFixedStop.title}</strong>
                      </span>
                      <small>
                        {nextAppointmentMinutes === null
                          ? tr("남은 시간 계산 전", "Time window not calculated")
                          : nextAppointmentMinutes > 0
                            ? language === "en"
                              ? `In ${nextAppointmentMinutes} min · keep ${safetyBufferMinutes} min buffer`
                              : `${nextAppointmentMinutes}분 후 · 여유 ${safetyBufferMinutes}분 남기기`
                            : tr(
                                "고정 일정 시각이 지났습니다.",
                                "The protected appointment time has passed.",
                              )}
                      </small>
                    </div>
                  )}
                  <details className="context-adjustment">
                    <summary>{tr("다른 일정 구간 선택", "Choose a different segment")}</summary>
                    <div className="field-grid two">
                    <label>
                      <span>
                        {tr("문제가 생긴 일정", "Affected stop")} <i>{tr("필수", "Required")}</i>
                      </span>
                      <select
                        value={affectedStopId}
                        onChange={(event) => setAffectedStopId(event.target.value)}
                        required
                      >
                        <option value="">{tr("일정을 선택하세요", "Choose a stop")}</option>
                        {/* 잠근 일정도 문제가 생길 수 있다. 예약이 취소되거나
                            공연이 취소되는 것이 그렇고, 3곳 중 2번을 잠갔다면
                            예전 구현에서는 2번을 고를 수조차 없었다 — 실제로
                            그 시나리오를 시험할 방법이 없었다. 실제 제약은
                            "다음 고정 일정으로 고른 것과 같을 수 없다"뿐이다. */}
                        {journeyPlan?.stops
                          .filter((stop) => stop.id !== nextFixedStopId)
                          .map((stop) => (
                            <option key={stop.id} value={stop.id}>
                              {formatStopTime(stop.time)} · {stop.title}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      <span>
                        {tr("다음 고정 일정", "Next protected appointment")} {" "}
                        <i>{tr("필수", "Required")}</i>
                      </span>
                      <select
                        value={nextFixedStopId}
                        onChange={(event) => setNextFixedStopId(event.target.value)}
                        required
                      >
                        <option value="">
                          {tr("도착할 일정을 선택하세요", "Choose the appointment to reach")}
                        </option>
                        {eligibleNextFixedStops.map((stop) => (
                            <option key={stop.id} value={stop.id}>
                              {formatStopTime(stop.time)} · {stop.title}
                            </option>
                          ))}
                      </select>
                    </label>
                    </div>
                  </details>
                </fieldset>

                <fieldset className="form-group">
                  <legend>{tr("지금 어디에 있나요?", "Where are you now?")}</legend>
                  {locationMode === "unselected" && (
                    <div className="location-choice">
                      <button
                        type="button"
                        className="location-choice-primary"
                        onClick={requestGeolocation}
                        disabled={geoState === "loading"}
                        data-testid="geolocation-button"
                      >
                        <span className="target-icon" aria-hidden="true" />
                        <span>
                          <strong>
                            {geoState === "loading"
                              ? tr("현재 위치 확인 중…", "Finding your location…")
                              : tr("현재 위치 자동 입력", "Use current location")}
                          </strong>
                          <small>
                            {tr(
                              "권한을 허용하면 시도·시군구까지 자동으로 채웁니다.",
                              "With permission, IEOGA fills the province and district automatically.",
                            )}
                          </small>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="location-choice-manual"
                        onClick={useManualLocation}
                      >
                        {tr("위치 권한 없이 직접 입력", "Enter a place without location access")}
                      </button>
                      <p>
                        {tr(
                          "현재 좌표는 저장하지 않지만 행정구역·경로·날씨 확인을 위해 관련 제공자에 일시 전송됩니다. 저장한 일정 장소 좌표는 직접 삭제하거나 만료될 때까지 보관됩니다.",
                          "Your live coordinates are not stored, but are sent temporarily to providers to check the district, route and weather. Coordinates in a saved itinerary remain until you delete them or they expire.",
                        )}
                      </p>
                    </div>
                  )}

                  {locationMode === "automatic" && geoState === "success" && (
                    <div className="automatic-location-card">
                      <span className="target-icon" aria-hidden="true" />
                      <div>
                        <b>{tr("현재 위치 자동 입력 완료", "Current location found")}</b>
                        <strong>
                          {originLabel || tr("내 현재 위치", "My current location")}
                          {[selectedRegion?.name, selectedDistrict?.name].some(Boolean)
                            ? ` · ${regionDisplayName(
                                [selectedRegion?.name, selectedDistrict?.name]
                                  .filter(Boolean)
                                  .join(" "),
                                language,
                              )}`
                            : ""}
                        </strong>
                        <small>
                          {tr(
                            "현재 좌표는 관련 경로·날씨 제공자에 일시 전송되며 서버에 저장하지 않습니다.",
                            "Live coordinates are sent temporarily to route and weather providers and are not stored on the server.",
                          )}
                        </small>
                        {geoAttribution && (
                          <em className="provider-attribution">
                            {tr("위치 판별 출처", "Location source")} ·{" "}
                            {contributionSourceText(geoAttribution, language)}
                          </em>
                        )}
                      </div>
                      <button type="button" onClick={useManualLocation}>
                        {tr("직접 입력으로 변경", "Enter a place instead")}
                      </button>
                    </div>
                  )}

                  {geoMessage && (
                    <p
                      className={`form-message ${geoState === "error" ? "is-error" : "is-success"}`}
                      role={geoState === "error" ? "alert" : "status"}
                    >
                      {geoMessage}
                    </p>
                  )}

                  {locationMode === "manual" && (
                    <div className="manual-location-panel">
                      {/* 장소명을 모를 때를 위한 두 번째 길.
                          여행 중에는 지금 서 있는 곳의 이름을 모르는 일이 흔하다.
                          그때 장소명만 요구하면 아무것도 할 수 없다. 시·군·구만
                          골라도 그 일대를 기준으로 찾을 수 있게 한다. */}
                      <ManualLocationPicker
                        language={language}
                        onRetryGeolocation={requestGeolocation}
                        geoBusy={geoState === "loading"}
                        heading={tr("현재 장소 직접 입력", "Enter your current place")}
                        areaHint={tr(
                          "장소명을 모르겠다면 시·군·구를 고르세요. 그 지역의 대표 지점을 기준으로 찾으며, 정확한 현재 위치로 저장하지 않습니다.",
                          "If you do not know the place name, choose a city and district. IEOGA searches from a representative point and does not treat it as your exact location.",
                        )}
                        onPick={(place) => {
                          geolocationRequestGenerationRef.current += 1;
                          setLatitude(String(place.latitude));
                          setLongitude(String(place.longitude));
                          setOriginLabel(place.title);
                          setAreaCode(place.areaCode ?? "");
                          setSigunguCode(place.sigunguCode ?? "");
                          setLocationMode("manual");
                          setGeoState("success");
                          setGeoMessage(
                            language === "en"
                              ? `Using the ${place.sourceLabel?.includes("한국관광공사") ? "KTO official Korean" : "source"} place name “${place.title}” as your current location. Location permission was not used.${
                                  place.retention === "ephemeral"
                                    ? " These coordinates will not be saved to the itinerary."
                                    : ""
                                }`
                              : `${quotedWithParticle(place.title, "을/를")} 현재 위치로 선택했어요. 위치 권한은 쓰지 않았습니다.${
                                  place.retention === "ephemeral"
                                    ? " 이 좌표는 일정에 저장하지 않습니다."
                                    : ""
                                }`,
                          );
                          setGeoAttribution(place.sourceLabel ?? "");
                        }}
                      />
                    </div>
                  )}
                </fieldset>

                <fieldset className="form-group">
                  <legend>{tr("무슨 일이 생겼나요?", "What happened?")}</legend>
                  <div className="incident-list">
                    {INCIDENTS.map((item) => (
                      <label
                        key={item.value}
                        className={incident === item.value ? "incident-option is-selected" : "incident-option"}
                      >
                        <input
                          type="radio"
                          name="incident"
                          value={item.value}
                          checked={incident === item.value}
                          onChange={() => {
                            setIncident(item.value);
                            /* 사용자가 직접 손대지 않았다면 상황에 맞는 기본값을
                               따라간다. 손댄 뒤에는 그 선택을 덮지 않는다. */
                            if (!indoorTouched) {
                              setIndoorOnly(item.value === "rain");
                            }
                          }}
                        />
                        <span className="incident-marker" aria-hidden="true">
                          {item.marker}
                        </span>
                        <span>
                          <strong>
                            {language === "en" ? INCIDENTS_EN[item.value].title : item.title}
                          </strong>
                          <small>
                            {language === "en"
                              ? INCIDENTS_EN[item.value].description
                              : item.description}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <ReferenceTimePicker
                  idPrefix="recover"
                  language={language}
                  mode={referenceTimeMode}
                  localValue={referenceTimeLocal}
                  onModeChange={changeReferenceTimeMode}
                  onLocalValueChange={changeReferenceTimeLocal}
                />

                <fieldset className="form-group">
                  <legend>{language === "en" ? "What IEOGA will protect" : "이어가가 반드시 지킬 것"}</legend>
                  <div className="derived-time-card">
                    <span>{language === "en" ? "Time you can use before the next booking" : "다음 예약까지 쓸 수 있는 시간"}</span>
                    <strong>
                      {tr(`${availableMinutes}분`, `${availableMinutes} min`)}
                    </strong>
                    <small>
                      {tr(
                        `예약 시각과 남겨 둘 여유 ${safetyBufferMinutes}분을 반영해 자동 계산했어요.`,
                        `Calculated from the appointment time with a ${safetyBufferMinutes}-minute safety buffer.`,
                      )}
                    </small>
                  </div>
                  <div
                    className="travel-mode-row"
                    role="radiogroup"
                    aria-label={
                      language === "en" ? "Travel mode" : "이동수단"
                    }
                  >
                    <span className="travel-mode-label">
                      {language === "en" ? "How you move" : "어떻게 이동하나요"}
                    </span>
                    {TRAVEL_MODES.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        role="radio"
                        aria-checked={travelMode === item.value}
                        className={
                          travelMode === item.value
                            ? "travel-mode-chip is-active"
                            : "travel-mode-chip"
                        }
                        onClick={() => setTravelMode(item.value)}
                      >
                        {language === "en" ? item.en : item.ko}
                      </button>
                    ))}
                    {/* 도보 경로 안내 문구는 지웠다 — 카드마다 이미 실제 경로와
                        시간이 나오므로 같은 말을 위에서 다시 하는 것이다.
                        자동차는 주차 시간이 빠졌다는 사실이 결정에 영향을 주므로
                        남긴다. */}
                    {travelMode === "car" && (
                      <small>
                        {tr(
                          "도착 시각에 주차 시간은 포함하지 않았습니다.",
                          "The arrival estimate does not include parking time.",
                        )}
                      </small>
                    )}
                  </div>
                  <details className="ablation-panel">
                    <summary>
                      {tr(
                        "심사용 · 한국관광공사 API를 끄고 결과 차이 보기",
                        "Evaluation tool · compare results with selected KTO APIs disabled",
                      )}
                    </summary>
                    <div className="ablation-body">
                      <p>
                        {tr(
                          "끈 서비스는 이 요청에서 호출하지 않습니다. 호출해 놓고 결과만 버리면 데이터가 없을 때 무엇이 깨지는지 보여 줄 수 없기 때문입니다. 국문 관광정보는 후보 자체를 만드는 유일한 원천이라 끌 수 없습니다.",
                          "Disabled services are not called for this request, so the comparison shows what genuinely breaks when that evidence is unavailable. KTO official Korean tourism data cannot be disabled because it is the source of the candidate places.",
                        )}
                      </p>
                      {ABLATION_SOURCES.map((item) => (
                        <label key={item.id} className="check-row">
                          <input
                            type="checkbox"
                            checked={disabledSources.includes(item.id)}
                            onChange={(event) =>
                              setDisabledSources((current) =>
                                event.target.checked
                                  ? [...current, item.id]
                                  : current.filter((id) => id !== item.id),
                              )
                            }
                          />
                          <span>
                            <strong>
                              {language === "en"
                                ? `Disable ${ABLATION_SOURCE_EN[item.id].label}`
                                : `${item.label} 끄기`}
                            </strong>
                            <small>
                              {language === "en"
                                ? ABLATION_SOURCE_EN[item.id].lost
                                : item.lost}
                            </small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </details>
                  <details className="recovery-preferences">
                    <summary>
                      {tr(
                        "이동 배려·실내 조건이 필요해요",
                        "I need mobility or indoor conditions",
                      )}
                    </summary>
                    <div className="recovery-preferences-body">
                      {/* 켜고 끄는 하나다. 두 항목뿐인 드롭다운은 여는 동작이
                          하나 더 붙을 뿐 고르는 일을 쉽게 만들지 않는다. 아래
                          실내 조건과 같은 모양으로 맞춰 한 덩어리로 읽힌다. */}
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={audience !== "general"}
                          onChange={(event) =>
                            setAudience(
                              (event.target.checked
                                ? "assisted"
                                : "general") as Audience,
                            )
                          }
                        />
                        <span>
                          <strong>
                            {language === "en"
                              ? AUDIENCES_EN.assisted
                              : "이동 도움이 필요해요"}
                          </strong>
                          <small>
                            {tr(
                              "계단 없는 동선이 필요한 경우입니다. 공식 무장애여행정보에서 출입 동선과 내부 이동을 확인합니다.",
                              "For a stroller, wheelchair or walking aid. IEOGA verifies step-free entry and indoor movement in official accessibility data.",
                            )}
                          </small>
                        </span>
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={indoorOnly}
                          onChange={(event) => {
                            setIndoorTouched(true);
                            setIndoorOnly(event.target.checked);
                          }}
                        />
                        <span>
                          <strong>
                            {tr("실내 후보만 찾기", "Only find verified indoor options")}
                          </strong>
                          <small>
                            {tr(
                              "실내 여부가 확인되지 않은 후보는 제외합니다.",
                              "Options without verified indoor status are excluded.",
                            )}
                            {incident === "rain" && !indoorOnly
                              ? tr(
                                  " 지금은 꺼져 있어 실외 후보까지 함께 검토합니다.",
                                  " This is off, so outdoor options are also checked.",
                                )
                              : ""}
                          </small>
                        </span>
                      </label>
                    </div>
                  </details>
                  <details className="advanced-constraints">
                    <summary>
                      {tr("시간 자세히 정하기", "Set time details")}
                    </summary>
                    <div className="field-grid three">
                      <label>
                        <span>
                          {tr("지금부터 쓸 수 있는 시간", "Time available from now")}
                        </span>
                        <span className="number-input">
                          <input
                            aria-label={tr(
                              "지금부터 쓸 수 있는 시간 (15~1,440분)",
                              "Time available from now (15 to 1,440 minutes)",
                            )}
                            type="number"
                            min={15}
                            max={1440}
                            step={5}
                            value={availableMinutes}
                            onChange={(event) => setAvailableMinutes(Number(event.target.value))}
                          />
                          <b aria-hidden="true">{tr("분", "min")}</b>
                        </span>
                      </label>
                      <label>
                        <span>
                          {tr("예약 전에 남겨 둘 여유", "Safety buffer before the booking")}
                        </span>
                        <span className="number-input">
                          <input
                            aria-label={tr(
                              "예약 전에 남겨 둘 여유 (5~60분)",
                              "Safety buffer before the booking (5 to 60 minutes)",
                            )}
                            type="number"
                            min={5}
                            max={60}
                            step={5}
                            value={safetyBufferMinutes}
                            onChange={(event) => setSafetyBufferMinutes(Number(event.target.value))}
                          />
                          <b aria-hidden="true">{tr("분", "min")}</b>
                        </span>
                      </label>
                      <label>
                        <span>
                          {tr("가면 최소 이만큼은 머물기", "Minimum time at the alternative")}
                        </span>
                        <span className="number-input">
                          <input
                            aria-label={tr(
                              "가면 최소 이만큼은 머물기 (10~180분)",
                              "Minimum time at the alternative (10 to 180 minutes)",
                            )}
                            type="number"
                            min={10}
                            max={180}
                            step={5}
                            value={minimumStayMinutes}
                            onChange={(event) =>
                              setMinimumStayMinutes(Number(event.target.value))
                            }
                          />
                          <b aria-hidden="true">{tr("분", "min")}</b>
                        </span>
                      </label>
                    </div>
                  </details>
                  <label className="consent-row">
                    <input
                      type="checkbox"
                      checked={analyticsConsent}
                      onChange={(event) => setAnalyticsConsent(event.target.checked)}
                    />
                    <span>
                      <strong>
                        {tr(
                          "선택: 익명 결과를 지역 관광 공백 개선에 활용",
                          "Optional: use anonymized outcomes to improve local tourism gaps",
                        )}
                      </strong>
                      <small>
                        {tr(
                          "정확한 위치·일정명은 저장하지 않습니다. 시군구·시간대·문제 유형과 도착 결과만 30일 보관하며, 동의하지 않아도 복구 기능은 동일합니다.",
                          "Exact locations and itinerary names are not stored. Only district, time band, incident type and arrival outcome are retained for 30 days. Recovery works the same if you decline.",
                        )}
                      </small>
                    </span>
                  </label>
                </fieldset>

                {recoverState === "error" && (
                  <div className="notice is-error" role="alert" data-testid="recover-error">
                    <strong>
                      {tr("복구 요청을 완료하지 못했습니다.", "The recovery request did not complete.")}
                    </strong>
                    <p>{recoverError}</p>
                  </div>
                )}

                <button
                  className="primary-action"
                  type="submit"
                  disabled={
                    recoverState === "loading" || !originSelectionCurrent
                  }
                  data-testid="recover-submit"
                >
                  {recoverState === "loading"
                    ? tr("갈 수 있는 길을 확인하는 중…", "Checking a safe route…")
                    : tr("한 곳만 바꿔서 찾기", "Replace only the disrupted stop")}
                  <span aria-hidden="true">→</span>
                </button>
                <p className="estimate-note">
                  {tr(
                    "실제 보행 경로와 운영 여부를 확인한 곳만 결과에 올립니다. 확인하지 못한 조건은 숨기지 않고 따로 알려 드립니다.",
                    "Only places with a verified route and opening status appear. Any condition that could not be verified is shown explicitly.",
                  )}
                </p>
              </form>

              <div
                className="result-panel"
                ref={resultRef}
                tabIndex={-1}
                aria-live="polite"
                data-testid="recover-result"
              >
                <div className="panel-heading dark">
                  <span>02</span>
                  <div>
                    <p>{language === "en" ? "Step 2 · where you can go" : "2단계 · 갈 수 있는 곳"}</p>
                    <h2>{language === "en" ? "Where you can go instead" : "지금 대신 갈 수 있는 곳"}</h2>
                  </div>
                </div>

                {recoverState === "idle" && (
                  <div className="result-empty">
                    <span className="route-graphic" aria-hidden="true">
                      <i />
                      <b />
                    </span>
                    <strong>
                      {tr(
                        "조건을 입력하면 여기에 결과가 나타납니다.",
                        "Your verified alternatives will appear here.",
                      )}
                    </strong>
                    <p>
                      {tr(
                        "긴 목록을 먼저 보여주지 않습니다. 시간·거리·이동 조건을 통과한 공식 관광정보만 제안합니다.",
                        "IEOGA does not show an unfiltered list. It only proposes official tourism places that pass your time, distance and mobility constraints.",
                      )}
                    </p>
                  </div>
                )}

                {recoverState === "loading" && (
                  <div className="result-loading" role="status">
                    <span className="loading-ring" aria-hidden="true" />
                    <strong>
                      {tr(
                        "전국 관광데이터를 교차 확인하고 있어요.",
                        "Cross-checking nationwide tourism data.",
                      )}
                    </strong>
                    <p>
                      {tr(
                        "조건을 못 지키는 곳은 이 단계에서 빠집니다. 보통 5~15초 걸립니다.",
                        "Places that fail a required condition are removed at this stage. This usually takes 5–15 seconds.",
                      )}
                    </p>
                  </div>
                )}

                {recoverState === "error" && (
                  <div className="result-empty is-error">
                    <span className="error-mark" aria-hidden="true">
                      !
                    </span>
                    <strong>
                      {tr("결과를 만들지 않았습니다.", "No result was fabricated.")}
                    </strong>
                    <p>
                      {recoverError ||
                        tr(
                          "실데이터 호출 또는 필수 입력을 확인한 뒤 다시 요청해 주세요.",
                          "Check the live-data connection and required inputs, then try again.",
                        )}
                    </p>
                  </div>
                )}

                {recoverState === "success" &&
                  !!recovery?.ablation?.disabledSources?.length && (
                    /* 무엇을 끄고 얻은 수치인지 결과와 같은 자리에 적는다. 끈
                       사실을 숨기면 이 결과가 전체 사용 결과로 읽힌다. */
                    <aside className="ablation-result" role="status">
                      <strong>
                        {tr(
                          `제거실험 진행 중 · 한국관광공사 API ${recovery.ablation.disabledSources.length}종을 끈 결과입니다`,
                          `Ablation running · ${recovery.ablation.disabledSources.length} KTO API source${recovery.ablation.disabledSources.length === 1 ? "" : "s"} disabled`,
                        )}
                      </strong>
                      <ul>
                        {language === "en"
                          ? recovery.ablation.disabledSources.map((source) => (
                              <li key={source}>
                                {ABLATION_SOURCE_EN[source]?.lost ??
                                  "A decision signal is unavailable in this comparison."}
                              </li>
                            ))
                          : (recovery.ablation.lostCapabilities ?? []).map((lost) => (
                              <li key={lost}>{lost}</li>
                            ))}
                      </ul>
                      <p>
                        {tr(
                          `검증된 후보 ${recovery.ablation.verifiedOptionCount ?? 0}개 · 확인 필요 ${recovery.ablation.confirmationRequiredCount ?? 0}개 · 연계 방문 근거 ${recovery.ablation.relatedEvidenceCount ?? 0}개 · 집중률 근거 ${recovery.ablation.crowdEvidenceCount ?? 0}개 · 접근성 확인 ${recovery.ablation.accessibilityVerifiedCount ?? 0}개`,
                          `Verified ${recovery.ablation.verifiedOptionCount ?? 0} · needs review ${recovery.ablation.confirmationRequiredCount ?? 0} · related-destination evidence ${recovery.ablation.relatedEvidenceCount ?? 0} · concentration evidence ${recovery.ablation.crowdEvidenceCount ?? 0} · accessibility verified ${recovery.ablation.accessibilityVerifiedCount ?? 0}`,
                        )}
                      </p>
                    </aside>
                  )}

                {recoverState === "success" && recovery && recovery.options.length === 0 && (
                  <div className="no-candidate" data-testid="no-candidate">
                    {submittedReferenceTime && (
                      <p className="reference-time-result" data-testid="recover-reference-time">
                        <strong>{tr("조회 기준", "Search reference")}</strong>{" "}
                        {submittedReferenceTime.mode === "now"
                          ? tr(
                              `요청을 받은 현재 시각 · ${formatReferenceTime(submittedReferenceTime.iso, language)}`,
                              `Current time when the request was received · ${formatReferenceTime(submittedReferenceTime.iso, language)}`,
                            )
                          : tr(
                              `가정 시각 · ${formatReferenceTime(submittedReferenceTime.iso, language)}`,
                              `Assumed time · ${formatReferenceTime(submittedReferenceTime.iso, language)}`,
                            )}
                      </p>
                    )}
                    <span>{tr("적용 가능 후보 0", "0 safe-to-apply alternatives")}</span>
                    <h3>
                      {tr(
                        "조건을 만족하는 일정을 찾지 못했습니다.",
                        "No itinerary satisfies every required condition.",
                      )}
                    </h3>
                    <p>
                      {tr(
                        "없는 후보를 만들어내지 않았습니다. 머무는 시간과 다음 약속 전 여유를 조정하거나, 실내 조건을 해제한 뒤 다시 확인해 주세요.",
                        "IEOGA did not invent an option. Adjust the stay or booking buffer, or remove the indoor-only condition, then verify again.",
                      )}
                    </p>
                    {typeof recovery.rejectedCount === "number" && (
                      <small>
                        {tr(
                          `조건 검증에서 제외된 후보 ${recovery.rejectedCount.toLocaleString("ko-KR")}개`,
                          `${recovery.rejectedCount.toLocaleString("en-US")} candidate${recovery.rejectedCount === 1 ? "" : "s"} excluded by required-condition checks`,
                        )}
                      </small>
                    )}
                    {recovery.counterfactual?.title && (
                      <aside className="counterfactual-card is-empty-result">
                        <div>
                          <span>
                            {tr(
                              "한 가지 조건만 바꾸면 가능한 대안",
                              "Possible if one condition changes",
                            )}
                          </span>
                          <h3 lang={language === "en" ? "ko" : undefined}>
                            {recovery.counterfactual.title}
                          </h3>
                          {language === "en" && (
                            <small>KTO official Korean place name</small>
                          )}
                        </div>
                        <div>
                          <p>
                            {counterfactualReasonText(recovery.counterfactual, language)}
                          </p>
                          {recovery.counterfactual.requiredRelaxation?.description && (
                            <strong className="counterfactual-relaxation">
                              {relaxationDescriptionText(recovery.counterfactual, language)}
                            </strong>
                          )}
                          {/* 사전 걸러내기 단계 탈락안은 경로·운영시간을 아직
                              확인하지 않았다. 그 후보에까지 "예약을 그대로
                              보존합니다"라고 쓰면 검증하지 않은 것을 보증하는
                              문장이 된다. */}
                          <small>
                            {recovery.counterfactual.verificationDepth ===
                            "pre_filter"
                              ? tr(
                                  "거리·시간 조건만 비교한 단계입니다. 실제 경로와 운영시간, 다음 예약 보존은 이 조건을 적용한 뒤 다시 검증합니다.",
                                  "This is only a distance-and-time pre-check. The real route, opening hours and next-booking preservation will be verified after you apply this condition.",
                                )
                              : tr(
                                  "다른 일정과 다음 예약은 그대로 보존합니다.",
                                  "The remaining itinerary and next booking stay protected.",
                                )}
                          </small>
                        </div>
                        <button
                          type="button"
                          onClick={applyCounterfactualRelaxation}
                          disabled={
                            !recovery.counterfactual.requiredRelaxation
                          }
                        >
                          {tr("이 한 조건만 적용", "Apply this one condition")}
                        </button>
                      </aside>
                    )}
                    {recovery.warnings?.map((warning) => (
                      <small key={warning}>
                        {language === "en"
                          ? "An official evidence source reported a limitation; review the verification details before changing any condition."
                          : sanitizeTravelerText(warning, language)}
                      </small>
                    ))}
                    <div className="no-candidate-actions">
                      <a href="tel:1330">
                        {tr("관광통역안내 1330 연결", "Call the 1330 Travel Helpline")}
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          document
                            .querySelector(".recovery-form")
                            ?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }}
                      >
                        {tr("조건을 직접 검토하기", "Review my conditions")}
                      </button>
                    </div>
                  </div>
                )}

                {recoverState === "success" && recovery && recovery.options.length > 0 && (
                  <div className="recovery-results">
                    {submittedReferenceTime && (
                      <p className="reference-time-result" data-testid="recover-reference-time">
                        <strong>{tr("조회 기준", "Search reference")}</strong>{" "}
                        {submittedReferenceTime.mode === "now"
                          ? tr(
                              `요청을 받은 현재 시각 · ${formatReferenceTime(submittedReferenceTime.iso, language)}`,
                              `Current time when the request was received · ${formatReferenceTime(submittedReferenceTime.iso, language)}`,
                            )
                          : tr(
                              `가정 시각 · ${formatReferenceTime(submittedReferenceTime.iso, language)}`,
                              `Assumed time · ${formatReferenceTime(submittedReferenceTime.iso, language)}`,
                            )}
                      </p>
                    )}
                    <div className="recovery-ready-banner">
                      <span aria-hidden="true">✓</span>
                      <div>
                        <strong>
                          {tr(
                            "다음 예약을 지키는 복구안을 찾았어요",
                            "We found a recovery that protects your next booking",
                          )}
                        </strong>
                        <p>
                          {tr(
                            "원래 여행에서 가장 적게 바꾸는 안을 먼저 보여드려요.",
                            "The option with the smallest change to your original trip appears first.",
                          )}
                        </p>
                      </div>
                    </div>

                    {recovery.warnings && recovery.warnings.length > 0 && (
                      <div className="notice is-warning">
                        {/* "일부 데이터 제한이 있습니다"는 무엇이 문제인지
                            알려 주지 않으면서 결과 전체를 의심하게 만든다.
                            아래에 실제 사유가 이미 나열되므로 제목은 그것을
                            가리키는 말이면 된다. */}
                        <strong>{tr("참고해 주세요", "Please review")}</strong>
                        {recovery.warnings.map((warning) => (
                          <p key={warning}>
                            {language === "en"
                              ? "An official evidence source was unavailable or incomplete. Affected safety conditions remain blocked and are identified on each option."
                              : sanitizeTravelerText(warning, language)}
                          </p>
                        ))}
                      </div>
                    )}

                    {!recoveryPersisted && (
                      <div className="notice is-error" role="alert">
                        <strong>
                          {tr(
                            "복구 실행 저장을 확인하지 못했습니다.",
                            "The saved recovery run could not be verified.",
                          )}
                        </strong>
                        <p>
                          {tr(
                            "이 결과는 일정에 적용하거나 공유·성과 기록에 사용할 수 없습니다. 복구를 다시 실행해 주세요.",
                            "This result cannot be applied, shared or recorded as an outcome. Run recovery again.",
                          )}
                        </p>
                      </div>
                    )}

                    {appliedOption && selectedAffectedStop && selectedNextFixedStop && (
                      <div
                        className="applied-recovery"
                        ref={appliedPlanRef}
                        tabIndex={-1}
                      >
                        <div className="applied-recovery-heading">
                          <div>
                            <span>
                              {tr("현재 적용 중인 복구안", "Recovery currently in use")}
                            </span>
                            <h3>
                              {tr(
                                `일정 ${
                                  appliedScheduleDiff?.changedNodeCount ??
                                  appliedScheduleDiff?.changedCount ??
                                  appliedScheduleDiff?.changedNodeIds?.length ??
                                  1
                                }개만 바꿔 다음 예약을 지킵니다.`,
                                `Only ${
                                  appliedScheduleDiff?.changedNodeCount ??
                                  appliedScheduleDiff?.changedCount ??
                                  appliedScheduleDiff?.changedNodeIds?.length ??
                                  1
                                } stop is changed to protect your next booking.`,
                              )}
                            </h3>
                          </div>
                          <b
                            className={
                              appliedScheduleDiff?.nextFixedAppointmentPreserved === false ||
                              appliedScheduleDiff?.nextFixedStopPreserved === false
                                ? "is-warning"
                                : ""
                            }
                          >
                            {appliedScheduleDiff?.nextFixedAppointmentPreserved === false ||
                            appliedScheduleDiff?.nextFixedStopPreserved === false
                              ? tr("예약 보존 재확인 필요", "Booking preservation needs re-checking")
                              : tr("다음 고정 일정 보존", "Next fixed appointment preserved")}
                          </b>
                        </div>

                        <div className="before-after-timeline">
                          <div className="timeline-column">
                            <span>{tr("변경 전", "Before")}</span>
                            <ol>
                              <li className="is-disrupted">
                                <time>{formatStopTime(selectedAffectedStop.time)}</time>
                                <strong>{selectedAffectedStop.title}</strong>
                                <small>{tr("돌발상황으로 진행 불가", "Disrupted")}</small>
                              </li>
                              {preservedOriginalStops.map((stop) => (
                                <li
                                  className={stop.fixed ? "is-locked" : ""}
                                  key={stop.id}
                                >
                                  <time>{formatStopTime(stop.time)}</time>
                                  <strong>{stop.title}</strong>
                                  <small>{tr("원래 일정 · 변경하지 않음", "Original stop · unchanged")}</small>
                                </li>
                              ))}
                              <li className="is-locked">
                                <time>{formatStopTime(selectedNextFixedStop.time)}</time>
                                <strong>{selectedNextFixedStop.title}</strong>
                                <small>{tr("예약·고정 일정", "Booked · fixed appointment")}</small>
                              </li>
                            </ol>
                          </div>
                          <i aria-hidden="true">→</i>
                          <div className="timeline-column is-after">
                            <span>{tr("최소변경 복구 후", "After minimum-change recovery")}</span>
                            <ol>
                              <li className="is-replacement">
                                <time>{tr("지금", "Now")}</time>
                                <strong>{appliedOption.title}</strong>
                                <small>
                                  {typeof appliedOption.estimatedTravelMinutes === "number"
                                    ? tr(
                                        `첫 이동 약 ${Math.ceil(appliedOption.estimatedTravelMinutes)}분`,
                                        `First leg about ${Math.ceil(appliedOption.estimatedTravelMinutes)} min`,
                                      )
                                    : tr("이동 경로 확인", "Route verified")}
                                </small>
                              </li>
                              {appliedScheduleDiff?.preservedWaypoints
                                ?.filter(
                                  (waypoint) =>
                                    waypoint.nodeId !==
                                    selectedNextFixedStop.id,
                                )
                                .map((waypoint) => (
                                  <li
                                    className={
                                      waypoint.status === "preserved"
                                        ? ""
                                        : "is-disrupted"
                                    }
                                    key={waypoint.nodeId ?? waypoint.title}
                                  >
                                    <time>
                                      {formatIsoTime(
                                        waypoint.estimatedArrivalAt,
                                        language,
                                      )}
                                    </time>
                                    <strong>
                                      {waypoint.title ?? tr("보존 일정", "Preserved stop")}
                                    </strong>
                                    <small>
                                      {typeof waypoint.arrivalBufferMinutes ===
                                      "number"
                                        ? tr(
                                            `도착 여유 ${waypoint.arrivalBufferMinutes}분 · 보존 검증`,
                                            `${waypoint.arrivalBufferMinutes} min arrival buffer · preservation verified`,
                                          )
                                        : tr("원래 일정 보존 검증", "Original stop preservation verified")}
                                    </small>
                                  </li>
                                ))}
                              <li className="is-locked">
                                <time>{formatStopTime(selectedNextFixedStop.time)}</time>
                                <strong>{selectedNextFixedStop.title}</strong>
                                <small>{tr("잠금 유지", "Lock preserved")}</small>
                              </li>
                            </ol>
                          </div>
                        </div>

                        <div className="continuity-proof-facts">
                          <dl>
                            <dt>{tr("잠긴 일정 보존", "Locked stops preserved")}</dt>
                            <dd>
                              {readText(appliedProof, ["lockedNodesPreserved"]) ||
                                appliedScheduleDiff?.preservedLockedNodeIds?.length ||
                                tr("확인 중", "Being verified")}
                              {readText(appliedProof, ["lockedNodesTotal"])
                                ? ` / ${readText(appliedProof, ["lockedNodesTotal"])}`
                                : ""}
                            </dd>
                          </dl>
                          <dl>
                            <dt>{tr("실제 경로 근거", "Real-route evidence")}</dt>
                            <dd>
                              {readText(appliedRouteEvidence, [
                                "status",
                                "provider",
                                "method",
                              ]) || tr("구간별 경로 확인", "Every route leg verified")}
                            </dd>
                          </dl>
                          <dl>
                            <dt>{tr("다음 일정 도착", "Arrival at next appointment")}</dt>
                            <dd>
                              {readText(appliedRouteEvidence, [
                                "arrivalAt",
                                "estimatedArrivalAt",
                              ]) ||
                                appliedScheduleDiff?.arrivalTime ||
                                tr("도착 시각 확인", "Arrival time verified")}
                            </dd>
                          </dl>
                          <dl>
                            <dt>{tr("안전 여유", "Safety buffer")}</dt>
                            <dd>
                              {typeof appliedScheduleDiff?.safetyBufferMinutes === "number"
                                ? tr(
                                    `${appliedScheduleDiff.safetyBufferMinutes}분`,
                                    `${appliedScheduleDiff.safetyBufferMinutes} min`,
                                  )
                                : tr(`${safetyBufferMinutes}분 기준`, `${safetyBufferMinutes} min minimum`) }
                            </dd>
                          </dl>
                          {appliedWeatherEvidence && (
                            <dl>
                              <dt>{tr("현재 기상 근거", "Current weather evidence")}</dt>
                              <dd>
                                {weatherSourceInfo(appliedWeatherEvidence, language).url ? (
                                  <a
                                    href={weatherSourceInfo(appliedWeatherEvidence, language).url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {weatherSourceInfo(appliedWeatherEvidence, language).label}
                                  </a>
                                ) : (
                                  weatherSourceInfo(appliedWeatherEvidence, language).label
                                )}
                                {" · "}
                                {formatIsoTime(
                                  readText(appliedWeatherEvidence, [
                                    "observedAt",
                                  ]),
                                  language,
                                )}
                              </dd>
                            </dl>
                          )}
                        </div>

                        <div className="route-action-row">
                          <a
                            href={`https://map.kakao.com/link/to/${encodeURIComponent(appliedOption.title)},${appliedOption.latitude},${appliedOption.longitude}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {tr("현재 위치 → 대체 일정 길찾기", "Directions: current location → recovery stop")}
                          </a>
                          {typeof selectedNextFixedStop.latitude === "number" &&
                            typeof selectedNextFixedStop.longitude === "number" && (
                              <a
                                href={`https://map.kakao.com/link/to/${encodeURIComponent(selectedNextFixedStop.title)},${selectedNextFixedStop.latitude},${selectedNextFixedStop.longitude}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {tr("대체 일정 → 다음 예약 길찾기", "Directions: recovery stop → next booking")}
                              </a>
                            )}
                        </div>
                        <p className="route-attribution">
                          {tr("적용 경로 출처", "Applied-route source")} ·{" "}
                          {readText(appliedRouteEvidence, ["attribution"])
                            ? contributionSourceText(
                                readText(appliedRouteEvidence, ["attribution"]),
                                language,
                              )
                            : tr("경로 제공자 출처 확인 필요", "Routing source not recorded")}
                          {readText(appliedRouteEvidence, ["calculatedAt"])
                            ? tr(
                                ` · 확인 ${formatDate(readText(appliedRouteEvidence, ["calculatedAt"]))}`,
                                ` · checked ${formatLocalizedDateTime(readText(appliedRouteEvidence, ["calculatedAt"]), language)}`,
                              )
                            : ""}
                        </p>

                        {outcomeMessage && (
                          <p className="outcome-message" role="status">
                            {outcomeMessage}
                          </p>
                        )}
                      </div>
                    )}

                    {/* 기준 지점의 날씨. 대안 카드의 같은 시점과 나란히 놓여야
                        "여기가 나은가"를 판단할 수 있다. */}
                    {(recovery.originWeatherGlance?.length ?? 0) > 0 && (
                      <WeatherGlanceStrip
                        label={
                          language === "en"
                            ? `Where you were headed — ${recovery.originWeatherLabel ?? ""}`
                            : `원래 가려던 곳 · ${recovery.originWeatherLabel ?? "현재 위치"}`
                        }
                        slots={recovery.originWeatherGlance ?? []}
                        language={language}
                        isBaseline
                      />
                    )}

                    {/* 정렬 축. 집중률 예측을 가진 후보가 2곳 미만이면 이 축으로
                        줄을 세울 수 없으므로 선택지를 만들지 않는다 — 누르면
                        아무 일도 일어나지 않는 컨트롤을 보여 주지 않는다. */}
                    {/* 후보가 둘 이상이면 정렬을 제공한다. 운영 여부는 모든
                        후보에 값이 있으므로 집중률이 없어도 쓸 수 있다.
                        집중률 축은 값이 부족하면 그 자리에서 밝힌다. */}
                    {recovery.options.length >= 2 && (
                      <div
                        className="option-sort"
                        role="group"
                        aria-label={
                          language === "en" ? "Sort alternatives" : "대안 정렬 기준"
                        }
                      >
                        {OPTION_SORTS.map((entry) => (
                          <button
                            key={entry.value}
                            type="button"
                            className={
                              optionSort === entry.value ? "is-active" : ""
                            }
                            aria-pressed={optionSort === entry.value}
                            title={language === "en" ? entry.hintEn : entry.hint}
                            onClick={() => setOptionSort(entry.value)}
                          >
                            {language === "en" ? entry.en : entry.ko}
                          </button>
                        ))}
                        <p className="option-sort-hint">
                          {language === "en"
                            ? OPTION_SORTS.find((e) => e.value === optionSort)?.hintEn
                            : OPTION_SORTS.find((e) => e.value === optionSort)?.hint}
                        </p>
                      </div>
                    )}

                    <div
                      className="option-sort option-category-filter"
                      role="radiogroup"
                      aria-label={
                        language === "en"
                          ? "Filter alternatives by official tourism category"
                          : "공식 관광 분류로 대안 필터"
                      }
                    >
                      <button
                        type="button"
                        role="radio"
                        className={optionCategory === "all" ? "is-active" : ""}
                        aria-checked={optionCategory === "all"}
                        onClick={() => setOptionCategory("all")}
                      >
                        {tr("전체", "All")} {recovery.options.length}
                      </button>
                      {recoveryCategoryCounts.map((category) => (
                        <button
                          key={category.code}
                          type="button"
                          role="radio"
                          className={
                            optionCategory === category.code ? "is-active" : ""
                          }
                          aria-checked={optionCategory === category.code}
                          onClick={() => setOptionCategory(category.code)}
                        >
                          {language === "en" ? category.labelEn : category.labelKo}{" "}
                          {category.count}
                        </button>
                      ))}
                      <p className="option-sort-hint">
                        {tr(
                          "한국관광공사 공식 관광 분류로 검증된 후보만 모아 봅니다.",
                          "Filters use the official Korea Tourism Organization classification attached to each verified option.",
                        )}
                      </p>
                    </div>
                    {sortedRecoveryOptionGroups.unranked.length > 0 && (
                      <p className="option-sort-hint">
                        {tr(
                          "집중률 예측이 없는 후보도 아래 목록에 그대로 보여줍니다. 더 나쁜 곳이라는 뜻이 아니라 측정되지 않았다는 뜻입니다.",
                          "Options without a crowding forecast remain in the list below. They are not worse, only unmeasured.",
                        )}
                      </p>
                    )}

                    <div className="option-list">
                      {displayedRecoveryOptions.map((option, index) => (
                        <article
                          className={[
                            "option-card",
                            appliedOptionId === option.id ? "is-applied" : "",
                            !optionApplicationSafety(option, language).canApply
                              ? "is-unverified"
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          key={option.id || option.contentId || `${option.title}-${index}`}
                          data-testid="recovery-option"
                        >
                          <div className="option-image">
                            {option.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={option.imageUrl}
                                alt=""
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                onError={(event) => {
                                  event.currentTarget.hidden = true;
                                }}
                              />
                            ) : null}
                            <span>#{String(index + 1).padStart(2, "0")}</span>
                          </div>
                          <div className="option-content">
                            <div className="option-title-row">
                              <div>
                                {option.strategyLabel && (
                                  <span className="strategy-label">
                                    {(language === "en" &&
                                      option.strategyLabelEn) ||
                                      option.strategyLabel}
                                  </span>
                                )}
                                {option.tourismCategory && (
                                  <span className="tourism-category-label">
                                    {language === "en"
                                      ? option.tourismCategory.labelEn
                                      : option.tourismCategory.labelKo}
                                  </span>
                                )}
                                <p lang={language === "en" ? "ko" : undefined}>
                                  {option.address || tr("주소 정보 확인 필요", "Address not provided")}
                                </p>
                                <h3 lang={language === "en" ? "ko" : undefined}>
                                  {option.title}
                                </h3>
                                {language === "en" && (
                                  <small>KTO official Korean place name and address</small>
                                )}
                              </div>
                              {typeof option.score === "number" && (
                                <span className="option-score">
                                  <b>{Math.round(option.score)}</b>
                                  <small>{tr("기초 적합도", "Base fit")}</small>
                                </span>
                              )}
                            </div>
                            {!optionApplicationSafety(option, language).canApply && (
                              <section
                                className="evidence-gap-alert"
                                role="alert"
                                aria-label={tr(
                                  "출발 전 직접 확인할 항목",
                                  "Conditions to verify before leaving",
                                )}
                              >
                                <strong>
                                  {language === "en"
                                    ? "Unavailable until every safety condition is verified"
                                    : "모든 안전 조건을 확인하기 전에는 적용할 수 없어요"}
                                </strong>
                                <p>
                                  {language === "en"
                                    ? "IEOGA blocks closed and unverified options to prevent a wasted trip or a missed appointment."
                                    : "헛걸음이나 다음 약속 지연을 막기 위해 휴무·미확인 후보는 일정에 적용하지 않습니다."}
                                </p>
                                <ul>
                                  {optionApplicationSafety(option, language).reasons.map(
                                    (reason, reasonIndex) => (
                                      <li key={`${option.id}-safety-${reasonIndex}`}>
                                        {reason}
                                      </li>
                                    ),
                                  )}
                                </ul>
                              </section>
                            )}
                            {(() => {
                              const geometry = (option.routeGeometry ??
                                []) as RoutePoint[];
                              if (geometry.length < 2) return null;
                              const evidence = asRecord(
                                asRecord(option.continuityProof)?.routeEvidence,
                              );
                              const provider = readText(evidence, ["provider"]);
                              const diff = option.scheduleDiff;
                              const markers: RouteMapMarker[] = [
                                {
                                  point: geometry[0],
                                  label: tr("현재 위치", "Current location"),
                                  kind: "origin",
                                },
                                {
                                  point: {
                                    latitude: option.latitude,
                                    longitude: option.longitude,
                                  },
                                  label: option.title,
                                  kind: "replacement",
                                },
                              ];
                              /* 다음 고정 일정까지 검증한 경우에만 끝점을
                                 도착지로 표시한다. 검증하지 않은 지점을
                                 도착지로 그리면 없는 보장을 그림으로 주장하는
                                 셈이 된다. */
                              const nextFixed = asRecord(
                                diff?.nextFixedAppointment,
                              );
                              if (nextFixed) {
                                markers.push({
                                  point: geometry[geometry.length - 1],
                                  label:
                                    readText(nextFixed, ["title"]) ||
                                    tr("다음 고정 일정", "Next fixed appointment"),
                                  kind: "destination",
                                });
                              }
                              return (
                                <RouteMap
                                  geometry={geometry}
                                  markers={markers}
                                  mode={
                                    provider === "tmap_car"
                                      ? "car"
                                      : provider === "kakao_transit"
                                        ? "transit"
                                        : provider === "kakao_bicycle"
                                          ? "bicycle"
                                          : "walk"
                                  }
                                  attribution={readText(evidence, [
                                    "attribution",
                                  ])}
                                  language={language}
                                  summary={tr(
                                    `현재 위치에서 ${option.title}까지의 경로 개요입니다. 약 ${option.estimatedTravelMinutes ?? 0}분, ${(option.distanceMeters ?? 0).toLocaleString("ko-KR")}m.`,
                                    `Route overview from your current location to the KTO official Korean place named ${option.title}. About ${option.estimatedTravelMinutes ?? 0} minutes and ${(option.distanceMeters ?? 0).toLocaleString("en-US")} metres.`,
                                  )}
                                />
                              );
                            })()}
                            {option.purposePreservation && (
                              <div
                                className="purpose-contract"
                                data-testid="travel-purpose-contract"
                              >
                                {/* 유형이 바뀐 후보에까지 "목적 보존"이라고 적으면
                                    바로 아래 "관광·체험 → 식사"와 모순된다. */}
                                <span>
                                  {option.purposePreservation.status ===
                                  "changed_visit_category"
                                    ? language === "en"
                                      ? "Activity changes"
                                      : "활동이 바뀝니다"
                                    : /* 보존할 원래 목적이 없는 결과에까지
                                         "목적 유지"라고 적으면 사용자가 말한
                                         적 없는 계획을 지켰다고 주장하게 된다. */
                                      option.purposePreservation.status ===
                                        "open_window_unconstrained"
                                      ? language === "en"
                                        ? "No original plan given"
                                        : "원래 계획 미입력"
                                      : language === "en"
                                        ? "Purpose kept"
                                        : "여행 목적 유지"}
                                </span>
                                <strong>
                                  {purposeLabelText(
                                    option.purposePreservation.originalPurpose,
                                    language,
                                  )}
                                  <i aria-hidden="true">→</i>
                                  {purposeLabelText(
                                    option.purposePreservation.replacementPurpose,
                                    language,
                                  )}
                                </strong>
                                <p>
                                  {(language === "en" &&
                                    option.purposePreservation.statementEn) ||
                                    option.purposePreservation.statement ||
                                    tr(
                                      "장소만 바꾸고 원래 하려던 여행 경험은 이어갑니다.",
                                      "Only the place changes; the intended travel experience continues.",
                                    )}
                                </p>
                                <small>
                                  {option.purposePreservation.evidenceSource ===
                                  "TarRlteTarService1"
                                    ? tr(
                                        `한국관광공사 연계 방문 근거${
                                          typeof option.purposePreservation.relatedRank === "number"
                                            ? ` · ${option.purposePreservation.relatedRank}위`
                                            : ""
                                        }`,
                                        `KTO related-destination evidence${
                                          typeof option.purposePreservation.relatedRank === "number"
                                            ? ` · rank ${option.purposePreservation.relatedRank}`
                                            : ""
                                        }`,
                                      )
                                    : tr(
                                        "한국관광공사 관광 콘텐츠 유형 근거",
                                        "KTO official Korean tourism-content type evidence",
                                      )}
                                </small>
                              </div>
                            )}
                            <div className="option-facts">
                              <dl>
                                <dt>{tr("거리", "Distance")}</dt>
                                <dd>
                                  {typeof option.distanceMeters === "number"
                                    ? option.distanceMeters >= 1000
                                      ? `${(option.distanceMeters / 1000).toFixed(1)}km`
                                      : `${Math.round(option.distanceMeters)}m`
                                    : tr("미확인", "Not verified")}
                                </dd>
                              </dl>
                              <dl>
                                <dt>{tr("이동 추정", "Travel estimate")}</dt>
                                <dd>
                                  {typeof option.estimatedTravelMinutes === "number"
                                    ? tr(
                                        `약 ${Math.ceil(option.estimatedTravelMinutes)}분`,
                                        `About ${Math.ceil(option.estimatedTravelMinutes)} min`,
                                      )
                                    : compactLocalizedValue(option.travelEstimate, language)}
                                </dd>
                              </dl>
                              <dl>
                                <dt>{tr("접근성", "Accessibility")}</dt>
                                <dd>{compactLocalizedValue(option.accessibility, language)}</dd>
                              </dl>
                              <dl>
                                <dt>{tr("붐빔 정도", "Crowding")}</dt>
                                <dd>{formatCrowd(option.crowd, language)}</dd>
                              </dl>
                            </div>
                            {/* 이 후보 지점의 시점별 날씨. 위 기준 지점 줄과
                                같은 시점이라 나란히 비교할 수 있다. */}
                            <WeatherGlanceStrip
                              label={
                                language === "en"
                                  ? `Here — ${option.title ?? ""}`
                                  : `이 곳 · ${option.title ?? ""}`
                              }
                              slots={option.weatherGlance ?? []}
                              language={language}
                            />
                            {option.indoorSuitability !== undefined && (
                              <div className="verification-tags">
                                <span>
                                  {tr("실내 적합성", "Indoor suitability")} ·{" "}
                                  {compactLocalizedValue(option.indoorSuitability, language)}
                                </span>
                                <span>
                                  {asRecord(option.continuityProof)?.routeEvidence
                                    ? tr(
                                        "현재→대안→다음 예약 경로 확인",
                                        "Current location → recovery stop → next booking route verified",
                                      )
                                    : tr("경로 근거 확인 필요", "Route evidence needs verification")}
                                </span>
                              </div>
                            )}
                            <p className="route-attribution">
                              {tr("추천 경로 출처", "Recommended-route source")} ·{" "}
                              {readText(
                                asRecord(asRecord(option.continuityProof)?.routeEvidence),
                                ["attribution"],
                              )
                                ? contributionSourceText(
                                    readText(
                                      asRecord(asRecord(option.continuityProof)?.routeEvidence),
                                      ["attribution"],
                                    ),
                                    language,
                                  )
                                : tr("경로 제공자 출처 확인 필요", "Routing source not recorded")}
                            </p>
                            {asRecord(
                              asRecord(option.continuityProof)
                                ?.weatherEvidence,
                            ) && (
                              <p className="route-attribution">
                                {tr("현재 기상 원자료", "Current weather source")} ·{" "}
                                {weatherSourceInfo(
                                  asRecord(asRecord(option.continuityProof)?.weatherEvidence),
                                  language,
                                ).url ? (
                                  <a
                                    href={weatherSourceInfo(
                                      asRecord(asRecord(option.continuityProof)?.weatherEvidence),
                                      language,
                                    ).url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {weatherSourceInfo(
                                      asRecord(asRecord(option.continuityProof)?.weatherEvidence),
                                      language,
                                    ).label}
                                  </a>
                                ) : (
                                  weatherSourceInfo(
                                    asRecord(asRecord(option.continuityProof)?.weatherEvidence),
                                    language,
                                  ).label
                                )}
                                {" · "}
                                {tr(
                                  "강수 여부는 이어가가 원자료에서 판정",
                                  "IEOGA derives precipitation status from the source data",
                                )}
                              </p>
                            )}
                            {/* `변경 일정 1개 / 잠금 보존 1 / 다음 예약 보존`
                                줄을 지웠다. 같은 사실을 바로 아래 `why` 문장이
                                이미 문장으로 말한다 — "다음 예약 '한빛탑'에
                                101분 여유를 두고 도착합니다", "'지금 있는 곳'
                                한 곳만 바꾸고 나머지 일정은 그대로 둡니다".
                                숫자만 적힌 줄은 그 문장을 요약하지 못하면서
                                자리만 차지하고, `잠금 보존 1`처럼 무엇의 1인지
                                알 수 없는 표기가 섞인다. */}
                            {option.scheduleDiff?.preservedWaypoints &&
                              option.scheduleDiff.preservedWaypoints.length >
                                0 && (
                                <ol className="waypoint-proof-list">
                                  {option.scheduleDiff.preservedWaypoints.map(
                                    (waypoint) => (
                                      <li
                                        key={
                                          waypoint.nodeId ?? waypoint.title
                                        }
                                      >
                                        <span>
                                          {waypoint.title ?? tr("보존 일정", "Preserved stop")}
                                        </span>
                                        <small>
                                          {formatIsoTime(
                                            waypoint.estimatedArrivalAt,
                                            language,
                                          )}
                                          {typeof waypoint.arrivalBufferMinutes ===
                                          "number"
                                            ? tr(
                                                ` 도착 · 여유 ${waypoint.arrivalBufferMinutes}분`,
                                                ` arrival · ${waypoint.arrivalBufferMinutes} min buffer`,
                                              )
                                            : tr(" 도착 검증", " arrival verified")}
                                        </small>
                                        <b>
                                          {waypoint.status === "preserved"
                                            ? tr("보존", "Preserved")
                                            : tr("재확인", "Re-check")}
                                        </b>
                                      </li>
                                    ),
                                  )}
                                </ol>
                              )}
                            {option.why && option.why.length > 0 && (
                              <ul className="why-list">
                                {(
                                  (language === "en" && option.whyEn) ||
                                  option.why ||
                                  []
                                ).map((reason) => (
                                  <li key={reason}>{reason}</li>
                                ))}
                              </ul>
                            )}
                            <div className="option-footer">
                              <span>
                                {language === "en" ? "Opening" : "운영 상태"} ·{" "}
                                {statusLabel(
                                  readText(asRecord(option.availability), [
                                    "status",
                                  ]),
                                  language,
                                )}
                              </span>
                              <div className="option-footer-actions">
                                <button
                                  type="button"
                                  className="apply-option-button"
                                  onClick={() => void applyRecoveryOption(option)}
                                  /* 적용은 서버와 화면에서 모두 fail-closed다.
                                     운영·경로·필수 조건 중 하나라도 확인되지
                                     않으면 설명은 보여 주되 실행 계약은 만들지
                                     않는다. */
                                  disabled={
                                    Boolean(applyingOptionId) ||
                                    !recoveryPersisted ||
                                    !recovery.requestId ||
                                    !option.id ||
                                    !optionApplicationSafety(option, language).canApply
                                  }
                                  aria-busy={applyingOptionId === option.id}
                                >
                                  {applyingOptionId === option.id
                                    ? language === "en"
                                      ? "Verifying active itinerary…"
                                      : "서버 활성 일정 확인 중…"
                                    : applyingOptionId
                                      ? language === "en"
                                        ? "Another itinerary is being applied"
                                        : "다른 일정 적용 확인 중"
                                    : appliedOptionId === option.id
                                    ? language === "en"
                                      ? "Currently applied"
                                      : "현재 적용 중"
                                    : !optionApplicationSafety(option, language).canApply
                                      ? language === "en"
                                        ? "Cannot apply until verified"
                                        : "안전 확인 전 적용 불가"
                                      : language === "en"
                                        ? "Continue with this itinerary"
                                        : "이 일정으로 이어가기"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void shareRecoveryOption(option)}
                                  disabled={
                                    Boolean(applyingOptionId) ||
                                    !recoveryPersisted ||
                                    !recovery.requestId ||
                                    !option.id ||
                                    !optionApplicationSafety(option, language).canApply
                                  }
                                >
                                  {shareMessages[option.id] ??
                                    (language === "en" ? "Share proof" : "결과 공유")}
                                </button>
                                <a
                                  href={`https://map.kakao.com/link/map/${encodeURIComponent(option.title)},${option.latitude},${option.longitude}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {language === "en" ? "Open map" : "지도 보기"}
                                  <span aria-hidden="true">↗</span>
                                </a>
                              </div>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                    {recovery.counterfactual?.title && (
                      <aside className="counterfactual-card">
                        <div>
                          {/* "최소 완화 반사실 증명"은 사람이 쓰는 말이 아니다.
                              뜻은 "조건 하나만 이만큼 풀면 갈 수 있는 곳"이다. */}
                          <span>
                            {tr(
                              "조건을 조금만 풀면 갈 수 있는 곳",
                              "Possible with one small condition change",
                            )}
                          </span>
                          <h3 lang={language === "en" ? "ko" : undefined}>
                            {recovery.counterfactual.title}
                          </h3>
                          {language === "en" && (
                            <small>KTO official Korean place name</small>
                          )}
                        </div>
                        <div>
                          <p>
                            {counterfactualReasonText(recovery.counterfactual, language)}
                          </p>
                          {recovery.counterfactual.requiredRelaxation?.description && (
                            <strong className="counterfactual-relaxation">
                              {relaxationDescriptionText(recovery.counterfactual, language)}
                            </strong>
                          )}
                          <small>
                            {tr(
                              "잠금 일정·다음 예약 보존 · 자동 적용하지 않음",
                              "Locked stops and next booking preserved · never applied automatically",
                            )}
                          </small>
                        </div>
                        <button
                          type="button"
                          onClick={applyCounterfactualRelaxation}
                          disabled={
                            !recovery.counterfactual.requiredRelaxation
                          }
                        >
                          {tr(
                            "이 한 조건만 적용해 재계산",
                            "Apply this one condition and verify again",
                          )}
                        </button>
                      </aside>
                    )}

                    <details className="decision-contribution">
                      <summary>{language === "en" ? "Why this place is safe to go" : "이 곳이 왜 안전한지 보기"}</summary>
                      <div className="decision-contribution-intro">
                        <span>{language === "en" ? "Why this place was chosen" : "이 곳을 고른 이유"}</span>
                        <h3>{language === "en" ? "What each data source decided" : "각 데이터가 바꾼 판단"}</h3>
                        <p>
                          {tr(
                            "어떤 데이터가 이 곳을 남기고 다른 곳을 제외했는지 그대로 보여 드립니다.",
                            "See which source kept this place, changed its order or excluded another option.",
                          )}
                        </p>
                      </div>
                      <ul>
                        {recovery.dataContributions && recovery.dataContributions.length > 0
                          ? recovery.dataContributions.map((contribution, index) => (
                              <li key={`${contribution.source ?? "source"}-${index}`}>
                                <strong>
                                  {contributionSourceText(contribution.source, language)}
                                </strong>
                                <span>{contributionDecisionText(contribution, language)}</span>
                                <b>
                                  {contributionEffectText(
                                    contribution.effect || contribution.status || "used",
                                    language,
                                  )}
                                </b>
                              </li>
                            ))
                          : (recovery.sourceLedger ?? []).map((source, index) => (
                              <li key={`${sourceName(source)}-effect-${index}`}>
                                <strong>
                                  {contributionSourceText(sourceName(source), language)}
                                </strong>
                                <span>
                                  {language === "en"
                                    ? "Used to verify or bound a required recovery condition."
                                    : sourceDecisionEffect(source)}
                                </span>
                                <b>{humanizeStatus(sourceStatus(source), language)}</b>
                              </li>
                            ))}
                      </ul>
                    </details>

                    <details className="source-ledger">
                      <summary>
                        {tr("요청·출처 원장 자세히 보기", "View request and source ledger")}
                      </summary>
                      <ul>
                        {(recovery.sourceLedger ?? []).map((source, index) => (
                          <li key={`${sourceName(source)}-${index}`}>
                            <span>{contributionSourceText(sourceName(source), language)}</span>
                            <b className={`status-badge ${statusTone(sourceStatus(source))}`}>
                              {humanizeStatus(sourceStatus(source), language)}
                            </b>
                          </li>
                        ))}
                      </ul>
                      <p>
                        {tr("요청 ID", "Request ID")} {recovery.requestId || tr("미제공", "not provided")} ·{" "}
                        {tr("생성 시각", "Generated")} {formatLocalizedDateTime(recovery.generatedAt, language)}
                      </p>
                    </details>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {activeTab === "discover" && (
          <section
            id="panel-discover"
            role="tabpanel"
            aria-labelledby="tab-discover"
            className="page-section"
          >
            <DiscoverWindowPanel
              language={language}
              origin={{
                latitude,
                longitude,
                areaCode,
                sigunguCode,
                label: originLabel,
              }}
              geoState={geoState}
              geoMessage={geoMessage}
              geoAttribution={geoAttribution}
              analyticsConsent={analyticsConsent}
              onRequestLocation={requestGeolocation}
              onResetLocation={resetLocationSelection}
              /* 직접 입력한 위치를 **이 화면에서 그대로 받는다.**
                 예전에는 여기서 복구 탭으로 화면을 바꿔 버려, 버튼을 누른
                 사용자가 지금 하려던 일과 입력한 조건을 함께 잃었다. 좌표
                 절삭·POST 전송·보관 정책은 요청을 만드는 쪽에 그대로 있으므로
                 개인정보 처리가 흩어지지 않는다. */
              onManualLocation={(place: ManualPlace) => {
                geolocationRequestGenerationRef.current += 1;
                setLatitude(String(place.latitude));
                setLongitude(String(place.longitude));
                setOriginLabel(place.title);
                setAreaCode(place.areaCode ?? "");
                setSigunguCode(place.sigunguCode ?? "");
                setLocationMode("manual");
                setGeoState("success");
                setGeoMessage(
                  `${place.title} 기준으로 찾습니다. 위치 권한은 쓰지 않았습니다.`,
                );
                setGeoAttribution(place.sourceLabel ?? "");
              }}
              /* 두 탭을 잇는 자리. "시간이 비었어요"에서 찾은 곳을 일정 초안의
                 **첫 방문지**로 넣고 복구 탭으로 넘긴다. 이후 지켜야 할 약속만
                 채우면 그 곳을 넣고도 약속을 지킬 수 있는지 바로 따져 볼 수
                 있다.

                 초안은 덮어쓰지 않고 **빈 자리부터 채운다.** 이미 적어 둔
                 일정을 이 버튼 한 번으로 지워 버리면, 되돌릴 방법이 없다. */
              onPlanFromPlace={(place) => {
                changeTab("recover");
                window.requestAnimationFrame(() => {
                  document
                    .getElementById("main-content")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
                const filled = journeyDraft.stops.filter((stop) =>
                  stop.title.trim(),
                );
                if (!filled.length) {
                  /* 빈 초안이면 물어볼 것이 없다. 다만 **첫 노드는 출발지다.**
                     여기에 고른 여행지를 넣으면 "지금 있는 곳에서 출발한다"는
                     전제가 깨져, 이동 시간이 0으로 잡힌다. 1번에 현재 위치를
                     두고 고른 곳은 2번에 넣는다. */
                  setJourneyDraft((previous) => {
                    const rest = previous.stops.slice(1);
                    return {
                      ...previous,
                      stops: [
                        {
                          ...previous.stops[0],
                          title: originLabel || "지금 있는 곳",
                          address: "",
                        },
                        makeStop({
                          title: place.title,
                          address: place.address,
                          type: stopTypeFromTourismContent(place.contentTypeId),
                        }),
                        ...rest,
                      ],
                    };
                  });
                  setJourneyEditing(true);
                  return;
                }
                setPlaceToPlan(place);
              }}
            />
          </section>
        )}

        {activeTab === "insights" && (
          <section
            id="panel-insights"
            aria-label={tr("지역 회복력 정책 정보", "Regional resilience policy")}
            className="page-section insights-section"
          >
            <PolicyMissionPanel className="policy-mission-embed" />
            <div hidden aria-hidden="true">
            <div className="section-intro">
              <p className="section-kicker">NATIONWIDE RESILIENCE INTELLIGENCE</p>
              <h1>여행자의 막힘을, 지역의 다음 정책으로.</h1>
              <p>
                전국 시도·시군구를 같은 기준으로 보되, 조회하지 않은 지역에는 점수를 만들지 않습니다.
                공개 가능한 실제 집계와 정책 OpenAPI 응답만 보여줍니다.
              </p>
            </div>

            <div className="insight-overview">
              <div>
                <span>광역권 범위</span>
                <strong>
                  {insightListState === "success" ? `${insightRegions.length}개` : "확인 중"}
                </strong>
                <small>현재 API 지역 코드 기준</small>
              </div>
              <div>
                <span>정책 데이터</span>
                <strong>4종</strong>
                <small>선택 지역을 온디맨드 조회</small>
              </div>
              <div>
                <span>공개 원칙</span>
                <strong>k ≥ 30</strong>
                <small>소규모 행동 재식별 방지</small>
              </div>
            </div>

            <div className="insight-workspace">
              <div className="region-board">
                <div className="board-heading">
                  <div>
                    <p>전국 현황판</p>
                    <h2>시도별 데이터 준비 상태</h2>
                  </div>
                  <span>점수 미생성 원칙</span>
                </div>

                {insightListState === "loading" && (
                  <div className="board-state" role="status">
                    <span className="loading-ring dark" aria-hidden="true" />
                    전국 지역 목록을 불러오는 중입니다.
                  </div>
                )}
                {insightListState === "error" && (
                  <div className="board-state is-error" role="alert">
                    <strong>전국 현황을 불러오지 못했습니다.</strong>
                    <p>{insightListError}</p>
                    <button type="button" onClick={loadInsightRegions} className="text-action">
                      다시 시도
                    </button>
                  </div>
                )}
                {insightListState === "success" && insightRegions.length === 0 && (
                  <div className="board-state">
                    <strong>공개할 수 있는 집계가 아직 없습니다.</strong>
                    <p>데이터 부족을 임의의 점수로 채우지 않습니다.</p>
                  </div>
                )}
                {insightListState === "success" && insightRegions.length > 0 && (
                  <div className="region-grid" data-testid="insight-region-grid">
                    {insightRegions.map((region) => (
                      <button
                        type="button"
                        key={region.code}
                        className={insightAreaCode === region.code ? "region-tile is-selected" : "region-tile"}
                        onClick={() => changeInsightArea(region.code)}
                        aria-pressed={insightAreaCode === region.code}
                      >
                        <span>{region.name}</span>
                        <b className={`status-badge ${statusTone(region.status)}`}>
                          {humanizeStatus(region.status)}
                        </b>
                        <small>
                          커버리지{" "}
                          {region.coverage === undefined || region.coverage === null
                            ? "조회 전"
                            : formatCoverage(region.coverage)}
                        </small>
                        <i>{region.sourceDate ? formatDate(region.sourceDate) : "기준일 미제공"}</i>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <aside className="insight-query">
                <p className="section-kicker">LIVE POLICY QUERY</p>
                <h2>지역 실데이터 불러오기</h2>
                <p>
                  선택한 지역에서만 정책 OpenAPI 4종을 호출합니다. 아직 조회하지 않은 지역은
                  &lsquo;조회 전&rsquo;으로 남습니다.
                </p>
                <label>
                  <span>시도</span>
                  <select
                    value={insightAreaCode}
                    onChange={(event) => changeInsightArea(event.target.value)}
                    data-testid="insight-region-select"
                  >
                    <option value="">시도를 선택하세요</option>
                    {insightRegions.map((region) => (
                      <option key={region.code} value={region.code}>
                        {region.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>시군구 <i>선택</i></span>
                  <select
                    value={insightSigunguCode}
                    onChange={(event) => {
                      setInsightSigunguCode(event.target.value);
                      setInsightDetail(null);
                      setInsightDetailState("idle");
                    }}
                    disabled={!insightAreaCode || insightDistrictState === "loading"}
                  >
                    <option value="">
                      {insightDistrictState === "loading" ? "불러오는 중…" : "시도 전체"}
                    </option>
                    {insightDistricts.map((district) => (
                      <option key={district.code} value={district.code}>
                        {district.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="primary-action light"
                  onClick={loadInsightDetail}
                  disabled={!insightAreaCode || insightDetailState === "loading"}
                  data-testid="load-insight-detail"
                >
                  {insightDetailState === "loading" ? "정책 API 확인 중…" : "실데이터 불러오기"}
                  <span aria-hidden="true">→</span>
                </button>
              </aside>
            </div>

            <div className="policy-result" aria-live="polite" data-testid="insight-detail">
              <div className="board-heading">
                  <div>
                    <p>선택 지역 정책 진단</p>
                  <h2>
                    {selectedInsightRegion?.name ?? "지역을 선택하세요"}
                    {insightSigunguCode
                      ? ` ${insightDistricts.find((item) => item.code === insightSigunguCode)?.name ?? ""}`
                      : ""}
                  </h2>
                </div>
                <span>
                  {insightDetailState === "success"
                    ? formatReferenceDate(
                        readText(insightDetail, ["baseYm", "sourceDate", "generatedAt", "updatedAt"]) ||
                          undefined,
                      )
                    : "조회 전"}
                </span>
              </div>

              {insightDetailState === "idle" && (
                <div className="policy-empty">
                  <strong>아직 정책 데이터를 조회하지 않았습니다.</strong>
                  <p>위에서 지역을 선택하고 실데이터 불러오기를 눌러 주세요.</p>
                </div>
              )}
              {insightDetailState === "loading" && (
                <div className="policy-empty" role="status">
                  <span className="loading-ring dark" aria-hidden="true" />
                  <strong>정책 OpenAPI 4종을 확인하고 있습니다.</strong>
                  <p>응답이 없는 항목은 데이터 부족으로 분리합니다.</p>
                </div>
              )}
              {insightDetailState === "error" && (
                <div className="policy-empty is-error" role="alert">
                  <strong>이 지역의 정책 데이터를 불러오지 못했습니다.</strong>
                  <p>{insightDetailError}</p>
                </div>
              )}
              {insightDetailState === "success" && insightDetail && (
                <>
                  <div className="policy-summary">
                    <div>
                      <span>응답 상태</span>
                      <strong>{humanizeStatus(insightDetail.status)}</strong>
                    </div>
                    <div>
                      <span>실데이터 커버리지</span>
                      <strong>
                        {typeof insightCoverage?.percent === "number"
                          ? `${Math.round(insightCoverage.percent as number)}%`
                          : formatCoverage(insightDetail.coverage)}
                      </strong>
                    </div>
                    <div>
                      <span>정책 기준월</span>
                      <strong>
                        {formatReferenceDate(readText(insightDetail, ["baseYm"]) || undefined)}
                      </strong>
                    </div>
                    <div>
                      <span>확인된 지역 허브</span>
                      <strong>{insightHubs.length ? `${insightHubs.length}개 표시` : "데이터 부족"}</strong>
                    </div>
                    {readText(insightCoverage, ["meaning"]) && (
                      <p>{readText(insightCoverage, ["meaning"])}</p>
                    )}
                  </div>
                  <div className="policy-source-grid">
                    {POLICY_APIS.map((api) => {
                      const matched = insightSources.find((source) =>
                        sourceName(source).toLowerCase().includes(api.id.toLowerCase()),
                      );
                      return (
                        <article key={api.id}>
                          <span>{api.label}</span>
                          <strong>{matched ? humanizeStatus(sourceStatus(matched)) : "데이터 부족"}</strong>
                          <small>{api.use}</small>
                        </article>
                      );
                    })}
                  </div>
                  {insightMetrics.length > 0 ? (
                    <div className="metric-grid">
                      {insightMetrics.map((metric) => (
                        <dl key={metric.key}>
                          <dt>{metric.label}</dt>
                          <dd>
                            {compactValue(metric.value)}
                            {metric.meta && <small>{metric.meta}</small>}
                          </dd>
                        </dl>
                      ))}
                    </div>
                  ) : (
                    <div className="policy-empty compact">
                      <strong>공개 가능한 수치가 없습니다.</strong>
                      <p>데이터 부족을 평균값이나 임의 점수로 대체하지 않았습니다.</p>
                    </div>
                  )}
                  {insightHubs.length > 0 && (
                    <div className="hub-section">
                      <div>
                        <p>지역 관광 허브</p>
                        <h3>실제 데이터 상위 거점</h3>
                      </div>
                      <ol>
                        {insightHubs.map((hub) => (
                          <li key={`${hub.rank}-${hub.name}`}>
                            <b>{hub.rank}</b>
                            <span>
                              <strong>{hub.name}</strong>
                              <small>{hub.category}</small>
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {Array.isArray(insightDetail.warnings) && insightDetail.warnings.length > 0 && (
                    <div className="notice is-warning">
                      <strong>해석 시 주의</strong>
                      {insightDetail.warnings.map((warning, index) => (
                        <p key={`${compactValue(warning)}-${index}`}>{compactValue(warning)}</p>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            </div>
          </section>
        )}

        {activeTab === "transparency" && (
          <section
            id="panel-transparency"
            aria-labelledby="transparency-title"
            className="page-section transparency-section"
          >
            <div className="section-intro">
              <p className="section-kicker">{language === "en" ? "Data sources" : "데이터 출처"}</p>
              <h1 id="transparency-title">
                {language === "en"
                  ? "Evidence first, recommendation second."
                  : "추천보다 먼저, 근거를 공개합니다."}
              </h1>
              <p>
                {language === "en"
                  ? "IEOGA uses only Korea Tourism Organization OpenAPI responses and the rules stated here. When a connection drops or a condition cannot be checked, we say so instead of filling the gap with a guess."
                  : "이어가는 한국관광공사 OpenAPI 응답과 여기 적은 규칙만 사용합니다. 연결이 끊기거나 확인할 수 없는 조건은 추정값으로 메우지 않고 그대로 알려 드립니다."}
              </p>
            </div>

            <div className="health-banner">
              <div>
                <span className={`health-dot ${statusTone(health?.overall)}`} aria-hidden="true" />
                <div>
                  <p>{language === "en" ? "Service readiness" : "서비스 준비 상태"}</p>
                  <strong>
                    {healthState === "loading"
                      ? tr(
                          "운영 점검 기록을 불러오는 중",
                          "Loading the latest readiness check",
                        )
                      : healthState === "error"
                        ? tr("지금은 확인할 수 없음", "Unavailable right now")
                        : humanizeStatus(health?.overall, language)}
                  </strong>
                  <small>
                    {health?.checkedAt
                      ? tr(
                          `마지막 운영 점검 ${formatDate(health.checkedAt)}${health.stale ? " · 오래된 점검" : ""}`,
                          `Last readiness check ${formatDate(health.checkedAt, "en")}${health.stale ? " · stale" : ""}`,
                        )
                      : tr(
                          "아직 저장된 운영 점검이 없습니다.",
                          "No saved readiness check is available yet.",
                        )}
                  </small>
                </div>
              </div>
              <button type="button" onClick={loadHealth} disabled={healthState === "loading"}>
                {tr("저장 상태 다시 불러오기", "Reload readiness status")}
              </button>
            </div>
            {healthError && (
              <div className="notice is-error" role="alert">
                <strong>
                  {tr(
                    "운영 점검 기록을 지금 불러오지 못했습니다. 여행 복구 기능은 그대로 사용할 수 있습니다.",
                    "The readiness record is unavailable right now. Trip recovery remains available.",
                  )}
                </strong>
                <p>
                  {travelerErrorText(
                    healthError ? new Error(healthError) : undefined,
                    language,
                    "The readiness check did not return a usable response.",
                    "연결 상태를 확인하지 못했습니다.",
                  )}
                </p>
              </div>
            )}

            <LaunchEvidencePanel language={language} />

            <div className="api-board" data-testid="health-source-list">
              <div className="board-heading">
                <div>
                  <p>{language === "en" ? "Official data" : "공식 데이터 연결"}</p>
                  <h2>
                    {language === "en"
                      ? "8 Korea Tourism Organization OpenAPIs"
                      : "한국관광공사 OpenAPI 8종"}
                  </h2>
                </div>
                <span>
                  {language === "en"
                    ? "Raw responses are not stored — only derived evidence"
                    : "원문 응답은 저장하지 않고 파생 근거만 기록합니다"}
                </span>
              </div>
              <div className="api-list">
                {OPEN_APIS.map((api, index) => {
                  const matched = health?.sources?.find((source) =>
                    sourceName(source).toLowerCase().includes(api.id.toLowerCase()),
                  );
                  /* 점검 기록을 못 불러온 것과 공사 API가 오류인 것은 다른
                     사실이다. 이전에는 전자를 후자로 표시해, 8종이 정상인데도
                     전부 `오류`로 보였다. 확인하지 못했으면 확인하지 못했다고
                     쓴다. 제3자의 상태를 근거 없이 단정하지 않는다. */
                  const currentStatus =
                    healthState === "error"
                      ? "unknown"
                      : matched
                        ? sourceStatus(matched)
                        : undefined;
                  return (
                    <article key={api.id}>
                      <span className="api-index">{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{language === "en" ? api.labelEn : api.label}</strong>
                        <code>{api.id}</code>
                      </div>
                      <p>{language === "en" ? api.useEn : api.use}</p>
                      <b className={`status-badge ${statusTone(currentStatus)}`}>
                        {healthState === "loading"
                          ? tr("확인 중", "Checking")
                          : humanizeStatus(currentStatus, language)}
                      </b>
                    </article>
                  );
                })}
              </div>
            </div>

            <div className="principle-grid">
              <article>
                <span>01</span>
                <h2>{tr("없는 후보를 만들지 않습니다", "Never invent an option")}</h2>
                <p>
                  {tr(
                    "필수 조건을 통과한 후보가 0개라면 0개라고 답합니다. 데이터가 줄면 신뢰도가 높아지지 않으며, 확인되지 않은 정보는 적용 가능으로 표시하지 않습니다.",
                    "If no place passes every required condition, IEOGA returns zero options. Missing data never raises confidence, and an unverified place is never marked as applicable.",
                  )}
                </p>
              </article>
              <article>
                <span>02</span>
                <h2>{tr("정확한 위치를 저장하지 않습니다", "Do not retain your live location")}</h2>
                <p>
                  {tr(
                    "현재 좌표는 주변 후보를 찾는 한 번의 요청에서만 사용합니다. 데이터베이스, 분석 로그, 정책 대시보드에는 정확한 좌표나 이동 경로를 남기지 않습니다.",
                    "Live coordinates are used only for the current nearby search. Exact coordinates and routes are excluded from the database, analytics logs and policy dashboard.",
                  )}
                </p>
              </article>
              <article>
                <span>03</span>
                <h2>{tr("추정과 사실을 구분합니다", "Separate facts from estimates")}</h2>
                <p>
                  {tr(
                    "관광지 정보는 출처와 기준일을 표시하고, 이동 경로는 경로 제공자의 구간별 근거와 확인 시각을 함께 표시합니다. 응답이 없으면 도착 가능을 단정하지 않습니다.",
                    "Attraction facts include their source and reference date. Routes show segment evidence and calculation time. Without a provider response, IEOGA never claims that arrival is feasible.",
                  )}
                </p>
              </article>
            </div>

            <div
              className="data-flow"
              aria-label={tr("데이터 처리 흐름", "Data-processing flow")}
            >
              <div>
                <span>{tr("요청", "Request")}</span>
                <strong>{tr("현재 위치·여행 조건", "Live location and trip conditions")}</strong>
                <small>{tr("메모리에서만 처리", "Processed in memory only")}</small>
              </div>
              <i aria-hidden="true">→</i>
              <div>
                <span>{tr("검증", "Verify")}</span>
                <strong>{tr("OpenAPI 8종·하드 필터", "8 OpenAPIs and hard filters")}</strong>
                <small>{tr("불확실성 분리", "Uncertainty kept explicit")}</small>
              </div>
              <i aria-hidden="true">→</i>
              <div>
                <span>{tr("결과", "Result")}</span>
                <strong>{tr("적용 가능 후보·근거", "Applicable options and evidence")}</strong>
                <small>{tr("요청 ID로 재현", "Traceable by request ID")}</small>
              </div>
              <i aria-hidden="true">→</i>
              <div>
                <span>{tr("정책 집계", "Policy aggregate")}</span>
                <strong>{tr("시군구·시간대 단위", "District and time-window level")}</strong>
                <small>{tr("k ≥ 30만 공개", "Published only when k ≥ 30")}</small>
              </div>
            </div>

            <div className="legal-grid">
              <article id="privacy">
                <p className="section-kicker">PRIVACY</p>
                <h2>{tr("개인정보 처리 원칙", "Privacy principles")}</h2>
                <ul>
                  <li>
                    {tr(
                      "정확한 현재 위치는 저장하지 않지만 행정구역·경로·날씨 확인을 위해 관련 제공자에 일시 전송됩니다.",
                      "Your exact live location is not retained, but is sent temporarily to the providers needed to resolve the district, route and weather.",
                    )}
                  </li>
                  <li>
                    {tr(
                      "사용자가 저장한 일정 장소 좌표는 여행 복구를 위해 세션에 보관하며, 내 데이터 삭제 또는 보관기간 만료 시 삭제합니다.",
                      "Coordinates for places you explicitly save in an itinerary remain in the session for recovery, then are deleted on request or expiry.",
                    )}
                  </li>
                  <li>{tr("유아차·휠체어·고령자 조건은 추천 필터이며 건강정보로 추론하지 않습니다.", "Stroller, wheelchair and older-traveller selections are recommendation filters and are never used to infer health information.")}</li>
                  <li>{tr("정책 통계는 시군구·시간대 단위로 일반화하고 30건 미만 집계는 공개하지 않습니다.", "Policy statistics are generalized to district and time windows; aggregates below 30 records are not published.")}</li>
                  <li>{tr("선택 동의가 없는 분석 식별자를 만들지 않으며, 만료된 익명 세션은 삭제합니다.", "No analytics identifier is created without opt-in consent, and expired anonymous sessions are deleted.")}</li>
                </ul>
              </article>
              <article id="terms">
                <p className="section-kicker">TERMS</p>
                <h2>{tr("이용 시 확인사항", "Before you rely on a result")}</h2>
                <ul>
                  <li>{tr("관광지 운영시간·휴무·현장 접근성은 방문 전 해당 시설에서 최종 확인해야 합니다.", "Confirm opening hours, closure notices and on-site accessibility with the venue before visiting.")}</li>
                  <li>
                    {tr(
                      "이동 시간은 경로 제공자의 응답과 확인 시각을 표시하며, 응답이 없거나 오래되면 도착 가능을 보증하지 않습니다.",
                      "Travel times identify the routing provider and calculation time. A missing or stale response never guarantees arrival.",
                    )}
                  </li>
                  <li>{tr("이어가는 예약·결제·운송을 제공하지 않으며 여행 중 의사결정을 돕는 정보 서비스입니다.", "IEOGA is an information service for travel decisions; it does not provide booking, payment or transport.")}</li>
                  <li>{tr("OpenAPI 장애 또는 데이터 부족 시 일부 기능이 제한될 수 있으며 이를 화면에 표시합니다.", "OpenAPI outages or data gaps can limit a feature, and that limitation is shown in the interface.")}</li>
                </ul>
              </article>
            </div>
          </section>
        )}
      </main>

      {/* 모바일 내비게이션은 **데스크톱 탭과 같은 것**을 가리킨다.
          예전에는 여기서 `/flow`·`/policy`·`/sources` 세 라우트로 보냈고,
          탭 바(`.desktop-nav`)는 821px 미만에서 숨겨져 있었다. 그래서 휴대폰
          사용자는 `지금 갈 곳 찾기`로 갈 방법이 아예 없었고, 대신 여행자 화면에서
          뺀 `지역 회복력`이 하단에 남아 있었다. 화면 크기에 따라 있는 기능이
          달라지면 그건 다른 앱이다.

          하단 고정 바라는 형태는 유지한다 — 엄지로 닿는 위치가 휴대폰에서
          맞다. 바뀌는 것은 무엇을 가리키느냐뿐이다. */}
      <nav
        className="mobile-nav"
        aria-label={language === "en" ? "Main menu" : "주요 메뉴"}
      >
        <button
          type="button"
          className={activeTab === "recover" ? "is-active" : ""}
          aria-current={activeTab === "recover" ? "page" : undefined}
          onClick={() => changeTab("recover")}
          data-testid="mobile-nav-recover"
        >
          <span aria-hidden="true">↗</span>
          {language === "en" ? "My plan broke" : "일정이 틀어졌어요"}
        </button>
        <button
          type="button"
          className={activeTab === "discover" ? "is-active" : ""}
          aria-current={activeTab === "discover" ? "page" : undefined}
          onClick={() => changeTab("discover")}
          data-testid="mobile-nav-discover"
        >
          <span aria-hidden="true">◷</span>
          {language === "en" ? "I have free time" : "시간이 비었어요"}
        </button>
      </nav>

      <footer className="product-footer">
        <div>
          <a className="product-brand compact" href="/">
            <span className="product-brand-mark" aria-hidden="true">
              이
            </span>
            <span>
              <strong>이어가</strong>
              <small>
                {language === "en"
                  ? "Keep what matters when travel changes"
                  : "여행이 흔들려도, 목적은 이어지도록"}
              </small>
            </span>
          </a>
          <p>
            {language === "en"
              ? "Built on Korea Tourism Organization OpenAPI — keeps your next booking when a stop breaks"
              : "한국관광공사 OpenAPI로 다음 예약을 지키는 여행 복구 서비스"}
          </p>
        </div>
        <div className="footer-links">
          <a href="/privacy">
            {language === "en" ? "Privacy" : "개인정보 처리방침"}
          </a>
          <a href="/terms">{language === "en" ? "Terms" : "이용약관"}</a>
          <a href="/accessibility">
            {language === "en" ? "Accessibility" : "접근성 안내"}
          </a>
          <button type="button" onClick={() => changeTab("transparency")}>
            {language === "en" ? "Data sources" : "데이터 출처"}
          </button>
          <a href="/policy">
            {language === "en"
              ? "For local governments"
              : "지자체·기관용 개선 과제"}
          </a>
          <a
            href="#launch-evidence"
            onClick={(event) => {
              event.preventDefault();
              changeTab("transparency");
              window.setTimeout(() => {
                document
                  .getElementById("launch-evidence")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }, 30);
            }}
          >
            {language === "en" ? "Service readiness" : "서비스 준비 현황"}
          </a>
        </div>
        <small>© 2026 IEOGA. Data provided by Korea Tourism Organization.</small>
      </footer>
    </div>
  );
}
