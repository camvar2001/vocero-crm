import { describe, expect, it } from "vitest";
import { isTelegramRecipientAllowed, orphanedTelegramDeliveryRecovery, prepareTelegramText, TelegramTextTooLongError } from "@/server/telegram/delivery";
import { withTelegramManualTakeover } from "@/server/telegram/mutex";

describe("Telegram message length", () => {
  it("counts Unicode code points and accepts exactly 4096", () => {
    const text = "🙂".repeat(4096);
    expect(prepareTelegramText(text, false)).toEqual({ text, truncated: false });
  });

  it("rejects overlong manual messages before any network call", () => {
    expect(() => prepareTelegramText("x".repeat(4097), false)).toThrow(TelegramTextTooLongError);
  });

  it("truncates agent output visibly to one Telegram message", () => {
    const result = prepareTelegramText("🙂".repeat(4097), true);
    expect(Array.from(result.text)).toHaveLength(4096);
    expect(result.text.endsWith("…")).toBe(true);
    expect(result.truncated).toBe(true);
  });
});

describe("Telegram authorization and manual takeover", () => {
  it("blocks a historical conversation after its recipient is removed from the allowlist", () => {
    expect(isTelegramRecipientAllowed(["1001"], "1002")).toBe(false);
    expect(isTelegramRecipientAllowed(["1001"], "1001")).toBe(true);
  });

  it("recovers a crash before send without leaving a pending message", () => {
    expect(orphanedTelegramDeliveryRecovery("reserved")).toEqual({
      deliveryStatus: "cancelled",
      errorCode: "interrupted_before_send",
      messageError: "El proceso se reinició antes de enviar a Telegram",
    });
    expect(orphanedTelegramDeliveryRecovery("sending").deliveryStatus).toBe("uncertain");
  });

  it("persists manual takeover before waiting for the in-flight bot operation", async () => {
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const operation = withTelegramManualTakeover(
      async () => { events.push("handoff"); },
      async () => { events.push("wait_for_bot_lock"); await blocked; events.push("dispatch"); },
    );
    expect(events).toEqual(["handoff"]);
    await Promise.resolve();
    expect(events).toEqual(["handoff", "wait_for_bot_lock"]);
    release();
    await operation;
    expect(events).toEqual(["handoff", "wait_for_bot_lock", "dispatch"]);
  });
});
