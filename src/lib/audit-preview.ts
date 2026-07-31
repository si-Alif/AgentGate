import { redactSensitiveFields } from "./object-redaction.js";
import {env} from "../config/env.js";


export const AUDIT_PREVIEW_MAX_BYTES = Number(env.AGENTGATE_AUDIT_PREVIEW_MAX_BYTES);

export interface CapturedPreview {
  preview: unknown;
  truncated: boolean;
}

export function capturePreview(value: unknown, maxBytes: number = AUDIT_PREVIEW_MAX_BYTES): CapturedPreview {
  if (value === undefined) {
    return { preview: undefined, truncated: false };
  }

  try {
    const redacted = redactSensitiveFields(value);
    const serialized = JSON.stringify(redacted);

    if (Buffer.byteLength(serialized, "utf-8") <= maxBytes) {
      return { preview: redacted, truncated: false };
    }

    return {
      preview: { _truncated: true, preview: serialized.slice(0, maxBytes) },
      truncated: true,
    };
  } catch {
    // Second-layer defense, on top of Decision 5.52's try/catch around
    // the audit() closure itself in execute-tool.ts. Should be
    // unreachable in practice — redactSensitiveFields() always returns a
    // fresh, acyclic, JSON-serializable graph — but an audit-path
    // function must never be the reason a caller sees an exception.
    return { preview: { _captureFailed: true }, truncated: true };
  }
}