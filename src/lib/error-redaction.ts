const URL_CREDENTIAL_PATTERN = /(:\/\/[^:/@\s]+):([^@\s]*)@/g;
const BEARER_TOKEN_PATTERN = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi;
const KEY_VALUE_SECRET_PATTERN =
  /\b((?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*)([^\s&"']+)/gi;

export function redactSecrets(message: string): string {
  return message
    .replace(URL_CREDENTIAL_PATTERN, "$1:***@")
    .replace(BEARER_TOKEN_PATTERN, "$1 ***")
    .replace(KEY_VALUE_SECRET_PATTERN, "$1***");
}