# 이어가 출시 검증 가이드

모든 검증은 실제 배포 환경과 실제 한국관광공사 OpenAPI 응답을
사용합니다. 정적 후보, 합성 정책값, 장애 시 관광지 폴백을 허용하지
않습니다.

## 1. 환경과 마이그레이션

- `.env.example`과 저장소 전체에 실제 인증키가 없는지 확인합니다.
- 배포마다 다른 32바이트 이상의 예측 불가능한 `SESSION_SIGNING_KEY`가
  Secret으로 설정되고, 테스트용 고정키나 `OPS_API_KEY` 대체키에 기대지
  않는지 확인합니다.
- `SESSION_SIGNING_KEY`, `OPS_API_KEY`, `PARTNER_API_KEY`,
  `RELEASE_AUDITOR_API_KEY`가 각각 CSPRNG로 생성된 32바이트 이상 값이고
  네 값이 모두 서로 다른지 확인합니다. `/api/v1/health/ready`의
  `releaseSecrets`는 길이·placeholder·문자 다양성·반복 패턴·분리를
  검사하지만 실제 엔트로피를 증명하지 않으므로 생성 기록도 별도로 확인합니다.
- D1 마이그레이션이 순서대로 적용되는지 확인합니다.
- 실제 D1·R2 바인딩이 없을 때 서비스가 준비 상태 오류를 명확히
  반환하는지 확인합니다.
- `npm ci` 후 `npm run quality`가 모두 통과해야 합니다. 이 명령은
  타입 검사, 린트, 프로덕션 빌드, 계약 테스트, 커버리지 하한,
  운영 의존성 감사를 순서대로 실행합니다.
- `npm audit --omit=dev --audit-level=high`에서 취약점이 한 건이라도
  발견되면 출시하지 않습니다.

## 2. 전국 범위

- `/api/v1/regions` 응답이 고정 배열이 아니라 공식 API 결과인지
  확인합니다.
- 서로 다른 세 개 이상의 시도에서 시군구와 관광지 검색을
  확인합니다.
- 선택 지역과 관광지 좌표가 불일치할 때 다른 지역의 근거가
  섞이지 않는지 확인합니다.

## 3. 여행 복구

각 사건 유형을 실제 관광지에서 실행합니다.

- 우천: 실내 적합성이 확인되지 않은 후보가 자동 적용되지 않음
- 지연: 시간·거리 상한을 넘는 후보가 제외됨
- 혼잡: 상대 집중률 예측의 기준일과 한계가 표시됨
- 이동 부담: 요청한 접근성 근거가 없으면 확인됨으로 간주하지 않음

공통 확인사항:

- 후보가 없는 조건에서 결과가 0개로 유지됨
- 요청 ID, 생성시각, 사용 OpenAPI 원장이 표시됨
- 저장 일정과 다음 고정 장소가 있으면 OpenStreetMap 기반 OSRM 보행
  경로와 확인 시각이 표시되고, 대체 장소부터 사이의 모든 원래
  일정과 다음 고정 장소까지 한 구간이라도 확인 실패한 후보는 일정
  복구안에서 제외됨
- 반사실 대안은 다른 일정·예약을 보존하는 단 하나의 최소 조건
  조정량만 표시하고, 해당 CTA가 그 조건 하나만 바꿔 재계산함
- `POST /api/v1/recover` 진입부터 입력·세션·요청 한도·저장 일정 확인,
  외부 근거·경로 검증, D1 원자 저장까지의 전체 처리가 20초를 넘으면
  확인되지 않은 후보 없이 HTTP 504 `RECOVERY_DEADLINE_EXCEEDED`로 종료됨.
  저장 시작 전은 `persistence.status: "not_started"`, D1 요청 진행 중
  응답 경합은 `persistence.status: "unknown"`이어야 하며, 클라이언트와
  문서는 `unknown`을 미저장으로 단정하거나 해당 결과를 적용하지 않음
- 원래 일정과 이후 고정·예약 일정이 없으면 복구 요청 자체가
  거절되고 주변 추천으로 우회하지 않음
