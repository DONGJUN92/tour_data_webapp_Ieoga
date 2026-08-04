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
import DiscoverWindowPanel from "./DiscoverWindowPanel";
import { RouteMap, type RouteMapMarker, type RoutePoint } from "./RouteMap";
import { ActiveJourneyCockpit } from "./ActiveJourneyCockpit";
import { LaunchEvidencePanel } from "./LaunchEvidencePanel";
import { PolicyMissionPanel } from "./PolicyMissionPanel";
import { SimulationGuide } from "./SimulationGuide";

import {
  AUDIENCES,
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
  RecoveryOutcome,
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
  formatDayOnly,
  formatIsoTime,
  formatMetricLabel,
  formatReferenceDate,
  formatStopTime,
  humanizeStatus,
  inferRecoveryContext,
  itineraryContract,
  makeStop,
  minutesUntil,
  normalizeDistricts,
  normalizeJourneyExecution,
  normalizeJourneyPlan,
  normalizePlaceResults,
  normalizeRegions,
  parseKoreaCoordinate,
  practiceJourneySchedule,
  readText,
  sourceDecisionEffect,
  sourceName,
  sourceStatus,
  statusTone,
  stopTypeFromTourismContent,
  todayInKorea,
  fetchJson,
} from "./product-app-model";
import { quotedWithParticle, withParticle } from "@/lib/text/korean";
import { statusLabel } from "@/lib/text/status-labels";

