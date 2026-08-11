# 이어가(IEOGA)

한국관광공사 OpenAPI를 이용해 전국 여행 중단 상황에서 적용 가능한
대안을 검증하고, 공식 데이터 공백과 동의 기반 비식별 복구 요청을
지역의 회복력 개선 미션으로 전환하는 웹 서비스입니다.

이 저장소에는 정적 시연 데이터나 합성 후보 폴백이 없습니다. 필수
OpenAPI를 확인하지 못하면 후보를 만들지 않고 장애·데이터 부족 상태를
응답합니다.

공개 화면은 여행 복구(`/flow`), 지역 회복력(`/policy`), 데이터
출처(`/sources`)와 개인정보 처리방침(`/privacy`), 이용약관(`/terms`),
접근성 선언(`/accessibility`)으로 구성됩니다. 검색엔진과 설치형 앱은
`/sitemap.xml`, `/robots.txt`, `/manifest.webmanifest`에서 동일한 공개
범위를 확인할 수 있습니다.

## 제품 범위

### 여행자 복구

- 전국 공식 시도·시군구 코드 조회
- 현재 위치 또는 공식 관광지 좌표를 출발점으로 사용
- 위치 권한 허용 시 소수점 다섯 자리로 줄인 좌표를 POST 본문으로
  전송해 행정구역을 자동 입력하며 URL·접근 로그에 좌표를 남기지 않음
- 우천, 지연, 혼잡, 이동 부담 조건별 대안 검증
- 시간·거리·실내·접근성 하드 필터
- 적용 가능한 후보가 없을 때 `0개`를 그대로 반환
- 결과별 출처 원장과 7일 만료 복구 증명 링크

복구를 실행하려면 사용자가 최초 진입에서 원래 일정과 다음 고정
장소를 등록해야 합니다. OpenStreetMap 기반 OSRM 보행 경로로
`현재 위치 → 대체 일정 → 사이의 모든 원래 일정 → 다음 고정 장소`
전체 순서의 이동시간과 도착 안전여유를 검증하며, 한 경유지라도
보존을 확인하지 못한 후보는 복구안에서 제외합니다. 일정 없는 주변
추천이나 직선거리 기반 복구 확정은 제공하지 않습니다. 통과하지
못한 후보 중 다른 모든 일정과 예약을 보존하면서 단 하나의 조건만
바꾸면 가능한 경우에는 그 최소 조정량만 반사실 증명으로 보여주며,
사용자 확인 없이 자동 적용하지 않습니다. Open-Meteo 현재 기상은
일정 복구의 보조 근거로 사용하며 사용자가 선택한 현장 상황을
우선합니다. `POST /api/v1/recover`의 20초는 후보 검색만의 목표 시간이
아니라 서버가 요청 처리를 시작한 때부터 입력·세션·요청 한도·저장 일정,
모든 외부 근거와 경로, D1 원자 저장까지를 포함하는 전체 상한입니다.
상한을 넘으면 HTTP 504 `RECOVERY_DEADLINE_EXCEEDED`로 종료하고 확인되지
않은 후보를 표시하거나 적용하지 않습니다. 저장 시작 전이면
`persistence.status: "not_started"`, D1 요청이 진행 중인 응답 경합이면
`persistence.status: "unknown"`을 반환합니다. `unknown`은 미저장을 뜻하지
않으므로 결과를 적용하지 말고 응답의 request ID로 상태를 확인하거나
재시도해야 합니다.
자동 위치에는 역지오코딩 제공자 출처를, 각 추천안과 적용안에는
경로 제공자 출처와 확인 시각을 화면에 표시합니다.
`/api/v1/capabilities`가 배포 버전의 지원 조건과 실패 시 동작을
기계 판독 형식으로 제공합니다.

### 전국 정책 인사이트와 회복력 미션

