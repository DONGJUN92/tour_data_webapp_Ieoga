import {
  openMeteoEndpoint,
  routingEndpoints,
  tmapPedestrianConfigured,
} from "@/lib/external-providers";
import { publicJsonResponse } from "@/lib/http";
import { externalProviderStatus } from "@/lib/runtime-readiness";
import { kakaoLocalConfigured } from "@/lib/location/kakao-local";
import { kmaConfigured } from "@/lib/weather/kma";
import {
  describeProviderCapabilities,
  PROVIDER_PROBE_STALE_AFTER_MS,
} from "@/lib/provider-readiness";

export async function GET() {
  const providers = externalProviderStatus();
  const kakaoConfigured = kakaoLocalConfigured();
  const domesticWeatherConfigured = kmaConfigured();
  const providerCapabilities = describeProviderCapabilities({
    providers,
    kakaoConfigured,
    kmaConfigured: domesticWeatherConfigured,
    tmapConfigured: tmapPedestrianConfigured(),
    osrmFallbackPresent: routingEndpoints().length > 0,
    openMeteoFallbackPresent: openMeteoEndpoint() !== undefined,
  });
  return publicJsonResponse(
    {
      scope: "nationwide",
      regionSource: "KorService2.ldongCode2",
      travelerRecovery: {
        supported: true,
        registeredItineraryRequired: true,
        requiredJourneyContract: [
          "changeable_disrupted_node",
          "later_locked_or_reserved_node_with_time_and_location",
          "current_origin",
        ],
        incidents: ["rain", "delay", "crowd", "less_walk"],
        audiences: ["general", "stroller", "wheelchair", "senior"],
        exactLocationRetention: "none",
        currentOriginRetention: "none",
        savedItineraryPlaceRetention: "30_days_or_session_delete",
        responseBudgetMilliseconds: 20_000,
        continuityPath:
          "current_origin_to_replacement_to_every_original_waypoint_to_next_fixed_appointment",
        counterfactual: {
          supported: true,
          method: "single_constraint_minimum_relaxation",
          autoApply: false,
          preservedContract: [
            "unchanged_itinerary_nodes",
            "locked_nodes",
            "next_fixed_appointment",
          ],
        },
        routeEta: {
          supported: true,
          currentMethod: providerCapabilities.routeMethod,
          requiredContext:
            "registered_itinerary_with_next_fixed_location",
          unavailableBehavior:
            "reject_continuity_candidate_without_route_fallback",
          disclosureRequired: true,
          providerMode: providers.walkingRouting,
        },
        weatherAutoDetection: {
          supported: true,
          currentMethod: providerCapabilities.weatherMethod,
          requiredContext: "registered_itinerary",
          decisionRole:
            "supporting_evidence_user_selected_incident_takes_priority",
          providerMode: providers.weather,
        },
        reverseGeocoding: {
          currentMethod: providerCapabilities.reverseMethod,
          providerMode: providers.reverseGeocoding,
          browserRequestCoordinatesInUrl: false,
          upstreamProviderTransport: "https_query_parameters",
        },
        placeSearch: {
          primary: "KorService2.searchKeyword2",
          currentOriginFallback: providerCapabilities.currentOriginFallback,
          savedStopFallback: providerCapabilities.savedStopFallback,
          manualCoordinatesRequired: false,
          browserCoordinateTransport: "https_post_body_when_present",
          providerMode: providers.forwardGeocoding,
        },
      },
      externalProviderReadiness: {
        statusEndpoint: "/api/v1/health/ready",
        authenticatedRefreshEndpoint: "/api/v1/ops/health/refresh",
        requiredEvidence:
          "fresh_successful_response_contract_probe_for_each_configured_managed_provider",
        staleAfterMilliseconds: PROVIDER_PROBE_STALE_AFTER_MS,
        configurationChangeBehavior: "previous_probe_invalidated",
        sharedPublicReleaseBehavior: "blocked",
        publicStatusBehavior: "stored_snapshot_only_no_outbound_probe",
      },
      policyInsights: {
        supported: true,
        mode: "scheduled_versioned_region_pack_by_official_region_code",
        cacheMissBehavior: "read_only_503_until_operator_sync",
        syntheticBackfill: false,
        missionLoop: {
          supported: true,
          failureCategories: [
            "content_gap",
            "data_gap",
            "operating_hours_gap",
            "mobility_gap",
          ],
          stages: [
            "classify_failure",
            "assign_owner_deadline_and_success_condition",
            "record_action_and_evidence",
            "revalidate_saved_same_scenario",
            "resolve_or_reopen",
          ],
          operatorRevalidation:
            "/api/v1/ops/missions/{missionId}/revalidate",
          behaviorMinimumSample: 30,
          exactLocationUsed: false,
          belowThresholdPublished: false,
        },
      },
    },
    { maxAge: 600 },
  );
}
