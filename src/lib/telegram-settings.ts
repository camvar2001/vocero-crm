export type TelegramChannelStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "conflict";

export type TelegramDeliveryStatus =
  | "reserved"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "cancelled";

export type ManualTelegramRetry = { text: string; actionId: string };

export function telegramAllowlistMatchesSaved(
  candidate: string[],
  saved: string[]
): boolean {
  return (
    candidate.length === saved.length &&
    candidate.every((id) => saved.includes(id))
  );
}

export function manualTelegramActionId(
  text: string,
  retry: ManualTelegramRetry | null,
  createId: () => string
): string {
  return retry?.text === text ? retry.actionId : createId();
}

export function parseTelegramAllowedIds(input: string): {
  ids: string[];
  error: string | null;
} {
  const values = input
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.some((value) => !/^\d{1,20}$/.test(value))) {
    return {
      ids: values.filter((value) => /^\d{1,20}$/.test(value)),
      error: "Cada ID permitido debe contener entre 1 y 20 dígitos, uno por línea.",
    };
  }
  if (new Set(values).size !== values.length) {
    return {
      ids: values,
      error: "Elimina los IDs repetidos antes de guardar.",
    };
  }
  return { ids: values, error: null };
}

const STATUS_LABELS: Record<TelegramChannelStatus | TelegramDeliveryStatus, string> = {
  disconnected: "Desconectado",
  connecting: "Conectando",
  connected: "Conectado",
  error: "Requiere atención",
  conflict: "Conflicto de consumidor",
  reserved: "Pendiente de envío",
  sending: "Enviando",
  sent: "Enviado",
  failed: "No entregado",
  uncertain: "Entrega incierta",
  cancelled: "Envío cancelado",
};

export function telegramStatusLabel(
  status: TelegramChannelStatus | TelegramDeliveryStatus | string
): string {
  return STATUS_LABELS[status as TelegramChannelStatus | TelegramDeliveryStatus] ?? "Estado desconocido";
}

export function telegramDeliveryNotice(
  status: TelegramDeliveryStatus | null | undefined
): string | null {
  if (!status) return null;
  if (status === "uncertain") {
    return "No se pudo confirmar la entrega. Revisa el chat en Telegram; Vocero no lo reenvía automáticamente.";
  }
  if (status === "failed") {
    return "Telegram confirmó que el mensaje no se entregó. Revisa el motivo antes de volver a intentarlo.";
  }
  return `${telegramStatusLabel(status)} por Telegram.`;
}
