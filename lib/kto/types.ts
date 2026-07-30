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
