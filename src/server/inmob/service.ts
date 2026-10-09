import { createHash } from "node:crypto";
import { desc, eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  InmobHistoryMessageSchema,
  InmobResultSchema,
  type InmobAgent,
  type InmobChat,
  type InmobGatewayRequest,
  type InmobGatewayResponse,
  type InmobHistoryMessage,
  type InmobPostBody,
  type InmobResult,
  type InmobTool,
  type InmobToolResult,
} from "@/lib/inmob";
import { assertInmobGatewayConfigured, postInmobGateway, InmobGatewayError, type GatewayOptions } from "@/server/inmob/client";
import { executeSecretariaTool } from "@/server/inmob/tools";

const TURN_TIMEOUT_MS = 50_000;
const MAX_ACTIONS = 4;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 32_000;
const MAX_VISIBLE_TURNS = 100;
const MAX_TOOL_RESULT_BYTES = 48 * 1024;

export type TurnRecord = {
  id: string;
  chatId: string;
  organizationId: string;
  userId: string;
  requestId: string;
  message: string;
  reply: string | null;
  results: unknown;
  status: "running" | "completed" | "failed" | "uncertain";
  errorCode: string | null;
  createdAt: Date;
  agent: InmobAgent;
};

export type InmobRepository = {
  getChat(input: { organizationId: string; userId: string; agent: InmobAgent }): Promise<{ id: string; agent: InmobAgent }>;
  readChat(input: { organizationId: string; userId: string; chatId: string }): Promise<InmobChat>;
  expireRunningTurns(input: { organizationId: string; userId: string; chatId: string; before: Date }): Promise<number>;
  findTurn(input: { organizationId: string; userId: string; requestId: string }): Promise<TurnRecord | null>;
  claimTurn(input: {
    organizationId: string;
    userId: string;
    agent: InmobAgent;
    requestId: string;
    message: string;
    now: Date;
  }): Promise<
    | { kind: "claimed"; chatId: string; turnId: string }
    | { kind: "existing"; turn: TurnRecord }
    | { kind: "conflict" }
    | { kind: "chat_busy" }
  >;
  listHistory(input: { organizationId: string; userId: string; chatId: string; limit: number }): Promise<Array<{ message: string; reply: string }>>;
  completeTurn(input: { organizationId: string; userId: string; turnId: string; reply: string; results: InmobResult[]; now: Date }): Promise<void>;
  failTurn(input: { organizationId: string; userId: string; turnId: string; errorCode: string; now: Date }): Promise<void>;
  markTurnUncertain(input: { organizationId: string; userId: string; turnId: string; errorCode: string; now: Date }): Promise<void>;
  claimToolAction(input: {
    organizationId: string;
    userId: string;
    turnId: string;
    toolCallId: string;
    name: string;
    inputHash: string;
    now: Date;
  }): Promise<
    | { kind: "claimed"; actionId: string }
    | { kind: "existing"; status: "completed" | "failed"; result: InmobToolResult }
    | { kind: "conflict" }
    | { kind: "uncertain" }
  >;
  finishToolAction(input: { organizationId: string; userId: string; actionId: string; result: InmobToolResult; now: Date }): Promise<void>;
  markToolActionUncertain(input: { organizationId: string; userId: string; actionId: string; now: Date }): Promise<void>;
};

type ServiceDependencies = {
  repository: InmobRepository;
  gateway: (payload: InmobGatewayRequest, options?: GatewayOptions) => Promise<InmobGatewayResponse>;
  executeTool: typeof executeSecretariaTool;
  now: () => Date;
  turnTimeoutMs?: number;
  identity?: { advisorId: string; advisorPhone: string };
};

export type ServiceReply = {
  statusCode: number;
  body: Record<string, unknown>;
};

function safeResults(value: unknown): InmobResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = InmobResultSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function turnDto(turn: TurnRecord) {
  return {
    requestId: turn.requestId,
    message: turn.message,
    reply: turn.reply,
    status: turn.status,
    errorCode: turn.errorCode,
    results: safeResults(turn.results),
    createdAt: turn.createdAt.toISOString(),
  };
}

