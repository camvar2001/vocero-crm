import { describe, expect, it, vi } from "vitest";

const lockState = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("@/lib/db", () => ({
  getSql: () => ({
    reserve: async () => ({
      unsafe: async (query: string) => { lockState.events.push(query.includes("unlock") ? "release_lock" : "acquire_lock"); },
      release: () => { lockState.events.push("release_session"); },
    }),
  }),
}));

import { withTelegramBotLock, withTelegramOperationLock } from "@/server/telegram/mutex";

describe("Telegram bot mutation lock", () => {
  it("serializes sends and credential changes for one bot", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withTelegramBotLock("777", async () => {
      order.push("send-start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("send-end");
    });
    await Promise.resolve();
    const second = withTelegramBotLock("777", async () => { order.push("rotate"); });
    await Promise.resolve();
    expect(order).toEqual(["send-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["send-start", "send-end", "rotate"]);
  });

  it("does not block independent bots", async () => {
    const order: string[] = [];
    await Promise.all([
      withTelegramBotLock("a", async () => { order.push("a"); }),
      withTelegramBotLock("b", async () => { order.push("b"); }),
    ]);
    expect(order).toHaveLength(2);
  });

  it("holds the shared database operation lock through the operation and releases it before returning", async () => {
    lockState.events = [];
    const result = await withTelegramOperationLock("777", async () => {
      lockState.events.push("start_poller");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(lockState.events).toEqual(["acquire_lock", "start_poller", "release_lock", "release_session"]);
  });
});
