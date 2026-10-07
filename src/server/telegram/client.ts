import { parseTelegramUpdateId } from "@/server/telegram/updates";

export type TelegramBotIdentity = { id: string; username: string | null };
export type TelegramUpdate = { update_id: number; message?: unknown };

export class TelegramApiError extends Error {
  constructor(
    readonly code: "unauthorized" | "conflict" | "rate_limited" | "unavailable" | "api_error",
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Telegram API ${code}`);
    this.name = "TelegramApiError";
  }
}

type TelegramEnvelope<T> = {
  ok?: boolean;
  result?: T;
  error_code?: number;
  parameters?: { retry_after?: number };
};

/** Narrow, redacting Telegram Bot API adapter. It intentionally has no
 * deleteWebhook operation, so an existing webhook cannot be removed here. */
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = 15_000,
  ) {}

  async getMe(signal?: AbortSignal): Promise<TelegramBotIdentity> {
    const result = await this.call<{ id?: number | string; username?: string }>("getMe", {}, signal);
    const id = parseTelegramUpdateId(result.id);
    if (id === null) throw new TelegramApiError("api_error");
    return { id: String(id), username: typeof result.username === "string" ? result.username : null };
  }

  async getWebhookInfo(signal?: AbortSignal): Promise<{ urlConfigured: boolean }> {
    const result = await this.call<{ url?: unknown }>("getWebhookInfo", {}, signal);
    return { urlConfigured: typeof result.url === "string" && result.url.length > 0 };
  }

  async getUpdates(offset: number | null, signal: AbortSignal): Promise<TelegramUpdate[]> {
    const result = await this.call<unknown>(
      "getUpdates",
      { ...(offset === null ? {} : { offset }), timeout: 20, allowed_updates: ["message"] },
      signal,
      25_000,
    );
    if (!Array.isArray(result)) throw new TelegramApiError("api_error");
    return result.flatMap((value): TelegramUpdate[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const update = value as Record<string, unknown>;
      const updateId = parseTelegramUpdateId(update.update_id);
      return updateId === null ? [] : [{ update_id: updateId, message: update.message }];
    });
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<string> {
    const result = await this.call<{ message_id?: number | string }>(
      "sendMessage",
      { chat_id: chatId, text },
      signal,
    );
    const id = parseTelegramUpdateId(result.message_id);
    if (id === null) throw new TelegramApiError("api_error");
    return String(id);
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    let response: Response;
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: requestSignal,
        },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TelegramApiError("unavailable");
    }

    const envelope = (await response.json().catch(() => null)) as TelegramEnvelope<T> | null;
    if (response.ok && envelope?.ok === true && envelope.result !== undefined) {
      return envelope.result;
    }
    const code = envelope?.error_code ?? response.status;
    if (code === 401) throw new TelegramApiError("unauthorized");
    if (code === 409) throw new TelegramApiError("conflict");
    if (code === 429) {
      const retry = envelope?.parameters?.retry_after;
      throw new TelegramApiError(
        "rate_limited",
        typeof retry === "number" && Number.isFinite(retry) ? Math.max(1, retry) : null,
      );
    }
    if (code >= 500 || response.status >= 500) throw new TelegramApiError("unavailable");
    throw new TelegramApiError("api_error");
  }
}
