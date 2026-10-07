import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { graphRequest, MetaApiError, normalizeRecipient } from "@/lib/meta/client";
import { destinatarioMeta, type Destinatario } from "@/lib/meta/destinatario";
import { publish } from "@/server/events/bus";
import {
  getCredentialsByOrg,
  markReconnectRequired,
  type Credentials,
} from "@/server/whatsapp/credentials";
import { isWindowOpen } from "@/server/inbox/window";
import { IG_PREFIX } from "@/server/inbox/identity";
import {
  getInstagramCredentialsByOrg,
  markInstagramReconnectRequired,
  type InstagramCredentials,
} from "@/server/instagram/credentials";
import { sendInstagramText } from "@/server/instagram/send";
import { FB_PREFIX } from "@/server/inbox/identity";
import {
  getMessengerCredentialsByOrg,
  markMessengerReconnectRequired,
  type MessengerCredentials,
} from "@/server/messenger/credentials";
import { sendMessengerText } from "@/server/messenger/send";
import {
  sendTelegramDelivery,
  TelegramDeliveryError,
  TelegramTextTooLongError,
} from "@/server/telegram/delivery";
import {
  capabilitiesFor,
  textFits,
  windowClosedMessage,
} from "@/server/channels/capabilities";
import { isChannelEnabled } from "@/server/channels/enabled";
import { serializeMessage } from "@/server/inbox/ingest";
import {
  saveMediaFile,
  uploadGraphMedia,
  validateOutgoing,
} from "@/server/whatsapp/media";

/** Error tipado del envío; `code` mapea a HTTP en la capa de API. */
export class SendError extends Error {
  code:
    | "sandbox_violation"
    | "not_connected"
    | "reconnect_required"
    | "window_closed"
    | "meta_error"
    | "meta_unavailable"
    | "upload_failed";
  /** 008: presente cuando el fallo ocurrió TRAS persistir el mensaje (failed). */
  messageId?: string;

  constructor(code: SendError["code"], message: string) {
    super(message);
    this.name = "SendError";
    this.code = code;
  }
}

type SendResult = { messageId: string };

type SendTarget = {
  conversation: typeof schema.conversation.$inferSelect;
  /** null cuando el destino no es WhatsApp (014). */
  credentials: Credentials | null;
  /** El destinatario en la forma que Meta espera: `to` o `recipient`. */
  destinatario: Destinatario;
  /** El identificador a secas, para lo que no arma un payload de Graph. */
  recipient: string;
  /** 014: presente solo en conversaciones de Instagram. */
  instagram?: InstagramCredentials;
  /** 017: presente solo en conversaciones de Messenger. */
  messenger?: MessengerCredentials;
  /** 018: Telegram uses durable reservation before calling its Bot API. */
  telegram?: true;
};

/**
 * Pre-flight común de todo envío por la conversación (008): existencia +
 * tenant, sandbox del Laboratorio (ASERCIÓN DURA, FR-031: jamás toca la API
 * real), ventana de 24 h, credenciales y destinatario.
 */
