import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { channelDisabledResponse, isChannelEnabled } from "@/server/channels/enabled";
import { TelegramApiError, TelegramClient } from "@/server/telegram/client";
import { startTelegramPoller, stopTelegramPoller, withTelegramSessionLock } from "@/server/telegram/poller";
import { withTelegramBotLock, withTelegramOperationLock } from "@/server/telegram/mutex";
import {
  getTelegramCounts,
  getTelegramCredentialsByOrg,
  revokeTelegramCredentials,
  saveTelegramCredentials,
  setTelegramConnected,
  TelegramBotMismatchError,
} from "@/server/telegram/credentials";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  if (!isChannelEnabled("telegram")) return channelDisabledResponse();
  if (session.role !== "owner") return apiError(403, "forbidden", "Solo el propietario puede ver la configuración de Telegram");
  const credentials = await getTelegramCredentialsByOrg(session.organizationId);
  const counts = await getTelegramCounts(session.organizationId);
  return Response.json({
    enabled: true,
    configured: Boolean(credentials?.token),
    connected: Boolean(credentials?.connected && credentials.token),
    bot: credentials
      ? { id: credentials.botId, username: credentials.botUsername }
      : null,
    allowedUserIds: credentials?.allowedUserIds ?? [],
    status: credentials?.status ?? "disconnected",
    lastErrorCode: credentials?.lastErrorCode ?? null,
    cursor: credentials?.nextUpdateId ?? null,
    counts,
  });
});

const decimalId = z.string().trim().regex(/^\d{1,20}$/);
const putSchema = z.object({
  token: z.string().trim().min(1).max(512).optional(),
  allowedUserIds: z.array(decimalId).max(50),
  connected: z.boolean().optional(),
});

export const PUT = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("telegram")) return channelDisabledResponse();
  if (session.role !== "owner") return apiError(403, "forbidden", "Solo el propietario puede administrar Telegram");
  if (!sameOrigin(req)) return apiError(403, "invalid_origin", "Origen no permitido");
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  if (new Set(body.data.allowedUserIds).size !== body.data.allowedUserIds.length) {
    return apiError(422, "invalid_allowlist", "Elimina los IDs de Telegram repetidos");
  }

  const existing = await getTelegramCredentialsByOrg(session.organizationId);
  const token = body.data.token ?? existing?.token ?? null;
  if (!token) return apiError(422, "invalid_body", "Hace falta el token del bot");

  try {
    const client = new TelegramClient(token);
    const [bot, webhook] = await Promise.all([client.getMe(), client.getWebhookInfo()]);
    if (webhook.urlConfigured) {
      return apiError(409, "webhook_configured", "El bot tiene un webhook configurado; no se modificó");
    }
    if (existing && existing.botId !== bot.id) {
      return apiError(409, "bot_mismatch", "El token pertenece a otro bot; el cursor y el historial se conservan");
    }
    const shouldReconnect = body.data.connected ?? existing?.connected ?? false;
    if (shouldReconnect && body.data.allowedUserIds.length === 0) {
      return apiError(422, "allowlist_required", "Agrega al menos un ID autorizado antes de conectar");
    }
    if (existing?.connected) await setTelegramConnected(session.organizationId, false);
    await withTelegramBotLock(existing?.botId ?? bot.id, async () => {
      await stopTelegramPoller(existing?.botId ?? bot.id);
      const saved = await withTelegramSessionLock(existing?.botId ?? bot.id, () =>
        withTelegramOperationLock(existing?.botId ?? bot.id, async () => {
          await saveTelegramCredentials({
            organizationId: session.organizationId,
            botId: bot.id,
            botUsername: bot.username,
            token: body.data.token,
            allowedUserIds: body.data.allowedUserIds,
            connected: shouldReconnect,
          });
          return getTelegramCredentialsByOrg(session.organizationId);
        }),
      );
      if (saved?.connected && saved.token) startTelegramPoller(saved);
    });
    return Response.json({ ok: true, bot: { id: bot.id, username: bot.username } });
  } catch (error) {
    if (error instanceof TelegramBotMismatchError) {
      return apiError(409, "bot_mismatch", error.message);
    }
    return translateTelegramError(error);
  }
});