- 정책 OpenAPI 최신 가용 기준월 온디맨드 조회
- 공식 지표·중심 관광지 응답의 누락 및 오류를 개선 미션으로 변환
- 미션 상태를 `open → in_progress → ready_for_recheck`로 운영
- 같은 공식 지역 범위를 재조회해 `resolved` 또는 `reopened` 판정
- 이용자 요청 기반 미션은 분석 동의된 시군구 단위 비식별 익명
  세션이 30개 이상일 때만 생성하며, 한 세션은 기간 내 한 번만 기여
- 정확한 위치, 이동 경로, 30건 미만 행동 집계는 정책 API에 노출하지
  않음

정책 화면의 근거 커버리지는 관광지 품질이나 지역 성과 점수가
아닙니다. 공식 세부지표의 값 확인 여부를 나타냅니다.

## 한국관광공사 OpenAPI 8종

| 구분 | 서비스 | 제품 내 역할 |
|---|---|---|
| 여행자 | `KorService2` | 공식 지역코드, 관광지, 좌표, 기본정보 |
| 여행자 | `TarRlteTarService1` | 원래 관광지와 연관된 대안 근거 |
| 여행자 | `TatsCnctrRateService` | 향후 상대 집중률 예측 보조 |
| 여행자 | `KorWithService2` | 무장애·영유아·고령자 편의정보 검증 |
| 정책 | `LocgoHubTarService1` | 기초지자체 중심 관광지 근거 |
| 정책 | `AreaTarDemDsService` | 관광 체류·소비 수요 지표 |
| 정책 | `AreaTarResDemService` | 관광서비스·문화자원 수요 지표 |
| 정책 | `AreaTarDivService` | 관광객·소비·국제 다양성 지표 |

## 기술 구성

- Next.js 호환 `vinext` 애플리케이션
- Cloudflare Workers 런타임
- D1: 익명 세션, 일반화된 복구 결과, 정책 스냅샷, 회복력 미션
- R2: 버전이 지정된 전국 지역 정책팩
- Drizzle ORM 및 SQL 마이그레이션
- 정기 Worker 스케줄: 정책팩 갱신, 미션 재검증, 만료 데이터 삭제

실시간 출발 좌표와 실제 이동 경로는 D1에 저장하지 않습니다. 복구
실행에는 시도·시군구, 시간·거리 구간, 사건 유형, 후보 수처럼
일반화된 필드만 저장합니다. 사용자가 직접 저장한 일정 장소 좌표는
일정 복구를 위해 익명 세션에 최대 30일 보관하며 세션 삭제 또는
만료 시 함께 삭제합니다.

브라우저의 자동 위치 좌표는 URL 쿼리에 넣지 않고 소수점 다섯
자리로 줄인 POST 본문으로 역지오코딩 제공자에 일시 전송합니다.
OpenStreetMap 공개 Nominatim·공개 OSRM은 로컬 및 제한된 검증용
기본값이며, 일반 사용자 출시에서는 `REVERSE_GEOCODE_URL`과
`ROUTING_BASE_URL`에 관리형 또는 자체 운영 엔드포인트를 연결해야
합니다. 공개 준비 상태 API는 공유 공개 엔드포인트 사용을
`degraded`로 표시합니다.

현재 위치 좌표는 브라우저에서 소수점 다섯 자리로 줄인 뒤
`POST /api/v1/location/resolve` JSON 본문으로 전송합니다. 서버는 이를
행정구역 판별, 보행 경로 및 현재 기상 제공자에게 일시 전달할 수
있지만 URL, D1, 정책 집계에는 저장하지 않습니다. OpenStreetMap
Nominatim/OSRM을 사용하는 경우 화면에 `© OpenStreetMap contributors`
출처를 명시합니다.

## 로컬 실행

필요 환경은 Node.js 22.13 이상입니다.

```powershell
npm.cmd ci
Copy-Item .env.example .env.local
```

`.env.local`에 공공데이터포털의 일반 인증키(Decoding)를 입력합니다.

