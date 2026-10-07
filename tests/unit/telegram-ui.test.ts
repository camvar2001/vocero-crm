import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageThread } from "@/components/inbox/message-thread";
import type { MessageDto } from "@/lib/types";
import type { TelegramDeliveryStatus } from "@/lib/telegram-settings";
import {
  manualTelegramActionId,
  telegramAllowlistMatchesSaved,
  parseTelegramAllowedIds,
  telegramDeliveryNotice,
  telegramStatusLabel,
} from "@/lib/telegram-settings";

describe("configuración local de Telegram", () => {
  it("conserva IDs decimales como texto sin redondearlos", () => {
    expect(parseTelegramAllowedIds("123\n9007199254740993")).toEqual({
      ids: ["123", "9007199254740993"],
      error: null,
    });
  });

  it("no conecta usando una allowlist distinta a la guardada", () => {
    expect(telegramAllowlistMatchesSaved(["2", "1"], ["1", "2"])).toBe(true);
    expect(telegramAllowlistMatchesSaved(["3"], ["1"])).toBe(false);
  });

  it("rechaza valores que no son IDs decimales", () => {
    expect(parseTelegramAllowedIds("123\n@usuario\n123456789012345678901")).toEqual({
      ids: ["123"],
      error: "Cada ID permitido debe contener entre 1 y 20 dígitos, uno por línea.",
    });
  });

  it("traduce los estados operativos sin mostrar detalles privados", () => {
    expect(telegramStatusLabel("conflict")).toBe("Conflicto de consumidor");
    expect(telegramStatusLabel("uncertain")).toBe("Entrega incierta");
    expect(telegramStatusLabel("disconnected")).toBe("Desconectado");
  });

  it("reutiliza la clave de acción al reintentar el mismo texto", () => {
    const retry = { text: "Hola", actionId: "action-1" };
    expect(manualTelegramActionId("Hola", retry, () => "action-2")).toBe("action-1");
    expect(manualTelegramActionId("Hola de nuevo", retry, () => "action-2")).toBe("action-2");
  });

  it("explica que una entrega incierta necesita revisión y no reenvío automático", () => {
    expect(telegramDeliveryNotice("uncertain")).toBe(
      "No se pudo confirmar la entrega. Revisa el chat en Telegram; Vocero no lo reenvía automáticamente."
    );
  });

  it("muestra la advertencia incierta dentro del mensaje del hilo", () => {
    const message = {
      id: "msg_1",
      conversationId: "cv_1",
      direction: "out",
      type: "text",
      text: "Hola",
      status: "pending",
      error: null,
      aiGenerated: false,
      origin: "manual",
      media: null,
      telegramDeliveryStatus: "uncertain",
      createdAt: "2026-10-07T12:00:00.000Z",
    } as MessageDto & { telegramDeliveryStatus: TelegramDeliveryStatus };
    const html = renderToStaticMarkup(
      createElement(MessageThread, { messages: [message] })
    );
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("Vocero no lo reenvía automáticamente");
  });
});
