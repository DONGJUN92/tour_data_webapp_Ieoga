export type KtoServiceName =
  | "KorService2"
  | "TarRlteTarService1"
  | "TatsCnctrRateService"
  | "KorWithService2"
  | "LocgoHubTarService1"
  | "AreaTarDemDsService"
  | "AreaTarResDemService"
  | "AreaTarDivService";

export type KtoItem = Record<string, unknown>;

export type KtoCallStatus = "live" | "empty" | "error" | "not_required";

export type KtoAudit = {
  apiName: KtoServiceName;
  operation: string;
  status: KtoCallStatus;
  httpStatus?: number;
  latencyMs: number;
  resultCount: number;
  totalCount: number;
  sourceReferenceDate?: string;
  fieldsUsed: string[];
  errorCode?: string;
  /* 이 논리적 호출이 실제로 **바깥으로 몇 건** 나갔는가. 원장 항목 수와 같지
     않다: 재시도는 2건, 지연 헤지는 2건, 엣지 캐시 적중은 0건, 그리고 호출하지
     않기로 한 `not_required`도 0건이다.

     예산 계량기가 이 값을 세지 않고 원장 항목 수를 세고 있었다. 그래서 부르지도
     않은 호출에 예산을 청구하고, 헤지로 두 번 나간 호출은 한 건으로 계산했다.
     그 어긋남이 실제 호출을 플랫폼 상한(무료 50건) 밖으로 밀어냈고, 상한을
     넘어 실패한 경로 조회가 화면에서는 "이 장소에는 갈 길이 없다"로 보였다. */
  upstreamCalls: number;
};

export type KtoCallResult = {
  items: KtoItem[];
  totalCount: number;
  pageNo: number;
  numOfRows: number;
  audit: KtoAudit;
};

export class KtoError extends Error {
  readonly code: string;
  readonly status: number;
  readonly audit: KtoAudit;

  constructor(message: string, code: string, status: number, audit: KtoAudit) {
    super(message);
    this.name = "KtoError";
    this.code = code;
    this.status = status;
    this.audit = audit;
  }
}