async function prepareSend(
  conversationId: string,
  organizationId: string
): Promise<SendTarget> {
  const db = getDb();
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const row = rows[0];
  if (!row || row.conversation.organizationId !== organizationId) {
    throw new SendError("meta_error", "Conversación no encontrada");
  }

  if (row.conversation.isTest) {
    throw new SendError(
      "sandbox_violation",
      "Conversación de prueba del Laboratorio: el envío real está prohibido"
    );
  }

  // 014: Instagram tiene su propio transporte, su propia ventana y NO tiene
  // plantillas. Se resuelve antes que las credenciales de WhatsApp para no
  // exigirle a una instancia de solo-Instagram un numero conectado.
  if (row.conversation.channel === "instagram") {
    // Una conversacion de un canal apagado puede existir (se apago despues de
    // recibirla): falla claro en vez de intentar un transporte que no aplica.
    if (!isChannelEnabled("instagram")) {
      throw new SendError(
        "not_connected",
        "El canal de Instagram está desactivado en esta instancia"
      );
    }
    const igCreds = await getInstagramCredentialsByOrg(organizationId);
    if (!igCreds) {
      throw new SendError(
        "not_connected",
        "No hay cuenta de Instagram conectada"
      );
    }
    if (igCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "El token de Instagram expiró: reconecta la cuenta en Configuración"
      );
    }
    const igRecipient = row.contact.waIdentity.startsWith(IG_PREFIX)
      ? row.contact.waIdentity.slice(IG_PREFIX.length)
      : row.contact.waIdentity;
    return {
      conversation: row.conversation,
      credentials: null,
      // Instagram no pasa por la Graph API de WhatsApp; el campo existe para
      // cumplir el tipo y su camino de envío no lo mira.
      destinatario: { to: igRecipient },
      recipient: igRecipient,
      instagram: igCreds,
    };
  }

  // 017: Messenger, mismo trato que Instagram: transporte propio, ventana
  // propia (con etiqueta fuera de ella) y sin plantillas.
  if (row.conversation.channel === "messenger") {
    if (!isChannelEnabled("messenger")) {
      throw new SendError(
        "not_connected",
        "El canal de Messenger está desactivado en esta instancia"
      );
    }
    const fbCreds = await getMessengerCredentialsByOrg(organizationId);
    if (!fbCreds) {
      throw new SendError(
        "not_connected",
        "No hay página de Facebook conectada"
      );
    }
    if (fbCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "El token de la página expiró: reconecta Messenger en Configuración"
      );
    }
    const fbRecipient = row.contact.waIdentity.startsWith(FB_PREFIX)
      ? row.contact.waIdentity.slice(FB_PREFIX.length)
      : row.contact.waIdentity;
    return {
      conversation: row.conversation,
      credentials: null,
      // Messenger tampoco pasa por la Graph API de WhatsApp.
      destinatario: { to: fbRecipient },
      recipient: fbRecipient,
      messenger: fbCreds,
    };
  }

  if (row.conversation.channel === "telegram") {
    if (!isChannelEnabled("telegram")) {
      throw new SendError("not_connected", "El canal de Telegram está desactivado en esta instancia");
    }
    if (!row.conversation.channelThreadRef) {
      throw new SendError("not_connected", "La conversación no tiene un chat de Telegram válido");
    }
    return {
      conversation: row.conversation,
      credentials: null,
      destinatario: { to: row.conversation.channelThreadRef },
      recipient: row.conversation.channelThreadRef,
      telegram: true,
    };
  }

  // El nucleo no decide la politica: la consulta. WhatsApp exige plantilla
  // fuera de ventana; Instagram etiqueta y sigue; otro canal podria no tener
  // ventana en absoluto.
  const caps = capabilitiesFor(row.conversation.channel);
  if (
    caps.windowMs !== null &&
    caps.outsideWindow === "template" &&
    !isWindowOpen(row.conversation.lastInboundAt)
  ) {
    throw new SendError(
      "window_closed",
      windowClosedMessage(row.conversation.channel)
    );
  }

  const credentials = await getCredentialsByOrg(organizationId);
  if (!credentials) {
    throw new SendError("not_connected", "No hay número de WhatsApp conectado");
  }
  if (credentials.status === "reconnect_required") {
    throw new SendError(
      "reconnect_required",
      "El token de WhatsApp expiró: reconecta el número en Configuración"
    );
  }

  /**
   * 003 — El destinatario, en el campo que Meta espera para cada forma.
   *
   * Un teléfono va en `to`; un BSUID va en `recipient` con
   * `recipient_type: "individual"`. Se mandaba el BSUID en `to` y Meta
   * respondía 131026, que en la bandeja se lee como si el número del cliente
   * no existiera.
   */
  const destinatario = destinatarioMeta(
    row.contact.phone ? normalizeRecipient(row.contact.phone) : null,
    row.contact.waUserId
  );
  const recipient = destinatario
    ? "to" in destinatario
      ? destinatario.to
      : destinatario.recipient
    : null;
  if (!destinatario || !recipient) {
    throw new SendError(
      "meta_error",
      "El contacto no tiene teléfono ni identidad de WhatsApp utilizable"
    );
  }

  return { conversation: row.conversation, credentials, destinatario, recipient };
}