const connectionSchema = z.object({ connected: z.boolean() });

export const PATCH = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("telegram")) return channelDisabledResponse();
  if (session.role !== "owner") return apiError(403, "forbidden", "Solo el propietario puede administrar Telegram");
  if (!sameOrigin(req)) return apiError(403, "invalid_origin", "Origen no permitido");
  const body = await parseBody(req, connectionSchema);
  if (!body.ok) return body.response;
  const credentials = await getTelegramCredentialsByOrg(session.organizationId);
  if (!credentials?.token) return apiError(409, "not_configured", "Guarda primero el token del bot");
  if (body.data.connected) {
    if (credentials.allowedUserIds.length === 0) {
      return apiError(422, "allowlist_required", "Agrega al menos un ID autorizado antes de conectar");
    }
    try {
      const client = new TelegramClient(credentials.token);
      const [bot, webhook] = await Promise.all([client.getMe(), client.getWebhookInfo()]);
      if (bot.id !== credentials.botId) return apiError(409, "bot_mismatch", "El token pertenece a otro bot");
      if (webhook.urlConfigured) {
        return apiError(409, "webhook_configured", "El bot tiene un webhook configurado; no se modificó");
      }
    } catch (error) {
      return translateTelegramError(error);
    }
    if (credentials.connected && credentials.status === "connected") {
      return Response.json({ ok: true, connected: true });
    }
  }
  await setTelegramConnected(session.organizationId, false);
  let missingConfig = false;
  await withTelegramBotLock(credentials.botId, async () => {
    await stopTelegramPoller(credentials.botId);
    const saved = await withTelegramSessionLock(credentials.botId, () => withTelegramOperationLock(credentials.botId, async () => {
      if (body.data.connected) {
        const latest = await getTelegramCredentialsByOrg(session.organizationId);
        if (!latest?.token || latest.botId !== credentials.botId || latest.allowedUserIds.length === 0) {
          missingConfig = true;
          return null;
        }
      }
      await setTelegramConnected(session.organizationId, body.data.connected);
      return getTelegramCredentialsByOrg(session.organizationId);
    }));
    if (body.data.connected && saved?.connected && saved.token) startTelegramPoller(saved);
  });
  if (missingConfig) return apiError(409, "not_configured", "El bot cambió durante la conexión; vuelve a validar la configuración");
  return Response.json({ ok: true, connected: body.data.connected });
});

export const DELETE = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("telegram")) return channelDisabledResponse();
  if (session.role !== "owner") return apiError(403, "forbidden", "Solo el propietario puede administrar Telegram");
  if (!sameOrigin(req)) return apiError(403, "invalid_origin", "Origen no permitido");
  const credentials = await getTelegramCredentialsByOrg(session.organizationId);
  await revokeTelegramCredentials(session.organizationId);
  if (credentials?.botId) {
    await withTelegramBotLock(credentials.botId, async () => {
      await stopTelegramPoller(credentials.botId);
      await withTelegramSessionLock(credentials.botId, () => withTelegramOperationLock(credentials.botId, async () => {
        await revokeTelegramCredentials(session.organizationId);
      }));
    });
  }
  return Response.json({ ok: true, connected: false });
});

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(getEnv().APP_BASE_URL).origin;
  } catch {
    return false;
  }
}

function translateTelegramError(error: unknown): Response {
  if (error instanceof TelegramApiError) {
    if (error.code === "unauthorized") return apiError(422, "invalid_token", "El token de Telegram no es válido");
    if (error.code === "unavailable" || error.code === "rate_limited") {
      return apiError(503, "platform_unavailable", "Telegram no está disponible; intenta de nuevo");
    }
    if (error.code === "conflict") return apiError(409, "polling_conflict", "Telegram reportó otro consumidor de updates");
  }
  return apiError(503, "platform_unavailable", "No se pudo validar el bot de Telegram");
}
