import { describe, expect, it } from "vitest";
import { isTelegramPollerCredentialsCurrent, telegramBackoffMs } from "@/server/telegram/poller";

describe("Telegram poller retry policy", () => {
  it("uses bounded exponential backoff and respects Retry-After", () => {
    expect(telegramBackoffMs(0)).toBe(1_000);
    expect(telegramBackoffMs(1)).toBe(2_000);
    expect(telegramBackoffMs(20)).toBe(60_000);
    expect(telegramBackoffMs(0, 17)).toBe(17_000);
  });

  it("does not wait forever on malformed retry-after values", () => {
    expect(telegramBackoffMs(2, -1)).toBe(4_000);
    expect(telegramBackoffMs(2, Number.NaN)).toBe(4_000);
  });

  it("does not resurrect a disconnected or tombstoned credential during startup", () => {
    const started = {
      id: "credential_1", organizationId: "org_1", botId: "bot_1", botUsername: "bot",
      token: "token", allowedUserIds: ["1001"], connected: true, status: "connecting" as const,
      lastErrorCode: null, nextUpdateId: null,
    };
    expect(isTelegramPollerCredentialsCurrent(started, { ...started, connected: false })).toBe(false);
    expect(isTelegramPollerCredentialsCurrent(started, { ...started, token: null, connected: false })).toBe(false);
    expect(isTelegramPollerCredentialsCurrent(started, { ...started, allowedUserIds: ["1002"] })).toBe(false);
  });
});