- 등록 일정 복구에서 Open-Meteo 현재 기상과 관측 시각을 표시하고,
  자동 기상과 사용자가 선택한 현장 상황이 다르면 사용자 입력을
  우선했다는 경고를 표시함
- API 장애 시 실제 후보처럼 보이는 폴백이 생성되지 않음

## 4. 복구 증명과 개인정보

- 복구를 실행한 세션만 증명 링크를 만들 수 있어야 합니다.
- 공유 링크는 7일 후 만료되고 소유 세션에서 철회할 수 있어야
  합니다.
- 증명서와 복구 실행 기록에 실시간 출발 좌표와 실제 이동 경로가
  없어야 합니다.
- 사용자가 저장한 일정 장소 좌표는 해당 익명 세션에만 귀속되고,
  30일 만료 또는 세션 삭제 시 함께 삭제돼야 합니다.
- `/api/v1/privacy/session` 삭제 후 세션·복구·공유 데이터에 다시
  접근할 수 없어야 합니다.

## 5. 정책 근거와 회복력 미션

- 시도 단위 정책 조회는 7개 세부지표를 기준으로 근거 충족률을
  계산합니다.
- 시군구 단위는 중심 관광지 근거를 추가로 확인합니다.
- 지표 누락 또는 원천 오류가 있으면
  `policy_evidence_gap` 미션이 생성됩니다.
- 시군구 중심 관광지 근거가 없으면 `hub_evidence_gap` 미션이
  생성됩니다.
- 미션을 `ready_for_recheck`로 변경한 뒤 동일 지역을 재검증하면
  공백이 남은 경우 `open`, 해결된 경우 `resolved`가 됩니다.
- 분석 동의 익명 세션이 30개 미만이면 행동 기반 미션과 집계값을
  응답에서 확인할 수 없어야 하며, 한 세션의 반복 요청은 한 번만
  집계돼야 합니다.

## 6. OpenAPI 8종 투명성

- 8개 서비스 모두 현재 상태, 오퍼레이션, 기준일 또는 오류코드를
  구분해 반환해야 합니다.
- 공개 사용자 상태 화면은 캐시된 운영 상태를 사용하고, 반복적인
  심층 점검으로 일 호출량을 소모하지 않도록 모니터링합니다.
- 8종 실호출 점검은 인증된 `POST /api/v1/ops/health/refresh`에서만
  실행되고, 같은 요청에서 관리형 역·정방향 지오코딩, 도보 경로, 날씨의
  실제 응답 계약도 검증되어야 합니다. 공개 준비 상태 조회는 외부 호출을
  만들지 않고 저장된 스냅샷만 읽어야 합니다.
- KTO 스냅샷은 필수 8종의 정확한 집합(누락·중복·기타 출처 없음)을
  하나의 D1 배치로 저장하고, 8건 모두 개별 6시간 신선도와 성공
  상태를 통과해야 합니다. 준비 상태·출시 증빙·스케줄러는 모두
  가장 오래된 `checkedAt`을 기준으로 판정하고, 한 건이라도 낡거나
  저장이 실패하면 새 세대 전체를 출시 근거로 인정하지 않습니다.
- 관리형 URL 문자열만 설정한 상태, `example.invalid`, 무응답·계약 불일치,
  구성 변경 후 이전 성공 기록, 6시간을 넘긴 성공 기록은 모두 출시
  차단으로 표시되어야 합니다. 공개 공유 제공자도 계속 차단합니다.
- 파트너 복구 키와 운영 제어 키가 분리되어 파트너 키로
  `/api/v1/ops/*`를 호출할 수 없어야 합니다.
- 파트너 복구는 키 해시 기준 분당 60회와 등록 클라이언트의 일일
  한도를 D1에서 원자 적용하고, 다른 IP·Worker에서도 합산되어야 합니다.
  비활성·해지 클라이언트와 사용량 저장 실패는 각각 403·503으로
  실패해야 하며, 일일 초과는 한국 날짜의 다음 자정까지 429여야 합니다.
