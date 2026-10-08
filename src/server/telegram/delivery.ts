import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { publish } from "@/server/events/bus";
import { serializeMessage } from "@/server/inbox/ingest";
import { getTelegramCredentialsByOrg, updateTelegramState } from "@/server/telegram/credentials";
import { withTelegramBotLock, withTelegramManualTakeover, withTelegramOperationLock } from "@/server/telegram/mutex";
import { TelegramApiError, TelegramClient } from "@/server/telegram/client";

const MAX_TELEGRAM_CODE_POINTS = 4096;

export class TelegramTextTooLongError extends Error {
  constructor() {
    super("Telegram admite hasta 4096 caracteres por mensaje");
    this.name = "TelegramTextTooLongError";
  }
}

export class TelegramDeliveryError extends Error {
  constructor(readonly code: "sandbox_violation" | "not_connected" | "human_handoff" | "action_id_required" | "send_failed" | "uncertain") {
    const message = {
      sandbox_violation: "Las conversaciones de prueba no pueden enviar mensajes reales",
      not_connected: "No hay una conexión Telegram activa para esta conversación",
      human_handoff: "La conversación está bajo control humano; el agente no respondió",
      action_id_required: "Falta el identificador de esta acción manual",
      send_failed: "No se pudo reservar la entrega de Telegram",
      uncertain: "No se pudo confirmar la entrega de Telegram",
    }[code];
    super(message);
    this.name = "TelegramDeliveryError";
  }
}

export function prepareTelegramText(text: string, aiGenerated: boolean): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= MAX_TELEGRAM_CODE_POINTS) return { text, truncated: false };
  if (!aiGenerated) throw new TelegramTextTooLongError();
  return { text: `${chars.slice(0, MAX_TELEGRAM_CODE_POINTS - 1).join("")}…`, truncated: true };
}

export function isTelegramRecipientAllowed(allowedUserIds: string[], chatId: string): boolean {
  return allowedUserIds.includes(chatId);
}

export function orphanedTelegramDeliveryRecovery(status: "reserved" | "sending") {
  return status === "reserved"
    ? { deliveryStatus: "cancelled" as const, errorCode: "interrupted_before_send", messageError: "El proceso se reinició antes de enviar a Telegram" }
    : { deliveryStatus: "uncertain" as const, errorCode: "restart_during_send", messageError: "No se pudo confirmar la entrega; revisa antes de repetir" };
}

export function manualHandoffTimestampExpression() {
  return sql`coalesce(${schema.conversation.handoffAt}, now())`;
}

export async function sendTelegramDelivery(input: {
  organizationId: string;
  conversationId: string;
  text: string;
  aiGenerated: boolean;
  actionId?: string;
  triggerMessageId?: string;
}): Promise<{ messageId: string; telegramDeliveryStatus: "sent" | "failed" | "uncertain" | "cancelled" }> {
  const beforeLock = await getTelegramCredentialsByOrg(input.organizationId);
  if (!beforeLock?.token || !beforeLock.connected || !beforeLock.allowedUserIds.length) {
    throw new TelegramDeliveryError("not_connected");
  }
  prepareTelegramText(input.text, input.aiGenerated);
  const initialTarget = await getTelegramConversationTarget(input.organizationId, input.conversationId);
  if (!initialTarget || initialTarget.channel !== "telegram") throw new TelegramDeliveryError("not_connected");
  if (initialTarget.isTest) throw new TelegramDeliveryError("sandbox_violation");
  if (!initialTarget.chatId) throw new TelegramDeliveryError("not_connected");
  const targetChatId = initialTarget.chatId;
  if (!isTelegramRecipientAllowed(beforeLock.allowedUserIds, initialTarget.chatId)) throw new TelegramDeliveryError("not_connected");
  if (!input.aiGenerated && !input.actionId) throw new TelegramDeliveryError("action_id_required");
  const dispatch = () => withTelegramBotLock(beforeLock.botId, () => withTelegramOperationLock(beforeLock.botId, async () => {
    const current = await getTelegramCredentialsByOrg(input.organizationId);
    if (!current?.token || !current.connected || current.botId !== beforeLock.botId) {
      throw new TelegramDeliveryError("not_connected");
    }
    if (!isTelegramRecipientAllowed(current.allowedUserIds, targetChatId)) throw new TelegramDeliveryError("not_connected");
    return sendTelegramDeliveryLocked(input, current);
  }));
  if (!input.aiGenerated) {
    return withTelegramManualTakeover(
      () => takeManualTelegramControl(input.organizationId, input.conversationId),
      dispatch,
    );
  }
  return dispatch();
}

