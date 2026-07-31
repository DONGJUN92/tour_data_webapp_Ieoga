import { publicJsonResponse } from "@/lib/http";
import { externalProviderStatus } from "@/lib/runtime-readiness";

export async function GET() {
  const providers = externalProviderStatus();
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
        responseBudgetMilliseconds: 12_000,
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
          currentMethod: "openstreetmap_osrm_walking",
          requiredContext:
            "registered_itinerary_with_next_fixed_location",
          unavailableBehavior:
            "reject_continuity_candidate_without_route_fallback",
          disclosureRequired: true,
          providerMode: providers.walkingRouting,
        },
        weatherAutoDetection: {
          supported: true,
          currentMethod:
            providers.weather === "managed"
              ? "kma_ultra_short_nowcast_with_open_meteo_fallback"
              : "open_meteo_current_conditions",
          requiredContext: "registered_itinerary",
          decisionRole:
            "supporting_evidence_user_selected_incident_takes_priority",
          providerMode: providers.weather,
        },
        reverseGeocoding: {
          currentMethod: "openstreetmap_nominatim_then_kto_nearest",
          providerMode: providers.reverseGeocoding,
          coordinatesInUrl: false,
        },
        placeSearch: {
          primary: "KorService2.searchKeyword2",
          currentOriginFallback:
            "kakao_local_when_configured_then_forward_geocoder",
          savedStopFallback: "managed_or_self_hosted_forward_geocoder",
          manualCoordinatesRequired: false,
          providerMode: providers.forwardGeocoding,
        },
      },
      policyInsights: {
        supported: true,
        mode: "on_demand_by_official_region_code",
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
