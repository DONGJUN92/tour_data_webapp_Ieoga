ALTER TABLE `resilience_missions` ADD `failure_category` text DEFAULT 'data_gap' NOT NULL;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `owner_organization` text DEFAULT '한국관광공사 관광데이터 운영 담당' NOT NULL;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `owner_role` text DEFAULT '미션 책임자' NOT NULL;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `deadline_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `success_condition` text DEFAULT '동일 시나리오 재검증에서 공백이 해소되어야 합니다.' NOT NULL;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `evidence_requirement` text DEFAULT '조치 전후를 확인할 수 있는 공식 증빙이 필요합니다.' NOT NULL;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `scenario_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `action_evidence_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `action_recorded_at` text;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `last_revalidated_at` text;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `last_revalidation_result` text;--> statement-breakpoint
ALTER TABLE `resilience_missions` ADD `revalidation_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `resilience_missions`
SET
  `failure_category` = CASE
    WHEN `mission_type` = 'policy_evidence_gap' THEN 'data_gap'
    WHEN `mission_type` = 'hub_evidence_gap' THEN 'content_gap'
    WHEN `mission_type` = 'recovery_scenario_gap' THEN 'operating_hours_gap'
    ELSE 'mobility_gap'
  END,
  `owner_organization` = CASE
    WHEN `mission_type` = 'policy_evidence_gap' THEN '한국관광공사 관광데이터 운영 담당'
    WHEN `mission_type` = 'hub_evidence_gap' THEN '지역코드 ' || `region_code` || ' 관광정책 담당부서'
    WHEN `mission_type` = 'recovery_scenario_gap' THEN '지역코드 ' || `region_code` || ' 관광정보·시설 운영 담당부서'
    ELSE '지역코드 ' || `region_code` || ' 관광·교통 협업 담당부서'
  END,
  `owner_role` = CASE
    WHEN `mission_type` = 'policy_evidence_gap' THEN '공식 관광데이터 품질 책임자'
    WHEN `mission_type` = 'hub_evidence_gap' THEN '지역 대체관광 콘텐츠 책임자'
    WHEN `mission_type` = 'recovery_scenario_gap' THEN '관광지 운영정보 개선 책임자'
    ELSE '여행 이동 연속성 개선 책임자'
  END,
  `deadline_at` = strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    `first_detected_at`,
    CASE
      WHEN `mission_type` = 'hub_evidence_gap' THEN '+30 days'
      WHEN `mission_type` IN ('continuity_outcome_gap', 'mobility_recovery_gap') THEN '+21 days'
      ELSE '+14 days'
    END
  ),
  `success_condition` = CASE
    WHEN `mission_type` = 'policy_evidence_gap' THEN '저장된 동일 지역·동일 API 조합을 재호출했을 때 필수 공식 지표가 모두 응답하고 원천 오류가 0건이어야 합니다.'
    WHEN `mission_type` = 'hub_evidence_gap' THEN '저장된 동일 중단 조건을 재실행했을 때 공식 식별자가 확인된 대체 관광지가 2개 이상 생성되어야 합니다.'
    WHEN `mission_type` = 'recovery_scenario_gap' THEN '저장된 동일 시간대·중단 유형 시나리오에서 운영 확인이 가능한 대안이 생성되고 유효 대안 없음 기준을 벗어나야 합니다.'
    WHEN `mission_type` = 'continuity_outcome_gap' THEN '저장된 동일 이동·다음 예약 조건에서 복구안을 실행한 뒤 여행 중단률이 기준 미만으로 낮아져야 합니다.'
    ELSE '저장된 동일 이동·접근성 조건에서 검증된 대안이 생성되고 다음 고정 일정까지 이동 가능해야 합니다.'
  END,
  `evidence_requirement` = CASE
    WHEN `mission_type` = 'policy_evidence_gap' THEN '수정된 공식 레코드 식별자, OpenAPI 요청 감사 ID, 조치 전후 응답 필드 비교를 제출해야 합니다.'
    WHEN `mission_type` = 'hub_evidence_gap' THEN '보완된 한국관광공사 콘텐츠 ID, 지자체 확인 기록, 동일 시나리오 후보 생성 결과를 제출해야 합니다.'
    WHEN `mission_type` = 'recovery_scenario_gap' THEN '공식 운영시간 또는 휴무정보 수정 근거, 반영된 API 응답, 같은 시간대 재실행 결과를 제출해야 합니다.'
    ELSE '경로 또는 접근성 공식 근거, 조치 완료 기록, 같은 출발 조건의 재실행 감사 ID와 최종 도착 결과를 제출해야 합니다.'
  END,
  `scenario_json` = json_object(
    'id', `id`,
    'scope', json_object(
      'areaCode', `region_code`,
      'districtCode', `district_code`
    ),
    'missionType', `mission_type`,
    'parameters', json_object(
      'failureCategory', CASE
        WHEN `mission_type` = 'policy_evidence_gap' THEN 'data_gap'
        WHEN `mission_type` = 'hub_evidence_gap' THEN 'content_gap'
        WHEN `mission_type` = 'recovery_scenario_gap' THEN 'operating_hours_gap'
        ELSE 'mobility_gap'
      END
    ),
    'calculationVersion', `calculation_version`,
    'evaluator', json_object(
      'metric', CASE
        WHEN `mission_type` = 'policy_evidence_gap' THEN 'official_evidence_coverage'
        WHEN `mission_type` = 'hub_evidence_gap' THEN 'confirmed_hub_count'
        WHEN `mission_type` = 'recovery_scenario_gap' THEN 'no_candidate_rate'
        WHEN `mission_type` = 'continuity_outcome_gap' THEN 'travel_abandonment_rate'
        ELSE 'mobility_no_candidate_rate'
      END,
      'betterWhen', CASE
        WHEN `mission_type` IN ('policy_evidence_gap', 'hub_evidence_gap') THEN 'higher'
        ELSE 'lower'
      END,
      'activationRule', '저장된 계산 버전의 동일 활성화 규칙',
      'observationWindow', CASE
        WHEN `mission_type` IN ('policy_evidence_gap', 'hub_evidence_gap') THEN 'official_base_month'
        ELSE 'rolling_30_days'
      END
    )
  );--> statement-breakpoint
CREATE INDEX `resilience_missions_failure_idx` ON `resilience_missions` (`failure_category`,`status`);
