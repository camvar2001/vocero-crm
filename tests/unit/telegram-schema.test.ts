import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import { schema } from "@/lib/db";

describe("Telegram durable schema", () => {
  it("keeps credentials, updates, agent work, and deliveries in tenant tables", () => {
    expect(getTableName(schema.telegramCredentials)).toBe("telegram_credentials");
    expect(getTableName(schema.telegramUpdate)).toBe("telegram_update");
    expect(getTableName(schema.telegramAgentWork)).toBe("telegram_agent_work");
    expect(getTableName(schema.telegramDelivery)).toBe("telegram_delivery");
  });
});
