const TICKET_QUERY_PARAM_PATTERN = /([?&]ticket=)[^&\s]+/gi;

export function redactTicketFromUrl(url: string): string {
  if (!url.includes("ticket=")) return url;
  return url.replace(TICKET_QUERY_PARAM_PATTERN, "$1[REDACTED]");
}