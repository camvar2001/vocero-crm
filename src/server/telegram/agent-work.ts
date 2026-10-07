import { and, eq } from "drizzle-orm";
import { isAiConfigured } from "@/lib/env";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { runAgentTurn } from "@/server/ai/pipeline";
import type { TelegramCredentials } from "@/server/telegram/credentials";

const globalForWork = globalThis as unknown as {
  __telegramAgentQueues?: Map<string, { credentials: TelegramCredentials; ids: Set<string> }>;
};

function queues() {
  return (globalForWork.__telegramAgentQueues ??= new Map());
}

/** Queue durable jobs per conversation so two inbound updates never run turns concurrently. */
export async function scheduleTelegramAgentWork(
  credentials: TelegramCredentials,
  jobId: string,
): Promise<void> {
  if (!isAiConfigured()) return;
  const db = getDb();
  const rows = await db.select({ conversationId: schema.telegramAgentWork.conversationId })
    .from(schema.telegramAgentWork)
    .where(scoped(schema.telegramAgentWork.organizationId, credentials.organizationId, eq(schema.telegramAgentWork.id, jobId)))
    .limit(1);
  const conversationId = rows[0]?.conversationId;
  if (!conversationId) return;
  const key = `${credentials.organizationId}:${conversationId}`;
  const queue = queues().get(key);
  if (queue) {
    queue.ids.add(jobId);
    return;
  }
  const work = { credentials, ids: new Set([jobId]) };
  queues().set(key, work);
  try {
    while (work.ids.size > 0) {
      const current = work.ids.values().next().value as string | undefined;
      if (!current) break;
      work.ids.delete(current);
      await processTelegramAgentWork(credentials, current);
    }
  } finally {
    queues().delete(key);
  }
}

export async function recoverTelegramAgentWork(credentials: TelegramCredentials): Promise<void> {
  const db = getDb();
  // A claimed turn may have reached the provider before a crash. Never repeat it.
  await db.update(schema.telegramAgentWork)
    .set({ status: "uncertain", errorCode: "restart_during_turn" })
    .where(scoped(schema.telegramAgentWork.organizationId, credentials.organizationId,
      and(eq(schema.telegramAgentWork.credentialId, credentials.id), eq(schema.telegramAgentWork.status, "claimed"))));
  await schedulePendingTelegramAgentWork(credentials);
}

export async function schedulePendingTelegramAgentWork(credentials: TelegramCredentials): Promise<void> {
  if (!isAiConfigured()) return;
  const db = getDb();
  const pending = await db.select({ id: schema.telegramAgentWork.id })
    .from(schema.telegramAgentWork)
    .where(scoped(schema.telegramAgentWork.organizationId, credentials.organizationId,
      and(eq(schema.telegramAgentWork.credentialId, credentials.id), eq(schema.telegramAgentWork.status, "pending"))));
  for (const job of pending) void scheduleTelegramAgentWork(credentials, job.id);
}

