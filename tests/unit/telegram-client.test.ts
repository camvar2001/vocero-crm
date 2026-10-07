import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramApiError, TelegramClient } from "@/server/telegram/client";

describe("Telegram Bot API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses HTTPS, validates Bot API envelopes, and returns only the requested result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ ok: true, result: { id: 777, username: "private_bot" } }),
    );
    const client = new TelegramClient("token-secret", fetchMock);
    await expect(client.getMe()).resolves.toEqual({ id: "777", username: "private_bot" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.telegram.org/bottoken-secret/getMe",
    );
  });

  it("maps conflict and retry-after to fixed codes without exposing the token or URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        { ok: false, error_code: 409, description: "Conflict bot token-secret" },
        { status: 409 },
      ),
    );
    const client = new TelegramClient("token-secret", fetchMock);
    try {
      await client.getUpdates(0, AbortSignal.timeout(100));
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramApiError);
      expect((error as TelegramApiError).code).toBe("conflict");
      expect((error as Error).message).not.toContain("token-secret");
      expect((error as Error).message).not.toContain("api.telegram.org");
    }
  });

  it("validates webhook status without deleting or changing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ ok: true, result: { url: "https://untrusted.example/hook" } }),
    );
    const client = new TelegramClient("token-secret", fetchMock);
    await expect(client.getWebhookInfo()).resolves.toEqual({ urlConfigured: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.telegram.org/bottoken-secret/getWebhookInfo",
    );
  });

  it("bounds a stalled Bot API request and returns a redacted unavailable error", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const client = new TelegramClient("token-secret", fetchMock, 5);
    await expect(client.getMe()).rejects.toMatchObject({ code: "unavailable" });
  });
});