- 인증키, 원문 응답 전체, 개인 위치는 감사 로그에 기록하지
  않습니다.

## 7. 반응형·접근성

- 최초 1회 `npx playwright install chromium`을 실행한 뒤
  `npm run build && npm run test:e2e`로 실브라우저 검증을 실행합니다.
- `/app`, `/plan`, `/flow`, `/embed/demo`, `/embed/recover`를 포함해
  360px, 390px, 768px, 1280px 이상에서 가로 스크롤이 없어야
  합니다.
- 키보드만으로 지역 선택, 관광지 검색, 사건 선택, 복구 실행,
  정책 조회가 가능해야 합니다.
- 오류와 로딩 상태가 화면 낭독기에 전달돼야 합니다.
- 200% 확대에서도 필수 입력과 실행 버튼이 가려지지 않아야
  합니다.
- axe의 WCAG 2 A·AA serious/critical 위반과 Lighthouse 색 대비
  위반이 없어야 합니다. 모바일·데스크톱 Lighthouse 모두 성능 0.90,
  접근성 1.00, 모범사례 0.95, SEO 0.95 미만이면 출시하지 않습니다.

## 8. PWA·검색·장애 복구

- `/manifest.webmanifest`가 `standalone`, 192·512px 아이콘,
  maskable 아이콘을 반환해야 합니다.
- `/sw.js`는 API와 쓰기 요청을 캐시하지 않고, 네트워크가 끊긴 문서
  탐색만 `/offline`으로 안내해야 합니다.
- 서비스워커는 `Cache-Control: no-store`와
  `Service-Worker-Allowed: /` 헤더로 제공되어야 합니다.
- `/sitemap.xml`에는 `/app`, `/plan`, `/flow`, `/policy`, `/sources`,
  `/privacy`, `/terms`, `/accessibility`가 포함돼야 하고 `/robots.txt`는 API와
  오프라인 안내 페이지의 색인을 막아야 합니다.
- Open Graph와 Twitter 이미지는 현재 배포 호스트의 `/og.png`를
  사용해야 하며 존재하지 않는 도메인을 가리키면 출시하지 않습니다.

## 9. 현장 증거와 최종 출시 판정

`FIELD_EVIDENCE_PLAYBOOK.md` 절차로 수집한 증거는 다음 순서로만
출시 판정에 반영합니다.

1. OPS 제출자가 `OPS_API_KEY`로 `POST /api/v1/ops/evidence`를 호출합니다.
   형식 검증 통과 응답도 `validated_pending_independent_audit`이며 출시
   완료가 아닙니다.
2. OPS와 다른 담당자가 별도 `RELEASE_AUDITOR_API_KEY`로
   `GET /api/v1/auditor/evidence/{evidenceId}`를 호출해 artifact 원본,
   측정시각, 표본, 권역, 검토자 자격을 대조합니다.
3. 같은 감사자가 해당 경로에 `PATCH` 요청으로
   `{ "decision": "approved", "approvedBy": "감사자 식별자" }` 또는
   반려 사유를 포함한 `rejected`를 기록합니다.
4. `pending → approved/rejected` 결정은 한 번만 허용합니다. 오직 최신의
   유효·180일 이내·독립 `approved` 증거만 `verified`로 집계합니다.
5. 운영 배포는 `main`의 `Release production worker` workflow로만 수행합니다.
   이 workflow는 clean HEAD에서 한 번 빌드한 `dist/server`와 `dist/client`를
   canonical SHA-256으로 고정합니다. 배포 전 같은 단일 빌드로 coverage 임계값,
   증거 구조, Chromium 360·390·768·1280px E2E를 모두 통과해야 합니다. 그 뒤
   같은 파일을 `--no-bundle --tag HEAD`로 배포하고 runtime version metadata와
   Cloudflare의 100% traffic·tag·timestamp·script ETag를 결속한 release
   receipt를 생성합니다. GitHub `production` environment는 required reviewer,
   `main` 전용 deployment branch policy, 관리자 우회 금지를 적용해야 합니다.
