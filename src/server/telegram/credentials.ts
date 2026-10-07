import { and, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

export class TelegramBotMismatchError extends Error {
  constructor() {
    super("El token pertenece a un bot distinto; el cursor y el historial se conservan");
    this.name = "TelegramBotMismatchError";
  }
}

type TelegramRow = typeof schema.telegramCredentials.$inferSelect;

export type TelegramCredentials = {
  id: string;
  organizationId: string;
  botId: string;
  botUsername: string | null;
  token: string | null;
  allowedUserIds: string[];
  connected: boolean;
  status: TelegramRow["status"];
  lastErrorCode: string | null;
  nextUpdateId: string | null;
};

function toCredentials(row: TelegramRow): TelegramCredentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    botId: row.botId,
    botUsername: row.botUsername,
    token:
      row.tokenCipher && row.tokenIv && row.tokenTag
        ? decryptSecret({ cipher: row.tokenCipher, iv: row.tokenIv, tag: row.tokenTag })
        : null,
    allowedUserIds: Array.isArray(row.allowedUserIds) ? row.allowedUserIds : [],
    connected: row.connected,
    status: row.status,
    lastErrorCode: row.lastErrorCode,
    nextUpdateId: row.nextUpdateId,
  };
}

export async function getTelegramCredentialsByOrg(
  organizationId: string,
): Promise<TelegramCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.telegramCredentials)
    .where(scoped(schema.telegramCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function saveTelegramCredentials(input: {
  organizationId: string;
  botId: string;
  botUsername: string | null;
  token?: string;
  allowedUserIds: string[];
  connected?: boolean;
}): Promise<void> {
  const db = getDb();
  const existing = await getTelegramCredentialsByOrg(input.organizationId);
  if (existing && existing.botId !== input.botId) throw new TelegramBotMismatchError();
  if (!existing && !input.token) throw new Error("Telegram token required");
  const encrypted = input.token ? encryptSecret(input.token) : null;
  if (existing && input.token && !encrypted) throw new Error("Telegram token required");

  const values = {
    id: existing?.id ?? newId("telegramCredentials"),
    organizationId: input.organizationId,
    botId: input.botId,
    botUsername: input.botUsername,
    tokenCipher: encrypted?.cipher ?? undefined,
    tokenIv: encrypted?.iv ?? undefined,
    tokenTag: encrypted?.tag ?? undefined,
    allowedUserIds: input.allowedUserIds,
    connected: input.connected ?? existing?.connected ?? false,
    status: input.connected === false ? "disconnected" as const : input.connected === true ? "connecting" as const : existing?.status ?? "disconnected" as const,
    lastErrorCode: null,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.telegramCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: schema.telegramCredentials.organizationId,
      set: {
        botUsername: values.botUsername,
        ...(encrypted
          ? { tokenCipher: encrypted.cipher, tokenIv: encrypted.iv, tokenTag: encrypted.tag }
          : {}),
        allowedUserIds: values.allowedUserIds,
        connected: values.connected,
        status: values.status,
        lastErrorCode: null,
        updatedAt: values.updatedAt,
      },
    });
}

export async function setTelegramConnected(
  organizationId: string,
  connected: boolean,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const credentials = await tx.select({ id: schema.telegramCredentials.id })
      .from(schema.telegramCredentials)
      .where(scoped(schema.telegramCredentials.organizationId, organizationId))
      .limit(1);
    if (!credentials[0]) return;
    await tx.update(schema.telegramCredentials)
      .set({ connected, status: connected ? "connecting" : "disconnected", lastErrorCode: null, updatedAt: new Date() })
      .where(scoped(schema.telegramCredentials.organizationId, organizationId));
    if (!connected) {
      await tx.update(schema.telegramAgentWork)
        .set({ status: "cancelled", completedAt: new Date(), errorCode: "channel_disconnected" })
        .where(scoped(schema.telegramAgentWork.organizationId, organizationId,
          and(eq(schema.telegramAgentWork.credentialId, credentials[0].id), eq(schema.telegramAgentWork.status, "pending"))));
    }
  });
}

export async function revokeTelegramCredentials(organizationId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const credentials = await tx.select({ id: schema.telegramCredentials.id })
      .from(schema.telegramCredentials)
      .where(scoped(schema.telegramCredentials.organizationId, organizationId))
      .limit(1);
    if (!credentials[0]) return;
    await tx.update(schema.telegramCredentials)
      .set({
        tokenCipher: null,
        tokenIv: null,
        tokenTag: null,
        connected: false,
        status: "disconnected",
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(scoped(schema.telegramCredentials.organizationId, organizationId));
    await tx.update(schema.telegramAgentWork)
      .set({ status: "cancelled", completedAt: new Date(), errorCode: "channel_disconnected" })
      .where(scoped(schema.telegramAgentWork.organizationId, organizationId,
        and(eq(schema.telegramAgentWork.credentialId, credentials[0].id), eq(schema.telegramAgentWork.status, "pending"))));
  });
}

export async function updateTelegramState(
  organizationId: string,
  patch: {
    status?: TelegramRow["status"];
    lastErrorCode?: string | null;
    nextUpdateId?: string | null;
    connected?: boolean;
  },
): Promise<void> {
  await getDb()
    .update(schema.telegramCredentials)
    .set({ ...patch, updatedAt: new Date() })
    .where(scoped(schema.telegramCredentials.organizationId, organizationId));
}

export async function advanceTelegramCursor(
  organizationId: string,
  updateId: string,
): Promise<void> {
  await getDb()
    .update(schema.telegramCredentials)
    .set({ nextUpdateId: updateId, updatedAt: new Date() })
    .where(scoped(schema.telegramCredentials.organizationId, organizationId));
}

export async function listConnectedTelegramOrganizations(): Promise<string[]> {
  const rows = await getDb()
    .select({ organizationId: schema.telegramCredentials.organizationId })
    .from(schema.telegramCredentials)
    .where(eq(schema.telegramCredentials.connected, true));
  return rows.map((row) => row.organizationId);
}

export async function getTelegramCounts(organizationId: string) {
  const rows = await getDb()
    .select({
      pending: sql<number>`count(*) filter (where ${schema.telegramDelivery.status} in ('reserved','sending'))::int`,
      failed: sql<number>`count(*) filter (where ${schema.telegramDelivery.status} = 'failed')::int`,
      uncertain: sql<number>`count(*) filter (where ${schema.telegramDelivery.status} = 'uncertain')::int`,
    })
    .from(schema.telegramDelivery)
    .where(scoped(schema.telegramDelivery.organizationId, organizationId));
  return rows[0] ?? { pending: 0, failed: 0, uncertain: 0 };
}
