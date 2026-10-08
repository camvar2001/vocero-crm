/**
 * E2E del navegador para la UI Telegram con API simulada.
 *
 * Este arnés empaqueta los componentes reales y sirve un harness efímero en
 * memoria. No arranca Next, no lee .env, no abre la DB y no contacta Telegram.
 * Usa Chrome instalado o un Chromium de Playwright que ya exista.
 *
 * Ejecutar: node scripts/e2e-telegram.mjs
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CANDIDATE_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_PATH =
  process.env.CHROME_PATH ??
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync(CANDIDATE_CHROME) ? CANDIDATE_CHROME : undefined);

let checks = 0;
let failures = 0;
const externalRequests = [];
const sendRequests = [];
let forbidden = false;
let sendAttempt = 0;
let tokenSubmitted = false;
let tokenVisibleFromApi = false;
let handoffPatch = null;
const settings = {
  enabled: true,
  configured: false,
  connected: false,
  bot: null,
  allowedUserIds: [],
  status: "disconnected",
  cursor: null,
  counts: { pending: 2, failed: 3, uncertain: 1 },
};

function ok(name, condition, detail = "") {
  checks++;
  if (condition) console.log(`  OK  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  tokenVisibleFromApi ||= payload.includes("ui-e2e-token-never-printed");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

const harnessSource = `
  import React, { createElement as h } from "react";
  import { createRoot } from "react-dom/client";
  import { TelegramClient } from "@/components/settings/telegram-client";
  import { Composer } from "@/components/inbox/composer";
  import { ContactPanel } from "@/components/inbox/contact-panel";
  import { MessageThread } from "@/components/inbox/message-thread";
  import type { ConversationDto, MessageDto } from "@/lib/types";

  const conversation = {
    id: "cv_ui_telegram",
    organizationId: "org_ui_mock",
    contact: { id: "ct_ui_mock", name: "Persona de prueba", phone: null },
    channel: "telegram",
    windowOpen: false,
    windowRemainingMs: 0,
    unreadCount: 0,
    stageName: null,
    handoffAt: null,
    aiEnabled: false,
    handoffAt: null,
    handoffReason: null,
    lastMessageAt: new Date().toISOString(),
  } as unknown as ConversationDto;

  const message = {
    id: "msg_ui_uncertain",
    conversationId: conversation.id,
    direction: "out",
    type: "text",
    text: "Respuesta de prueba",
    status: "pending",
    telegramDeliveryStatus: "uncertain",
    error: null,
    aiGenerated: false,
    origin: "manual",
    media: null,
    createdAt: new Date().toISOString(),
  } as MessageDto;

  async function send(text: string, actionId?: string) {
    const response = await fetch("/__send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, actionId }),
    });
    return response.ok ? null : "La respuesta de prueba no se pudo enviar.";
  }

  async function patchConversation(patch: { aiEnabled?: boolean; reactivate?: boolean }) {
    await fetch("/__handoff", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  function Harness() {
    const view = new URLSearchParams(location.search).get("view");
    if (view === "composer") {
      return h(React.Fragment, null,
        h(MessageThread, { messages: [message] }),
        h(Composer, { conversation, onSend: send, onSent: () => {} })
      );
    }
    if (view === "handoff" || view === "handoff-whatsapp") {
      return h(ContactPanel, {
        conversation: {
          ...conversation,
          channel: view === "handoff-whatsapp" ? "whatsapp" : "telegram",
          aiEnabled: true,
          handoffAt: new Date().toISOString(),
          handoffReason: "manual_reply",
        },
        onPatchConversation: patchConversation,
        onClose: () => {},
      });
    }
    return h(TelegramClient);
  }

  createRoot(document.getElementById("root")!).render(h(Harness));
`;

const built = await build({
  stdin: {
    contents: harnessSource,
    resolveDir: ROOT,
    sourcefile: "telegram-e2e-harness.tsx",
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  jsx: "automatic",
  alias: { "@": join(ROOT, "src") },
  banner: { js: "var process = { env: { NODE_ENV: 'production' } };" },
  logLevel: "silent",
});
const bundle =
  built.outputFiles.find((file) => file.path.endsWith(".js"))?.contents ??
  built.outputFiles[0]?.contents;
if (!bundle) throw new Error("No se generó el bundle temporal del harness");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/bundle.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(bundle);
    return;
  }
  if (url.pathname === "/api/settings/telegram") {
    if (forbidden) {
      json(res, 403, { error: { code: "forbidden", message: "Solo propietario" } });
      return;
    }
    if (req.method === "GET") {
      json(res, 200, settings);
      return;
    }
    if (req.method === "DELETE") {
      settings.configured = false;
      settings.connected = false;
      settings.bot = null;
      settings.allowedUserIds = [];
      settings.status = "disconnected";
      json(res, 200, { ok: true, connected: false });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (req.method === "PUT") {
      if (body.token) tokenSubmitted = true;
      settings.allowedUserIds = body.allowedUserIds;
      if (body.token) {
        settings.configured = true;
        settings.bot = { id: "987654", username: "pilot_ui_mock_bot" };
      }
      if (body.connected === true) {
        settings.connected = true;
        settings.status = "connected";
      }
      if (body.connected === false) {
        settings.connected = false;
        settings.status = "disconnected";
      }
      json(res, 200, { ok: true, bot: settings.bot });
      return;
    }
    if (req.method === "PATCH") {
      settings.connected = body.connected;
      settings.status = body.connected ? "connected" : "disconnected";
      json(res, 200, { ok: true, connected: settings.connected });
      return;
    }
  }
  if (url.pathname === "/api/templates" && req.method === "GET") {
    json(res, 200, { templates: [] });
    return;
  }
  if (url.pathname === "/__send" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sendRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    sendAttempt++;
    json(res, sendAttempt === 1 ? 503 : 200, { ok: sendAttempt > 1 });
    return;
  }
  if (url.pathname === "/__handoff" && req.method === "PATCH") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    handoffPatch = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Telegram UI E2E</title></head><body><main id="root"></main><script src="/bundle.js"></script></body></html>`);
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
const BASE = `http://127.0.0.1:${address.port}`;
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("Browser error:", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Browser console:", message.text());
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(BASE)) externalRequests.push(request.url().split("?")[0]);
  });

  console.log("== Ajustes Telegram (API mock) ==");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByText("Todavía no hay un bot configurado.").waitFor();
  ok("el estado desconectado y los contadores se muestran", await page.getByText("Desconectado").isVisible());
  ok(
    "el formulario muestra los contadores operativos",
    (await Promise.all(
      ["Pendientes", "Fallidos", "Inciertos"].map((label) =>
        page.getByText(label).isVisible()
      )
    )).every(Boolean)
  );

  const tokenInput = page.locator("#telegram-token");
  await tokenInput.fill("ui-e2e-token-never-printed");
  await page.locator("#telegram-allowed-ids").fill("12345678901234567890");
  const connect = page.getByRole("button", { name: "Conectar bot" });
  ok("no se puede conectar antes de guardar una credencial", await connect.isDisabled());
  await page.getByRole("button", { name: "Guardar configuración" }).click();
  await page.getByText("Configuración guardada.").waitFor();
  ok("el input de contraseña se limpia después de guardar", (await tokenInput.inputValue()) === "");
  ok("el token no aparece en el DOM", !(await page.locator("body").innerText()).includes("ui-e2e-token-never-printed"));
  ok("GET no recibe ni devuelve la credencial", tokenSubmitted && !tokenVisibleFromApi);
  ok("guardar credenciales deja el bot desconectado", !settings.connected && settings.status === "disconnected");

  await page.locator("#telegram-allowed-ids").fill("222");
  await connect.click();
  await page.getByText("Guarda primero los cambios de IDs permitidos y después conecta el bot.").waitFor();
  ok("conectar con una allowlist editada sin guardar se bloquea", !settings.connected);
  await page.getByRole("button", { name: "Guardar configuración" }).click();
  await page.getByText("Configuración guardada.").waitFor();
  await page.getByRole("button", { name: "Conectar bot" }).click();
  await page.getByText("Conectado", { exact: true }).waitFor();
  ok("la acción explícita conecta después de guardar la allowlist", settings.connected && settings.status === "connected");

  await page.locator("#telegram-allowed-ids").fill("222\n@no-valido");
  ok("un remitente no decimal se marca y bloquea guardar", await page.getByRole("button", { name: "Guardar configuración" }).isDisabled());
  await page.locator("#telegram-allowed-ids").fill("222");

  forbidden = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("alert").waitFor();
  ok("un GET sin permiso produce un estado de acceso claro", (await page.getByRole("alert").innerText()).includes("acceso de propietario"));
  forbidden = false;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Bot @pilot_ui_mock_bot").waitFor();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Revocar y desconectar" }).click();
  await page.getByText("Bot desconectado y credencial revocada.").waitFor();
  ok("revocar limpia credencial y desconecta en la UI", !settings.configured && !settings.connected);
  await context.close();

  console.log("\n== Composer y estado incierto (solo API mock) ==");
  const composerPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  composerPage.on("request", (request) => {
    if (!request.url().startsWith(BASE)) externalRequests.push(request.url().split("?")[0]);
  });
  await composerPage.goto(`${BASE}/?view=composer`, { waitUntil: "domcontentloaded" });
  await composerPage.getByRole("alert").filter({ hasText: "No se pudo confirmar la entrega" }).waitFor();
  ok("el hilo muestra entrega incierta y explica que no hay reenvío automático", true);
  ok("el composer Telegram oculta los controles de medios", (await composerPage.getByLabel("Adjuntar archivo").count()) === 0 && (await composerPage.getByLabel("Enviar ubicación").count()) === 0 && (await composerPage.getByLabel("Compartir contacto").count()) === 0);

  const textbox = composerPage.getByPlaceholder("Escribe una respuesta…");
  const send = composerPage.getByRole("button", { name: "Enviar" });
  await textbox.fill("😀".repeat(4097));
  ok("4097 puntos de código se bloquean en el composer", await send.isDisabled() && (await composerPage.getByText("4097/4096 caracteres").count()) > 0);
  await textbox.fill("Hola desde prueba de navegador");
  await send.click();
  await composerPage.getByText("La respuesta de prueba no se pudo enviar.").waitFor();
  ok("el primer intento simulado falla con recuperación del texto", sendRequests.length === 1 && (await textbox.inputValue()) === "Hola desde prueba de navegador");
  await send.click();
  await composerPage.waitForFunction(() => document.querySelector("textarea")?.value === "");
  ok("el reintento termina correctamente", sendRequests.length === 2);
  ok("el reintento reusa actionId para no duplicar", Boolean(sendRequests[0]?.actionId) && sendRequests[0].actionId === sendRequests[1]?.actionId);
  ok("todos los requests permanecen en localhost", externalRequests.length === 0, externalRequests.join(", "));
  await composerPage.close();

  console.log("\n== Handoff humano (solo API mock) ==");
  const handoffPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  handoffPage.on("request", (request) => {
    if (!request.url().startsWith(BASE)) externalRequests.push(request.url().split("?")[0]);
  });
  await handoffPage.goto(`${BASE}/?view=handoff`, { waitUntil: "domcontentloaded" });
  await handoffPage.getByText("Respuesta manual — IA en pausa").waitFor();
  const handoffResponse = handoffPage.waitForResponse(
    (response) => response.url().endsWith("/__handoff") && response.status() === 200
  );
  await handoffPage.getByRole("button", { name: "Reactivar IA" }).click();
  await handoffResponse;
  ok("el control de handoff llama a reactivar IA de forma explícita", handoffPatch?.reactivate === true);
  await handoffPage.close();

  const whatsappHandoffPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await whatsappHandoffPage.goto(`${BASE}/?view=handoff-whatsapp`, { waitUntil: "domcontentloaded" });
  await whatsappHandoffPage.getByText("Respondiste desde el teléfono — IA en pausa").waitFor();
  ok("WhatsApp conserva el texto de handoff manual desde el teléfono", true);
  await whatsappHandoffPage.close();

  console.log(`\n${failures === 0 ? `TODO VERDE (${checks} checks)` : `${failures} FALLO(S) de ${checks} checks`}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

process.exitCode = failures ? 1 : 0;
