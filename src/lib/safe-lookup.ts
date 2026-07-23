import net from "node:net";
import dns from "node:dns";
import { resolveAndValidate, defaultDnsResolver, type DnsResolver, type IpValidator } from "./dns-security.js";
import { DNS_TIMEOUT_MS } from "../handlers/types.js";

export function createSafeLookup(
  resolver: DnsResolver = defaultDnsResolver,
  validate?: IpValidator
): net.LookupFunction {
  return (hostname, options, callback) => {
    const opts = typeof options === "number" ? {} : options ?? {};
    const all = (opts as dns.LookupAllOptions).all === true;
    const signal = AbortSignal.timeout(DNS_TIMEOUT_MS);

    resolveAndValidate({ hostname, signal }, resolver, validate)
      .then((target) => {
        if (all) {
          (callback as (err: Error | null, addresses: dns.LookupAddress[]) => void)(
            null, [{ address: target.ip, family: target.family }]
          );
        } else {
          (callback as (err: Error | null, address: string, family: number) => void)(
            null, target.ip, target.family
          );
        }
      })
      .catch((err) => {
        (callback as (err: Error | null, address: string, family: number) => void)(
          err instanceof Error ? err : new Error(String(err)), "", 4
        );
      });
  };
}