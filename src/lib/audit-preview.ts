import { redactSecrets } from "./error-redaction.js";
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

  const redacted = redactSecrets(value as string);
  const serialized = JSON.stringify(redacted);

  if (Buffer.byteLength(serialized, "utf-8") <= maxBytes) {
    return { preview: redacted, truncated: false };
  }


  return {
    preview: { _truncated: true, preview: serialized.slice(0, maxBytes) },
    truncated: true,
  };
}