import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "../config/env.js";

describe("assertProductionSafety — Decision 9.17", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // vi.resetModules();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { }) as any);
    vi.spyOn(console, "error").mockImplementation(() => { });
  });

  afterEach(() => exitSpy.mockRestore());

  it("is a no-op outside production", async () => {
    env.AGENTGATE_NODE_ENV = "development";
    env.AGENTGATE_JWT_SECRET = "short";
    const { assertProductionSafety } = await import("../config/production-safety-guard.js");
    assertProductionSafety();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("GATE — refuses a documented placeholder secret in production", async () => {
    env.AGENTGATE_NODE_ENV = "production";
    env.AGENTGATE_JWT_SECRET = "change-this-to-a-random-string-at-least-32-chars-long";
    const { assertProductionSafety } = await import("../config/production-safety-guard.js");
    assertProductionSafety();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("GATE — refuses a connection string pointed at localhost in production", async () => {
    env.AGENTGATE_NODE_ENV = "production";
    env.AGENTGATE_DATABASE_URL = "postgresql://u:realSecretPassword123@localhost:5432/db";
    const { assertProductionSafety } = await import("../config/production-safety-guard.js");
    assertProductionSafety();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("boots cleanly against real, non-placeholder secrets", async () => {
    env.AGENTGATE_NODE_ENV = "production";

    // Satisfy all policy constraints checked by assertProductionSafety
    env.AGENTGATE_JWT_SECRET = "K7pQ2mX9vB4nR8sT1wY6zA3cD5fG0hJ321";
    env.AGENTGATE_PLATFORM_ENCRYPTION_KEY = "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890";
    env.AGENTGATE_API_KEY_PEPPER = "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890";
    env.AGENTGATE_INVITATION_TOKEN_SECRET = "K7pQ2mX9vB4nR8sT1wY6zA3cD5fG0hJ321";
    env.AGENTGATE_DATABASE_URL = "postgresql://svc:aB9kL2mN7pQ4rS1t@db.example.com:5432/db";
    env.AGENTGATE_REDIS_URL = "redis://svc:aB9kL2mN7pQ4rS1t@redis.example.com:6379";
    env.AGENTGATE_EMAIL_PROVIDER = "sendgrid";

    // ADD THIS LINE:
    env.AGENTGATE_APP_BASE_URL = "https://app.example.com";
    env.AGENTGATE_SENDGRID_API_KEY = "SG.CryptedMockApiKeyForTesting123456789";

    const { assertProductionSafety } = await import("../config/production-safety-guard.js");
    assertProductionSafety();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});