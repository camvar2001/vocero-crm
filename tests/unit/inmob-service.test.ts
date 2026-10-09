import { describe, expect, it, vi } from "vitest";

const input = {
  organizationId: "org_primary",
  userId: "usr_owner",
  agent: "buscador" as const,
  requestId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
  message: "Casa de dos dormitorios",
};

function fakeRepository(overrides: Record<string, unknown> = {}) {
  return {
    findTurn: vi.fn(async () => null),
    claimTurn: vi.fn(async () => ({ kind: "claimed", chatId: "iwc_1", turnId: "iwt_1" })),
    listHistory: vi.fn(async () => []),
    completeTurn: vi.fn(async () => undefined),
    failTurn: vi.fn(async () => undefined),
    markTurnUncertain: vi.fn(async () => undefined),
    expireRunningTurns: vi.fn(async () => 0),
    readChat: vi.fn(async () => ({ chatId: "iwc_1", agent: "buscador", turns: [] })),
    ...overrides,
  };
}

const gatewayReply = {
  version: 1,
  requestId: input.requestId,
  agent: "buscador",
  status: "completed",
  reply: "Hay una casa disponible.",
  results: [{ title: "Casa Norte", url: "https://century21.example/1", source: "fuente" }],
};

describe("INMOB service claims, replay safety, and recovery", () => {
  it("rejects a reused requestId with different text without another gateway POST", async () => {
    const repository = fakeRepository({
      findTurn: vi.fn(async () => ({ ...input, status: "completed" })),
    });
    const gateway = vi.fn(async () => gatewayReply);
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway, executeTool: vi.fn(), now: () => new Date("2026-10-08T12:00:00.000Z") });

    const result = await service.submitMessage({ ...input, message: "Un texto diferente" });

    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({ errorCode: "request_conflict" });
    expect(gateway).not.toHaveBeenCalled();
    expect(repository.claimTurn).not.toHaveBeenCalled();
  });

  it("returns an identical completed requestId from storage without replaying the gateway action", async () => {
    const stored = { ...input, reply: "Ya procesado", status: "completed", results: [] };
    const repository = fakeRepository({ findTurn: vi.fn(async () => stored) });
    const gateway = vi.fn(async () => gatewayReply);
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway, executeTool: vi.fn(), now: () => new Date("2026-10-08T12:00:00.000Z") });

    const result = await service.submitMessage(input);

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ turn: { requestId: input.requestId, reply: "Ya procesado", status: "completed" } });
    expect(gateway).not.toHaveBeenCalled();
    expect(repository.claimTurn).not.toHaveBeenCalled();
  });

  it("does not send to the gateway when another request owns the chat claim", async () => {
    const repository = fakeRepository({ claimTurn: vi.fn(async () => ({ kind: "chat_busy" })) });
    const gateway = vi.fn(async () => gatewayReply);
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway, executeTool: vi.fn(), now: () => new Date("2026-10-08T12:00:00.000Z") });

    const result = await service.submitMessage(input);

    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({ errorCode: "chat_busy" });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("allows only one gateway call when two different requests race for one chat", async () => {
    let running = false;
    const repository = fakeRepository({ claimTurn: vi.fn(async () => {
      if (running) return { kind: "chat_busy" };
      running = true;
      return { kind: "claimed", chatId: "iwc_1", turnId: "iwt_1" };
    }) });
    const gateway = vi.fn(async () => gatewayReply);
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway, executeTool: vi.fn(), now: () => new Date("2026-10-08T12:00:00.000Z") });

    const results = await Promise.all([
      service.submitMessage(input),
      service.submitMessage({ ...input, requestId: "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2", message: "Otro criterio" }),
    ]);

    expect(results.map((result: { statusCode: number }) => result.statusCode).sort()).toEqual([200, 409]);
    expect(gateway).toHaveBeenCalledOnce();
  });

  it("claims durably before the gateway call and persists the completed reply", async () => {
    const events: string[] = [];
    const repository = fakeRepository({
      claimTurn: vi.fn(async () => {
        events.push("claim");
        return { kind: "claimed", chatId: "iwc_1", turnId: "iwt_1" };
      }),
      completeTurn: vi.fn(async () => { events.push("complete"); }),
    });
    const gateway = vi.fn(async () => { events.push("gateway"); return gatewayReply; });
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway, executeTool: vi.fn(), now: () => new Date("2026-10-08T12:00:00.000Z") });

    const result = await service.submitMessage(input);

    expect(events).toEqual(["claim", "gateway", "complete"]);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      chatId: "iwc_1",
      agent: "buscador",
      turn: { requestId: input.requestId, status: "completed", reply: "Hay una casa disponible." },
    });
  });

  it("marks a lost gateway outcome uncertain and never retries the POST", async () => {
    const repository = fakeRepository();
    const gateway = vi.fn(async () => { throw new Error("gateway timeout"); });
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway, executeTool: vi.fn(), now: () => new Date("2026-10-08T12:00:00.000Z") });

    const result = await service.submitMessage(input);

    expect(result.statusCode).toBe(202);
    expect(result.body).toMatchObject({ turn: { status: "uncertain" } });
    expect(repository.markTurnUncertain).toHaveBeenCalledOnce();
    expect(repository.completeTurn).not.toHaveBeenCalled();
    expect(gateway).toHaveBeenCalledOnce();
  });

  it("executes a Secretaria action once and sends its tool result in the next gateway continuation", async () => {
    const toolRequest = {
      version: 1,
      requestId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
      agent: "secretaria",
      status: "tool_request",
      toolCallId: "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3",
      tool: { name: "agenda_availability", arguments: {} },
    };
    const finalReply = {
      version: 1,
      requestId: input.requestId,
      agent: "secretaria",
      status: "completed",
      reply: "Tengo dos horarios disponibles.",
    };
    const repository = fakeRepository();
    const gateway = vi.fn()
      .mockResolvedValueOnce(toolRequest)
      .mockResolvedValueOnce(finalReply);
    const executeTool = vi.fn(async () => ({ ok: true, result: { slots: [{ startUtc: "2026-10-09T15:00:00.000Z" }] } }));
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway, executeTool, now: () => new Date("2026-10-08T12:00:00.000Z") });

    const result = await service.submitMessage({ ...input, agent: "secretaria" });

    expect(result.statusCode).toBe(200);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith("org_primary", toolRequest.tool);
    expect(gateway).toHaveBeenCalledTimes(2);
    expect(gateway.mock.calls[1]?.[0]).toMatchObject({
      requestId: input.requestId,
      agent: "secretaria",
      toolResult: { toolCallId: toolRequest.toolCallId, name: "agenda_availability", ok: true, result: { slots: [{ startUtc: "2026-10-09T15:00:00.000Z" }] } },
      toolResults: [{ toolCallId: toolRequest.toolCallId, name: "agenda_availability", ok: true, result: { slots: [{ startUtc: "2026-10-09T15:00:00.000Z" }] } }],
    });
  });

  it("turns expired running work into uncertain through an atomic running-only transition", async () => {
    const repository = fakeRepository({ expireRunningTurns: vi.fn(async (cutoff: Date) => {
      expect(cutoff.toISOString()).toBe("2026-10-08T11:59:10.000Z");
      return 1;
    }) });
    const now = () => new Date("2026-10-08T12:00:00.000Z");
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway: vi.fn(), executeTool: vi.fn(), now, turnTimeoutMs: 50_000 });

    await service.getChat({ organizationId: input.organizationId, userId: input.userId, agent: input.agent });

    expect(repository.expireRunningTurns).toHaveBeenCalledOnce();
    expect(repository.readChat).toHaveBeenCalledOnce();
  });

  it("does not let expiry move a terminal turn back to uncertain", async () => {
    const repository = fakeRepository({
      expireRunningTurns: vi.fn(async () => 0),
      readChat: vi.fn(async () => ({
        chatId: "iwc_1",
        agent: "buscador",
        turns: [
          { requestId: input.requestId, message: input.message, reply: "ok", status: "completed", errorCode: null, results: [], createdAt: "2026-10-08T11:00:00.000Z" },
          { requestId: "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2", message: "otra", reply: null, status: "uncertain", errorCode: "timeout", results: [], createdAt: "2026-10-08T11:00:00.000Z" },
        ],
      })),
    });
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway: vi.fn(), executeTool: vi.fn(), now: () => new Date("2026-10-08T12:00:00.000Z") });

    const chat = await service.getChat({ organizationId: input.organizationId, userId: input.userId, agent: input.agent });

    expect(chat.turns.map((turn: { status: string }) => turn.status)).toEqual(["completed", "uncertain"]);
    expect(repository.expireRunningTurns).toHaveBeenCalledOnce();
  });

  it("bounds completed context to 20 turns and 32000 characters", async () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}:` + "x".repeat(2000),
    }));
    const repository = fakeRepository({ listHistory: vi.fn(async () => history) });
    const gateway = vi.fn(async () => gatewayReply);
    const { createInmobService } = await import("@/server/inmob/service");
    const service = createInmobService({ repository, gateway, executeTool: vi.fn(), now: () => new Date("2026-10-08T12:00:00.000Z") });

    await service.submitMessage(input);

    const sentHistory = gateway.mock.calls[0]?.[0]?.history as { role: string; content: string }[];
    expect(sentHistory).toHaveLength(20);
    expect(sentHistory.reduce((sum, turn) => sum + turn.content.length, 0)).toBeLessThanOrEqual(32_000);
    expect(sentHistory[0]?.content).toContain("15:");
  });
});
