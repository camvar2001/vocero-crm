import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { onLeadActivity } from "@/server/inbox/lead-activity";
import { publish } from "@/server/events/bus";
import type { TelegramCredentials } from "@/server/telegram/credentials";
import { buildTelegramProviderMessageId, parseTelegramPrivateText } from "@/server/telegram/updates";

export type TelegramIngestResult = {
  disposition: "accepted" | "discarded" | "duplicate";
  jobId: string | null;
};

export class TelegramIngestPausedError extends Error {
  constructor() {
    super("Telegram ingestion paused while settings changed");
    this.name = "TelegramIngestPausedError";
  }
}

/** Persists one update durably before the poller advances its offset. */
export async function ingestTelegramUpdate(
  credential: TelegramCredentials,
  updateId: number,
  update: unknown,
): Promise<TelegramIngestResult> {
  const parsed = parseTelegramPrivateText(update);
  const providerMessageId = parsed
    ? buildTelegramProviderMessageId(credential.botId, parsed.chatId, parsed.messageId)
    : `tg:${credential.botId}:update:${updateId}`;
  const db = getDb();

  const outcome = await db.transaction(async (tx) => {
    const currentCredential = await tx.select({ connected: schema.telegramCredentials.connected, botId: schema.telegramCredentials.botId, allowedUserIds: schema.telegramCredentials.allowedUserIds })
      .from(schema.telegramCredentials)
      .where(and(eq(schema.telegramCredentials.organizationId, credential.organizationId), eq(schema.telegramCredentials.id, credential.id)))
      .for("update")
      .limit(1);
    const current = currentCredential[0];
    if (!current?.connected || current.botId !== credential.botId) throw new TelegramIngestPausedError();

    const existingEvent = await tx
      .select()
      .from(schema.telegramUpdate)
      .where(and(
        eq(schema.telegramUpdate.organizationId, credential.organizationId),
        eq(schema.telegramUpdate.credentialId, credential.id),
        eq(schema.telegramUpdate.updateId, String(updateId)),
      ))
      .limit(1);
    if (existingEvent[0]) {
      const work = await tx
        .select({ id: schema.telegramAgentWork.id, status: schema.telegramAgentWork.status })
        .from(schema.telegramAgentWork)
        .where(and(
          eq(schema.telegramAgentWork.organizationId, credential.organizationId),
          eq(schema.telegramAgentWork.credentialId, credential.id),
          eq(schema.telegramAgentWork.updateId, String(updateId)),
        ))
        .limit(1);
      return {
        disposition: "duplicate" as const,
        jobId: work[0]?.status === "pending" ? work[0].id : null,
        messageId: existingEvent[0].messageId,
        contactId: null,
        conversationId: existingEvent[0].conversationId,
      };
    }

    if (!parsed || !(current.allowedUserIds ?? []).includes(parsed.userId)) {
      const event = await tx.insert(schema.telegramUpdate).values({
        id: newId("telegramUpdate"),
        organizationId: credential.organizationId,
        credentialId: credential.id,
        updateId: String(updateId),
        providerMessageId,
        disposition: "discarded",
        conversationId: null,
      }).onConflictDoNothing().returning();
      return {
        disposition: event[0] ? "discarded" as const : "duplicate" as const,
        jobId: null,
        messageId: null,
        contactId: null,
        conversationId: null,
      };
    }

    const identity = `tg:${parsed.userId}`;
    const contactRows = await tx.select().from(schema.contact).where(and(
      eq(schema.contact.organizationId, credential.organizationId),
      eq(schema.contact.channel, "telegram"),
      eq(schema.contact.waIdentity, identity),
    )).limit(1);
    let contact = contactRows[0];
    if (contact) {
      if (contact.archivedAt) {
        const restored = await tx.update(schema.contact).set({ archivedAt: null, updatedAt: new Date() })
          .where(eq(schema.contact.id, contact.id)).returning();
        contact = restored[0] ?? { ...contact, archivedAt: null };
      }
    } else {
      const inserted = await tx.insert(schema.contact).values({
        id: newId("contact"),
        organizationId: credential.organizationId,
        channel: "telegram",
        waIdentity: identity,
        phone: null,
        waUserId: null,
        name: parsed.name?.trim() || "Telegram",
      }).onConflictDoNothing({ target: [schema.contact.organizationId, schema.contact.channel, schema.contact.waIdentity] }).returning();
      contact = inserted[0] ?? (await tx.select().from(schema.contact).where(and(
        eq(schema.contact.organizationId, credential.organizationId),
        eq(schema.contact.channel, "telegram"),
        eq(schema.contact.waIdentity, identity),
      )).limit(1))[0];
      if (!contact) throw new Error("telegram_contact_missing_after_upsert");
    }

    const conversationRows = await tx.select().from(schema.conversation).where(and(
      eq(schema.conversation.organizationId, credential.organizationId),
      eq(schema.conversation.contactId, contact.id),
      eq(schema.conversation.isTest, false),
    )).limit(1);
    let conversation = conversationRows[0];
    if (conversation) {
      if (conversation.channelThreadRef !== parsed.chatId || conversation.channel !== "telegram") {
        const updated = await tx.update(schema.conversation).set({ channel: "telegram", channelThreadRef: parsed.chatId, updatedAt: new Date() })
          .where(eq(schema.conversation.id, conversation.id)).returning();
        conversation = updated[0] ?? { ...conversation, channel: "telegram", channelThreadRef: parsed.chatId };
      }
    } else {
      const inserted = await tx.insert(schema.conversation).values({
        id: newId("conversation"),
        organizationId: credential.organizationId,
        contactId: contact.id,
        channel: "telegram",
        channelThreadRef: parsed.chatId,
      }).onConflictDoNothing().returning();
      conversation = inserted[0] ?? (await tx.select().from(schema.conversation).where(and(
        eq(schema.conversation.organizationId, credential.organizationId),
        eq(schema.conversation.contactId, contact.id),
        eq(schema.conversation.isTest, false),
      )).limit(1))[0];
      if (!conversation) throw new Error("telegram_conversation_missing_after_upsert");
    }

    const contactId = contact.id;
    const conversationId = conversation.id;

    const eventRows = await tx
      .insert(schema.telegramUpdate)
      .values({
        id: newId("telegramUpdate"),
        organizationId: credential.organizationId,
        credentialId: credential.id,
        updateId: String(updateId),
        providerMessageId,
        disposition: "accepted",
        conversationId,
      })
      .onConflictDoNothing()
      .returning();
    const event = eventRows[0];
    if (!event) return { disposition: "duplicate" as const, jobId: null, messageId: null };
    const messageRows = await tx
      .insert(schema.message)
      .values({
        id: newId("message"),
        organizationId: credential.organizationId,
        conversationId,
        waMessageId: providerMessageId,
        direction: "in",
        type: "text",
        text: parsed.text,
        status: "delivered",
        waTimestamp: new Date(parsed.timestamp * 1000),
      })
      .onConflictDoNothing({ target: schema.message.waMessageId })
      .returning();
    const message = messageRows[0] ?? (await tx
      .select()
      .from(schema.message)
      .where(and(
        eq(schema.message.organizationId, credential.organizationId),
        eq(schema.message.waMessageId, providerMessageId),
      ))
      .limit(1))[0];
    if (!message) throw new Error("telegram_message_missing_after_upsert");

    await tx
      .update(schema.conversation)
      .set({
        lastInboundAt: message.waTimestamp,
        lastMessageAt: message.waTimestamp,
        unreadCount: sql`${schema.conversation.unreadCount} + 1`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.conversation.organizationId, credential.organizationId),
        eq(schema.conversation.id, conversationId),
      ));
    const job = await tx
      .insert(schema.telegramAgentWork)
      .values({
        id: newId("telegramWork"),
        organizationId: credential.organizationId,
        credentialId: credential.id,
        updateId: String(updateId),
        conversationId,
        inboundMessageId: message.id,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning();
    const jobId = job[0]?.id ?? (await tx
      .select({ id: schema.telegramAgentWork.id })
      .from(schema.telegramAgentWork)
      .where(and(
        eq(schema.telegramAgentWork.organizationId, credential.organizationId),
        eq(schema.telegramAgentWork.credentialId, credential.id),
        eq(schema.telegramAgentWork.updateId, String(updateId)),
      ))
      .limit(1))[0]?.id ?? null;
    await tx
      .update(schema.telegramUpdate)
      .set({ messageId: message.id, conversationId })
      .where(eq(schema.telegramUpdate.id, event.id));
    return { disposition: "accepted" as const, jobId, messageId: message.id, contactId, conversationId };
  });

  if (outcome.disposition === "accepted" && outcome.messageId && parsed && outcome.conversationId && outcome.contactId) {
    const messages = await db
      .select()
      .from(schema.message)
      .where(and(eq(schema.message.organizationId, credential.organizationId), eq(schema.message.id, outcome.messageId)))
      .limit(1);
    const message = messages[0];
    if (message) {
      if (outcome.disposition === "accepted") {
        try {
          await onLeadActivity(credential.organizationId, outcome.contactId, message.waTimestamp ?? new Date(parsed.timestamp * 1000));
        } catch {
          console.error("[telegram] lead_activity_failed");
        }
      }
      publish(credential.organizationId, {
        type: "message.new",
        data: { conversationId: outcome.conversationId, message: { ...serializeTelegramMessage(message), telegramDeliveryStatus: null } },
      });
      publish(credential.organizationId, { type: "conversation.updated", data: { conversation: { id: outcome.conversationId } } });
    }
  }
  return { disposition: outcome.disposition, jobId: outcome.jobId };
}

function serializeTelegramMessage(message: typeof schema.message.$inferSelect) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    type: message.type,
    text: message.text,
    status: message.status,
    error: message.error,
    aiGenerated: message.aiGenerated,
    origin: message.origin,
    media: null,
    createdAt: (message.waTimestamp ?? message.createdAt).toISOString(),
  };
}