```dotenv
KTO_SERVICE_KEY=발급받은_일반_인증키
KMA_SERVICE_KEY=승인받은_기상청_일반_인증키
SESSION_SIGNING_KEY=32바이트_이상_별도_임의값
PARTNER_API_KEY=파트너_복구_API용_별도_긴_임의값
OPS_API_KEY=운영_제어_API용_별도_긴_임의값
RELEASE_AUDITOR_API_KEY=독립_증거_감사용_별도_긴_임의값
DEPLOYMENT_COMMIT_SHA=현재_배포에_포함된_40자리_Git_SHA
EMBED_ALLOWED_ORIGINS=https://partner.example.org
EVIDENCE_ARTIFACT_ALLOWED_ORIGINS=https://evidence.example.org
REVERSE_GEOCODE_URL=관리형_역지오코딩_엔드포인트
ROUTING_BASE_URL=관리형_OSRM_호환_보행경로_엔드포인트
```

인증키를 소스, 예제 파일, 브라우저 코드에 기록하지 마세요. 노출된
키는 공공데이터포털에서 재발급한 뒤 배포 환경의 Secret으로
교체해야 합니다.

D1 마이그레이션을 적용한 후 서비스를 실행합니다.

```powershell
npx.cmd wrangler d1 migrations apply site-creator-d1 --local
npm.cmd run dev -- --host localhost --port 4173
```

마이그레이션 이력 도입 전에 생성한 이어가 로컬 D1을 유지해야 하는
경우에는 먼저 아래 명령을 한 번 실행합니다. 이 스크립트는 기존
테이블 구조가 검증된 0000 스키마와 정확히 일치할 때만 기준 이력을
기록하며, 일정·복구 데이터는 삭제하지 않습니다.

```powershell
npm.cmd run db:baseline:legacy-local
npm.cmd run db:migrate:local
```

운영 빌드와 동일한 Cloudflare Workers 런타임으로 로컬 확인할 때는
다음을 사용합니다.

```powershell
npm.cmd run build
npm.cmd run start -- --port 4173
```

`start` 스크립트는 빌드 설정 파일의 위치와 관계없이 프로젝트 루트의
`.env.local` 및 기존 로컬 D1 상태를 절대 경로로 연결합니다. 따라서
개발 서버와 운영 로컬 서버가 서로 다른 빈 D1을 만드는 일을 막습니다.

