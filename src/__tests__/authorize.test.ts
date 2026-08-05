import { describe, it, expect, vi } from "vitest";
import { requireRole } from "../plugins/authorize.js";

function fakeRequest(role: string) {
  return { tenantContext: { userId: "u1", tenantId: "t1", role } } as any;
}
function fakeReply() {
  return { forbidden: vi.fn() } as any;
}

describe("requireRole", () => {
  it("allows a matching role through (no reply call)", async () => {
    const reply = fakeReply();
    await requireRole("owner")(fakeRequest("owner"), reply);
    expect(reply.forbidden).not.toHaveBeenCalled();
  });

  it("GATE — rejects a non-matching role with 403 forbidden", async () => {
    const reply = fakeReply();
    await requireRole("owner")(fakeRequest("member"), reply);
    expect(reply.forbidden).toHaveBeenCalledTimes(1);
  });

  it("accepts a request whose role matches ANY of multiple allowed roles", async () => {
    const reply = fakeReply();
    await requireRole("owner", "member")(fakeRequest("member"), reply);
    expect(reply.forbidden).not.toHaveBeenCalled();
  });
});