async function getTelegramConversationTarget(organizationId: string, conversationId: string) {
  const rows = await getDb().select({
    channel: schema.conversation.channel,
    isTest: schema.conversation.isTest,
    chatId: schema.conversation.channelThreadRef,
  }).from(schema.conversation)
    .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)))
    .limit(1);
  const row = rows[0];
  return row?.chatId ? row : null;
}

async function takeManualTelegramControl(organizationId: string, conversationId: string): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx.update(schema.conversation).set({
      aiEnabled: false,
      handoffAt: manualHandoffTimestampExpression(),
      handoffReason: sql`coalesce(${schema.conversation.handoffReason}, 'manual_reply')`,
      updatedAt: now,
    }).where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)));
    await tx.update(schema.telegramAgentWork).set({ status: "cancelled", completedAt: now, errorCode: "human_handoff" })
      .where(scoped(schema.telegramAgentWork.organizationId, organizationId,
        and(eq(schema.telegramAgentWork.conversationId, conversationId), eq(schema.telegramAgentWork.status, "pending"))));
  });
}

async function sendTelegramDeliveryLocked(input: {
  organizationId: string;
  conversationId: string;
  text: string;
  aiGenerated: boolean;
  actionId?: string;
  triggerMessageId?: string;
}, credentials: NonNullable<Awaited<ReturnType<typeof getTelegramCredentialsByOrg>>>): Promise<{
  messageId: string;
  telegramDeliveryStatus: "sent" | "failed" | "cancelled" | "uncertain";
}> {
  const safeText = prepareTelegramText(input.text, input.aiGenerated);
  const db = getDb();
  const rows = await db
    .select({ conversation: schema.conversation, contact: schema.contact })
    .from(schema.conversation)
    .innerJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
    .where(scoped(schema.conversation.organizationId, input.organizationId, eq(schema.conversation.id, input.conversationId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.conversation.channel !== "telegram") throw new TelegramDeliveryError("not_connected");
  if (row.conversation.isTest) throw new TelegramDeliveryError("sandbox_violation");
  const chatId = row.conversation.channelThreadRef;
  if (!chatId) throw new TelegramDeliveryError("not_connected");
  if (!input.aiGenerated && !input.actionId) throw new TelegramDeliveryError("action_id_required");
  if (!isTelegramRecipientAllowed(credentials.allowedUserIds, chatId)) throw new TelegramDeliveryError("not_connected");

  const inboundRows = input.aiGenerated
    ? await db.select({ id: schema.message.id })
        .from(schema.message)
        .where(scoped(schema.message.organizationId, input.organizationId,
          eq(schema.message.conversationId, input.conversationId), eq(schema.message.direction, "in"),
          ...(input.triggerMessageId ? [eq(schema.message.id, input.triggerMessageId)] : [])))
        .orderBy(sql`${schema.message.createdAt} desc`)
        .limit(1)
    : [];
  const triggerMessageId = inboundRows[0]?.id ?? null;
  if (input.aiGenerated && !triggerMessageId) throw new TelegramDeliveryError("human_handoff");
  const idempotencyKey = input.aiGenerated
    ? `agent:${input.conversationId}:${triggerMessageId}`
    : `manual:${input.conversationId}:${input.actionId}`;

  const reservation = await db.transaction(async (tx) => {
    const currentRows = await tx.select().from(schema.conversation).where(scoped(
      schema.conversation.organizationId,
      input.organizationId,
      eq(schema.conversation.id, input.conversationId),
    )).limit(1);
    const current = currentRows[0];
    if (!current || current.channel !== "telegram" || current.isTest) {
      throw new TelegramDeliveryError(current?.isTest ? "sandbox_violation" : "not_connected");
    }
    if (input.aiGenerated && (!current.aiEnabled || current.handoffAt)) {
      throw new TelegramDeliveryError("human_handoff");
    }
    if (!input.aiGenerated) {
      await tx.update(schema.conversation).set({
        aiEnabled: false,
        handoffAt: current.handoffAt ?? new Date(),
        handoffReason: current.handoffReason ?? "manual_reply",
        updatedAt: new Date(),
      }).where(scoped(schema.conversation.organizationId, input.organizationId, eq(schema.conversation.id, input.conversationId)));
    }
    const inserted = await tx.insert(schema.telegramDelivery).values({
      id: newId("telegramDelivery"),
      organizationId: input.organizationId,
      credentialId: credentials.id,
      conversationId: input.conversationId,
      idempotencyKey,
      origin: input.aiGenerated ? "agent" : "manual",
      triggerMessageId,
      status: "reserved",
    }).onConflictDoNothing({ target: [schema.telegramDelivery.organizationId, schema.telegramDelivery.idempotencyKey] }).returning();
    if (!inserted[0]) {
      const existing = await tx.select().from(schema.telegramDelivery).where(scoped(
        schema.telegramDelivery.organizationId,
        input.organizationId,
        eq(schema.telegramDelivery.idempotencyKey, idempotencyKey),
      )).limit(1);
      const delivery = existing[0];
      if (!delivery?.messageId) return { messageId: null, created: false };
      return { messageId: delivery.messageId, created: false };
    }
    const messageRows = await tx.insert(schema.message).values({
      id: newId("message"),
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      direction: "out",
      type: "text",
      text: safeText.text,
      status: "pending",
      aiGenerated: input.aiGenerated,
      origin: input.aiGenerated ? "ai" : "operator",
    }).returning();
    const message = messageRows[0]!;
    await tx.update(schema.telegramDelivery).set({ messageId: message.id, updatedAt: new Date() })
      .where(eq(schema.telegramDelivery.id, inserted[0].id));
    await tx.update(schema.conversation).set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(scoped(schema.conversation.organizationId, input.organizationId, eq(schema.conversation.id, input.conversationId)));
    return { messageId: message.id, deliveryId: inserted[0].id, created: true };
  });

  if (!reservation.messageId) throw new TelegramDeliveryError("send_failed");
  if (!reservation.created) {
    const existingRows = await db.select({ status: schema.telegramDelivery.status })
      .from(schema.telegramDelivery)
      .where(scoped(schema.telegramDelivery.organizationId, input.organizationId, eq(schema.telegramDelivery.messageId, reservation.messageId)))
      .limit(1);
    const status = existingRows[0]?.status ?? "uncertain";
    return { messageId: reservation.messageId, telegramDeliveryStatus: status === "sent" ? "sent" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "uncertain" };
  }

  // Claim is committed before dispatch. A crash after this point is recovered
  // as uncertain and never retried automatically.
  const claimed = await db.update(schema.telegramDelivery)
    .set({ status: "sending", updatedAt: new Date() })
    .where(scoped(schema.telegramDelivery.organizationId, input.organizationId, and(
      eq(schema.telegramDelivery.id, reservation.deliveryId!),
      eq(schema.telegramDelivery.status, "reserved"),
    )))
    .returning({ id: schema.telegramDelivery.id });
  if (!claimed[0]) return { messageId: reservation.messageId, telegramDeliveryStatus: "uncertain" };

  const currentCredential = await db.select({ connected: schema.telegramCredentials.connected, allowedUserIds: schema.telegramCredentials.allowedUserIds })
    .from(schema.telegramCredentials)
    .where(scoped(schema.telegramCredentials.organizationId, input.organizationId, eq(schema.telegramCredentials.id, credentials.id)))
    .limit(1);
  if (!currentCredential[0]?.connected || !isTelegramRecipientAllowed(currentCredential[0].allowedUserIds ?? [], chatId)) {
    const revoked = Boolean(currentCredential[0]?.connected);
    await db.update(schema.telegramDelivery).set({ status: "cancelled", errorCode: revoked ? "recipient_revoked" : "channel_disconnected", updatedAt: new Date() })
      .where(eq(schema.telegramDelivery.id, reservation.deliveryId!));
    await db.update(schema.message).set({ error: revoked ? "El usuario ya no está autorizado" : "El canal Telegram se desconectó antes del envío" })
      .where(scoped(schema.message.organizationId, input.organizationId, eq(schema.message.id, reservation.messageId)));
    return { messageId: reservation.messageId, telegramDeliveryStatus: "cancelled" };
  }

  // Recheck after generation and reservation, immediately before calling Telegram.
  if (input.aiGenerated) {
    const fresh = await db.select({ aiEnabled: schema.conversation.aiEnabled, handoffAt: schema.conversation.handoffAt })
      .from(schema.conversation)
      .where(scoped(schema.conversation.organizationId, input.organizationId, eq(schema.conversation.id, input.conversationId)))
      .limit(1);
    if (!fresh[0]?.aiEnabled || fresh[0].handoffAt) {
      await db.update(schema.telegramDelivery).set({ status: "cancelled", errorCode: "human_handoff", updatedAt: new Date() })
        .where(eq(schema.telegramDelivery.id, reservation.deliveryId!));
      await db.update(schema.message).set({ error: "La conversación pasó a control humano" })
        .where(scoped(schema.message.organizationId, input.organizationId, eq(schema.message.id, reservation.messageId)));
      return { messageId: reservation.messageId, telegramDeliveryStatus: "cancelled" };
    }
  }

  try {
    const telegramMessageId = await new TelegramClient(credentials.token!).sendMessage(chatId, safeText.text, AbortSignal.timeout(25_000));
    await db.transaction(async (tx) => {
      await tx.update(schema.telegramDelivery).set({ status: "sent", telegramMessageId, updatedAt: new Date() })
        .where(scoped(schema.telegramDelivery.organizationId, input.organizationId, eq(schema.telegramDelivery.id, reservation.deliveryId!)));
      await tx.update(schema.message).set({ status: "sent" })
        .where(scoped(schema.message.organizationId, input.organizationId, eq(schema.message.id, reservation.messageId!)));
    });
    const sentRows = await db.select().from(schema.message).where(scoped(schema.message.organizationId, input.organizationId, eq(schema.message.id, reservation.messageId))).limit(1);
    if (sentRows[0]) publish(input.organizationId, { type: "message.new", data: { conversationId: input.conversationId, message: serializeMessage(sentRows[0], null, "sent") } });
    return { messageId: reservation.messageId, telegramDeliveryStatus: "sent" };
  } catch (error) {
    const uncertain = !(error instanceof TelegramApiError && ["unauthorized", "api_error", "rate_limited"].includes(error.code));
    const status = uncertain ? "uncertain" as const : "failed" as const;
    const code = error instanceof TelegramApiError ? error.code : "network_ambiguous";
    await db.transaction(async (tx) => {
      await tx.update(schema.telegramDelivery).set({ status, errorCode: code, updatedAt: new Date() })
        .where(scoped(schema.telegramDelivery.organizationId, input.organizationId, eq(schema.telegramDelivery.id, reservation.deliveryId!)));
      await tx.update(schema.message).set({ status: "failed", error: uncertain ? "No se pudo confirmar la entrega; revisa antes de repetir" : "Telegram rechazó el mensaje" })
        .where(scoped(schema.message.organizationId, input.organizationId, eq(schema.message.id, reservation.messageId!)));
    });
    if (error instanceof TelegramApiError && error.code === "unauthorized") {
      await updateTelegramState(input.organizationId, { connected: false, status: "error", lastErrorCode: "invalid_token" });
    }
    return { messageId: reservation.messageId, telegramDeliveryStatus: status };
  }
}

export async function recoverOrphanedTelegramDeliveries(organizationId: string): Promise<void> {
  const db = getDb();
  for (const orphanedStatus of ["reserved", "sending"] as const) {
    const recovery = orphanedTelegramDeliveryRecovery(orphanedStatus);
    const rows = await db.update(schema.telegramDelivery)
      .set({ status: recovery.deliveryStatus, errorCode: recovery.errorCode, updatedAt: new Date() })
      .where(scoped(schema.telegramDelivery.organizationId, organizationId, eq(schema.telegramDelivery.status, orphanedStatus)))
      .returning({ messageId: schema.telegramDelivery.messageId });
    const messageIds = rows.map((row) => row.messageId).filter((id): id is string => Boolean(id));
    for (const messageId of messageIds) {
      await db.update(schema.message)
        .set({ status: "failed", error: recovery.messageError })
        .where(scoped(schema.message.organizationId, organizationId, eq(schema.message.id, messageId)));
    }
  }
}
