export interface ExecutionResult {
  status: "success" | "error" | "denied" | "rate_limited";
  output: unknown;
  durationMs: number;
  errorMessage?: string;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface DateRangeFilter {
  startDate?: string;
  endDate?: string;
}