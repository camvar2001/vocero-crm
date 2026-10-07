import { describe, expect, it } from "vitest";
import {
  buildTelegramProviderMessageId,
  parseTelegramUpdateId,
  validateTelegramPrivateText,
} from "@/server/telegram/updates";
import { parseIdentity, TG_PREFIX } from "@/server/inbox/identity";

describe("Telegram update validation", () => {
  it("accepts only private, authorized, human text from the same user and chat", () => {
    const message = {
      message_id: 42,
      date: 1_790_000_000,
      text: "Hola",
      chat: { id: 1234567890123, type: "private" },
      from: { id: 1234567890123, is_bot: false, first_name: "Ana" },
    };
    expect(validateTelegramPrivateText(message, ["1234567890123"])).toEqual({
      messageId: "42",
      chatId: "1234567890123",
      userId: "1234567890123",
      text: "Hola",
      timestamp: 1_790_000_000,
      name: "Ana",
    });
  });

  it.each([
    ["empty allowlist", { chat: { id: 9, type: "private" }, from: { id: 9 }, text: "x" }, []],
    ["unauthorized user", { chat: { id: 9, type: "private" }, from: { id: 9 }, text: "x" }, ["10"]],
    ["group", { chat: { id: 9, type: "group" }, from: { id: 9 }, text: "x" }, ["9"]],
    ["bot", { chat: { id: 9, type: "private" }, from: { id: 9, is_bot: true }, text: "x" }, ["9"]],
    ["unknown bot state", { message_id: 1, date: 1, chat: { id: 9, type: "private" }, from: { id: 9 }, text: "x" }, ["9"]],
    ["different chat and user", { chat: { id: 9, type: "private" }, from: { id: 10 }, text: "x" }, ["10"]],
    ["non-text update", { chat: { id: 9, type: "private" }, from: { id: 9 } }, ["9"]],
    ["blank text", { chat: { id: 9, type: "private" }, from: { id: 9 }, text: "  " }, ["9"]],
  ])("rejects %s", (_label, message, allowlist) => {
    expect(validateTelegramPrivateText(message, allowlist)).toBeNull();
  });

  it("deduplicates by bot, chat, and message, and accepts only safe integer offsets", () => {
    expect(buildTelegramProviderMessageId("777", "1234567890123", "42")).toBe(
      "tg:777:1234567890123:42",
    );
    expect(parseTelegramUpdateId("9007199254740991")).toBe(9007199254740991);
    expect(parseTelegramUpdateId("9007199254740992")).toBeNull();
    expect(parseTelegramUpdateId("1.5")).toBeNull();
  });

  it("keeps Telegram identities separate from WhatsApp phone parsing", () => {
    expect(TG_PREFIX).toBe("tg:");
    expect(parseIdentity("tg:1234567890123")).toMatchObject({
      identity: "tg:1234567890123",
      channel: "telegram",
      phone: null,
    });
  });
});