6. workflow artifact의 `release-receipt.json`과 canonical manifest를
   `outputs/release/`에 내려받습니다. 실제 `outputs/submission-manifest.json`은
   receipt path·receipt SHA-256·bundle digest·asset manifest digest·서명된
   worker/static manifest path를 모두 포함해야 합니다. `outputs/`는 ignored
   경로이므로 배포 뒤 생성된 receipt가 clean HEAD를 바꾸지 않습니다.
7. GitHub CLI를 인증한 뒤 `npm run release:gate`를 실행합니다. 게이트는
   `gh attestation verify`로 repository
   `DONGJUN92/tour_data_webapp_Ieoga`, signer workflow
   `.github/workflows/release-production.yml`, source digest HEAD,
   `refs/heads/main`, GitHub-hosted runner를 정확히 강제합니다. self-hosted
   runner attestation, 다른 workflow/repository/ref, 다른 receipt bytes는
   모두 실패해야 합니다. 이어서 두 canonical manifest JSON을 canonical
   SHA-256으로 다시 계산하고, 운영 origin에서 redirect 없이 모든
   `.js`·`.css`·`.wasm`, `sw.js`, `manifest.webmanifest` 실제 바이트를 검증합니다.
   `/`, `/app`, `/flow`, `/plan`, `/embed/recover` HTML이 참조하는 same-origin
   JS/CSS가 static manifest에 하나라도 빠지면 실패해야 합니다. 검증 전후
   runtime version ID와 Cloudflare script ETag도 같아야 합니다.
8. 제출 CSV 해시는 배포본이 공개하는 독립 승인 artifact digest와 일치해야
   하고, 행별 외부 artifact는 실제 바이트 재다운로드·SHA-256 검증을
   통과해야 합니다. 실사용자 동의 참조는 별도 승인된 가명 동의 원장
   digest와 교차검증합니다.

### 배포 뒤 실패 시 복구

receipt 생성, attestation 또는 제출 게이트가 실패한 배포는 제출할 수 없습니다.
receipt를 수동 편집하거나 실패 실행의 manifest를 재사용하지 않습니다. 보호된
`production` 승인권자가 `npx wrangler versions list --name
ieoga-national-travel-resilience`로 직전 known-good version ID를 확인하고,
`npx wrangler versions deploy "KNOWN_GOOD_VERSION_ID@100%" --name
ieoga-national-travel-resilience --yes`로 단일 version 100%를 복원합니다. 이후
runtime version metadata와 Cloudflare control plane이 known-good receipt의
version ID/tag/timestamp/script ETag와 일치하는지 확인합니다. 원인 수정은 새
`main` commit과 새 release workflow/attestation으로만 출시합니다.

Bearer 토큰은 담당자의 법적 신원이나 증거물 진위를 스스로 보증하지
않습니다. 테스트 통과나 문서 작성만으로 초행 사용자, 실무자 검토,
6개 권역, K-TRIPBREAK 100을 완료 처리하지 않습니다.

`node scripts/smoke-production.mjs`는 다음을 모두 확인해야 성공합니다.

- 출시 증거 보고서 `overall`이 `ready`
- 모든 증거 항목이 `verified`
- 준비 상태 HTTP 200 및 `overall`이 `ready`
- KTO 8종이 최신·무오류이고 관리형 외부 제공자 요구가 `satisfied`
- 출시용 Secret 4개가 모두 CSPRNG 생성·최소 품질 통과·상호 분리되고 현장 증거가
  독립 감사 `approved`

다음 중 하나라도 해당하면 출시를 중단합니다.

- 실제 인증키가 저장소나 브라우저 번들에 포함됨
- D1 마이그레이션 또는 R2 쓰기가 실패함
- 없는 관광지를 폴백 데이터로 생성함
- 접근성·운영정보 미확인을 확인 완료로 표시함
- 30건 미만 이용행동 집계를 공개함
- 특정 지역만 성공하고 다른 공식 지역에서 코드·매칭이 깨짐
- 출시 증거가 `blocked` 또는 `evidence_collection`임
- 준비 상태가 `degraded`, `not_checked`, `unavailable`임