export function ProductApp() {
  const [activeTab, setActiveTab] = useState<TabId>("recover");
  const [language, setLanguage] = useState<Language>("ko");
  const [regions, setRegions] = useState<Region[]>([]);
  const [regionState, setRegionState] = useState<LoadState>("loading");
  const [regionError, setRegionError] = useState("");

  const [journeyDraft, setJourneyDraft] = useState<JourneyPlan>(emptyJourneyDraft);
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
  const [placeKeyword, setPlaceKeyword] = useState("");
  const [placeSearchState, setPlaceSearchState] = useState<LoadState>("idle");
  const [placeSearchError, setPlaceSearchError] = useState("");
  const [placeResults, setPlaceResults] = useState<PlaceSearchResult[]>([]);
  const originSelectionCurrent = Boolean(
    latitude.trim() &&
      longitude.trim() &&
      geoState === "success" &&
      (locationMode === "automatic" ||
        (locationMode === "manual" &&
          placeKeyword.trim() === originLabel.trim())),
  );
  const [incident, setIncident] = useState<Incident>("rain");
  const [availableMinutes, setAvailableMinutes] = useState(90);
  const [travelMode, setTravelMode] = useState<TravelMode>("walk");
  const [safetyBufferMinutes, setSafetyBufferMinutes] = useState(15);
  const [minimumStayMinutes, setMinimumStayMinutes] = useState(30);
  const [maxDistanceMeters, setMaxDistanceMeters] = useState(2500);
  const [radiusMeters, setRadiusMeters] = useState(5000);
  const [audience, setAudience] = useState<Audience>("general");
  /* 우천이면 실내 조건을 기본으로 켠다. 엔진이 더 이상 우천을 이유로 실내를
     강제하지 않으므로(명시적으로 보낸 값이 이긴다) 그 기본값을 화면이 만들어야
     한다. 사용자가 끄면 그 선택이 유지되며, 그때 비로소 실외 후보까지 검토된다. */
  const [indoorOnly, setIndoorOnly] = useState(false);
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
  const [shareMessages, setShareMessages] = useState<Record<string, string>>({});
  const [appliedOptionId, setAppliedOptionId] = useState("");
  const [recoveryOutcome, setRecoveryOutcome] = useState<RecoveryOutcome>("idle");
  const [outcomeMessage, setOutcomeMessage] = useState("");
  const [showAllOptions, setShowAllOptions] = useState(false);
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
          setRecoveryOutcome(
            execution.status === "contract_met" ? "arrived" : "applied",
          );
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
    () =>
      journeyPlan && selectedNextFixedStop
        ? minutesUntil(journeyPlan.date, selectedNextFixedStop.time)
        : null,
    [journeyPlan, selectedNextFixedStop],
  );

  useEffect(() => {
    if (!journeyPlan || !affectedStopId) return;
    if (!eligibleNextFixedStops.some((stop) => stop.id === nextFixedStopId)) {
      setNextFixedStopId(eligibleNextFixedStops[0]?.id ?? "");
    }
  }, [journeyPlan, affectedStopId, eligibleNextFixedStops, nextFixedStopId]);

  useEffect(() => {
    if (nextAppointmentMinutes === null) return;
    setAvailableMinutes(
      Math.min(240, Math.max(15, nextAppointmentMinutes - safetyBufferMinutes)),
    );
  }, [nextAppointmentMinutes, safetyBufferMinutes, nextFixedStopId]);

  function dismissSimulationGuide() {
    window.localStorage.setItem(GUIDE_STORAGE_KEY, "seen");
    setGuideOpen(false);
  }

  async function findPracticePlace(
    keywords: string[],
  ): Promise<PlaceSearchResult> {
    for (const keyword of keywords) {
      try {
        const payload = await fetchJson(
          `/api/v1/places/search?keyword=${encodeURIComponent(
            keyword,
          )}&purpose=saved_stop&fallback=auto`,
        );
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
        title: "이어가 사용 연습",
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
            reservationCode: "연습용 고정 일정",
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
        error instanceof Error
          ? error.message
          : "실제 장소를 불러오지 못했습니다.",
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
      setJourneyPlaceError("장소명을 두 글자 이상 입력한 뒤 확인해 주세요.");
      return;
    }
    setJourneyPlaceState("loading");
    try {
      const payload = await fetchJson(
        `/api/v1/places/search?keyword=${encodeURIComponent(keyword)}&purpose=saved_stop&fallback=${fallback}`,
      );
      const next = normalizePlaceResults(payload).slice(0, 8);
      setJourneyPlaceResults(next);
      setJourneyPlaceState("success");
    } catch (error) {
      setJourneyPlaceState("error");
      setJourneyPlaceError(
        error instanceof Error ? error.message : "공식 관광지 정보를 확인하지 못했습니다.",
      );
    }
  }

  function selectJourneyStopPlace(stopId: string, place: PlaceSearchResult) {
    if (place.retention === "ephemeral") {
      setJourneyPlaceState("error");
      setJourneyPlaceError(
        "이 검색 결과는 현재 위치 확인에만 사용할 수 있습니다. 저장 가능한 주소 결과를 선택해 주세요.",
      );
      return;
    }
    const currentStop = journeyDraft.stops.find(
      (stop) => stop.id === stopId,
    );
    updateJourneyStop(stopId, {
      title: place.title,
      address: place.address ?? "",
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
      setJourneyError("여행 이름과 날짜를 입력해 주세요.");
      return;
    }
    if (completeStops.length < 2) {
      setJourneyError("원래 일정과 다음 일정을 포함해 두 개 이상의 일정을 입력해 주세요.");
      return;
    }
    const stopWithoutLocation = completeStops.find(
      (stop) =>
        typeof stop.latitude !== "number" ||
        typeof stop.longitude !== "number",
    );
    if (stopWithoutLocation) {
      setJourneyError(
        `${quotedWithParticle(stopWithoutLocation.title, "을/를")} 장소 검색 결과에서 선택해 주세요.`,
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
      setJourneyError("반드시 지켜야 할 예약 또는 고정 일정 하나 이상을 잠가 주세요.");
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
        "변경 가능한 일정 뒤에 도착해야 할 예약 또는 고정 일정을 배치해 주세요.",
      );
      return;
    }
    if (
      typeof nextFixed.latitude !== "number" ||
      typeof nextFixed.longitude !== "number"
    ) {
      setJourneyError(
        "다음 고정 일정의 도착 가능성을 계산하려면 장소검색 결과에서 위치를 선택해 주세요.",
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
    } catch (error) {
      setJourneySaveState("error");
      setJourneyError(
        error instanceof Error ? error.message : "여행 일정을 저장하지 못했습니다.",
      );
    }
  }

  async function deleteMyData() {
    if (
      !window.confirm(
        "이 기기에 연결된 일정과 복구 기록을 삭제할까요? 삭제한 기록은 되돌릴 수 없습니다.",
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
      setRecoveryOutcome("idle");
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
    const tabs: TabId[] = ["recover", "discover", "insights", "transparency"];
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
    setGeoMessage("");
    setGeoAttribution("");
    if (!navigator.geolocation) {
      setLocationMode("manual");
      setGeoState("error");
      setGeoMessage("이 브라우저에서는 현재 위치 기능을 지원하지 않습니다. 장소를 직접 입력해 주세요.");
      return;
    }
    setGeoState("loading");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextLatitude = position.coords.latitude.toFixed(5);
        const nextLongitude = position.coords.longitude.toFixed(5);
        setLatitude(nextLatitude);
        setLongitude(nextLongitude);
        setGeoMessage("현재 위치의 행정구역을 확인하고 있습니다.");
        void fetchJson("/api/v1/location/resolve", {
          method: "POST",
          body: JSON.stringify({
            latitude: Number(nextLatitude),
            longitude: Number(nextLongitude),
          }),
        })
          .then((payload) => {
            const record = asRecord(payload);
            const resolved = asRecord(record?.location) ?? asRecord(record?.data) ?? record;
            const resolvedAreaCode = readText(resolved, ["areaCode", "regionCode"]);
            const resolvedDistrictCode = readText(resolved, ["sigunguCode", "districtCode"]);
            const areaName = readText(resolved, ["areaName", "regionName"]);
            const districtName = readText(resolved, ["districtName", "sigunguName"]);
            setAreaCode(resolvedAreaCode);
            setSigunguCode(resolvedDistrictCode);
            setOriginLabel(readText(resolved, ["label"]) || "내 현재 위치");
            setPlaceKeyword("");
            setPlaceResults([]);
            setGeoAttribution(readText(resolved, ["attribution"]));
            setLocationMode("automatic");
            setGeoState("success");
            setGeoMessage(
              `${withParticle([areaName, districtName].filter(Boolean).join(" ") || "현재 지역", "으로/로")} 자동 입력했어요. 정확한 좌표는 복구 계산에만 사용합니다.`,
            );
          })
          .catch(() => {
            setLocationMode("manual");
            setGeoState("error");
            setGeoMessage(
              "현재 위치는 확인했지만 행정구역을 자동 판별하지 못했습니다. 아래에서 장소를 직접 입력해 주세요.",
            );
          });
      },
      (error) => {
        setLocationMode("manual");
        setGeoState("error");
        setGeoMessage(
          error.code === error.PERMISSION_DENIED
            ? "위치 권한을 사용하지 않습니다. 아래에서 현재 장소를 직접 입력해 주세요."
            : "현재 위치를 확인하지 못했습니다. 아래에서 현재 장소를 직접 입력해 주세요.",
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 },
    );
  }

  function useManualLocation() {
    setLocationMode("manual");
    setGeoState("idle");
    setLatitude("");
    setLongitude("");
    setOriginLabel("");
    setPlaceKeyword("");
    setPlaceResults([]);
    setPlaceSearchState("idle");
    setGeoAttribution("");
    setGeoMessage("현재 장소명이나 주소를 검색해 주세요.");
  }

  async function searchOriginPlace(
    fallback: "auto" | "force" = "auto",
  ) {
    const keyword = placeKeyword.trim();
    setPlaceSearchError("");
    setPlaceResults([]);
    if (keyword.length < 2) {
      setPlaceSearchState("error");
      setPlaceSearchError("관광지명을 두 글자 이상 입력해 주세요.");
      return;
    }
    setLatitude("");
    setLongitude("");
    setOriginLabel("");
    setGeoState("idle");
    setPlaceSearchState("loading");
    const currentLatitude = parseKoreaCoordinate(latitude, 32, 39.8);
    const currentLongitude = parseKoreaCoordinate(longitude, 124, 132);
    const searchInput = {
      keyword,
      purpose: "current_origin",
      fallback,
      ...(areaCode ? { areaCode } : {}),
      ...(sigunguCode ? { sigunguCode } : {}),
      ...(currentLatitude !== undefined && currentLongitude !== undefined
        ? {
            latitude: currentLatitude,
            longitude: currentLongitude,
          }
        : {}),
    };
    try {
      const payload = await fetchJson("/api/v1/places/search", {
        method: "POST",
        body: JSON.stringify(searchInput),
      });
      const next = normalizePlaceResults(payload).slice(0, 10);
      setPlaceResults(next);
      setPlaceSearchState("success");
    } catch (error) {
      setPlaceSearchState("error");
      setPlaceSearchError(error instanceof Error ? error.message : "관광지를 검색하지 못했습니다.");
    }
  }

  function selectOriginPlace(place: PlaceSearchResult) {
    if (place.areaCode && place.areaCode !== areaCode) {
      setAreaCode(place.areaCode);
    }
    if (place.sigunguCode) setSigunguCode(place.sigunguCode);
    setLatitude(place.latitude.toFixed(6));
    setLongitude(place.longitude.toFixed(6));
    setOriginLabel(place.title);
    setPlaceKeyword(place.title);
    setLocationMode("manual");
    setPlaceResults([]);
    setPlaceSearchState("idle");
    setGeoState("success");
    setGeoAttribution(place.sourceLabel ?? "");
    setGeoMessage(
      `현재 위치를 ${quotedWithParticle(place.title, "으로/로")} 정했어요.${place.retention === "ephemeral" ? " 이 좌표는 일정에 저장하지 않습니다." : ""}`,
    );
  }

  async function submitRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecoverError("");
    if (!journeyPlan || !selectedAffectedStop || !selectedNextFixedStop) {
      setRecoverState("error");
      setRecoverError("먼저 원래 일정과 다음 고정 일정을 선택해 주세요.");
      return;
    }
    if (
      nextAppointmentMinutes !== null &&
      nextAppointmentMinutes <= safetyBufferMinutes
    ) {
      setRecoverState("error");
      setRecoverError(
        "다음 고정 일정까지 남은 시간이 안전 여유보다 짧습니다. 일정 시각을 확인하거나 긴급 지원을 이용해 주세요.",
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
        "현재 위치를 자동으로 확인하거나 장소명·주소 검색 결과에서 선택해 주세요.",
      );
      return;
    }
    if (
      !Number.isFinite(availableMinutes) ||
      availableMinutes < 15 ||
      availableMinutes > 240 ||
      !Number.isFinite(maxDistanceMeters) ||
      maxDistanceMeters < 300 ||
      maxDistanceMeters > 20000 ||
      !Number.isFinite(radiusMeters) ||
      radiusMeters < 500 ||
      radiusMeters > 20000 ||
      !Number.isFinite(minimumStayMinutes) ||
      minimumStayMinutes < 10 ||
      minimumStayMinutes > 180
    ) {
      setRecoverState("error");
      setRecoverError("시간은 15~240분, 최소 체류는 10~180분, 이동 거리는 300~20,000m, 탐색 반경은 500~20,000m로 입력해 주세요.");
      return;
    }

    setRecoverState("loading");
    setRecovery(null);
    setAppliedOptionId("");
    setShowAllOptions(false);
    setRecoveryOutcome("idle");
    setOutcomeMessage("");
    try {
      const payload = await fetchJson("/api/v1/recover", {
        method: "POST",
        body: JSON.stringify({
          origin: {
            latitude: lat,
            longitude: lng,
            label: originLabel.trim() || "사용자 지정 위치",
            areaCode: areaCode || undefined,
            sigunguCode: sigunguCode || undefined,
          },
          incident,
          availableMinutes,
          maxDistanceMeters,
          audience,
          indoorOnly,
          travelMode,
          disabledSources: disabledSources.length ? disabledSources : undefined,
          radiusMeters,
          safetyBufferMinutes,
          minimumStayMinutes,
          analyticsConsent,
          itinerary: itineraryContract(
            journeyPlan,
            selectedAffectedStop.id,
            selectedNextFixedStop.id,
          ),
        }),
      });
      const record = asRecord(payload);
      const persistence = asRecord(record?.persistence);
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
      setRecovery(response);
      setRecoverState("success");
      window.setTimeout(() => resultRef.current?.focus({ preventScroll: false }), 40);
    } catch (error) {
      setRecoverState("error");
      setRecoverError(error instanceof Error ? error.message : "여행 복구 요청에 실패했습니다.");
    }
  }

  function applyCounterfactualRelaxation() {
    const relaxation = recovery?.counterfactual?.requiredRelaxation;
    if (!relaxation || typeof relaxation.requiredLimit !== "number") {
      return;
    }
    if (relaxation.constraint === "maximum_distance") {
      setMaxDistanceMeters(relaxation.requiredLimit);
    } else if (relaxation.constraint === "available_time") {
      setAvailableMinutes(relaxation.requiredLimit);
    } else if (relaxation.constraint === "minimum_stay") {
      setMinimumStayMinutes(relaxation.requiredLimit);
    } else if (relaxation.constraint === "safety_buffer") {
      setSafetyBufferMinutes(relaxation.requiredLimit);
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
    if (
      option.confirmationRequired ||
      (option.evidenceGaps?.length ?? 0) > 0
    ) {
      setShareMessages((current) => ({
        ...current,
        [option.id]:
          language === "en"
            ? "Proof cannot be shared until every required condition is verified by official evidence."
            : "필수 조건의 공식 근거가 모두 확인되기 전에는 복구 증명을 공유할 수 없습니다.",
      }));
      return;
    }
    if (!originSelectionCurrent) {
      setRecoverState("error");
      setRecoverError(
        "현재 위치를 자동으로 확인하거나 검색 결과에서 장소를 다시 선택해 주세요.",
      );
      return;
    }
    if (!recovery?.requestId || !option.id || !recoveryPersisted) {
      setShareMessages((current) => ({
        ...current,
        [option.id]:
          "저장이 확인된 복구 실행만 공유할 수 있습니다. 복구를 다시 실행해 주세요.",
      }));
      return;
    }
    setShareMessages((current) => ({
      ...current,
      [option.id]: "공유 링크 생성 중",
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
      if (!relativeUrl) throw new Error("공유 링크를 확인하지 못했습니다.");
      const absoluteUrl = new URL(relativeUrl, window.location.origin).toString();
      const usedNativeShare = "share" in navigator;
      if (usedNativeShare) {
        await navigator.share({
          title: `이어가 · ${option.title}`,
          text: "내 원래 일정과 다음 예약을 지키는 여행 복구안입니다.",
          url: absoluteUrl,
        });
      } else {
        await navigator.clipboard.writeText(absoluteUrl);
      }
      setShareMessages((current) => ({
        ...current,
        [option.id]: usedNativeShare ? "공유 완료" : "7일 공유 링크 복사 완료",
      }));
    } catch (error) {
      setShareMessages((current) => ({
        ...current,
        [option.id]:
          error instanceof Error ? error.message : "공유 링크 생성 실패",
      }));
    }
  }

  async function recordRecoveryOutcome(
    option: RecoveryOption,
    event: "selected" | "applied" | "arrived" | "continued" | "abandoned",
  ) {
    if (
      (event === "selected" || event === "applied") &&
      (option.confirmationRequired ||
        (option.evidenceGaps?.length ?? 0) > 0)
    ) {
      setOutcomeMessage(
        language === "en"
          ? "This option cannot be applied until every required condition is verified by official evidence."
          : "필수 조건의 공식 근거가 모두 확인되기 전에는 이 복구안을 적용할 수 없습니다.",
      );
      return;
    }
    if (!recovery?.requestId || !option.id || !recoveryPersisted) {
      setOutcomeMessage(
        "저장이 확인된 복구 실행만 적용하거나 결과를 기록할 수 있습니다. 복구를 다시 실행해 주세요.",
      );
      return;
    }
    setOutcomeMessage("여행 연속성 기록을 저장하고 있습니다.");
    try {
      if (event === "applied") {
        const payload = await fetchJson(
          `/api/v1/recover/${encodeURIComponent(recovery.requestId)}/apply`,
          {
            method: "POST",
            body: JSON.stringify({ optionId: option.id }),
          },
        );
        const execution = normalizeJourneyExecution(payload);
        if (!execution) {
          throw new Error("적용된 복구 일정을 확인하지 못했습니다.");
        }
        setAppliedOptionId(option.id);
        setRecoveryOutcome("applied");
        setActiveExecution(execution);
        setOutcomeMessage(
          "복구 일정이 새 버전으로 저장되었습니다. 지금부터 순서대로 안내합니다.",
        );
        window.setTimeout(
          () => document
            .querySelector<HTMLElement>(".active-journey-cockpit")
            ?.focus({ preventScroll: false }),
          40,
        );
        return;
      }
      await fetchJson(
        `/api/v1/recover/${encodeURIComponent(recovery.requestId)}/outcome`,
        {
          method: "POST",
          body: JSON.stringify({
            optionId: option.id,
            event,
            reasonCode: event === "abandoned" ? "USER_REPORTED_NOT_ARRIVED" : undefined,
          }),
        },
      );
      if (event === "selected") {
        setAppliedOptionId(option.id);
        setRecoveryOutcome("applied");
        setOutcomeMessage("이 복구안을 현재 일정에 적용했습니다.");
        window.setTimeout(
          () => appliedPlanRef.current?.focus({ preventScroll: false }),
          40,
        );
      } else if (event === "arrived" || event === "continued") {
        setRecoveryOutcome("arrived");
        setOutcomeMessage("다음 고정 일정 도착을 확인했습니다. 여행이 이어졌습니다.");
      } else {
        setRecoveryOutcome("not_arrived");
        setOutcomeMessage(
          "도착하지 못한 원인을 기록했습니다. 같은 조건의 다음 복구 품질 개선에 반영됩니다.",
        );
      }
    } catch (error) {
      setOutcomeMessage(
        error instanceof Error
          ? error.message
          : "결과 기록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
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
            이
          </span>
          <span>
            <strong>이어가</strong>
            <small>{language === "en" ? "Keep your trip going" : "여행을 이어 주는 서비스"}</small>
          </span>
        </a>

        <nav
          className="desktop-nav"
          aria-label={language === "en" ? "Main navigation" : "주요 메뉴"}
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
            {language === "en" ? "Trip recovery" : "여행 복구"}
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
            {language === "en" ? "Free time now" : "지금 갈 곳 찾기"}
          </button>
          <button
            id="tab-insights"
            role="tab"
            aria-selected={activeTab === "insights"}
            aria-controls="panel-insights"
            tabIndex={activeTab === "insights" ? 0 : -1}
            className={activeTab === "insights" ? "is-active" : ""}
            onClick={() => changeTab("insights")}
            data-testid="nav-insights"
          >
            {language === "en" ? "Regional missions" : "지역 개선 미션"}
          </button>
          <button
            id="tab-transparency"
            role="tab"
            aria-selected={activeTab === "transparency"}
            aria-controls="panel-transparency"
            tabIndex={activeTab === "transparency" ? 0 : -1}
            className={activeTab === "transparency" ? "is-active" : ""}
            onClick={() => changeTab("transparency")}
            data-testid="nav-transparency"
          >
            {language === "en" ? "Data transparency" : "데이터 투명성"}
          </button>
        </nav>

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
          <a className="header-cta" href="/flow">
            {language === "en" ? "Recover now" : "지금 바로 복구"}
            <span aria-hidden="true">→</span>
          </a>
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
            {executionState === "loading" && (
              <div className="execution-loading" role="status">
                <span className="loading-ring dark" aria-hidden="true" />
                진행 중인 복구 여행을 확인하고 있습니다.
              </div>
            )}
            {activeExecution && (
              <ActiveJourneyCockpit
                execution={activeExecution}
                language={language}
                onChange={setActiveExecution}
                onCloseCompleted={() => {
                  setActiveExecution(null);
                  setAppliedOptionId("");
                  setRecovery(null);
                  setRecoverState("idle");
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
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
              <aside className="scope-card" aria-label="서비스 범위">
                <span className="scope-orbit" aria-hidden="true">
                  <i />
                  전국
                </span>
                <div>
                  <p>전국 시도·시군구</p>
                  <strong>
                    {regionState === "success" && regions.length
                      ? `${regions.length}개 광역권 연결`
                      : "관광정보 연결 중"}
                  </strong>
                  <small>지역 목록은 TourAPI 응답 기준으로 표시합니다.</small>
                </div>
              </aside>
            </div>

            <ol className="journey-steps" aria-label="이어가 사용 단계">
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
                저장된 여행 일정을 확인하고 있습니다.
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
                      편집 취소
                    </button>
                  )}
                </div>

                {practiceReady && (
                  <div className="practice-ready" role="status">
                    <span aria-hidden="true">✓</span>
                    <div>
                      <strong>실제 관광지로 연습 일정이 준비됐어요</strong>
                      <p>
                        장소와 시간은 자유롭게 바꿀 수 있어요. 아래의
                        ‘이 일정으로 여행 시작’을 누르면 실제 복구 흐름을
                        연습합니다.
                      </p>
                    </div>
                  </div>
                )}

                <details className="journey-advanced">
                  <summary>
                    오늘이 아니거나 이동 배려 설정이 필요해요
                  </summary>
                  <div className="journey-meta-grid">
                    <label>
                      <span>여행 이름 <i>필수</i></span>
                      <input
                        value={journeyDraft.title}
                        onChange={(event) =>
                          setJourneyDraft((current) => ({
                            ...current,
                            title: event.target.value,
                          }))
                        }
                        maxLength={60}
                        placeholder="예: 서울 미술관과 저녁 공연"
                        required
                      />
                    </label>
                    <label>
                      <span>여행 날짜 <i>필수</i></span>
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
                      <span>이동·접근성 조건</span>
                      <select
                        value={journeyDraft.audience}
                        onChange={(event) =>
                          setJourneyDraft((current) => ({
                            ...current,
                            audience: event.target.value as Audience,
                          }))
                        }
                      >
                        {AUDIENCES.map((item) => (
                          <option key={item.value} value={item.value}>
                            {language === "en"
                              ? AUDIENCES_EN[item.value]
                              : item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </details>

                <div className="schedule-builder">
                  <div className="schedule-builder-title">
                    <div>
                      <strong>원래 여행 일정</strong>
                      <span>순서대로 입력하고 예약·공연·교통편처럼 바꿀 수 없는 일정은 잠가 주세요.</span>
                    </div>
                    <button type="button" onClick={addJourneyStop}>
                      + 일정 추가
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
                                  ? "지금 문제가 생길 수 있는 일정"
                                  : "반드시 지켜야 할 다음 일정"}
                              </strong>
                              <span>
                                {index === 0
                                  ? "이 장소만 바꾸고 여행 목적은 유지해요."
                                  : "이어가가 이 시각까지 돌아오는 복구안만 보여줘요."}
                              </span>
                            </div>
                          )}
                          <div className="schedule-primary-fields">
                            <label>
                              <span>시각</span>
                              <input
                                type="time"
                                value={stop.time}
                                onChange={(event) =>
                                  updateJourneyStop(stop.id, { time: event.target.value })
                                }
                                required
                              />
                            </label>
                            <label>
                              <span>일정 유형</span>
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
                                <option value="visit">관광·방문</option>
                                <option value="reservation">예약·공연</option>
                                <option value="meal">식사</option>
                                <option value="transit">교통</option>
                                <option value="stay">숙소</option>
                                <option value="other">기타</option>
                              </select>
                            </label>
                            <label className="schedule-title-field">
                              <span>장소·일정명</span>
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
                                maxLength={80}
                                placeholder="예: 국립현대미술관 서울"
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
                                ? "장소 확인됨"
                                : journeyPlaceState === "loading" &&
                                    journeyPlaceStopId === stop.id
                                  ? "확인 중…"
                                  : "장소 찾기"}
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
                                <strong>이 일정 잠금</strong>
                                <small>복구안이 변경하거나 취소할 수 없습니다.</small>
                              </span>
                            </label>
                            {stop.address && <span className="verified-address">{stop.address}</span>}
                            {journeyDraft.stops.length > 2 && (
                              <button
                                type="button"
                                className="remove-stop"
                                onClick={() => removeJourneyStop(stop.id)}
                                aria-label={`${stop.title || `${index + 1}번 일정`} 삭제`}
                              >
                                삭제
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
                                <span>일치하는 장소를 찾지 못했습니다.</span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void searchJourneyStopPlace(
                                      stop.id,
                                      "force",
                                    )
                                  }
                                >
                                  주소·다른 지도에서 다시 찾기
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
                                        <strong>{place.title}</strong>
                                        <small>{place.address || "주소 정보 없음"}</small>
                                        {place.sourceLabel && (
                                          <small>{place.sourceLabel}</small>
                                        )}
                                      </span>
                                      <b>이 장소 선택</b>
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
                                찾는 장소가 없어요 · 주소로 더 찾기
                              </button>
                            )}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>

                {journeyError && (
                  <div className="notice is-error" role="alert">
                    <strong>일정을 저장할 수 없습니다.</strong>
                    <p>{journeyError}</p>
                  </div>
                )}
                <button
                  type="submit"
                  className="primary-action journey-save"
                  disabled={journeySaveState === "loading"}
                >
                  {journeySaveState === "loading"
                    ? "일정 잠금을 저장하는 중…"
                    : "이 일정으로 여행 시작"}
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
                      {formatDayOnly(journeyPlan.date)} · 잠긴 일정{" "}
                      {journeyPlan.stops.filter((stop) => stop.fixed).length}개
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
                      원래 일정 편집
                    </button>
                    <button
                      type="button"
                      className="danger-text"
                      onClick={() => void deleteMyData()}
                      disabled={deleteState === "loading"}
                    >
                      {deleteState === "loading" ? "삭제 중…" : "내 데이터 삭제"}
                    </button>
                  </div>
                </div>
                <ol className="saved-timeline">
                  {journeyPlan.stops.map((stop) => (
                    <li key={stop.id} className={stop.fixed ? "is-locked" : ""}>
                      <time>{formatStopTime(stop.time)}</time>
                      <span>
                        <strong>{stop.title}</strong>
                        <small>{stop.address || "위치 설명 없음"}</small>
                      </span>
                      <b>{stop.fixed ? "잠금" : "변경 가능"}</b>
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

            <div className="region-ribbon" aria-label="현재 연결된 전국 시도 범위">
              <span>전국 범위</span>
              <div>
                {regionState === "loading" && <small>시도 목록을 불러오는 중입니다.</small>}
                {regionState === "error" && <small>{regionError}</small>}
                {regionState === "success" &&
                  regions.map((region) => <b key={region.code}>{region.name}</b>)}
              </div>
            </div>

            <div className="service-grid" hidden={!journeyPlan || journeyEditing}>
              <form
                className="recovery-form"
                ref={recoveryFormRef}
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
                  <legend>이어갈 일정</legend>
                  {selectedAffectedStop && selectedNextFixedStop && (
                    <div className="continuity-contract">
                      <span>
                        <b>지금 변경할 곳</b>
                        <strong>{selectedAffectedStop.title}</strong>
                      </span>
                      <i aria-hidden="true">→</i>
                      <span className="is-locked">
                        <b>반드시 도착</b>
                        <strong>{selectedNextFixedStop.title}</strong>
                      </span>
                      <small>
                        {nextAppointmentMinutes === null
                          ? "남은 시간 계산 전"
                          : nextAppointmentMinutes > 0
                            ? `${nextAppointmentMinutes}분 후 · 안전 여유 ${safetyBufferMinutes}분`
                            : "고정 일정 시각이 지났습니다."}
                      </small>
                    </div>
                  )}
                  <details className="context-adjustment">
                    <summary>다른 일정 구간 선택</summary>
                    <div className="field-grid two">
                    <label>
                      <span>문제가 생긴 일정 <i>필수</i></span>
                      <select
                        value={affectedStopId}
                        onChange={(event) => setAffectedStopId(event.target.value)}
                        required
                      >
                        <option value="">일정을 선택하세요</option>
                        {journeyPlan?.stops
                          .filter(
                            (stop) =>
                              !stop.fixed && stop.type !== "reservation",
                          )
                          .map((stop) => (
                            <option key={stop.id} value={stop.id}>
                              {formatStopTime(stop.time)} · {stop.title}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      <span>다음 고정 일정 <i>필수</i></span>
                      <select
                        value={nextFixedStopId}
                        onChange={(event) => setNextFixedStopId(event.target.value)}
                        required
                      >
                        <option value="">복귀할 일정을 선택하세요</option>
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
                  <legend>지금 어디에 있나요?</legend>
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
                              ? "현재 위치 확인 중…"
                              : "현재 위치 자동 입력"}
                          </strong>
                          <small>권한을 허용하면 시도·시군구까지 자동으로 채웁니다.</small>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="location-choice-manual"
                        onClick={useManualLocation}
                      >
                        위치 권한 없이 직접 입력
                      </button>
                      <p>
                        현재 좌표는 저장하지 않지만 행정구역·경로·날씨 확인을 위해 관련 제공자에
                        일시 전송됩니다. 저장한 일정 장소 좌표는 직접 삭제하거나 만료될 때까지 보관됩니다.
                      </p>
                    </div>
                  )}

                  {locationMode === "automatic" && geoState === "success" && (
                    <div className="automatic-location-card">
                      <span className="target-icon" aria-hidden="true" />
                      <div>
                        <b>현재 위치 자동 입력 완료</b>
                        <strong>
                          {originLabel || "내 현재 위치"}
                          {[selectedRegion?.name, selectedDistrict?.name].some(Boolean)
                            ? ` · ${[selectedRegion?.name, selectedDistrict?.name]
                                .filter(Boolean)
                                .join(" ")}`
                            : ""}
                        </strong>
                        <small>현재 좌표는 관련 경로·날씨 제공자에 일시 전송되며 서버에 저장하지 않습니다.</small>
                        {geoAttribution && (
                          <em className="provider-attribution">
                            위치 판별 출처 · {geoAttribution}
                          </em>
                        )}
                      </div>
                      <button type="button" onClick={useManualLocation}>
                        직접 입력으로 변경
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
                      <div className="manual-location-heading">
                        <div>
                          <strong>현재 장소 직접 입력</strong>
                          <span>장소명이나 도로명 주소만 입력하면 위치를 찾습니다.</span>
                        </div>
                        <button
                          type="button"
                          onClick={requestGeolocation}
                          disabled={geoState === "loading"}
                        >
                          위치 권한 다시 사용
                        </button>
                      </div>

                      <div className="place-search">
                        <label htmlFor="origin-place-keyword">
                          현재 장소명·주소
                        </label>
                        <div>
                          <input
                            id="origin-place-keyword"
                            value={placeKeyword}
                            onChange={(event) => {
                              setPlaceKeyword(event.target.value);
                              setLatitude("");
                              setLongitude("");
                              setOriginLabel("");
                              setGeoState("idle");
                              setPlaceResults([]);
                              setPlaceSearchState("idle");
                              setPlaceSearchError("");
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void searchOriginPlace();
                              }
                            }}
                            placeholder="예: 서울역, 광화문 D타워, 도로명 주소"
                            maxLength={80}
                            autoComplete="off"
                            data-testid="origin-place-keyword"
                          />
                          <button
                            type="button"
                            onClick={() => void searchOriginPlace()}
                            disabled={placeSearchState === "loading"}
                            data-testid="origin-place-search"
                          >
                            {placeSearchState === "loading"
                              ? "검색 중…"
                              : "장소 찾기"}
                          </button>
                        </div>
                        <p>
                          한국관광공사 관광정보를 먼저 확인하고, 없으면 다른
                          지도·주소 검색으로 자동 전환합니다.
                        </p>
                        {placeSearchState === "error" && (
                          <span className="place-search-message is-error" role="alert">
                            {placeSearchError}
                          </span>
                        )}
                        {placeSearchState === "success" && placeResults.length === 0 && (
                          <span className="place-search-message">
                            일치하는 장소가 없습니다.
                            <button
                              type="button"
                              onClick={() => void searchOriginPlace("force")}
                            >
                              다른 지도에서 다시 찾기
                            </button>
                          </span>
                        )}
                        {placeResults.length > 0 && (
                          <ul className="place-results" aria-label="관광지 검색 결과">
                            {placeResults.map((place) => (
                              <li
                                key={
                                  place.providerId ||
                                  place.contentId ||
                                  `${place.title}-${place.latitude}-${place.longitude}`
                                }
                              >
                                <button type="button" onClick={() => selectOriginPlace(place)}>
                                  <span>
                                    <strong>{place.title}</strong>
                                    <small>{place.address || "주소 정보 없음"}</small>
                                    {place.sourceLabel && (
                                      <small>{place.sourceLabel}</small>
                                    )}
                                  </span>
                                  <b>현재 위치로 선택</b>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {placeResults.length > 0 && (
                          <button
                            type="button"
                            className="place-fallback-button"
                            onClick={() => void searchOriginPlace("force")}
                          >
                            찾는 장소가 없어요 · 다른 지도에서 더 찾기
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </fieldset>

                <fieldset className="form-group">
                  <legend>무슨 일이 생겼나요?</legend>
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

                <fieldset className="form-group">
                  <legend>{language === "en" ? "What IEOGA will protect" : "이어가가 반드시 지킬 것"}</legend>
                  <div className="derived-time-card">
                    <span>{language === "en" ? "Time you can use before the next booking" : "다음 예약까지 쓸 수 있는 시간"}</span>
                    <strong>{availableMinutes}분</strong>
                    <small>
                      예약 시각과 안전 여유 {safetyBufferMinutes}분을 반영해
                      자동 계산했어요.
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
                    <small>
                      {travelMode === "car"
                        ? "TMAP 자동차 경로로 도착 시각을 검증합니다. 주차 시간은 포함하지 않습니다."
                        : "TMAP 보행자 경로로 도착 시각을 검증합니다."}
                    </small>
                  </div>
                  <details className="ablation-panel">
                    <summary>
                      심사용 · 한국관광공사 API를 끄고 결과 차이 보기
                    </summary>
                    <div className="ablation-body">
                      <p>
                        끈 서비스는 이 요청에서 호출하지 않습니다. 호출해 놓고
                        결과만 버리면 데이터가 없을 때 무엇이 깨지는지 보여 줄 수
                        없기 때문입니다. 국문 관광정보는 후보 자체를 만드는 유일한
                        원천이라 끌 수 없습니다.
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
                            <strong>{item.label} 끄기</strong>
                            <small>{item.lost}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </details>
                  <details className="recovery-preferences">
                    <summary>이동 배려·실내 조건이 필요해요</summary>
                    <div className="recovery-preferences-body">
                      <label>
                        <span>이동·접근성 조건</span>
                        <select
                          value={audience}
                          onChange={(event) =>
                            setAudience(event.target.value as Audience)
                          }
                        >
                          {AUDIENCES.map((item) => (
                            <option key={item.value} value={item.value}>
                              {language === "en"
                                ? AUDIENCES_EN[item.value]
                                : item.label}
                            </option>
                          ))}
                        </select>
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
                          <strong>실내 후보만 찾기</strong>
                          <small>
                            실내 여부가 확인되지 않은 후보는 제외합니다.
                            {incident === "rain" && !indoorOnly
                              ? " 지금은 꺼져 있어 실외 후보까지 함께 검토합니다."
                              : ""}
                          </small>
                        </span>
                      </label>
                    </div>
                  </details>
                  <details className="advanced-constraints">
                    <summary>시간·거리 세부 조건 조정</summary>
                    <div className="field-grid three">
                      <label>
                        <span>
                          사용 가능한 시간 <i aria-hidden="true">(분)</i>
                        </span>
                        <span className="number-input">
                          <input
                            aria-label="사용 가능한 시간 (15~240분)"
                            type="number"
                            min={15}
                            max={240}
                            step={5}
                            value={availableMinutes}
                            onChange={(event) => setAvailableMinutes(Number(event.target.value))}
                          />
                          <b aria-hidden="true">분</b>
                        </span>
                      </label>
                      <label>
                        <span>
                          안전 여유 <i aria-hidden="true">(분)</i>
                        </span>
                        <span className="number-input">
                          <input
                            aria-label="안전 여유 (5~60분)"
                            type="number"
                            min={5}
                            max={60}
                            step={5}
                            value={safetyBufferMinutes}
                            onChange={(event) => setSafetyBufferMinutes(Number(event.target.value))}
                          />
                          <b aria-hidden="true">분</b>
                        </span>
                      </label>
                      <label>
                        <span>
                          대체 일정 최소 체류 <i aria-hidden="true">(분)</i>
                        </span>
                        <span className="number-input">
                          <input
                            aria-label="대체 일정 최소 체류 (10~180분)"
                            type="number"
                            min={10}
                            max={180}
                            step={5}
                            value={minimumStayMinutes}
                            onChange={(event) =>
                              setMinimumStayMinutes(Number(event.target.value))
                            }
                          />
                          <b aria-hidden="true">분</b>
                        </span>
                      </label>
                      <label>
                        <span>
                          최대 이동 거리 <i aria-hidden="true">(m)</i>
                        </span>
                        <span className="number-input">
                          <input
                            aria-label="최대 이동 거리 (300~20,000m)"
                            type="number"
                            min={300}
                            max={20000}
                            step={100}
                            value={maxDistanceMeters}
                            onChange={(event) => setMaxDistanceMeters(Number(event.target.value))}
                          />
                          <b aria-hidden="true">m</b>
                        </span>
                      </label>
                      <label>
                        <span>
                          탐색 반경 <i aria-hidden="true">(m)</i>
                        </span>
                        <span className="number-input">
                          <input
                            aria-label="탐색 반경 (500~20,000m)"
                            type="number"
                            min={500}
                            max={20000}
                            step={500}
                            value={radiusMeters}
                            onChange={(event) => setRadiusMeters(Number(event.target.value))}
                          />
                          <b aria-hidden="true">m</b>
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
                      <strong>선택: 익명 결과를 지역 관광 공백 개선에 활용</strong>
                      <small>
                        정확한 위치·일정명은 저장하지 않습니다. 시군구·시간대·문제 유형과
                        도착 결과만 30일 보관하며, 동의하지 않아도 복구 기능은 동일합니다.
                      </small>
                    </span>
                  </label>
                </fieldset>

                {recoverState === "error" && (
                  <div className="notice is-error" role="alert" data-testid="recover-error">
                    <strong>복구 요청을 완료하지 못했습니다.</strong>
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
                    ? "갈 수 있는 길을 확인하는 중…"
                    : "한 곳만 바꿔서 찾기"}
                  <span aria-hidden="true">→</span>
                </button>
                <p className="estimate-note">
                  실제 보행 경로와 운영 여부를 확인한 곳만 결과에 올립니다.
                  확인하지 못한 조건은 숨기지 않고 따로 알려 드립니다.
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
                    <strong>조건을 입력하면 여기에 결과가 나타납니다.</strong>
                    <p>
                      긴 목록을 먼저 보여주지 않습니다. 시간·거리·이동 조건을
                      통과한 공식 관광정보만 제안합니다.
                    </p>
                  </div>
                )}

                {recoverState === "loading" && (
                  <div className="result-loading" role="status">
                    <span className="loading-ring" aria-hidden="true" />
                    <strong>전국 관광데이터를 교차 확인하고 있어요.</strong>
                    <p>
                      조건을 못 지키는 곳은 이 단계에서 빠집니다. 보통 5~15초
                      걸립니다.
                    </p>
                  </div>
                )}

                {recoverState === "error" && (
                  <div className="result-empty is-error">
                    <span className="error-mark" aria-hidden="true">
                      !
                    </span>
                    <strong>결과를 만들지 않았습니다.</strong>
                    <p>
                      {recoverError ||
                        "실데이터 호출 또는 필수 입력을 확인한 뒤 다시 요청해 주세요."}
                    </p>
                  </div>
                )}

                {recoverState === "success" &&
                  !!recovery?.ablation?.disabledSources?.length && (
                    /* 무엇을 끄고 얻은 수치인지 결과와 같은 자리에 적는다. 끈
                       사실을 숨기면 이 결과가 전체 사용 결과로 읽힌다. */
                    <aside className="ablation-result" role="status">
                      <strong>
                        제거실험 진행 중 · 한국관광공사 API{" "}
                        {recovery.ablation.disabledSources.length}종을 끈 결과입니다
                      </strong>
                      <ul>
                        {(recovery.ablation.lostCapabilities ?? []).map((lost) => (
                          <li key={lost}>{lost}</li>
                        ))}
                      </ul>
                      <p>
                        검증된 후보 {recovery.ablation.verifiedOptionCount ?? 0}개 ·
                        확인 필요 {recovery.ablation.confirmationRequiredCount ?? 0}개 ·
                        연계 방문 근거 {recovery.ablation.relatedEvidenceCount ?? 0}개 ·
                        집중률 근거 {recovery.ablation.crowdEvidenceCount ?? 0}개 ·
                        접근성 확인 {recovery.ablation.accessibilityVerifiedCount ?? 0}개
                      </p>
                    </aside>
                  )}

                {recoverState === "success" && recovery && recovery.options.length === 0 && (
                  <div className="no-candidate" data-testid="no-candidate">
                    <span>적용 가능 후보 0</span>
                    <h3>조건을 만족하는 일정을 찾지 못했습니다.</h3>
                    <p>
                      없는 후보를 만들어내지 않았습니다. 탐색 반경이나 이동 거리를 조금 넓히거나, 실내
                      조건을 해제한 뒤 다시 확인해 주세요.
                    </p>
                    {typeof recovery.rejectedCount === "number" && (
                      <small>조건 검증에서 제외된 후보 {recovery.rejectedCount.toLocaleString("ko-KR")}개</small>
                    )}
                    {recovery.counterfactual?.title && (
                      <aside className="counterfactual-card is-empty-result">
                        <div>
                          <span>한 가지 조건만 바꾸면 가능한 대안</span>
                          <h3>{recovery.counterfactual.title}</h3>
                        </div>
                        <div>
                          <p>
                            {recovery.counterfactual.reason ||
                              "다음 예약을 지키면서 가능한 최소 조건 조정을 계산했습니다."}
                          </p>
                          {recovery.counterfactual.requiredRelaxation?.description && (
                            <strong className="counterfactual-relaxation">
                              {recovery.counterfactual.requiredRelaxation.description}
                            </strong>
                          )}
                          {/* 사전 걸러내기 단계 탈락안은 경로·운영시간을 아직
                              확인하지 않았다. 그 후보에까지 "예약을 그대로
                              보존합니다"라고 쓰면 검증하지 않은 것을 보증하는
                              문장이 된다. */}
                          <small>
                            {recovery.counterfactual.verificationDepth ===
                            "pre_filter"
                              ? "거리·시간 조건만 비교한 단계입니다. 실제 경로와 운영시간, 다음 예약 보존은 이 조건을 적용한 뒤 다시 검증합니다."
                              : "다른 일정과 다음 예약은 그대로 보존합니다."}
                          </small>
                        </div>
                        <button
                          type="button"
                          onClick={applyCounterfactualRelaxation}
                          disabled={
                            !recovery.counterfactual.requiredRelaxation
                          }
                        >
                          이 한 조건만 적용
                        </button>
                      </aside>
                    )}
                    {recovery.warnings?.map((warning) => (
                      <small key={warning}>{warning}</small>
                    ))}
                    <div className="no-candidate-actions">
                      <a href="tel:1330">관광통역안내 1330 연결</a>
                      <button
                        type="button"
                        onClick={() => {
                          document
                            .querySelector(".recovery-form")
                            ?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }}
                      >
                        조건을 직접 검토하기
                      </button>
                    </div>
                  </div>
                )}

                {recoverState === "success" && recovery && recovery.options.length > 0 && (
                  <div className="recovery-results">
                    <div className="recovery-ready-banner">
                      <span aria-hidden="true">✓</span>
                      <div>
                        <strong>다음 예약을 지키는 복구안을 찾았어요</strong>
                        <p>
                          원래 여행에서 가장 적게 바꾸는 안을 먼저
                          보여드려요.
                        </p>
                      </div>
                    </div>

                    {recovery.warnings && recovery.warnings.length > 0 && (
                      <div className="notice is-warning">
                        <strong>일부 데이터 제한이 있습니다.</strong>
                        {recovery.warnings.map((warning) => (
                          <p key={warning}>{warning}</p>
                        ))}
                      </div>
                    )}

                    {!recoveryPersisted && (
                      <div className="notice is-error" role="alert">
                        <strong>복구 실행 저장을 확인하지 못했습니다.</strong>
                        <p>
                          이 결과는 일정에 적용하거나 공유·성과 기록에 사용할 수
                          없습니다. 복구를 다시 실행해 주세요.
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
                            <span>현재 적용 중인 복구안</span>
                            <h3>
                              일정{" "}
                              {appliedScheduleDiff?.changedNodeCount ??
                                appliedScheduleDiff?.changedCount ??
                                appliedScheduleDiff?.changedNodeIds?.length ??
                                1}
                              개만 바꿔 다음 예약을 지킵니다.
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
                              ? "예약 보존 재확인 필요"
                              : "다음 고정 일정 보존"}
                          </b>
                        </div>

                        <div className="before-after-timeline">
                          <div className="timeline-column">
                            <span>변경 전</span>
                            <ol>
                              <li className="is-disrupted">
                                <time>{formatStopTime(selectedAffectedStop.time)}</time>
                                <strong>{selectedAffectedStop.title}</strong>
                                <small>돌발상황으로 진행 불가</small>
                              </li>
                              {preservedOriginalStops.map((stop) => (
                                <li
                                  className={stop.fixed ? "is-locked" : ""}
                                  key={stop.id}
                                >
                                  <time>{formatStopTime(stop.time)}</time>
                                  <strong>{stop.title}</strong>
                                  <small>원래 일정 · 변경하지 않음</small>
                                </li>
                              ))}
                              <li className="is-locked">
                                <time>{formatStopTime(selectedNextFixedStop.time)}</time>
                                <strong>{selectedNextFixedStop.title}</strong>
                                <small>예약·고정 일정</small>
                              </li>
                            </ol>
                          </div>
                          <i aria-hidden="true">→</i>
                          <div className="timeline-column is-after">
                            <span>최소변경 복구 후</span>
                            <ol>
                              <li className="is-replacement">
                                <time>지금</time>
                                <strong>{appliedOption.title}</strong>
                                <small>
                                  {typeof appliedOption.estimatedTravelMinutes === "number"
                                    ? `첫 이동 약 ${Math.ceil(appliedOption.estimatedTravelMinutes)}분`
                                    : "이동 경로 확인"}
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
                                      )}
                                    </time>
                                    <strong>
                                      {waypoint.title ?? "보존 일정"}
                                    </strong>
                                    <small>
                                      {typeof waypoint.arrivalBufferMinutes ===
                                      "number"
                                        ? `도착 여유 ${waypoint.arrivalBufferMinutes}분 · 보존 검증`
                                        : "원래 일정 보존 검증"}
                                    </small>
                                  </li>
                                ))}
                              <li className="is-locked">
                                <time>{formatStopTime(selectedNextFixedStop.time)}</time>
                                <strong>{selectedNextFixedStop.title}</strong>
                                <small>잠금 유지</small>
                              </li>
                            </ol>
                          </div>
                        </div>

                        <div className="continuity-proof-facts">
                          <dl>
                            <dt>잠긴 일정 보존</dt>
                            <dd>
                              {readText(appliedProof, ["lockedNodesPreserved"]) ||
                                appliedScheduleDiff?.preservedLockedNodeIds?.length ||
                                "확인 중"}
                              {readText(appliedProof, ["lockedNodesTotal"])
                                ? ` / ${readText(appliedProof, ["lockedNodesTotal"])}`
                                : ""}
                            </dd>
                          </dl>
                          <dl>
                            <dt>실제 경로 근거</dt>
                            <dd>
                              {readText(appliedRouteEvidence, [
                                "status",
                                "provider",
                                "method",
                              ]) || "구간별 경로 확인"}
                            </dd>
                          </dl>
                          <dl>
                            <dt>다음 일정 도착</dt>
                            <dd>
                              {readText(appliedRouteEvidence, [
                                "arrivalAt",
                                "estimatedArrivalAt",
                              ]) ||
                                appliedScheduleDiff?.arrivalTime ||
                                "도착 시각 확인"}
                            </dd>
                          </dl>
                          <dl>
                            <dt>안전 여유</dt>
                            <dd>
                              {typeof appliedScheduleDiff?.safetyBufferMinutes === "number"
                                ? `${appliedScheduleDiff.safetyBufferMinutes}분`
                                : `${safetyBufferMinutes}분 기준`}
                            </dd>
                          </dl>
                          {appliedWeatherEvidence && (
                            <dl>
                              <dt>현재 기상 근거</dt>
                              <dd>
                                <a
                                  href="https://open-meteo.com/"
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open-Meteo
                                </a>
                                {" · "}
                                {formatIsoTime(
                                  readText(appliedWeatherEvidence, [
                                    "observedAt",
                                  ]),
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
                            현재 위치 → 대체 일정 길찾기
                          </a>
                          {typeof selectedNextFixedStop.latitude === "number" &&
                            typeof selectedNextFixedStop.longitude === "number" && (
                              <a
                                href={`https://map.kakao.com/link/to/${encodeURIComponent(selectedNextFixedStop.title)},${selectedNextFixedStop.latitude},${selectedNextFixedStop.longitude}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                대체 일정 → 다음 예약 길찾기
                              </a>
                            )}
                        </div>
                        <p className="route-attribution">
                          적용 경로 출처 ·{" "}
                          {readText(appliedRouteEvidence, ["attribution"]) ||
                            "경로 제공자 출처 확인 필요"}
                          {readText(appliedRouteEvidence, ["calculatedAt"])
                            ? ` · 확인 ${formatDate(readText(appliedRouteEvidence, ["calculatedAt"]))}`
                            : ""}
                        </p>

                        <div className="arrival-check">
                          <div>
                            <strong>다음 고정 일정까지 여행이 이어졌나요?</strong>
                            <span>도착 결과가 있어야 복구가 실제로 성공했는지 확인할 수 있습니다.</span>
                          </div>
                          <div>
                            <button
                              type="button"
                              className={recoveryOutcome === "arrived" ? "is-selected" : ""}
                              onClick={() => void recordRecoveryOutcome(appliedOption, "arrived")}
                              disabled={!recoveryPersisted}
                            >
                              도착했어요
                            </button>
                            <button
                              type="button"
                              className={recoveryOutcome === "not_arrived" ? "is-selected is-negative" : ""}
                              onClick={() => void recordRecoveryOutcome(appliedOption, "abandoned")}
                              disabled={!recoveryPersisted}
                            >
                              도착하지 못했어요
                            </button>
                          </div>
                        </div>
                        {outcomeMessage && (
                          <p className="outcome-message" role="status">
                            {outcomeMessage}
                          </p>
                        )}
                      </div>
                    )}

                    <div className="option-list">
                      {recovery.options.map((option, index) => (
                        <article
                          className={[
                            "option-card",
                            appliedOptionId === option.id ? "is-applied" : "",
                            option.confirmationRequired ||
                            (option.evidenceGaps?.length ?? 0) > 0
                              ? "is-unverified"
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          key={option.id || option.contentId || `${option.title}-${index}`}
                          data-testid="recovery-option"
                          hidden={index > 0 && !showAllOptions}
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
                                <p>{option.address || "주소 정보 확인 필요"}</p>
                                <h3>{option.title}</h3>
                              </div>
                              {typeof option.score === "number" && (
                                <span className="option-score">
                                  <b>{Math.round(option.score)}</b>
                                  <small>복구 적합도</small>
                                </span>
                              )}
                            </div>
                            {(option.confirmationRequired ||
                              (option.evidenceGaps?.length ?? 0) > 0) && (
                              <section
                                className="evidence-gap-alert"
                                role="alert"
                                aria-label="공식 근거 확인 필요"
                              >
                                <strong>
                                  이 후보는 아직 검증된 복구안이 아닙니다
                                </strong>
                                <p>
                                  아래 조건을 공식 정보로 확인하지 못해 일정에
                                  적용할 수 없습니다.
                                </p>
                                <ul>
                                  {(option.evidenceGaps ?? []).map(
                                    (gap, gapIndex) => (
                                      <li key={`${gap.code ?? "gap"}-${gapIndex}`}>
                                        {(language === "en"
                                          ? gap.noteEn
                                          : "") ||
                                          gap.note ||
                                          (gap.code === "INDOOR_UNVERIFIED"
                                            ? "실내 이용 가능 여부 미확인"
                                            : gap.code ===
                                                "ACCESSIBILITY_UNVERIFIED"
                                              ? "요청한 접근성 조건 미확인"
                                              : gap.code ===
                                                  "CONCENTRATION_UNVERIFIED"
                                                ? "관광 집중률 예측 미확인"
                                                : "필수 조건 근거 미확인")}
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
                                  label: "현재 위치",
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
                                    "다음 고정 일정",
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
                                  summary={`현재 위치에서 ${option.title}까지의 경로 개요입니다. 약 ${option.estimatedTravelMinutes ?? 0}분, ${(option.distanceMeters ?? 0).toLocaleString("ko-KR")}m.`}
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
                                  {option.purposePreservation.originalPurpose ||
                                    "원래 여행 경험"}
                                  <i aria-hidden="true">→</i>
                                  {option.purposePreservation
                                    .replacementPurpose || "대체 경험"}
                                </strong>
                                <p>
                                  {(language === "en" &&
                                    option.purposePreservation.statementEn) ||
                                    option.purposePreservation.statement ||
                                    "장소만 바꾸고 원래 하려던 여행 경험은 이어갑니다."}
                                </p>
                                <small>
                                  {option.purposePreservation.evidenceSource ===
                                  "TarRlteTarService1"
                                    ? `한국관광공사 연계 방문 근거${
                                        typeof option.purposePreservation
                                          .relatedRank === "number"
                                          ? ` · ${option.purposePreservation.relatedRank}위`
                                          : ""
                                      }`
                                    : "한국관광공사 관광 콘텐츠 유형 근거"}
                                </small>
                              </div>
                            )}
                            <div className="option-facts">
                              <dl>
                                <dt>거리</dt>
                                <dd>
                                  {typeof option.distanceMeters === "number"
                                    ? option.distanceMeters >= 1000
                                      ? `${(option.distanceMeters / 1000).toFixed(1)}km`
                                      : `${Math.round(option.distanceMeters)}m`
                                    : "미확인"}
                                </dd>
                              </dl>
                              <dl>
                                <dt>이동 추정</dt>
                                <dd>
                                  {typeof option.estimatedTravelMinutes === "number"
                                    ? `약 ${Math.ceil(option.estimatedTravelMinutes)}분`
                                    : compactValue(option.travelEstimate)}
                                </dd>
                              </dl>
                              <dl>
                                <dt>접근성</dt>
                                <dd>{compactValue(option.accessibility)}</dd>
                              </dl>
                              <dl>
                                <dt>집중 예측</dt>
                                <dd>{formatCrowd(option.crowd)}</dd>
                              </dl>
                            </div>
                            {option.indoorSuitability !== undefined && (
                              <div className="verification-tags">
                                <span>실내 적합성 · {compactValue(option.indoorSuitability)}</span>
                                <span>
                                  {asRecord(option.continuityProof)?.routeEvidence
                                    ? "현재→대안→다음 예약 경로 확인"
                                    : "경로 근거 확인 필요"}
                                </span>
                              </div>
                            )}
                            <p className="route-attribution">
                              추천 경로 출처 ·{" "}
                              {readText(
                                asRecord(
                                  asRecord(option.continuityProof)?.routeEvidence,
                                ),
                                ["attribution"],
                              ) || "경로 제공자 출처 확인 필요"}
                            </p>
                            {asRecord(
                              asRecord(option.continuityProof)
                                ?.weatherEvidence,
                            ) && (
                              <p className="route-attribution">
                                현재 기상 원자료 ·{" "}
                                <a
                                  href="https://open-meteo.com/"
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open-Meteo
                                </a>
                                {" · "}
                                강수 여부는 이어가가 원자료에서 판정
                              </p>
                            )}
                            {option.scheduleDiff && (
                              <div className="option-continuity-summary">
                                <span>
                                  변경 일정{" "}
                                  <b>
                                    {option.scheduleDiff.changedNodeCount ??
                                      option.scheduleDiff.changedNodeIds?.length ??
                                      1}
                                    개
                                  </b>
                                </span>
                                <span>
                                  잠금 보존{" "}
                                  <b>
                                    {option.scheduleDiff.preservedLockedNodeIds?.length ??
                                      (option.scheduleDiff.nextFixedAppointmentPreserved
                                        ? "확인"
                                        : "재확인")}
                                  </b>
                                </span>
                                <span>
                                  다음 예약{" "}
                                  <b>
                                    {option.scheduleDiff.nextFixedAppointmentPreserved === false
                                      ? "미보존"
                                      : "보존"}
                                  </b>
                                </span>
                              </div>
                            )}
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
                                          {waypoint.title ?? "보존 일정"}
                                        </span>
                                        <small>
                                          {formatIsoTime(
                                            waypoint.estimatedArrivalAt,
                                          )}
                                          {typeof waypoint.arrivalBufferMinutes ===
                                          "number"
                                            ? ` 도착 · 여유 ${waypoint.arrivalBufferMinutes}분`
                                            : " 도착 검증"}
                                        </small>
                                        <b>
                                          {waypoint.status === "preserved"
                                            ? "보존"
                                            : "재확인"}
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
                                  onClick={() => void recordRecoveryOutcome(option, "applied")}
                                  disabled={
                                    !recoveryPersisted ||
                                    !recovery.requestId ||
                                    !option.id ||
                                    option.confirmationRequired ||
                                    (option.evidenceGaps?.length ?? 0) > 0
                                  }
                                >
                                  {option.confirmationRequired ||
                                  (option.evidenceGaps?.length ?? 0) > 0
                                    ? "공식 확인 전 적용 불가"
                                    : appliedOptionId === option.id
                                    ? "현재 적용 중"
                                    : "이 일정으로 이어가기"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void shareRecoveryOption(option)}
                                  disabled={
                                    !recoveryPersisted ||
                                    !recovery.requestId ||
                                    !option.id ||
                                    option.confirmationRequired ||
                                    (option.evidenceGaps?.length ?? 0) > 0
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
                    {recovery.options.length > 1 && (
                      <button
                        type="button"
                        className="option-toggle"
                        onClick={() =>
                          setShowAllOptions((current) => !current)
                        }
                      >
                        {showAllOptions
                          ? "최우선 복구안만 보기"
                          : `다른 검증안 ${recovery.options.length - 1}개 비교`}
                      </button>
                    )}

                    {recovery.counterfactual?.title && (
                      <aside className="counterfactual-card">
                        <div>
                          <span>최소 완화 반사실 증명</span>
                          <h3>{recovery.counterfactual.title}</h3>
                        </div>
                        <div>
                          <p>
                            {recovery.counterfactual.reason ||
                              "다음 예약을 지키면서 가능한 단일 조건의 최소 조정량입니다."}
                          </p>
                          {recovery.counterfactual.requiredRelaxation?.description && (
                            <strong className="counterfactual-relaxation">
                              {recovery.counterfactual.requiredRelaxation.description}
                            </strong>
                          )}
                          <small>
                            잠금 일정·다음 예약 보존 · 자동 적용하지 않음
                          </small>
                        </div>
                        <button
                          type="button"
                          onClick={applyCounterfactualRelaxation}
                          disabled={
                            !recovery.counterfactual.requiredRelaxation
                          }
                        >
                          이 한 조건만 적용해 재계산
                        </button>
                      </aside>
                    )}

                    <details className="decision-contribution">
                      <summary>{language === "en" ? "Why this place is safe to go" : "이 곳이 왜 안전한지 보기"}</summary>
                      <div className="decision-contribution-intro">
                        <span>{language === "en" ? "Why this place was chosen" : "이 곳을 고른 이유"}</span>
                        <h3>{language === "en" ? "What each data source decided" : "각 데이터가 바꾼 판단"}</h3>
                        <p>어떤 데이터가 이 곳을 남기고 다른 곳을 제외했는지 그대로 보여 드립니다.</p>
                      </div>
                      <ul>
                        {recovery.dataContributions && recovery.dataContributions.length > 0
                          ? recovery.dataContributions.map((contribution, index) => (
                              <li key={`${contribution.source ?? "source"}-${index}`}>
                                <strong>{contribution.source || "공식 데이터"}</strong>
                                <span>{contribution.effect || contribution.decision || "복구 조건 판정"}</span>
                                <b>{humanizeStatus(contribution.status || "used")}</b>
                              </li>
                            ))
                          : (recovery.sourceLedger ?? []).map((source, index) => (
                              <li key={`${sourceName(source)}-effect-${index}`}>
                                <strong>{sourceName(source)}</strong>
                                <span>{sourceDecisionEffect(source)}</span>
                                <b>{humanizeStatus(sourceStatus(source))}</b>
                              </li>
                            ))}
                      </ul>
                    </details>

                    <details className="source-ledger">
                      <summary>요청·출처 원장 자세히 보기</summary>
                      <ul>
                        {(recovery.sourceLedger ?? []).map((source, index) => (
                          <li key={`${sourceName(source)}-${index}`}>
                            <span>{sourceName(source)}</span>
                            <b className={`status-badge ${statusTone(sourceStatus(source))}`}>
                              {humanizeStatus(sourceStatus(source))}
                            </b>
                          </li>
                        ))}
                      </ul>
                      <p>
                        요청 ID {recovery.requestId || "미제공"} · 생성 시각 {formatDate(recovery.generatedAt)}
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
              /* 위치 직접 입력은 복구 탭의 검색 흐름을 그대로 쓴다. 개인정보
                 처리(좌표 절삭·POST 전송·보관 정책)가 한 곳에만 있어야 한다. */
              onManualLocation={() => changeTab("recover")}
            />
          </section>
        )}

        {activeTab === "insights" && (
          <section
            id="panel-insights"
            role="tabpanel"
            aria-labelledby="tab-insights"
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
            role="tabpanel"
            aria-labelledby="tab-transparency"
            className="page-section transparency-section"
          >
            <div className="section-intro">
              <p className="section-kicker">{language === "en" ? "Data sources" : "데이터 출처"}</p>
              <h1>
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
                      ? "운영 점검 기록을 불러오는 중"
                      : healthState === "error"
                        ? "지금은 확인할 수 없음"
                        : humanizeStatus(health?.overall, language)}
                  </strong>
                  <small>
                    {health?.checkedAt
                      ? `마지막 운영 점검 ${formatDate(health.checkedAt)}${health.stale ? " · 오래된 점검" : ""}`
                      : "아직 저장된 운영 점검이 없습니다."}
                  </small>
                </div>
              </div>
              <button type="button" onClick={loadHealth} disabled={healthState === "loading"}>
                저장 상태 다시 불러오기
              </button>
            </div>
            {healthError && (
              <div className="notice is-error" role="alert">
                <strong>
                  운영 점검 기록을 지금 불러오지 못했습니다. 여행 복구 기능은
                  그대로 사용할 수 있습니다.
                </strong>
                <p>{healthError}</p>
              </div>
            )}

            <LaunchEvidencePanel />

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
                        <strong>{api.label}</strong>
                        <code>{api.id}</code>
                      </div>
                      <p>{api.use}</p>
                      <b className={`status-badge ${statusTone(currentStatus)}`}>
                        {healthState === "loading" ? "확인 중" : humanizeStatus(currentStatus)}
                      </b>
                    </article>
                  );
                })}
              </div>
            </div>

            <div className="principle-grid">
              <article>
                <span>01</span>
                <h2>없는 후보를 만들지 않습니다</h2>
                <p>
                  필수 조건을 통과한 후보가 0개라면 0개라고 답합니다. 데이터가 줄면 신뢰도가 높아지지
                  않으며, 확인되지 않은 정보는 적용 가능으로 표시하지 않습니다.
                </p>
              </article>
              <article>
                <span>02</span>
                <h2>정확한 위치를 저장하지 않습니다</h2>
                <p>
                  현재 좌표는 주변 후보를 찾는 한 번의 요청에서만 사용합니다. 데이터베이스, 분석 로그,
                  정책 대시보드에는 정확한 좌표나 이동 경로를 남기지 않습니다.
                </p>
              </article>
              <article>
                <span>03</span>
                <h2>추정과 사실을 구분합니다</h2>
                <p>
                  관광지 정보는 출처와 기준일을 표시하고, 이동 경로는 경로 제공자의 구간별 근거와
                  확인 시각을 함께 표시합니다. 응답이 없으면 도착 가능을 단정하지 않습니다.
                </p>
              </article>
            </div>

            <div className="data-flow" aria-label="데이터 처리 흐름">
              <div>
                <span>요청</span>
                <strong>현재 위치·여행 조건</strong>
                <small>메모리에서만 처리</small>
              </div>
              <i aria-hidden="true">→</i>
              <div>
                <span>검증</span>
                <strong>OpenAPI 8종·하드 필터</strong>
                <small>불확실성 분리</small>
              </div>
              <i aria-hidden="true">→</i>
              <div>
                <span>결과</span>
                <strong>적용 가능 후보·근거</strong>
                <small>요청 ID로 재현</small>
              </div>
              <i aria-hidden="true">→</i>
              <div>
                <span>정책 집계</span>
                <strong>시군구·시간대 단위</strong>
                <small>k ≥ 30만 공개</small>
              </div>
            </div>

            <div className="legal-grid">
              <article id="privacy">
                <p className="section-kicker">PRIVACY</p>
                <h2>개인정보 처리 원칙</h2>
                <ul>
                  <li>
                    정확한 현재 위치는 저장하지 않지만 행정구역·경로·날씨 확인을 위해 관련 제공자에
                    일시 전송됩니다.
                  </li>
                  <li>
                    사용자가 저장한 일정 장소 좌표는 여행 복구를 위해 세션에 보관하며, 내 데이터 삭제
                    또는 보관기간 만료 시 삭제합니다.
                  </li>
                  <li>유아차·휠체어·고령자 조건은 추천 필터이며 건강정보로 추론하지 않습니다.</li>
                  <li>정책 통계는 시군구·시간대 단위로 일반화하고 30건 미만 집계는 공개하지 않습니다.</li>
                  <li>선택 동의가 없는 분석 식별자를 만들지 않으며, 만료된 익명 세션은 삭제합니다.</li>
                </ul>
              </article>
              <article id="terms">
                <p className="section-kicker">TERMS</p>
                <h2>이용 시 확인사항</h2>
                <ul>
                  <li>관광지 운영시간·휴무·현장 접근성은 방문 전 해당 시설에서 최종 확인해야 합니다.</li>
                  <li>
                    이동 시간은 경로 제공자의 응답과 확인 시각을 표시하며, 응답이 없거나 오래되면
                    도착 가능을 보증하지 않습니다.
                  </li>
                  <li>이어가는 예약·결제·운송을 제공하지 않으며 여행 중 의사결정을 돕는 정보 서비스입니다.</li>
                  <li>OpenAPI 장애 또는 데이터 부족 시 일부 기능이 제한될 수 있으며 이를 화면에 표시합니다.</li>
                </ul>
              </article>
            </div>
          </section>
        )}
      </main>

      {/* Mobile navigation points at the scenario routes rather than the
          in-page tabs. Each of those is a sequence of single-decision screens;
          the tab panels below remain as the detailed desktop view. */}
      <nav
        className="mobile-nav"
        aria-label={language === "en" ? "Mobile navigation" : "모바일 주요 메뉴"}
      >
        <a href="/flow">
          <span aria-hidden="true">↗</span>
          {language === "en" ? "Recovery" : "여행 복구"}
        </a>
        <a href="/policy">
          <span aria-hidden="true">▦</span>
          {language === "en" ? "Resilience" : "지역 회복력"}
        </a>
        <a href="/sources">
          <span aria-hidden="true">◎</span>
          {language === "en" ? "Sources" : "데이터 출처"}
        </a>
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
          <button type="button" onClick={() => changeTab("insights")}>
            {language === "en"
              ? "For local governments"
              : "지자체·기관용 개선 과제"}
          </button>
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
