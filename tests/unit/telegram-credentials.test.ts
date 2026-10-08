import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "owner" as string,
  credentials: null as null | Record<string, unknown>,
  save: vi.fn(),
  revoke: vi.fn(),
  setConnected: vi.fn(),
  appBaseUrl: "http://localhost:3000",
  events: [] as string[],
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    withAuth: (handler: (session: { userId: string; organizationId: string; role: string }, ...args: unknown[]) => Promise<Response>) =>
      (...args: unknown[]) => handler({ userId: "user_1", organizationId: "org_1", role: state.role }, ...args),
  };
});
vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_BASE_URL: state.appBaseUrl }) }));
vi.mock("@/server/channels/enabled", () => ({
  isChannelEnabled: () => true,
  channelDisabledResponse: () => new Response(null, { status: 404 }),
}));
vi.mock("@/server/telegram/credentials", () => ({
  getTelegramCredentialsByOrg: async () => state.credentials,
  getTelegramCounts: async () => ({ pending: 0, failed: 0, uncertain: 0 }),
  saveTelegramCredentials: state.save,
  revokeTelegramCredentials: state.revoke,
  setTelegramConnected: async (_organizationId: string, connected: boolean) => {
    state.setConnected(connected);
    state.events.push(connected ? "enable" : "disable");
  },
  updateTelegramState: vi.fn(),
  TelegramBotMismatchError: class TelegramBotMismatchError extends Error {},
}));
vi.mock("@/server/telegram/client", () => ({
  TelegramApiError: class TelegramApiError extends Error {
    code = "api_error";
  },
  TelegramClient: class TelegramClient {
    getMe = async () => ({ id: "222", username: "safe_bot" });
    getWebhookInfo = async () => ({ urlConfigured: false });
  },
}));
vi.mock("@/server/telegram/poller", () => ({
  startTelegramPoller: vi.fn(() => state.events.push("start")),
  stopTelegramPoller: vi.fn(async () => { state.events.push("stop"); }),
  withTelegramSessionLock: async (_botId: string, operation: () => Promise<unknown>) => {
    state.events.push("session_enter");
    try { return await operation(); }
    finally { state.events.push("session_release"); }
  },
}));
vi.mock("@/server/telegram/mutex", async () => {
  const actual = await vi.importActual<typeof import("@/server/telegram/mutex")>("@/server/telegram/mutex");
  return { ...actual, withTelegramOperationLock: async (_botId: string, operation: () => Promise<unknown>) => operation() };
});

beforeEach(() => {
  state.role = "owner";
  state.credentials = null;
  state.save.mockReset();
  state.revoke.mockReset().mockImplementation(async () => { state.events.push("revoke"); });
  state.setConnected.mockReset();
  state.appBaseUrl = "http://localhost:3000";
  state.events = [];
});

const request = (method: string, body?: unknown, origin = "http://localhost:3000", requestHost = "localhost:3000", forwardedHost?: string) =>
  new Request(`http://${requestHost}/api/settings/telegram`, {
    method,
    headers: { origin, ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("Telegram settings permissions and secret handling", () => {
  it("rejects members before validating or saving a token", async () => {
    state.role = "member";
    const { PUT } = await import("@/app/api/settings/telegram/route");
    const response = await PUT(request("PUT", { token: "secret-token", allowedUserIds: ["123"] }));
    expect(response.status).toBe(403);
    expect(state.save).not.toHaveBeenCalled();
  });

  it("rejects cross-origin writes", async () => {
    const { PUT } = await import("@/app/api/settings/telegram/route");
    const response = await PUT(request("PUT", { token: "secret-token", allowedUserIds: ["123"] }, "https://attacker.example", "next-internal:3000", "localhost:3000"));
    expect(response.status).toBe(403);
    expect(state.save).not.toHaveBeenCalled();
  });

  it("accepts the configured browser origin when Next exposes an internal request host", async () => {
    const { PUT } = await import("@/app/api/settings/telegram/route");
    const response = await PUT(request("PUT", { token: "secret-token", allowedUserIds: ["123"] }, "http://localhost:3000", "next-internal:3000"));
    expect(response.status).toBe(200);
    expect(state.save).toHaveBeenCalledOnce();
  });

  it("never returns the saved token from GET", async () => {
    state.credentials = {
      token: "secret-token",
      botId: "222",
      botUsername: "safe_bot",
      allowedUserIds: ["123"],
      connected: false,
      status: "disconnected",
      nextUpdateId: null,
    };
    const { GET } = await import("@/app/api/settings/telegram/route");
    const response = await GET();
    const json = await response.json();
    expect(JSON.stringify(json)).not.toContain("secret-token");
    expect(json.bot).toEqual({ id: "222", username: "safe_bot" });
  });

  it("keeps a tombstoned bot identity when a different bot token is submitted", async () => {
    state.credentials = { token: "old-token", botId: "111", allowedUserIds: [], connected: false };
    const credentials = await import("@/server/telegram/credentials");
    state.save.mockRejectedValue(new credentials.TelegramBotMismatchError());
    const { PUT } = await import("@/app/api/settings/telegram/route");
    const response = await PUT(request("PUT", { token: "new-token", allowedUserIds: ["123"] }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("bot_mismatch");
  });

  it("waits for the active poller to stop before rotating token or allowlist", async () => {
    state.credentials = { token: "old-token", botId: "222", botUsername: "safe_bot", allowedUserIds: ["123"], connected: true };
    state.save.mockImplementation(async () => { state.events.push("save"); });
    const { PUT } = await import("@/app/api/settings/telegram/route");
    const response = await PUT(request("PUT", { token: "new-token", allowedUserIds: ["456"] }));
    expect(response.status).toBe(200);
    expect(state.events).toEqual(["disable", "stop", "session_enter", "save", "session_release", "start"]);
  });

  it("rejects removing the last allowed user while keeping a connected bot", async () => {
    state.credentials = { token: "old-token", botId: "222", botUsername: "safe_bot", allowedUserIds: ["123"], connected: true };
    const { PUT } = await import("@/app/api/settings/telegram/route");
    const response = await PUT(request("PUT", { allowedUserIds: [] }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("allowlist_required");
    expect(state.save).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it("treats connect on an already active bot as idempotent", async () => {
    state.credentials = { token: "saved-token", botId: "222", botUsername: "safe_bot", allowedUserIds: ["123"], connected: true, status: "connected" };
    const { PATCH } = await import("@/app/api/settings/telegram/route");
    const response = await PATCH(request("PATCH", { connected: true }));
    expect(response.status).toBe(200);
    expect((await response.json()).connected).toBe(true);
    expect(state.setConnected).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it("stops an unhealthy poller before reconnect and starts only after both DB locks release", async () => {
    state.credentials = { token: "saved-token", botId: "222", botUsername: "safe_bot", allowedUserIds: ["123"], connected: true, status: "error" };
    const { PATCH } = await import("@/app/api/settings/telegram/route");
    const response = await PATCH(request("PATCH", { connected: true }));
    expect(response.status).toBe(200);
    expect(state.events).toEqual(["disable", "stop", "session_enter", "enable", "session_release", "start"]);
  });

  it("reapplies token revocation after waiting for poller and delivery locks", async () => {
    state.credentials = { token: "saved-token", botId: "222", botUsername: "safe_bot", allowedUserIds: ["123"], connected: true, status: "connected" };
    const { DELETE } = await import("@/app/api/settings/telegram/route");
    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(200);
    expect(state.events).toEqual(["revoke", "stop", "session_enter", "revoke", "session_release"]);
  });
});
