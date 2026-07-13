import ipaddr from "ipaddr.js";


/*
  This module only checks if the given URL is valid enough to be considered as an URL or not .
  It doesn't yet do DNS checkup to get the actual IP address and decide it's safety


  This is a deliberate design choice to prevent SSRF attack . Later DNS checkup will be done when an agent is actually trying to resolve an URL to an IP address and make a connection to it. This is because the DNS resolution can be manipulated by an attacker to resolve to a private IP address or localhost, which can lead to SSRF attacks.
  That's why instead of doing DNS resolution at the time of tool creation , we're doing it when an agent is actually trying to resolve an URL to an IP address and make a connection to it. This way, we can prevent SSRF attacks by checking the resolved IP address against a list of allowed IP addresses or ranges before making the connection
*/


const ALLOWED_HTTP_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_POSTGRES_SCHEMES = new Set(["postgres:", "postgresql:"]);

const BLOCKED_LITERAL_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal", // GCP metadata hostname alias
]);


const BLOCKED_IP_RANGES = new Set([
  "private",         // RFC 1918 (10/8, 172.16/12, 192.168/16)
  "loopback",        // 127.0.0.0/8, ::1
  "linkLocal",       // 169.254.0.0/16 — cloud metadata range
  "uniqueLocal",     // IPv6 equivalent of RFC 1918 (fc00::/7)
  "reserved",
  "carrierGradeNat", // 100.64.0.0/10
  "unspecified",     // 0.0.0.0, ::
]);


export interface NetworkSafetyCheckResult {
  isSafe: boolean;
  reason?: string;
}

export function checkHostnameSafety(rawHostname: string): NetworkSafetyCheckResult {

  // stp1 : normalize the hostname
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  const normalized = hostname.toLowerCase();

  // step2 : check if the hostname is in the blocked list
  if (BLOCKED_LITERAL_HOSTNAMES.has(normalized)) {
    return { isSafe: false, reason: `Hostname ${normalized} is blocked` };
  }

  //isValid() check if the given string in itself is a valid IP or not ,if it is `true` is returned . So , if it's a literal IP address , we have to reject it
  if(!ipaddr.isValid(normalized)) {
    // if it's a hostname rather than an IP address , we can consider it safe (FOR NOW)
    return {isSafe : true};
  }

  // step3 : ipaddr.process() unifies IPv4-mapped IPv6 forms (e.g. "::ffff:127.0.0.1") with their IPv4 equivalent
  const parsed = ipaddr.parse(normalized);

  // step4 : classify the IP address using range() . it tells us exactly what kind of network address this is.
  if(BLOCKED_IP_RANGES.has(parsed.range())) {
    return { isSafe: false, reason: `hostname ${normalized} resolves to a blocked IP range: ${parsed.range()}` };
  }

  return { isSafe: true };

}


// Validates an http(s) / web - fetch URL: scheme allow - list + hostname safety.
export function checkHttpUrlSafety(rawUrl: string): NetworkSafetyCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { isSafe: false, reason: "not a valid URL" };
  }

  if (!ALLOWED_HTTP_SCHEMES.has(parsed.protocol)) {
    return { isSafe: false, reason: `scheme "${parsed.protocol}" is not allowed (only http/https)` };
  }

  return checkHostnameSafety(parsed.hostname);
}

// checks if the postgres connection string is valid and safe to use.
// if the scheme isn't allowed then it returns false with reason
// Multiple hosts are not allowed in the connection string, if there are multiple hosts then it returns false with reason
export function checkPostgresConnectionStringSafety(raw: string): NetworkSafetyCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { isSafe: false, reason: "not a valid connection URI (single-host postgresql:// form required)" };
  }

  if (!ALLOWED_POSTGRES_SCHEMES.has(parsed.protocol)) {
    return { isSafe: false, reason: `scheme "${parsed.protocol}" is not allowed (only postgres/postgresql)` };
  }

  if (parsed.hostname.includes(",")) {
    return { isSafe: false, reason: "multi-host connection strings are not supported" };
  }

  return checkHostnameSafety(parsed.hostname);
}