import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: {} as Record<string, unknown>, inserted: [] as unknown[] }));

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return { ...actual, getDb: () => state.db };
});

import * as schema from "@/lib/db/schema";
import { ingestTelegramUpdate, TelegramIngestPausedError } from "@/server/telegram/ingest";

const update = {
  message_id: 42,
  date: 1_790_000_000,
  text: "hola",
  chat: { id: "123", type: "private" },
  from: { id: "123", is_bot: false, first_name: "Ana" },
};

function setup(credential: { connected: boolean; botId: string; allowedUserIds: string[] }) {
  state.inserted = [];
  const tx = {
    select: () => {
      let table: unknown;
      const query = {
        from(value: unknown) { table = value; return query; },
        where() { return query; },
        for() { return query; },
        limit: async () => table === schema.telegramCredentials ? [credential] : [],
      };
      return query;
    },
    insert: (table: unknown) => {
      state.inserted.push(table);
      const query = {
        values() { return query; },
        onConflictDoNothing() { return query; },
        returning: async () => [{ id: "telegram_update_1" }],
      };
      return query;
    },
  };
  state.db = { transaction: async (operation: (tx: object) => unknown) => operation(tx) };
}

beforeEach(() => setup({ connected: true, botId: "777", allowedUserIds: [] }));

describe("Telegram ingest auth transaction", () => {
  it("revalidates allowlist under credential lock before creating contact or conversation", async () => {
    const result = await ingestTelegramUpdate({
      id: "credential_1", organizationId: "org_1", botId: "777", botUsername: "bot", token: "token",
      allowedUserIds: ["123"], connected: true, status: "connected", lastErrorCode: null, nextUpdateId: null,
    }, 41, update);
    expect(result.disposition).toBe("discarded");
    expect(state.inserted).toEqual([schema.telegramUpdate]);
  });

  it("does not create any row when disconnect wins before the transaction", async () => {
    setup({ connected: false, botId: "777", allowedUserIds: ["123"] });
    await expect(ingestTelegramUpdate({
      id: "credential_1", organizationId: "org_1", botId: "777", botUsername: "bot", token: "token",
      allowedUserIds: ["123"], connected: true, status: "connected", lastErrorCode: null, nextUpdateId: null,
    }, 42, update)).rejects.toBeInstanceOf(TelegramIngestPausedError);
    expect(state.inserted).toEqual([]);
  });
});