function bodyForTurn(turn: TurnRecord): ServiceReply {
  const statusCode = turn.status === "running" ? 202 : turn.status === "failed" ? 503 : 200;
  return {
    statusCode,
    body: {
      chatId: turn.chatId,
      agent: turn.agent,
      turn: turnDto(turn),
    },
  };
}

function errorReply(statusCode: number, errorCode: string): ServiceReply {
  return { statusCode, body: { errorCode } };
}

class ToolActionConflictError extends Error {}

function trustedGatewayIdentity(input: {
  organizationId: string;
  userId: string;
  agent: InmobAgent;
  chatId: string;
  requestId: string;
  message: string;
  history: InmobHistoryMessage[];
  identity?: { advisorId: string; advisorPhone: string };
}): InmobGatewayRequest {
  const advisorId = input.identity?.advisorId ?? process.env.INMOB_TEST_ADVISOR_ID?.trim();
  const advisorPhone = input.identity?.advisorPhone ?? process.env.INMOB_TEST_PHONE?.trim();
  if (!advisorId || !advisorPhone) throw new InmobGatewayError("configuration", true, "Identidad de asesor no configurada");
  return {
    version: 1,
    requestId: input.requestId,
    agent: input.agent,
    sessionId: `vocero_inmob:${input.organizationId}:${input.userId}:${input.agent}:${input.chatId}`,
    organizationId: input.organizationId,
    userId: input.userId,
    advisorId,
    advisorPhone,
    message: input.message,
    history: input.history,
  };
}

function boundedHistory(rows: Array<{ message: string; reply: string }>): InmobHistoryMessage[] {
  const selected: InmobHistoryMessage[] = [];
  let chars = 0;
  for (const row of rows.slice(-MAX_HISTORY_TURNS).reverse()) {
    const pair = [
      { role: "user" as const, content: row.message },
      { role: "assistant" as const, content: row.reply },
    ];
    const pairSize = pair.reduce((sum, item) => sum + item.content.length, 0);
    if (chars + pairSize > MAX_HISTORY_CHARS) break;
    selected.unshift(...pair);
    chars += pairSize;
  }
  const parsed = InmobHistoryMessageSchema.array().safeParse(selected);
  return parsed.success ? parsed.data : [];
}

function inputHash(tool: InmobTool): string {
  return createHash("sha256").update(JSON.stringify({ name: tool.name, arguments: tool.arguments })).digest("hex");
}