async function persistOutbound(input: {
  organizationId: string;
  conversationId: string;
  waMessageId: string | null;
  type: string;
  text: string | null;
  /**
   * 014: 'sent' existe porque no todos los canales confirman por webhook.
   * WhatsApp entra como 'pending' y avanza con los `statuses` de Meta;
   * Instagram no manda ese evento salvo que se suscriba aparte, asi que la
   * aceptacion de la plataforma ES la confirmacion. Sin esto el mensaje se
   * queda con el reloj puesto para siempre aunque ya se haya entregado.
   */
  status: "pending" | "sent" | "failed";
  error?: string | null;
  aiGenerated?: boolean;
  origin: "ai" | "operator";
  mediaAssetId?: string | null;
  media?: typeof schema.mediaAsset.$inferSelect | null;
}): Promise<string> {
  const db = getDb();
  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId: input.waMessageId,
      direction: "out",
      type: input.type,
      text: input.text,
      status: input.status,
      error: input.error ?? null,
      aiGenerated: input.aiGenerated ?? false,
      origin: input.origin,
      mediaAssetId: input.mediaAssetId ?? null,
    })
    .returning();
  const message = inserted[0]!;

  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, input.conversationId));

  publish(input.organizationId, {
    type: "message.new",
    data: {
      conversationId: input.conversationId,
      message: serializeMessage(message, input.media ?? null),
    },
  });

  return message.id;
}

/** Envía un mensaje de texto libre por WhatsApp. */
export async function sendText(input: {
  conversationId: string;
  organizationId: string;
  text: string;
  aiGenerated?: boolean;
  actionId?: string;
  telegramTriggerMessageId?: string;
}): Promise<SendResult> {
  const target = await prepareSend(input.conversationId, input.organizationId);
  const { credentials } = target;

  if (target.telegram) {
    try {
      return await sendTelegramDelivery({
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        text: input.text,
        aiGenerated: input.aiGenerated ?? false,
        actionId: input.actionId,
        triggerMessageId: input.telegramTriggerMessageId,
      });
    } catch (error) {
      if (error instanceof TelegramTextTooLongError) {
        throw new SendError("meta_error", error.message);
      }
      if (error instanceof TelegramDeliveryError) {
        const code = error.code === "sandbox_violation"
          ? "sandbox_violation"
          : error.code === "not_connected"
            ? "not_connected"
            : error.code === "human_handoff"
              ? "window_closed"
              : "meta_error";
        throw new SendError(code, error.message);
      }
      throw error;
    }
  }

  const waMessageId = target.instagram
    ? await callInstagramSend(target, input.text)
    : target.messenger
      ? await callMessengerSend(target, input.text)
      : await callGraphSend(credentials!, {
          messaging_product: "whatsapp",
          ...target.destinatario,
          type: "text",
          text: { body: input.text },
        });

  const messageId = await persistOutbound({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    waMessageId,
    type: "text",
    text: input.text,
    // Un canal sin acuses de entrega confirma al aceptar; uno con acuses
    // avanza despues por webhook. Sin esta distincion el mensaje se queda
    // con el reloj puesto para siempre.
    status: capabilitiesFor(target.conversation.channel).deliveryReceipts
      ? "pending"
      : "sent",
    aiGenerated: input.aiGenerated,
    origin: input.aiGenerated ? "ai" : "operator",
  });

  return { messageId };
}

