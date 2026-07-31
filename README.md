# 이어가(IEOGA)

한국관광공사 OpenAPI를 이용해 전국 여행 중단 상황에서 적용 가능한
대안을 검증하고, 공식 데이터 공백과 동의 기반 비식별 복구 요청을
지역의 회복력 개선 미션으로 전환하는 웹 서비스입니다.

이 저장소에는 정적 시연 데이터나 합성 후보 폴백이 없습니다. 필수
OpenAPI를 확인하지 못하면 후보를 만들지 않고 장애·데이터 부족 상태를
응답합니다.

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
우선합니다. 전체 실제 데이터 검증은 12초 응답 예산을 넘기면
확인되지 않은 후보를 표시하지 않고 재시도 가능한 오류로 종료합니다.
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
PARTNER_API_KEY=파트너_복구_API용_별도_긴_임의값
OPS_API_KEY=운영_제어_API용_별도_긴_임의값
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

## 주요 API

| 경로 | 설명 |
|---|---|
| `GET /api/v1/capabilities` | 실제 지원 범위와 제한 |
| `GET /api/v1/regions` | 공식 전국 시도 코드 |
| `GET /api/v1/regions/{areaCode}/districts` | 공식 시군구 코드 |
| `GET /api/v1/places/search` | 공식 관광지 검색 |
| `POST /api/v1/recover` | 여행 중단 복구 실행 |
| `POST /api/v1/share` | 소유 세션의 복구 증명 링크 생성 |
| `GET /api/v1/insights/regions/{areaCode}` | 정책 근거 및 미션 재평가 |
| `GET /api/v1/insights/missions` | 공개 가능한 전국 회복력 미션 |
| `PATCH /api/v1/ops/missions/{missionId}` | 운영 미션 상태 변경 |
| `POST /api/v1/ops/missions/revalidate` | 동일 지역 범위 즉시 재검증 |
| `DELETE /api/v1/privacy/session` | 현재 익명 세션 데이터 삭제 |
| `GET /api/v1/health/live` | 프로세스 생존 상태 |
| `GET /api/v1/health/ready` | Secret·D1·R2 및 저장된 8종 점검 상태 |
| `POST /api/v1/ops/health/refresh` | 인증된 8종 OpenAPI 정밀 점검 |

`/api/v1/partner/*`는 `PARTNER_API_KEY`, `/api/v1/ops/*`는 별도의
`OPS_API_KEY` Bearer 인증이 필요합니다. 파트너 키로 운영 제어
API를 호출할 수 없습니다.

## 관리형 외부 제공자

공사 OpenAPI 외의 보조 데이터는 기본값이 공개 공유 엔드포인트이며, 이
상태에서는 준비 상태가 `degraded`로 표시됩니다. 아래를 설정하면 각
항목이 `managed`로 전환됩니다.

| 항목 | 환경변수 | 미설정 시 |
|---|---|---|
| 역지오코딩·장소검색 | `KAKAO_REST_API_KEY` | 공개 Nominatim |
| 도보 경로 | `ROUTING_BASE_URL` | 공개 OSRM |
| 날씨 | `WEATHER_API_URL` | 공개 Open-Meteo |

### 카카오 (역지오코딩·장소검색)

`KAKAO_REST_API_KEY` 하나로 두 가지가 함께 관리형으로 바뀝니다.
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

`ROUTING_BASE_URL`은 OSRM 호환 엔드포인트를 쉼표로 구분해 순서대로
받습니다. 앞에서부터 시도하고 실패하면 다음으로 넘어가며, 공개
제공자가 항상 마지막에 자동으로 붙습니다.

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
npm.cmd run build
npx.cmd wrangler d1 migrations apply site-creator-d1 --remote
cd dist/server
npx.cmd wrangler deploy --config wrangler.json
```

빌드가 `dist/server/wrangler.json`에 바인딩·크론 설정을 생성하므로 배포는
루트가 아니라 해당 파일을 사용합니다. 배포 직후 수 분간 자산 전파가
끝나지 않아 일부 요청이 404로 응답할 수 있으며, 전파가 끝나면 해소됩니다.

### Secret 등록

값이 명령 이력에 남지 않도록 대화형 입력을 사용합니다.

```powershell
npx.cmd wrangler secret put KTO_SERVICE_KEY --name ieoga-national-travel-resilience
npx.cmd wrangler secret put PARTNER_API_KEY --name ieoga-national-travel-resilience
npx.cmd wrangler secret put OPS_API_KEY --name ieoga-national-travel-resilience
```

`KTO_SERVICE_KEY`가 없으면 `/api/v1/health/ready`가 `configured: false`와
함께 `unavailable`을 반환하고, 후보를 지어내지 않고 조회 실패로 종료합니다.

## 배포 전 필수 작업

1. 공공데이터포털에서 노출 이력이 없는 KTO 인증키를 준비합니다.
2. 실제 D1 데이터베이스와 R2 버킷을 만들고 배포 설정에 연결합니다.
3. 모든 D1 마이그레이션을 운영 데이터베이스에 적용합니다.
4. `KTO_SERVICE_KEY`, `PARTNER_API_KEY`, `OPS_API_KEY`를 서로 다른
   배포 Secret으로 설정합니다.
5. 관리형 역지오코딩·보행 경로 엔드포인트를 연결하고 준비 상태가
   공유 공개 제공자 사용으로 저하되지 않는지 확인합니다.
6. 8종 OpenAPI 상태, 전국 지역코드, 복구, 정책 조회, 미션 재검증을
   운영 도메인에서 확인합니다.
7. API 호출량·오류율·지연시간·D1/R2 저장 실패를 모니터링합니다.
8. 개인정보 처리방침, 이용약관, 데이터 출처, 세션 삭제 흐름을
   운영 주체 정보와 함께 최종 법무 검토합니다.