export function createInmobService(deps: ServiceDependencies) {
  const timeoutMs = deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;

  async function expireChat(input: { organizationId: string; userId: string; agent: InmobAgent }) {
    const chat = await deps.repository.getChat(input);
    await deps.repository.expireRunningTurns({
      organizationId: input.organizationId,
      userId: input.userId,
      chatId: chat.id,
      before: new Date(deps.now().getTime() - timeoutMs),
    });
    return chat;
  }

  async function getChat(input: { organizationId: string; userId: string; agent: InmobAgent }): Promise<InmobChat> {
    const chat = await expireChat(input);
    return deps.repository.readChat({
      organizationId: input.organizationId,
      userId: input.userId,
      chatId: chat.id,
    });
  }

  async function submitMessage(input: {
    organizationId: string;
    userId: string;
    agent: InmobAgent;
  } & InmobPostBody): Promise<ServiceReply> {
    try {
      if (!deps.identity) {
        assertInmobGatewayConfigured();
        if (!process.env.INMOB_TEST_ADVISOR_ID?.trim() || !process.env.INMOB_TEST_PHONE?.trim()) {
          throw new InmobGatewayError("configuration", true, "Identidad de asesor no configurada");
        }
      }
      const chat = await expireChat(input);
      const prior = await deps.repository.findTurn({
        organizationId: input.organizationId,
        userId: input.userId,
        requestId: input.requestId,
      });
      if (prior) {
        if (prior.agent !== input.agent || prior.message !== input.message) return errorReply(409, "request_conflict");
        return bodyForTurn(prior);
      }

      const claim = await deps.repository.claimTurn({
        organizationId: input.organizationId,
        userId: input.userId,
        agent: input.agent,
        requestId: input.requestId,
        message: input.message,
        now: deps.now(),
      });
      if (claim.kind === "conflict") return errorReply(409, "request_conflict");
      if (claim.kind === "chat_busy") return errorReply(409, "chat_busy");
      if (claim.kind === "existing") {
        if (claim.turn.agent !== input.agent || claim.turn.message !== input.message) return errorReply(409, "request_conflict");
        return bodyForTurn(claim.turn);
      }

      const historyRows = await deps.repository.listHistory({
        organizationId: input.organizationId,
        userId: input.userId,
        chatId: claim.chatId,
        limit: MAX_HISTORY_TURNS,
      });
      const payload = trustedGatewayIdentity({
        ...input,
        chatId: chat.id,
        history: boundedHistory(historyRows),
        identity: deps.identity,
      });
      const deadline = Date.now() + timeoutMs;
      const toolResults: InmobToolResult[] = [];
      let reply: string | null = null;
      let results: InmobResult[] = [];

      try {
        for (let action = 0; action <= MAX_ACTIONS; action++) {
          const gatewayResponse = await deps.gateway(payload, { deadline });
          if (gatewayResponse.status === "completed") {
            reply = gatewayResponse.reply;
            results = gatewayResponse.results ?? [];
            break;
          }
          if (action === MAX_ACTIONS) {
            await deps.repository.markTurnUncertain({
              organizationId: input.organizationId,
              userId: input.userId,
              turnId: claim.turnId,
              errorCode: "action_limit",
              now: deps.now(),
            });
            return errorReply(202, "uncertain");
          }
          const tool = gatewayResponse.tool;
          const callResult = await executeAction({
            organizationId: input.organizationId,
            userId: input.userId,
            turnId: claim.turnId,
            toolCallId: gatewayResponse.toolCallId,
            tool,
            now: deps.now(),
          });
          toolResults.push(callResult);
          payload.toolResult = callResult;
          payload.toolResults = [...toolResults];
        }
      } catch (error) {
        if (error instanceof ToolActionConflictError) {
          await deps.repository.markTurnUncertain({
            organizationId: input.organizationId,
            userId: input.userId,
            turnId: claim.turnId,
            errorCode: "tool_conflict",
            now: deps.now(),
          });
          return errorReply(409, "tool_conflict");
        }
        const uncertain = error instanceof InmobGatewayError ? !error.retrySafe : true;
        const errorCode = error instanceof InmobGatewayError
          ? error.code === "rejected" ? "gateway_rejected" : error.code === "configuration" ? "configuration" : "gateway_uncertain"
          : "action_uncertain";
        if (uncertain) {
          await deps.repository.markTurnUncertain({
            organizationId: input.organizationId,
            userId: input.userId,
            turnId: claim.turnId,
            errorCode,
            now: deps.now(),
          });
          return {
            statusCode: 202,
            body: {
              chatId: claim.chatId,
              agent: input.agent,
              turn: {
                requestId: input.requestId,
                message: input.message,
                reply: null,
                status: "uncertain",
                errorCode,
                results: [],
                createdAt: deps.now().toISOString(),
              },
            },
          };
        }
        await deps.repository.failTurn({
          organizationId: input.organizationId,
          userId: input.userId,
          turnId: claim.turnId,
          errorCode,
          now: deps.now(),
        });
        return errorReply(503, errorCode);
      }

      await deps.repository.completeTurn({
        organizationId: input.organizationId,
        userId: input.userId,
        turnId: claim.turnId,
        reply: reply!,
        results,
        now: deps.now(),
      });
      return {
        statusCode: 200,
        body: {
          chatId: claim.chatId,
          agent: input.agent,
          turn: {
            requestId: input.requestId,
            message: input.message,
            reply,
            status: "completed",
            errorCode: null,
            results,
            createdAt: deps.now().toISOString(),
          },
        },
      };
    } catch (error) {
      if (error instanceof InmobGatewayError && error.retrySafe) return errorReply(503, error.code);
      return errorReply(503, "inmob_unavailable");
    }
  }

  async function executeAction(input: {
    organizationId: string;
    userId: string;
    turnId: string;
    toolCallId: string;
    tool: InmobTool;
    now: Date;
  }): Promise<InmobToolResult> {
    const claim = await deps.repository.claimToolAction({
      organizationId: input.organizationId,
      userId: input.userId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      name: input.tool.name,
      inputHash: inputHash(input.tool),
      now: input.now,
    });
    if (claim.kind === "existing") return claim.result;
    if (claim.kind === "conflict") throw new ToolActionConflictError("tool_conflict");
    if (claim.kind === "uncertain") throw new InmobGatewayError("unavailable", false, "La acción anterior no tiene resultado confirmado");
    try {
      const output = await deps.executeTool(input.organizationId, input.tool, input.userId);
      if (output.uncertain) {
        throw new InmobGatewayError("unavailable", false, "No se pudo confirmar la acción local");
      }
      const serializedResult = JSON.stringify(output.result);
      if (!serializedResult || Buffer.byteLength(serializedResult, "utf8") > MAX_TOOL_RESULT_BYTES) {
        throw new Error("tool_result_unbounded");
      }
      const result: InmobToolResult = {
        toolCallId: input.toolCallId,
        name: input.tool.name,
        ok: output.ok,
        result: JSON.parse(serializedResult) as unknown,
      };
      await deps.repository.finishToolAction({
        organizationId: input.organizationId,
        userId: input.userId,
        actionId: claim.actionId,
        result,
        now: deps.now(),
      });
      return result;
    } catch {
      await deps.repository.markToolActionUncertain({
        organizationId: input.organizationId,
        userId: input.userId,
        actionId: claim.actionId,
        now: deps.now(),
      });
      throw new InmobGatewayError("unavailable", false, "No se pudo confirmar la acción local");
    }
  }

  return { getChat, submitMessage };
}