/**
 * 008 — Envía un adjunto de archivo (imagen/video/audio/documento).
 * El archivo queda ANTES en el volumen local (fuente durable de la preview);
 * si Graph falla tras eso, el mensaje se persiste `failed` (visible en el
 * hilo, nunca se pierde en silencio) y el SendError lleva `messageId`.
 */
export async function sendMediaMessage(input: {
  conversationId: string;
  organizationId: string;
  file: { data: Buffer; mimeType: string; fileName?: string };
  caption?: string;
}): Promise<SendResult> {
  // Validación previa (FR-007): tipo y tamaño antes de tocar disco o red.
  const kind = validateOutgoing(input.file.mimeType, input.file.data.byteLength);

  const target = await prepareSend(input.conversationId, input.organizationId);
  const { credentials } = target;
  const sendCaps = capabilitiesFor(target.conversation.channel);
  if (!sendCaps.outboundMedia) {
    throw new SendError(
      "meta_error",
      `Todavía no se pueden enviar adjuntos por ${sendCaps.label}; manda el texto`
    );
  }

  const db = getDb();
  const assetId = newId("mediaAsset");
  const storagePath = await saveMediaFile(
    input.organizationId,
    assetId,
    input.file.data
  );
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: assetId,
      organizationId: input.organizationId,
      kind,
      mimeType: input.file.mimeType,
      fileName: input.file.fileName ?? null,
      fileSize: input.file.data.byteLength,
      caption: input.caption ?? null,
      storagePath,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  try {
    const waMediaId = await uploadGraphMedia(credentials!, input.file);
    await db
      .update(schema.mediaAsset)
      .set({ waMediaId, updatedAt: new Date() })
      .where(eq(schema.mediaAsset.id, assetId));

    const mediaPayload: Record<string, unknown> = { id: waMediaId };
    if (input.caption && kind !== "audio") mediaPayload.caption = input.caption;
    if (kind === "document" && input.file.fileName) {
      mediaPayload.filename = input.file.fileName;
    }
    const waMessageId = await callGraphSend(credentials!, {
      messaging_product: "whatsapp",
      ...target.destinatario,
      type: kind,
      [kind]: mediaPayload,
    });

    const messageId = await persistOutbound({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId,
      type: kind,
      text: null,
      status: "pending",
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
    });
    return { messageId };
  } catch (err) {
    let sendErr: SendError;
    if (err instanceof SendError) {
      sendErr = err;
    } else if (err instanceof MetaApiError && err.isAuthError) {
      // Mismo criterio que el texto: SOLO 401/código 190 (fix 2026-08-04).
      await markReconnectRequired(input.organizationId);
      sendErr = new SendError(
        "reconnect_required",
        "El token de WhatsApp expiró: reconecta el número en Configuración"
      );
    } else {
      sendErr = new SendError(
        "upload_failed",
        "No se pudo subir el adjunto a WhatsApp"
      );
    }
    // El contenido NO se pierde: mensaje failed con el asset ya en disco.
    sendErr.messageId = await persistOutbound({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId: null,
      type: kind,
      text: null,
      status: "failed",
      error: sendErr.message,
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
    });
    throw sendErr;
  }
}

export type LocationInput = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

export type ContactInput = { name: string; phone: string };