async function processTelegramAgentWork(credentials: TelegramCredentials, jobId: string): Promise<void> {
  if (!isAiConfigured()) return;
  const db = getDb();
  const credential = await db.select({ connected: schema.telegramCredentials.connected, allowedUserIds: schema.telegramCredentials.allowedUserIds })
    .from(schema.telegramCredentials)
    .where(scoped(schema.telegramCredentials.organizationId, credentials.organizationId,
      and(eq(schema.telegramCredentials.id, credentials.id), eq(schema.telegramCredentials.connected, true))))
    .limit(1);
  if (!credential[0]?.connected) {
    await cancelPendingWork(db, credentials.organizationId, jobId, "channel_disconnected");
    return;
  }
  const claimed = await db.update(schema.telegramAgentWork)
    .set({ status: "claimed", claimedAt: new Date() })
    .where(scoped(schema.telegramAgentWork.organizationId, credentials.organizationId,
      and(eq(schema.telegramAgentWork.id, jobId), eq(schema.telegramAgentWork.status, "pending"))))
    .returning({ conversationId: schema.telegramAgentWork.conversationId, inboundMessageId: schema.telegramAgentWork.inboundMessageId });
  const conversationId = claimed[0]?.conversationId;
  if (!conversationId) return;
  const inboundMessageId = claimed[0]!.inboundMessageId;
  const conversation = await db.select({
    aiEnabled: schema.conversation.aiEnabled,
    handoffAt: schema.conversation.handoffAt,
    chatId: schema.conversation.channelThreadRef,
  })
    .from(schema.conversation)
    .where(scoped(schema.conversation.organizationId, credentials.organizationId, eq(schema.conversation.id, conversationId)))
    .limit(1);
  if (!conversation[0]?.aiEnabled || conversation[0].handoffAt) {
    await cancelPendingWork(db, credentials.organizationId, jobId, "human_handoff");
    return;
  }
  if (!conversation[0].chatId || !(credential[0].allowedUserIds ?? []).includes(conversation[0].chatId)) {
    await cancelPendingWork(db, credentials.organizationId, jobId, "recipient_revoked");
    return;
  }

  // Disconnect can race the claim and conversation checks. Recheck immediately
  // before entering the AI pipeline; delivery performs another check before send.
  const stillConnected = await db.select({ connected: schema.telegramCredentials.connected, allowedUserIds: schema.telegramCredentials.allowedUserIds })
    .from(schema.telegramCredentials)
    .where(scoped(schema.telegramCredentials.organizationId, credentials.organizationId,
      and(eq(schema.telegramCredentials.id, credentials.id), eq(schema.telegramCredentials.connected, true))))
    .limit(1);
  if (!stillConnected[0]?.connected) {
    await cancelPendingWork(db, credentials.organizationId, jobId, "channel_disconnected");
    return;
  }
  if (!conversation[0].chatId || !(stillConnected[0].allowedUserIds ?? []).includes(conversation[0].chatId)) {
    await cancelPendingWork(db, credentials.organizationId, jobId, "recipient_revoked");
    return;
  }

  try {
    await runAgentTurn(conversationId, { telegramTriggerMessageId: inboundMessageId });
    const delivery = await db.select({ status: schema.telegramDelivery.status })
      .from(schema.telegramDelivery)
      .where(scoped(schema.telegramDelivery.organizationId, credentials.organizationId,
        and(eq(schema.telegramDelivery.conversationId, conversationId), eq(schema.telegramDelivery.triggerMessageId, inboundMessageId))))
      .limit(1);
    const isUncertain = delivery[0]?.status === "uncertain" || delivery[0]?.status === "sending";
    await db.update(schema.telegramAgentWork).set({
      status: isUncertain ? "uncertain" : "completed",
      completedAt: new Date(),
      errorCode: isUncertain ? "delivery_uncertain" : null,
    }).where(scoped(schema.telegramAgentWork.organizationId, credentials.organizationId, eq(schema.telegramAgentWork.id, jobId)));
  } catch {
    await db.update(schema.telegramAgentWork).set({ status: "uncertain", completedAt: new Date(), errorCode: "turn_failed" })
      .where(scoped(schema.telegramAgentWork.organizationId, credentials.organizationId, eq(schema.telegramAgentWork.id, jobId)));
    console.error("[telegram] agent_turn_failed");
  }
}

async function cancelPendingWork(
  db: ReturnType<typeof getDb>,
  organizationId: string,
  jobId: string,
  reason: "channel_disconnected" | "human_handoff" | "recipient_revoked",
): Promise<void> {
  await db.update(schema.telegramAgentWork)
    .set({ status: "cancelled", completedAt: new Date(), errorCode: reason })
    .where(scoped(schema.telegramAgentWork.organizationId, organizationId, eq(schema.telegramAgentWork.id, jobId)));
}