class DrizzleInmobRepository implements InmobRepository {
  async getChat(input: { organizationId: string; userId: string; agent: InmobAgent }) {
    const db = getDb();
    await db.insert(schema.inmobWebChat).values({
      id: newId("inmobChat"),
      organizationId: input.organizationId,
      userId: input.userId,
      agent: input.agent,
    }).onConflictDoNothing({ target: [schema.inmobWebChat.organizationId, schema.inmobWebChat.userId, schema.inmobWebChat.agent] });
    const rows = await db.select({ id: schema.inmobWebChat.id, agent: schema.inmobWebChat.agent })
      .from(schema.inmobWebChat)
      .where(scoped(
        schema.inmobWebChat.organizationId,
        input.organizationId,
        eq(schema.inmobWebChat.userId, input.userId),
        eq(schema.inmobWebChat.agent, input.agent)
      ))
      .limit(1);
    if (!rows[0]) throw new Error("inmob_chat_missing");
    return rows[0] as { id: string; agent: InmobAgent };
  }

  async readChat(input: { organizationId: string; userId: string; chatId: string }): Promise<InmobChat> {
    const db = getDb();
      const rows = await db.select()
      .from(schema.inmobWebTurn)
      .where(scoped(
        schema.inmobWebTurn.organizationId,
        input.organizationId,
        eq(schema.inmobWebTurn.userId, input.userId),
        eq(schema.inmobWebTurn.chatId, input.chatId)
      ))
      .orderBy(desc(schema.inmobWebTurn.createdAt))
      .limit(MAX_VISIBLE_TURNS);
    const chatRows = await db.select({ agent: schema.inmobWebChat.agent })
      .from(schema.inmobWebChat)
      .where(scoped(
        schema.inmobWebChat.organizationId,
        input.organizationId,
        eq(schema.inmobWebChat.userId, input.userId),
        eq(schema.inmobWebChat.id, input.chatId)
      ))
      .limit(1);
    if (!chatRows[0]) throw new Error("inmob_chat_missing");
    return {
      chatId: input.chatId,
      agent: chatRows[0].agent as InmobAgent,
      turns: rows.reverse().map((row) => ({
        requestId: row.requestId,
        message: row.message,
        reply: row.reply,
        status: row.status,
        errorCode: row.errorCode,
        results: safeResults(row.results),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async expireRunningTurns(input: { organizationId: string; userId: string; chatId: string; before: Date }) {
    const db = getDb();
    const rows = await db.update(schema.inmobWebTurn).set({ status: "uncertain", errorCode: "expired", completedAt: new Date() })
      .where(scoped(
        schema.inmobWebTurn.organizationId,
        input.organizationId,
        eq(schema.inmobWebTurn.userId, input.userId),
        eq(schema.inmobWebTurn.chatId, input.chatId),
        eq(schema.inmobWebTurn.status, "running"),
        lt(schema.inmobWebTurn.claimedAt, input.before)
      ))
      .returning({ id: schema.inmobWebTurn.id });
    return rows.length;
  }

  async findTurn(input: { organizationId: string; userId: string; requestId: string }): Promise<TurnRecord | null> {
    const db = getDb();
    const rows = await db.select({
      id: schema.inmobWebTurn.id,
      chatId: schema.inmobWebTurn.chatId,
      organizationId: schema.inmobWebTurn.organizationId,
      userId: schema.inmobWebTurn.userId,
      requestId: schema.inmobWebTurn.requestId,
      message: schema.inmobWebTurn.message,
      reply: schema.inmobWebTurn.reply,
      results: schema.inmobWebTurn.results,
      status: schema.inmobWebTurn.status,
      errorCode: schema.inmobWebTurn.errorCode,
      createdAt: schema.inmobWebTurn.createdAt,
      agent: schema.inmobWebChat.agent,
    }).from(schema.inmobWebTurn)
      .innerJoin(schema.inmobWebChat, eq(schema.inmobWebTurn.chatId, schema.inmobWebChat.id))
      .where(scoped(
        schema.inmobWebTurn.organizationId,
        input.organizationId,
        eq(schema.inmobWebTurn.userId, input.userId),
        eq(schema.inmobWebTurn.requestId, input.requestId),
        eq(schema.inmobWebChat.organizationId, input.organizationId),
        eq(schema.inmobWebChat.userId, input.userId)
      ))
      .limit(1);
    return (rows[0] as TurnRecord | undefined) ?? null;
  }

  async claimTurn(input: {
    organizationId: string;
    userId: string;
    agent: InmobAgent;
    requestId: string;
    message: string;
    now: Date;
  }) {
    const db = getDb();
    return db.transaction(async (tx) => {
      const lockKey = `${input.organizationId}:${input.userId}:${input.requestId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      await tx.insert(schema.inmobWebChat).values({
        id: newId("inmobChat"),
        organizationId: input.organizationId,
        userId: input.userId,
        agent: input.agent,
      }).onConflictDoNothing({ target: [schema.inmobWebChat.organizationId, schema.inmobWebChat.userId, schema.inmobWebChat.agent] });
      const chats = await tx.select()
        .from(schema.inmobWebChat)
        .where(scoped(
          schema.inmobWebChat.organizationId,
          input.organizationId,
          eq(schema.inmobWebChat.userId, input.userId),
          eq(schema.inmobWebChat.agent, input.agent)
        ))
        .limit(1)
        .for("update");
      const chat = chats[0];
      if (!chat) throw new Error("inmob_chat_missing");
      const prior = await tx.select({
        id: schema.inmobWebTurn.id,
        chatId: schema.inmobWebTurn.chatId,
        organizationId: schema.inmobWebTurn.organizationId,
        userId: schema.inmobWebTurn.userId,
        requestId: schema.inmobWebTurn.requestId,
        message: schema.inmobWebTurn.message,
        reply: schema.inmobWebTurn.reply,
        results: schema.inmobWebTurn.results,
        status: schema.inmobWebTurn.status,
        errorCode: schema.inmobWebTurn.errorCode,
        createdAt: schema.inmobWebTurn.createdAt,
        agent: schema.inmobWebChat.agent,
      }).from(schema.inmobWebTurn)
        .innerJoin(schema.inmobWebChat, eq(schema.inmobWebTurn.chatId, schema.inmobWebChat.id))
        .where(scoped(
          schema.inmobWebTurn.organizationId,
          input.organizationId,
          eq(schema.inmobWebTurn.userId, input.userId),
          eq(schema.inmobWebTurn.requestId, input.requestId),
          eq(schema.inmobWebChat.organizationId, input.organizationId),
          eq(schema.inmobWebChat.userId, input.userId)
        ))
        .limit(1);
      if (prior[0]) {
        const full = prior[0] as TurnRecord;
        return full.message === input.message && full.agent === input.agent
          ? { kind: "existing" as const, turn: full }
          : { kind: "conflict" as const };
      }
      const running = await tx.select({ id: schema.inmobWebTurn.id })
        .from(schema.inmobWebTurn)
        .where(scoped(
          schema.inmobWebTurn.organizationId,
          input.organizationId,
          eq(schema.inmobWebTurn.userId, input.userId),
          eq(schema.inmobWebTurn.chatId, chat.id),
          eq(schema.inmobWebTurn.status, "running")
        ))
        .limit(1);
      if (running[0]) return { kind: "chat_busy" as const };
      const turnId = newId("inmobTurn");
      await tx.insert(schema.inmobWebTurn).values({
        id: turnId,
        chatId: chat.id,
        organizationId: input.organizationId,
        userId: input.userId,
        requestId: input.requestId,
        message: input.message,
        status: "running",
        claimedAt: input.now,
      });
      return { kind: "claimed" as const, chatId: chat.id, turnId };
    });
  }

  async listHistory(input: { organizationId: string; userId: string; chatId: string; limit: number }) {
    const db = getDb();
    const rows = await db.select({ message: schema.inmobWebTurn.message, reply: schema.inmobWebTurn.reply })
      .from(schema.inmobWebTurn)
      .where(scoped(
        schema.inmobWebTurn.organizationId,
        input.organizationId,
        eq(schema.inmobWebTurn.userId, input.userId),
        eq(schema.inmobWebTurn.chatId, input.chatId),
        eq(schema.inmobWebTurn.status, "completed")
      ))
      .orderBy(desc(schema.inmobWebTurn.createdAt))
      .limit(input.limit);
    return rows
      .filter((row): row is { message: string; reply: string } => typeof row.reply === "string")
      .reverse();
  }

  async completeTurn(input: { organizationId: string; userId: string; turnId: string; reply: string; results: InmobResult[]; now: Date }) {
    const db = getDb();
    const changed = await db.update(schema.inmobWebTurn).set({
      status: "completed",
      reply: input.reply,
      results: input.results,
      errorCode: null,
      completedAt: input.now,
    }).where(scoped(
      schema.inmobWebTurn.organizationId,
      input.organizationId,
      eq(schema.inmobWebTurn.userId, input.userId),
      eq(schema.inmobWebTurn.id, input.turnId),
      eq(schema.inmobWebTurn.status, "running")
    )).returning({ id: schema.inmobWebTurn.id });
    if (!changed[0]) throw new Error("inmob_turn_already_terminal");
  }

  async failTurn(input: { organizationId: string; userId: string; turnId: string; errorCode: string; now: Date }) {
    const db = getDb();
    await db.update(schema.inmobWebTurn).set({ status: "failed", errorCode: input.errorCode, completedAt: input.now })
      .where(scoped(
        schema.inmobWebTurn.organizationId,
        input.organizationId,
        eq(schema.inmobWebTurn.userId, input.userId),
        eq(schema.inmobWebTurn.id, input.turnId),
        eq(schema.inmobWebTurn.status, "running")
      ));
  }

  async markTurnUncertain(input: { organizationId: string; userId: string; turnId: string; errorCode: string; now: Date }) {
    const db = getDb();
    await db.update(schema.inmobWebTurn).set({ status: "uncertain", errorCode: input.errorCode, completedAt: input.now })
      .where(scoped(
        schema.inmobWebTurn.organizationId,
        input.organizationId,
        eq(schema.inmobWebTurn.userId, input.userId),
        eq(schema.inmobWebTurn.id, input.turnId),
        eq(schema.inmobWebTurn.status, "running")
      ));
  }

  async claimToolAction(input: {
    organizationId: string;
    userId: string;
    turnId: string;
    toolCallId: string;
    name: string;
    inputHash: string;
    now: Date;
  }) {
    const db = getDb();
    return db.transaction(async (tx) => {
      const lockKey = `${input.organizationId}:${input.userId}:${input.turnId}:${input.toolCallId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const turns = await tx.select({ id: schema.inmobWebTurn.id })
        .from(schema.inmobWebTurn)
        .where(scoped(
          schema.inmobWebTurn.organizationId,
          input.organizationId,
          eq(schema.inmobWebTurn.userId, input.userId),
          eq(schema.inmobWebTurn.id, input.turnId),
          eq(schema.inmobWebTurn.status, "running")
        ))
        .limit(1);
      if (!turns[0]) return { kind: "uncertain" as const };
      const existing = await tx.select().from(schema.inmobToolAction)
        .where(scoped(
          schema.inmobToolAction.organizationId,
          input.organizationId,
          eq(schema.inmobToolAction.userId, input.userId),
          eq(schema.inmobToolAction.turnId, input.turnId),
          eq(schema.inmobToolAction.toolCallId, input.toolCallId)
        ))
        .limit(1);
      if (existing[0]) {
        if (existing[0].inputHash !== input.inputHash || existing[0].name !== input.name) return { kind: "conflict" as const };
        if ((existing[0].status === "completed" || existing[0].status === "failed") && existing[0].result) {
          return { kind: "existing" as const, status: existing[0].status, result: existing[0].result as InmobToolResult };
        }
        return { kind: "uncertain" as const };
      }
      const actionId = newId("inmobToolAction");
      await tx.insert(schema.inmobToolAction).values({
        id: actionId,
        turnId: input.turnId,
        organizationId: input.organizationId,
        userId: input.userId,
        toolCallId: input.toolCallId,
        name: input.name,
        inputHash: input.inputHash,
        status: "running",
        claimedAt: input.now,
      });
      return { kind: "claimed" as const, actionId };
    });
  }

  async finishToolAction(input: { organizationId: string; userId: string; actionId: string; result: InmobToolResult; now: Date }) {
    const db = getDb();
    const status = input.result.ok ? "completed" : "failed";
    const rows = await db.update(schema.inmobToolAction).set({ status, result: input.result, completedAt: input.now })
      .where(scoped(
        schema.inmobToolAction.organizationId,
        input.organizationId,
        eq(schema.inmobToolAction.userId, input.userId),
        eq(schema.inmobToolAction.id, input.actionId),
        eq(schema.inmobToolAction.status, "running")
      )).returning({ id: schema.inmobToolAction.id });
    if (!rows[0]) throw new Error("inmob_action_already_terminal");
  }

  async markToolActionUncertain(input: { organizationId: string; userId: string; actionId: string; now: Date }) {
    const db = getDb();
    await db.update(schema.inmobToolAction).set({ status: "uncertain", completedAt: input.now })
      .where(scoped(
        schema.inmobToolAction.organizationId,
        input.organizationId,
        eq(schema.inmobToolAction.userId, input.userId),
        eq(schema.inmobToolAction.id, input.actionId),
        eq(schema.inmobToolAction.status, "running")
      ));
  }
}

/** Producción y Postgres de integración comparten exactamente este adapter. */
export function createPostgresInmobRepository(): InmobRepository {
  return new DrizzleInmobRepository();
}

const repository = new DrizzleInmobRepository();
const service = createInmobService({
  repository,
  gateway: postInmobGateway,
  executeTool: executeSecretariaTool,
  now: () => new Date(),
});

export function getInmobChat(input: { organizationId: string; userId: string; agent: InmobAgent }) {
  return service.getChat(input);
}

export function submitInmobMessage(input: {
  organizationId: string;
  userId: string;
  agent: InmobAgent;
} & InmobPostBody) {
  return service.submitMessage(input);
}