## 검증

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
```

`npm.cmd run build`는 빌드 도구가 생성한 환경 파일을 산출물에서
제거하고, 로컬에 설정된 인증키가 `dist`에 남지 않았는지 자동
검사합니다. 이 검사가 실패한 산출물은 배포하지 않습니다.

출시 전 수동 검증은 [RELEASE_TEST_GUIDE.md](./RELEASE_TEST_GUIDE.md)를
따릅니다.
초행 사용자 20명, 실무자 3인, 6개 권역, K-TRIPBREAK 100과 성능·
오추천 현장 근거는 [FIELD_EVIDENCE_PLAYBOOK.md](./FIELD_EVIDENCE_PLAYBOOK.md)의
표본·개인정보·증거물 참조 규칙으로 수집합니다. OPS 제출자는
`POST /api/v1/ops/evidence`로 메타데이터를 등록하고, 별도 감사자는
`GET /api/v1/auditor/evidence/{evidenceId}`로 원본 참조와 검토자 정보를
대조한 뒤 `PATCH`로 승인 또는 반려합니다. OPS 등록 결과의 `validated`는
형식·기간·표본·임계값 통과만 뜻하며 상태는 `pending`입니다. 독립 감사의
명시적 `approved` 결정만 출시 증거로 집계하고, 한 번 결정한 증거는
덮어쓰지 않습니다. 코드 테스트나 문서만으로 현장 증거를 완료 처리하지
않습니다.

## 주요 API

| 경로 | 설명 |
|---|---|
| `GET /api/v1/capabilities` | 실제 지원 범위와 제한 |
| `GET /api/v1/regions` | 공식 전국 시도 코드 |
| `GET /api/v1/regions/{areaCode}/districts` | 공식 시군구 코드 |
| `GET·POST /api/v1/places/search` | 공식 관광지 검색. 현재 좌표는 JSON POST만 허용 |
| `POST /api/v1/recover` | 여행 중단 복구 실행 |
| `POST /api/v1/share` | 소유 세션의 복구 증명 링크 생성 |
| `GET /api/v1/insights/regions/{areaCode}` | 정책 근거 및 미션 재평가 |
| `GET /api/v1/insights/missions` | 공개 가능한 전국 회복력 미션 |
| `PATCH /api/v1/ops/missions/{missionId}` | 운영 미션 상태 변경 |
| `POST /api/v1/ops/missions/revalidate` | 동일 지역 범위 즉시 재검증 |
| `POST /api/v1/ops/evidence` | 운영 토큰으로 현장 증거 메타데이터 등록·임계값 검사 |
| `GET /api/v1/auditor/evidence/{evidenceId}` | 독립 감사자가 제출 증거 원본 참조·검토자 확인 |
| `PATCH /api/v1/auditor/evidence/{evidenceId}` | 독립 감사자의 일회성 승인·반려 결정 |
| `DELETE /api/v1/privacy/session` | 현재 익명 세션 데이터 삭제 |
| `GET /api/v1/health/live` | 프로세스 생존 상태 |
| `GET /api/v1/health/ready` | Secret·D1·R2, 저장된 8종·외부 제공자 실호출 점검 상태 |
| `POST /api/v1/ops/health/refresh` | 인증된 8종 OpenAPI·외부 제공자 응답 계약 정밀 점검 |

KTO 준비 상태는 필수 8종의 이름이 정확히 한 번씩 존재하고,
각 항목이 6시간 이내이며 오류가 없을 때만 `ready`입니다. 표시
시각과 스케줄러의 재점검 판정은 8건 중 가장 오래된
`checkedAt`을 사용합니다. 갱신은 8건을 하나의 D1 배치로
저장하므로 일부만 최신으로 보이는 중간 상태를 출시 근거로
사용하지 않습니다.

`/api/v1/partner/*`는 `PARTNER_API_KEY`, `/api/v1/ops/*`는
`OPS_API_KEY`, `/api/v1/auditor/*`는 `RELEASE_AUDITOR_API_KEY` Bearer
인증이 필요합니다. 세 키와 `SESSION_SIGNING_KEY`는 각각 CSPRNG로 생성한
32바이트 이상 값이며 모두 서로 달라야 합니다. 서버는 최소 길이와 알려진
placeholder·낮은 문자 다양성·반복 패턴을 차단하지만 실제 엔트로피까지
증명하지는 못하므로 생성 절차도 배포 체크리스트에서 확인합니다. 최소 품질을
위반하거나 재사용된 키의 인증 API는 실패로 닫히고 출시 증거와 준비 상태는
`release_blocker`·`degraded`로 남습니다. 인증된
파트너 키는 원문이 아닌 SHA-256
해시로 D1 클라이언트 레지스트리에 연결되며, 키 단위 분당 60회와
클라이언트별 일일 한도(기본 500회)를 원자적으로 적용합니다. 비활성·
해지 클라이언트나 사용량 저장소를 확인할 수 없는 요청은 실패로 닫고,
IP를 바꾸거나 Worker 인스턴스를 나누어도 키 할당량은 늘어나지 않습니다.

## 관리형 외부 제공자

공사 OpenAPI 외의 보조 데이터는 기본값이 공개 공유 엔드포인트이며, 이
상태에서는 준비 상태가 `degraded`로 표시됩니다. 관리형 제공자를
1순위로 추가했더라도 호출 가능한 체인에 공개 fallback이 남아 있으면
정식 출시 요건을 충족한 것으로 간주하지 않습니다. 역·정방향 지오코딩,
도보 경로, 날씨를 각각 관리형 엔드포인트로 닫아야 하며 최종 판정은
`/api/v1/health/ready`의 제공자별 상태와 `releaseRequirement`를
기준으로 합니다.

관리형 URL 문자열이 있다는 사실만으로는 출시 준비로 판정하지 않습니다.
인증된 운영 점검 또는 예약 작업이 서울의 고정 좌표·질의로 역지오코딩,
정방향 지오코딩, 모든 도보 경로 엔드포인트, 날씨의 실제 JSON 응답 계약을
검증하고 D1에 저장합니다. 현재 구성 지문과 일치하는 6시간 이내 성공
스냅샷이 네 항목 모두 있어야 하며, URL·질의 인증정보는 저장하지 않습니다.

| 항목 | 환경변수 | 미설정 시 |
|---|---|---|
| 역지오코딩·장소검색 | `KAKAO_REST_API_KEY`, `REVERSE_GEOCODE_URL`, `FORWARD_GEOCODE_URL` | 공개 Nominatim |
| 도보 경로 | `TMAP_APP_KEY`, `ROUTING_BASE_URL` | 공개 OSRM |
| 날씨 | `KMA_SERVICE_KEY`, `WEATHER_API_URL` | 공개 Open-Meteo |

### 기상청 단기예보 (날씨)

`KMA_SERVICE_KEY`를 설정하면 국내 공식 기상자료가 1순위가 됩니다.
`WEATHER_API_URL`을 비워 두면 장애 시 공개 Open-Meteo가 대체 경로로
남으므로 키 설정만으로 출시 요건이 충족되지는 않습니다. 관리형 날씨
대체 엔드포인트까지 설정한 뒤 준비 상태의 보수 판정을 확인합니다. 값은
`KTO_SERVICE_KEY`와 같은 공공데이터포털
일반 인증키이지만, **자동으로 빌려 쓰지 않고 별도로 적어야 동작합니다.**
포털이 데이터셋별로 활용신청을 따로 받기 때문에, 승인 없이 자동 사용하면
날씨 조회마다 5초를 버리고 실패하며 준비 상태에는 응답하지 않는 관리형
제공자가 표시됩니다.

data.go.kr에서 `기상청_단기예보 ((구)_동네예보) 조회서비스`를 활용신청하고
승인된 뒤 같은 인증키를 넣습니다. 승인 전에는 403이 반환되며 Open-Meteo로
대체됩니다.

`WEATHER_API_URL`에 `none`, `disabled`, `off` 중 하나를 넣으면 Open-Meteo
폴백이 없다고 명시적으로 선언합니다. 국내 전용 서비스에서 대한민국 공식
기상청만 사용하는 구성이 이에 해당합니다. 이 구성에서 기상청이 응답하지
않으면 기상 근거를 `unavailable`로 반환하며, 꺼 둔 제공자를 몰래 호출하지
않습니다. 현재 기상은 일정 복구의 보조 근거이고 사용자가 선택한 현장
상황이 우선하므로, 근거 하나가 빠지는 것이지 복구가 중단되지는 않습니다.

```dotenv
# 기상청 단독 운영. 공개 Open-Meteo 폴백 없음
KMA_SERVICE_KEY=승인받은_기상청_일반_인증키
WEATHER_API_URL=none
```

준비 상태가 `managed`로 바뀌면 예약 점검이 초단기실황을 실제로 호출해
응답 계약까지 검증합니다. 공공데이터포털은 미승인 서비스를 HTTP 200 본문의
`resultCode`로 알리므로, 상태 코드만으로는 통과하지 못합니다.

어댑터는 두 가지를 처리합니다.

- 위경도를 기상청 람베르트 5km 격자(`nx`, `ny`)로 변환. 공개된 기준 격자
  4곳(서울 종로·제주·춘천·대구)과 일치함을 테스트로 고정
- 발표 시각 내림. 초단기실황은 매시 40분 이후, 단기예보는 하루 8회
  발표 10분 이후부터 조회 가능하므로 그 이전에는 직전 발표를 사용

기상청의 `PTY`·`SKY` 값은 앱이 이미 사용하는 WMO 코드로 변환해, 제공자가
바뀌어도 호출부 해석이 달라지지 않습니다. 초단기실황에는 체감온도가 없어
계산값을 관측값처럼 제시하지 않고 기온을 그대로 사용합니다.

### 카카오 (역지오코딩·장소검색)

`KAKAO_REST_API_KEY` 하나로 역지오코딩과 장소검색의 1순위 관리형 호출을
설정합니다. 하지만 `REVERSE_GEOCODE_URL`과 `FORWARD_GEOCODE_URL`을 비워
두면 뒤쪽 공개 Nominatim 경로가 그대로 남으므로 준비 상태는 정식 출시를
차단합니다. 공개 fallback까지 제거하려면 두 경로도 관리형 또는 자체 운영
Nominatim 호환 엔드포인트로 설정합니다.
[Kakao Developers](https://developers.kakao.com)에서 애플리케이션을
만들고 REST API 키를 발급받습니다.

역지오코딩은 `coord2regioncode`가 돌려주는 법정동 코드의 앞 2자리와
5자리를 시도·시군구 코드로 사용합니다. 공개 Nominatim 경로가 장소
*이름*을 공사 목록과 문자열 대조하는 것과 달리 코드가 직접 대응하므로
표기 차이나 행정구역 개편에 영향을 받지 않습니다. 두 코드 모두 공사
공식 목록으로 다시 검증하며, 목록에 없는 코드는 사용하지 않습니다.

카카오 호출이 실패하면 공개 Nominatim, 그다음 공사 관광정보 최근접
콘텐츠 순으로 내려갑니다. 각 응답은 어느 제공자가 답했는지
(`source`, `confidence`)를 함께 반환합니다.

### 도보 경로

`TMAP_APP_KEY`를 설정하면 TMAP 보행자 경로안내가 1순위가 됩니다. 국내
지하상가 연결과 횡단보도를 공개 OSRM보다 정확히 반영하며, 도착 시각이
"다음 예약을 지킬 수 있는가"의 판정 근거이므로 경로 품질이 곧 판정
품질입니다. TMAP은 OSRM 호환 규격이 아니라 별도 어댑터이므로
`ROUTING_BASE_URL`에는 넣을 수 없습니다.

**키가 있다는 것만으로 준비 상태가 `managed`가 되지는 않습니다.**
판정 기준은 "무엇이 먼저 응답하는가"가 아니라 "호출 가능한 전체 체인에
공개 공유 서버가 남아 있는가"입니다. 카카오·기상청과 같은 기준입니다.
따라서 `TMAP_APP_KEY`만 설정하면 뒤에 공개 OSRM이 남아 있어
`public_shared`입니다. 준비 상태가 `managed`로 바뀌면 예약 점검이 TMAP
보행자 경로 API를 실제로 호출해 응답 계약까지 검증합니다.

`ROUTING_BASE_URL`은 OSRM 호환 엔드포인트를 쉼표로 구분해 순서대로
받습니다. 앞에서부터 시도하고 실패하면 다음으로 넘어갑니다. 값이 있으면
그 목록이 전체 호출 체인이며 공개 제공자는 자동으로 추가되지 않습니다.
공개 OSRM을 목록에 직접 넣은 경우에는 fallback 여부를 숨기지 않고 준비
상태를 `public_shared`로 판정합니다.

`none`, `disabled`, `off` 중 하나를 넣으면 OSRM 폴백이 없다고 명시적으로
선언합니다. TMAP만으로 운영하는 구성을 표현하기 위한 값입니다.

```dotenv
# TMAP 단독 운영. 공개 OSRM 폴백 없음
TMAP_APP_KEY=발급받은_REST_앱키
ROUTING_BASE_URL=none
```

이 구성에서 TMAP이 실패하면 경로를 확인하지 못한 후보는 그대로
탈락합니다. 아래에 적힌 대로 의도된 동작이며, 폴백이 필요하면
`ROUTING_BASE_URL`에 엔드포인트를 명시적으로 넣으십시오.

```dotenv
# 자체 운영 OSRM
ROUTING_BASE_URL=https://osrm.example.com/route/v1/foot

# 질의 문자열로 인증하는 관리형 제공자도 그대로 사용 가능
ROUTING_BASE_URL=https://api.mapbox.com/directions/v5/mapbox/walking?access_token=발급받은_토큰
```

좌표는 경로(path)에 이어 붙이므로 인증용 질의 문자열이 보존됩니다.
질의 문자열 안의 쉼표는 구분자로 처리하지 않습니다.

경로를 확인하지 못한 후보는 직선거리로 추정해 통과시키지 않고
탈락시킵니다. 따라서 경로 제공자가 모두 실패하면 복구안이 줄어들거나
0개가 되며, 이는 의도된 동작입니다.

## 배포 현황

| 항목 | 값 |
|---|---|
| 운영 URL | https://ieoga-national-travel-resilience.sans5-poems-5045.workers.dev |
| 런타임 | Cloudflare Workers |
| D1 | `site-creator-d1` (마이그레이션 7종 적용 완료) |
| R2 | `site-creator-r2` (Standard) |
| 예약 실행 | 매시 17분 — 정책팩 갱신, OpenAPI 8종 상태 점검 |

### 배포 절차

```powershell
npx.cmd wrangler d1 migrations apply site-creator-d1 --remote
```

운영 D1 마이그레이션과 백업을 확인한 뒤 GitHub Actions의
`Release production worker` workflow를 `main`에서 실행합니다. 제출 후보를
로컬 `wrangler deploy`로 직접 배포하면 서명된 단일 빌드 영수증이 없으므로
출시 게이트를 통과할 수 없습니다.

workflow는 clean HEAD에서 `npm run build`를 정확히 한 번 실행하고,
`dist/server` 전체의 canonical worker digest와 `dist/client` 정적 파일
manifest digest를 계산합니다. 같은 빌드에 대해 coverage 임계값,
증거 구조, Chromium 360·390·768·1280px E2E를 모두 통과한 뒤에만 같은
디렉터리를 재번들링 없이
`--no-bundle --tag $GITHUB_SHA`로 배포하고, 런타임 version metadata와
Cloudflare control plane의 100% traffic·tag·timestamp·script ETag를 확인한
뒤 `outputs/release/release-receipt.json`을 만듭니다. 이 receipt는
worker/static manifest의 고정 로컬 경로와 canonical digest까지 포함하며,
immutable commit SHA로 고정한 `actions/attest@v4`의 GitHub-hosted
OIDC/Sigstore provenance로 서명됩니다. checkout·Node setup·artifact upload
action도 모두 full commit SHA로 고정합니다.

GitHub `production` environment에는 required reviewer, `main` 전용 deployment
branch policy, 관리자 우회 금지를 설정합니다. 현재 릴리스는 보호된 수동 승인
뒤 pre-deploy 품질 게이트를 모두 통과한 단일 `wrangler deploy`로 100%를
전환합니다. workflow 외부의 직접 배포는 receipt를 만들지 못하므로 제출본으로
인정하지 않습니다.

### Secret 등록

값이 명령 이력에 남지 않도록 대화형 입력을 사용합니다.

```powershell
npx.cmd wrangler secret put KTO_SERVICE_KEY --name ieoga-national-travel-resilience
npx.cmd wrangler secret put SESSION_SIGNING_KEY --name ieoga-national-travel-resilience
npx.cmd wrangler secret put PARTNER_API_KEY --name ieoga-national-travel-resilience
npx.cmd wrangler secret put OPS_API_KEY --name ieoga-national-travel-resilience
npx.cmd wrangler secret put RELEASE_AUDITOR_API_KEY --name ieoga-national-travel-resilience
```

GitHub의 `production` environment에는 최소 권한의
`CLOUDFLARE_ACCOUNT_ID`와 Workers Scripts Edit/Read 전용
`CLOUDFLARE_API_TOKEN`을 등록합니다. workflow가 정확한 HEAD를
`DEPLOYMENT_COMMIT_SHA`와 Worker version tag에 함께 주입합니다. 배포 후
런타임 SHA·Cloudflare version ID/ETag·서명 receipt·로컬 HEAD·현장 원장의
SHA가 모두 같아야 하며 하나라도 다르면 출시 게이트가 실패합니다. iframe
파트너는 `EMBED_ALLOWED_ORIGINS`에 정확한 HTTPS origin을 쉼표로 등록합니다.

`KTO_SERVICE_KEY`가 없으면 `/api/v1/health/ready`가 `configured: false`와
함께 `unavailable`을 반환하고, 후보를 지어내지 않고 조회 실패로 종료합니다.

## 배포 전 필수 작업

1. 공공데이터포털에서 노출 이력이 없는 KTO 인증키를 준비합니다.
2. 실제 D1 데이터베이스와 R2 버킷을 만들고 배포 설정에 연결합니다.
3. 모든 D1 마이그레이션을 운영 데이터베이스에 적용합니다.
4. `KTO_SERVICE_KEY`를 설정하고 `SESSION_SIGNING_KEY`, `PARTNER_API_KEY`,
   `OPS_API_KEY`, `RELEASE_AUDITOR_API_KEY`를 각각 CSPRNG로 생성한
   32바이트 이상의 예측 불가능하고 서로 다른 배포 Secret으로 설정합니다.
   readiness의 최소 품질 통과만으로 엔트로피가 증명된다고 간주하지 않습니다.
5. 정방향·역방향 지오코딩, 보행 경로, 날씨의 관리형 제공자를 연결하고
   공개 fallback 포함 여부까지 반영한 준비 상태가 `ready`,
   `releaseRequirement`가 `satisfied`인지 확인합니다.
6. 8종 OpenAPI 상태, 전국 지역코드, 복구, 정책 조회, 미션 재검증을
   운영 도메인에서 확인합니다.
7. API 호출량·오류율·지연시간·D1/R2 저장 실패를 모니터링합니다.
8. 개인정보 처리방침, 이용약관, 데이터 출처, 세션 삭제 흐름을
   운영 주체 정보와 함께 최종 법무 검토합니다.
9. release workflow artifact를 저장소 안의 ignored 경로인
   `outputs/release/`에 내려받고, `evidence/submission-manifest.example.json`을
   복사한 실제 manifest에 receipt path·SHA-256·bundle digest·asset manifest
   digest·두 canonical manifest path를 기록합니다.
10. GitHub CLI 인증 후 `npm run release:gate`로 제출 SHA·배포 SHA·Cloudflare
    control plane·Sigstore provenance·원장 SHA와 모든 현장 임계값을
    대조합니다. 게이트는 exact repository, exact signer workflow,
    `refs/heads/main`, source HEAD를 강제하고 self-hosted runner 증명을
    거부합니다. 또한 운영 origin에서 redirect 없이 모든 `.js`·`.css`·`.wasm`,
    `sw.js`, `manifest.webmanifest`의 실제 바이트를 다시 해시하고 `/`, `/app`,
    `/flow`, `/plan`, `/embed/recover` HTML의 same-origin JS/CSS 참조가 서명
    manifest에 모두 포함됐는지 확인합니다. 마지막으로
    `/api/v1/health/ready`가 `ready`인지 확인합니다.

### 배포 실패·롤백 runbook

배포 뒤 receipt 생성, attestation, 원격 바이트 검증 중 하나라도 실패하면 해당
실행의 receipt를 제출하거나 수동으로 재작성하지 않습니다. `production`
environment 승인권자가 Cloudflare 배포 이력과 직전 제출 게이트 통과 version ID를
확인한 뒤 다음과 같이 그 단일 known-good version으로 100% 복귀합니다.

```powershell
npx.cmd wrangler versions list --name ieoga-national-travel-resilience
npx.cmd wrangler versions deploy "KNOWN_GOOD_VERSION_ID@100%" --name ieoga-national-travel-resilience --yes
```

복귀 후 `/api/v1/release/version`의 version ID/tag/timestamp와 Cloudflare control
plane의 100% traffic·script ETag가 known-good receipt와 일치하는지 확인합니다.
실패한 version의 receipt는 폐기하고, 원인을 수정해 `main`에 반영한 다음 새
`Release production worker` 실행으로 새 attestation을 발급합니다. 롤백 자체를
새 제출 증명으로 재사용하지 않습니다.