/** 008 — Envía una ubicación o contactos (payload estructurado, sin archivo). */
export async function sendStructured(
  input: {
    conversationId: string;
    organizationId: string;
  } & (
    | { kind: "location"; location: LocationInput }
    | { kind: "contacts"; contacts: ContactInput[] }
  )
): Promise<SendResult> {
  const target = await prepareSend(
    input.conversationId,
    input.organizationId
  );
  // Ubicaciones y contactos son mensajes de WhatsApp: en los demás canales no
  // hay credenciales de WhatsApp que usar y Graph los rechazaría.
  if (!target.credentials) {
    throw new SendError(
      "meta_error",
      "Este canal no admite ubicaciones ni contactos; manda el texto"
    );
  }

  const payload =
    input.kind === "location"
      ? { type: "location", location: input.location }
      : {
          type: "contacts",
          contacts: input.contacts.map((c) => ({
            name: { formatted_name: c.name, first_name: c.name },
            phones: [{ phone: c.phone, type: "CELL" }],
          })),
        };

  const waMessageId = await callGraphSend(target.credentials, {
    messaging_product: "whatsapp",
    ...target.destinatario,
    ...payload,
  });

  const db = getDb();
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: newId("mediaAsset"),
      organizationId: input.organizationId,
      kind: input.kind,
      payload: input.kind === "location" ? input.location : input.contacts,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  const messageId = await persistOutbound({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    waMessageId,
    type: input.kind,
    text: null,
    status: "pending",
    origin: "operator",
    mediaAssetId: asset.id,
    media: asset,
  });
  return { messageId };
}

/** Llama a Graph /messages y traduce errores de Meta a SendError. */
export async function callGraphSend(
  credentials: Credentials,
  payload: unknown
): Promise<string> {
  try {
    const res = await graphRequest<{ messages?: { id: string }[] }>(
      `${credentials.phoneNumberId}/messages`,
      { method: "POST", token: credentials.token, body: payload }
    );
    const id = res.messages?.[0]?.id;
    if (!id) throw new SendError("meta_error", "Meta no devolvió ID de mensaje");
    return id;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markReconnectRequired(credentials.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de WhatsApp expiró: reconecta el número en Configuración"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError("meta_unavailable", "Meta no está disponible ahora");
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}


/**
 * 014 — Envío por el canal de Instagram. Traduce los fallos al mismo
 * vocabulario de SendError que ya usa WhatsApp, para que la bandeja no tenga
 * que aprender un idioma por plataforma.
 */
async function callInstagramSend(
  target: SendTarget,
  text: string
): Promise<string> {
  const creds = target.instagram!;

  const caps = capabilitiesFor("instagram");
  if (!textFits("instagram", text)) {
    throw new SendError(
      "meta_error",
      `${caps.label} no acepta mensajes de más de ${caps.maxTextBytes} bytes: acorta el texto`
    );
  }

  // Instagram no tiene plantillas: fuera de la ventana de 24 h la única vía
  // es la etiqueta de agente humano (hasta 7 días).
  const humanAgentTag = !isWindowOpen(target.conversation.lastInboundAt);

  try {
    const res = await sendInstagramText({
      credentials: creds,
      recipient: target.recipient,
      threadRef: target.conversation.channelThreadRef,
      text,
      humanAgentTag,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markInstagramReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de Instagram expiró o fue revocado: reconecta la cuenta"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          "Instagram no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}

/**
 * 017 — Envío por el canal de Messenger. Mismo vocabulario de SendError que
 * WhatsApp e Instagram: la bandeja no aprende un idioma por plataforma.
 */
async function callMessengerSend(
  target: SendTarget,
  text: string
): Promise<string> {
  const creds = target.messenger!;

  const caps = capabilitiesFor("messenger");
  if (!textFits("messenger", text)) {
    throw new SendError(
      "meta_error",
      `${caps.label} no acepta mensajes de más de ${caps.maxTextBytes} bytes: acorta el texto`
    );
  }

  // Messenger no tiene plantillas: fuera de la ventana de 24 h la única vía
  // es la etiqueta de agente humano (hasta 7 días).
  const humanAgentTag = !isWindowOpen(target.conversation.lastInboundAt);

  try {
    const res = await sendMessengerText({
      credentials: creds,
      recipient: target.recipient,
      // Zernio responde dentro de SU conversación, no al PSID: sin esta
      // referencia el envío no tiene a dónde ir.
      threadRef: target.conversation.channelThreadRef,
      text,
      humanAgentTag,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markMessengerReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de la página expiró o fue revocado: reconecta Messenger"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          "Messenger no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}
