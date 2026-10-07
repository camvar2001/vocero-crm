/**
 * E2E de integración Telegram contra PostgreSQL aislado.
 *
 * Solo se ejecuta dentro del servicio de aplicación del compose E2E, con
 * TELEGRAM_E2E_ISOLATED=1, CHANNELS=telegram y DATABASE_URL host `postgres`.
 * El fixture se limita a una organización sintética con slug aleatorio y se
 * elimina al terminar. global.fetch solo permite el endpoint de sendMessage
 * con el token sintético de este archivo; cualquier otro fetch falla cerrado.
 */

const SYNTHETIC_TOKEN = "7710000000:telegram-e2e-synthetic-token-not-real";
const FIXTURE_USER_ID = "1001";
const FIXTURE_BOT_ID = "7710000000";
const FIXTURE_CHAT_ID = "1001";

function assertIsolatedEnvironment(): void {
  if (process.env.TELEGRAM_E2E_ISOLATED !== "1") {
    throw new Error("isolation_flag_required");
  }
  if (process.env.CHANNELS !== "telegram") {
    throw new Error("telegram_only_channel_required");
  }
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    throw new Error("invalid_database_url");
  }
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    databaseUrl.hostname !== "postgres"
  ) {
    throw new Error("isolated_postgres_host_required");
  }
}

assertIsolatedEnvironment();

// Disable optional AI discovery in this process. This test calls no AI pipeline.
process.env.OPENROUTER_API_TOKEN = "";

const [{ and, eq }, { getDb, getSql, schema }, { newId }, credentials, ingest, delivery] =
  await Promise.all([
    import("drizzle-orm"),
    import("@/lib/db"),
    import("@/lib/db/ids"),
    import("@/server/telegram/credentials"),
    import("@/server/telegram/ingest"),
    import("@/server/telegram/delivery"),
  ]);

const db = getDb();
const originalFetch = globalThis.fetch;
let fixtureOrganizationId: string | null = null;
let fakeSendCalls = 0;
let deniedFetchCalls = 0;
let failNextTelegramRequest = false;
let stage = "fixture setup";
let checks = 0;

function check(condition: unknown, safeName: string): asserts condition {
  checks++;
  if (!condition) throw new Error(`assertion_failed:${safeName}`);
  console.log(`OK ${safeName}`);
}

function telegramResponse(messageId: string): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = async (input, init) => {
  const expectedUrl = `https://api.telegram.org/bot${SYNTHETIC_TOKEN}/sendMessage`;
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (requestUrl !== expectedUrl || init?.method !== "POST") {
    deniedFetchCalls++;
    throw new Error("blocked_non_fixture_network");
  }
  fakeSendCalls++;
  if (failNextTelegramRequest) {
    failNextTelegramRequest = false;
    throw new TypeError("synthetic_network_ambiguity");
  }
  return telegramResponse(String(8000 + fakeSendCalls));
};

async function countRows(table: typeof schema.contact, organizationId: string): Promise<number>;
async function countRows(table: typeof schema.message, organizationId: string): Promise<number>;
async function countRows(table: typeof schema.telegramUpdate, organizationId: string): Promise<number>;
async function countRows(table: typeof schema.telegramAgentWork, organizationId: string): Promise<number>;
async function countRows(
  table:
    | typeof schema.contact
    | typeof schema.message
    | typeof schema.telegramUpdate
    | typeof schema.telegramAgentWork,
  organizationId: string,
): Promise<number> {
  return (await db.select().from(table).where(eq(table.organizationId, organizationId))).length;
}

