/** Telegram IDs are kept as decimal strings so PostgreSQL and JavaScript do
 * not silently narrow chat/user identifiers to 32-bit integers. */
function decimalId(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

export type TelegramPrivateText = {
  messageId: string;
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
  name: string | null;
};

/** Accept the narrow US6 scope: authorized human text in a private self-chat. */
export function validateTelegramPrivateText(
  input: unknown,
  allowedUserIds: readonly string[],
): TelegramPrivateText | null {
  const parsed = parseTelegramPrivateText(input);
  return parsed && allowedUserIds.includes(parsed.userId) ? parsed : null;
}

export function parseTelegramPrivateText(input: unknown): TelegramPrivateText | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const message = input as Record<string, unknown>;
  const chat = message.chat;
  const from = message.from;
  if (!chat || typeof chat !== "object" || Array.isArray(chat)) return null;
  if (!from || typeof from !== "object" || Array.isArray(from)) return null;
  const chatData = chat as Record<string, unknown>;
  const fromData = from as Record<string, unknown>;
  if (chatData.type !== "private" || fromData.is_bot !== false) return null;
  const chatId = decimalId(chatData.id);
  const userId = decimalId(fromData.id);
  const messageId = decimalId(message.message_id);
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const timestamp = message.date;
  if (
    !chatId ||
    !userId ||
    !messageId ||
    chatId !== userId ||
    !text ||
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    return null;
  }
  const name = [fromData.first_name, fromData.last_name]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(" ") || (typeof fromData.username === "string" ? fromData.username : null);
  return { messageId, chatId, userId, text, timestamp, name };
}

export function buildTelegramProviderMessageId(
  botId: string,
  chatId: string,
  messageId: string,
): string {
  return `tg:${botId}:${chatId}:${messageId}`;
}

export function parseTelegramUpdateId(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
