export type HandlerStatus = "success" | "error" | "timeout" | "payload_too_large";

export interface HandlerResult{
  status : HandlerStatus;
  result ?: any;
  error ?: string;
}

export interface ExecutionResult extends HandlerResult {
  durationMs : number ;
}

export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // HTTP handler ceiling
export const MAX_WEBFETCH_BYTES = 2 * 1024 * 1024; // WebFetch — smaller, it's meant for text content
export const MAX_POSTGRES_ROWS = 1_000;
export const MAX_POSTGRES_PAYLOAD_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DNS_TIMEOUT_MS = 5_000; // bounded well below the 30s handler budget
export const CONNECTION_TIMEOUT_MS = 10_000

export class TimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export class PayloadTooLargeError extends Error {
  constructor(
    public actualBytes : number,
    public maxBytes : number,

  ){
    super(`Payload too large: ${actualBytes} bytes (max ${maxBytes} bytes)`);
    this.name = "PayloadTooLargeError";
  }
}

export class SsrfBlockedError extends Error {
  constructor(
    public hostname: string,
    public ip: string,
    public reason: string,
    public family: 4 | 6,
    public allResolvedIps: readonly string[]
  ) {
    super(`SSRF blocked: ${hostname} resolves to ${ip} (${reason})`);
    this.name = "SsrfBlockedError";
  }
}