async function run(): Promise<void> {
  const slug = `telegram-e2e-${crypto.randomUUID()}`;
  const prior = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1);
  check(prior.length === 0, "slug sintético único");

  fixtureOrganizationId = newId("organization");
  await db.insert(schema.organization).values({
    id: fixtureOrganizationId,
    name: "Telegram E2E fixture",
    slug,
  });

  stage = "credential encryption";
  await credentials.saveTelegramCredentials({
    organizationId: fixtureOrganizationId,
    botId: FIXTURE_BOT_ID,
    botUsername: "telegram_e2e_fixture_bot",
    token: SYNTHETIC_TOKEN,
    allowedUserIds: [FIXTURE_USER_ID],
    connected: true,
  });
  const saved = await credentials.getTelegramCredentialsByOrg(fixtureOrganizationId);
  const credentialRows = await db
    .select({ cipher: schema.telegramCredentials.tokenCipher, iv: schema.telegramCredentials.tokenIv, tag: schema.telegramCredentials.tokenTag })
    .from(schema.telegramCredentials)
    .where(eq(schema.telegramCredentials.organizationId, fixtureOrganizationId))
    .limit(1);
  check(
    saved?.token === SYNTHETIC_TOKEN &&
      Boolean(credentialRows[0]?.cipher && credentialRows[0]?.iv && credentialRows[0]?.tag) &&
      credentialRows[0]?.cipher !== SYNTHETIC_TOKEN,
    "credencial cifrada y descifrada desde la fila persistida",
  );
  if (!saved) throw new Error("credential_fixture_missing");

  stage = "private update ingestion";
  const updates: unknown[] = Array.from({ length: 10 }, (_, index) => ({
    message_id: 5000 + index,
    date: 1_780_000_000 + index,
    chat: { id: FIXTURE_CHAT_ID, type: "private" },
    from: { id: FIXTURE_USER_ID, is_bot: false, first_name: "Fixture" },
    text: `Private fixture ${index + 1}`,
  }));
  const accepted = [];
  for (let index = 0; index < updates.length; index++) {
    accepted.push(await ingest.ingestTelegramUpdate(saved, 9000 + index, updates[index]));
  }
  check(accepted.every((result) => result.disposition === "accepted"), "10 updates privados permitidos aceptados");

  const replays = [];
  for (let index = 0; index < updates.length; index++) {
    replays.push(await ingest.ingestTelegramUpdate(saved, 9000 + index, updates[index]));
  }
  check(replays.every((result) => result.disposition === "duplicate"), "replay de 10 updates no duplica eventos");

  const rejected = await Promise.all([
    ingest.ingestTelegramUpdate(saved, 9010, {
      message_id: 5010,
      date: 1_780_000_020,
      chat: { id: "-1001", type: "group" },
      from: { id: "2002", is_bot: false, first_name: "Group fixture" },
      text: "Group fixture must be discarded",
    }),
    ingest.ingestTelegramUpdate(saved, 9011, {
      message_id: 5011,
      date: 1_780_000_021,
      chat: { id: "2002", type: "private" },
      from: { id: "2002", is_bot: false, first_name: "Unauthorized fixture" },
      text: "Unauthorized fixture must be discarded",
    }),
  ]);
  check(rejected.every((result) => result.disposition === "discarded"), "grupo y remitente no permitido descartados");
  check(
    (await countRows(schema.contact, fixtureOrganizationId)) === 1 &&
      (await countRows(schema.message, fixtureOrganizationId)) === 10 &&
      (await countRows(schema.telegramUpdate, fixtureOrganizationId)) === 12 &&
      (await countRows(schema.telegramAgentWork, fixtureOrganizationId)) === 10,
    "grupo y remitente no permitido no crean contactos ni mensajes",
  );

  const conversations = await db
    .select({ id: schema.conversation.id, channelThreadRef: schema.conversation.channelThreadRef })
    .from(schema.conversation)
    .where(eq(schema.conversation.organizationId, fixtureOrganizationId))
    .limit(1);
  const conversation = conversations[0];
  const inbound = await db
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(and(
      eq(schema.message.organizationId, fixtureOrganizationId),
      eq(schema.message.direction, "in"),
    ))
    .orderBy(schema.message.createdAt)
    .limit(1);
  if (!conversation || !inbound[0]) throw new Error("inbound_fixture_missing");

  stage = "manual success and handoff";
  const successInput = {
    organizationId: fixtureOrganizationId,
    conversationId: conversation.id,
    text: "Synthetic successful send",
    aiGenerated: false,
    actionId: "telegram-e2e-success-action",
  };
  const success = await delivery.sendTelegramDelivery(successInput);
  const successRetry = await delivery.sendTelegramDelivery(successInput);
  check(
    success.telegramDeliveryStatus === "sent" &&
      successRetry.telegramDeliveryStatus === "sent" &&
      success.messageId === successRetry.messageId &&
      fakeSendCalls === 1,
    "send manual exitoso y retry idempotente con una llamada Telegram",
  );
  const handoff = await db
    .select({ aiEnabled: schema.conversation.aiEnabled, handoffAt: schema.conversation.handoffAt, handoffReason: schema.conversation.handoffReason })
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversation.id))
    .limit(1);
  check(
    handoff[0]?.aiEnabled === false && Boolean(handoff[0]?.handoffAt) && handoff[0]?.handoffReason === "manual_reply",
    "el envío manual persiste handoff humano antes de continuar",
  );
  let handoffBlocked = false;
  try {
    await delivery.sendTelegramDelivery({
      organizationId: fixtureOrganizationId,
      conversationId: conversation.id,
      text: "Synthetic AI reply blocked by handoff",
      aiGenerated: true,
      triggerMessageId: inbound[0].id,
    });
  } catch (error) {
    handoffBlocked = error instanceof delivery.TelegramDeliveryError && error.code === "human_handoff";
  }
  check(handoffBlocked && fakeSendCalls === 1, "handoff bloquea envío IA antes de la red");

  stage = "ambiguous network outcome";
  const uncertainInput = {
    organizationId: fixtureOrganizationId,
    conversationId: conversation.id,
    text: "Synthetic ambiguous send",
    aiGenerated: false,
    actionId: "telegram-e2e-uncertain-action",
  };
  failNextTelegramRequest = true;
  const uncertain = await delivery.sendTelegramDelivery(uncertainInput);
  const callsAfterUncertain = fakeSendCalls;
  const uncertainRetry = await delivery.sendTelegramDelivery(uncertainInput);
  check(
    uncertain.telegramDeliveryStatus === "uncertain" &&
      uncertainRetry.telegramDeliveryStatus === "uncertain" &&
      uncertain.messageId === uncertainRetry.messageId &&
      callsAfterUncertain === 2 &&
      fakeSendCalls === callsAfterUncertain,
    "fallo de red queda incierto y retry no vuelve a enviar",
  );

  stage = "orphan recovery";
  const recoveryRows = [
    { idempotencyKey: "telegram-e2e-orphan-reserved", status: "reserved" as const },
    { idempotencyKey: "telegram-e2e-orphan-sending", status: "sending" as const },
  ];
  for (const row of recoveryRows) {
    await db.insert(schema.telegramDelivery).values({
      id: newId("telegramDelivery"),
      organizationId: fixtureOrganizationId,
      credentialId: saved.id,
      conversationId: conversation.id,
      idempotencyKey: row.idempotencyKey,
      origin: "manual",
      status: row.status,
    });
  }
  await delivery.recoverOrphanedTelegramDeliveries(fixtureOrganizationId);
  const recovered = await db
    .select({ idempotencyKey: schema.telegramDelivery.idempotencyKey, status: schema.telegramDelivery.status })
    .from(schema.telegramDelivery)
    .where(eq(schema.telegramDelivery.organizationId, fixtureOrganizationId));
  check(
    recovered.some((row) => row.idempotencyKey === recoveryRows[0].idempotencyKey && row.status === "cancelled") &&
      recovered.some((row) => row.idempotencyKey === recoveryRows[1].idempotencyKey && row.status === "uncertain") &&
      fakeSendCalls === callsAfterUncertain,
    "reserved se cancela y sending queda incierto sin llamada externa",
  );

  stage = "credential revoke";
  await credentials.revokeTelegramCredentials(fixtureOrganizationId);
  const revoked = await credentials.getTelegramCredentialsByOrg(fixtureOrganizationId);
  const revokedRow = await db
    .select({ cipher: schema.telegramCredentials.tokenCipher, iv: schema.telegramCredentials.tokenIv, tag: schema.telegramCredentials.tokenTag })
    .from(schema.telegramCredentials)
    .where(eq(schema.telegramCredentials.organizationId, fixtureOrganizationId))
    .limit(1);
  check(
    revoked?.token === null && revokedRow[0]?.cipher === null && revokedRow[0]?.iv === null && revokedRow[0]?.tag === null,
    "revocación elimina el ciphertext y su material de descifrado",
  );
  const historical = await db
    .select({ id: schema.conversation.id, channelThreadRef: schema.conversation.channelThreadRef })
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversation.id))
    .limit(1);
  let revokedSendBlocked = false;
  try {
    await delivery.sendTelegramDelivery({
      organizationId: fixtureOrganizationId,
      conversationId: conversation.id,
      text: "Synthetic revoked target must not send",
      aiGenerated: false,
      actionId: "telegram-e2e-after-revoke",
    });
  } catch (error) {
    revokedSendBlocked = error instanceof delivery.TelegramDeliveryError && error.code === "not_connected";
  }
  check(
    historical[0]?.channelThreadRef === FIXTURE_CHAT_ID &&
      revokedSendBlocked &&
      fakeSendCalls === callsAfterUncertain,
    "el hilo histórico sobrevive a revocación y no acepta nuevos envíos",
  );
  check(deniedFetchCalls === 0, "ningún fetch salió del fixture de Telegram permitido");
}

try {
  await run();
  console.log(`TODO VERDE (${checks} checks de integración Telegram)`);
} catch {
  // Deliberately omit exception objects: driver/SQL errors can contain host or data.
  console.error(`FAILED at safe stage: ${stage}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  if (fixtureOrganizationId) {
    try {
      await db.delete(schema.telegramDelivery).where(eq(schema.telegramDelivery.organizationId, fixtureOrganizationId));
      await db.delete(schema.telegramAgentWork).where(eq(schema.telegramAgentWork.organizationId, fixtureOrganizationId));
      await db.delete(schema.telegramUpdate).where(eq(schema.telegramUpdate.organizationId, fixtureOrganizationId));
      await db.delete(schema.organization).where(eq(schema.organization.id, fixtureOrganizationId));
    } catch {
      console.error("FIXTURE CLEANUP FAILED; inspect isolated test database only");
      process.exitCode = 1;
    }
  }
  try {
    await getSql().end({ timeout: 5 });
  } catch {
    process.exitCode = 1;
  }
}
