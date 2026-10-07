import { describe, expect, it } from "vitest";
import { messagesThroughTelegramTrigger } from "@/server/telegram/turn";

describe("Telegram durable turn correlation", () => {
  it("does not attribute an earlier turn's response to an inbound that arrived during generation", () => {
    const history = [
      { id: "in-a", direction: "in" },
      { id: "out-previous", direction: "out" },
      { id: "in-b", direction: "in" },
    ];
    expect(messagesThroughTelegramTrigger(history, "in-a").map(({ id }) => id)).toEqual(["in-a"]);
    expect(messagesThroughTelegramTrigger(history, "in-b").map(({ id }) => id)).toEqual(history.map(({ id }) => id));
    expect(messagesThroughTelegramTrigger(history, "missing")).toEqual([]);
  });
});
