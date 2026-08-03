import { WebSocket } from "ws";
import type { LiveExecutionEvent } from "../lib/audit-publish.js";



const WS_SHUTDOWN_GRACE_MS = 3000;
export type WsFrameType = "connected" | "event" | "error";

export interface WsConnectedFrame {
  type: "connected";
  serverTime: string; // ISO 8601
  tenantId: string;
}

export interface WsErrorFrame {
  type: "error";
  code: number; // mirrors the WS close code that follows
  message: string;
}

export type WsEventFrame = LiveExecutionEvent & { type: "event" };

// WsEventFrame (wrapping the existing LiveExecutionEvent, Week 5) is
// Day 4's addition — the "event" WsFrameType above is reserved for it
// today, not yet constructed by anything.

export const WS_CLOSE_CODE = {
  NORMAL: 1000, // IANA standard — client-initiated clean disconnect
  GOING_AWAY: 1001, // IANA standard — server graceful shutdown (Day 5)
  POLICY_VIOLATION: 1008, // IANA standard — backpressure breach (Day 4)
  TICKET_INVALID: 4001, // private-use range, RFC 6455 §7.4
  ORIGIN_NOT_ALLOWED: 4002,
  CONNECTION_CEILING_EXCEEDED: 4003,
  HEARTBEAT_TIMEOUT: 4004, // Day 4
  SERVICE_DEGRADED: 4005, // NEW — Day 2 Finding F1 / Decision 7.32
  TOO_MANY_CONNECTION_ATTEMPTS: 4006, // NEW — Day 2 Finding F7 / Decision 7.39-7.40
} as const;

export type WsCloseCodeValue = (typeof WS_CLOSE_CODE)[keyof typeof WS_CLOSE_CODE];

const WS_CLOSE_REASON: Partial<Record<number, string>> = {
  [WS_CLOSE_CODE.TICKET_INVALID]: "Ticket invalid, expired, or already redeemed",
  [WS_CLOSE_CODE.ORIGIN_NOT_ALLOWED]: "Origin not allowed",
  [WS_CLOSE_CODE.CONNECTION_CEILING_EXCEEDED]: "Too many concurrent connections for this user",
  [WS_CLOSE_CODE.HEARTBEAT_TIMEOUT]: "Heartbeat timeout",
  [WS_CLOSE_CODE.SERVICE_DEGRADED]: "Service temporarily degraded",
  [WS_CLOSE_CODE.TOO_MANY_CONNECTION_ATTEMPTS]: "Too many connection attempts — slow down and retry shortly",
  [WS_CLOSE_CODE.POLICY_VIOLATION]: "Backpressure threshold exceeded",
};

export function buildConnectedFrame(tenantId: string): WsConnectedFrame {
  return { type: "connected", serverTime: new Date().toISOString(), tenantId };
}

function buildErrorFrame(code: number, message: string): WsErrorFrame {
  return { type: "error", code, message };
}

/**
 * THE single, shared rejection primitive for this entire surface. Per
 * Decision 7.35 (Finding F4), nowhere else in this module is permitted
 * to call socket.close() directly for a policy-driven rejection.
 * Guarantees:
 *   1. the error frame is ALWAYS sent before the close frame, when the
 *      socket is still open — reconciling Part 3.2's sequence diagram
 *      with Part 4.1's own frame-taxonomy prose
 *   2. every close carries the documented reason string, never one
 *      that could drift between call sites
 *   3. never throws, even if the socket is already closing/closed —
 *      rejection code runs on error/edge paths and must never itself
 *      become a second, confusing failure (mirrors execute-tool.ts's
 *      own audit()-closure discipline, Week 5)
 */
export function rejectConnection(
  socket: Pick<WebSocket, "send" | "close" | "readyState">,
  code: WsCloseCodeValue,
  message: string = WS_CLOSE_REASON[code] ?? "Connection rejected"
): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(buildErrorFrame(code, message)));
    }
  } catch (err) {
    console.warn(`[ws-protocol] failed to send error frame before closing ${code}:`, err);
  } finally {
    try {
      // RFC 6455 §5.5.1 — close reason capped at 123 UTF-8 bytes.
      socket.close(code, message.slice(0, 123));
    } catch (err) {
      console.warn(`[ws-protocol] failed to close socket with code ${code}:`, err);
    }
  }
}

export function sendConnectedFrame(socket: Pick<WebSocket, "send">, tenantId: string): void {
  socket.send(JSON.stringify(buildConnectedFrame(tenantId)));
}

export async function closeConnectionForShutdown(
  socket: Pick<WebSocket, "send" | "close" | "terminate" | "readyState" | "once">,
  graceMs: number = WS_SHUTDOWN_GRACE_MS
): Promise < void> {
  if (socket.readyState === WebSocket.CLOSED) return;

  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> ;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };

    socket.once("close", finish);
    timer = setTimeout(()=>{
      if (settled) return;
      try {
        socket.terminate();
      }catch (err) {
        console.warn("[ws-protocol] terminate() fallback failed during shutdown:", err);
      }
      finish();
    } , graceMs);

    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(WS_CLOSE_CODE.GOING_AWAY, "Server shutting down");
      }
    }catch (err) {
      console.warn("[ws-protocol] close() failed during shutdown, will fall back to terminate() on timeout:", err);
    }
    if (typeof socket.once !== "function") {
      finish();
    }

  })

}

export function terminateUnresponsiveConnection(
  socket: Pick<WebSocket,"send" | "terminate" | "readyState">,
  code : WsCloseCodeValue = WS_CLOSE_CODE.HEARTBEAT_TIMEOUT,
  message: string = WS_CLOSE_REASON[code] ?? "Connection terminated (unresponsive)"
): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(buildErrorFrame(code, message)));
    }
  }catch {
    // Expected and harmless for an unresponsive peer — swallow.
  }finally {
    try {
      socket.terminate();
    }catch (err) {
      console.warn("[ws-protocol] terminate() itself failed for an unresponsive connection:", err);
    }

  }


}

export function buildEventFrame(event : LiveExecutionEvent) : WsEventFrame {
  return {type : "event" , ...event}
}

export function sendEventFrame(socket: Pick<WebSocket, "send">, event : LiveExecutionEvent) : void {
  socket.send(JSON.stringify(buildEventFrame(event)));
}