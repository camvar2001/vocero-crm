/**
 * E2E del chat web de INMOB con API simulada.
 *
 * Empaqueta el componente de producción y lo ejecuta en Chromium con un
 * servidor efímero en memoria. No arranca Next, no lee .env ni conecta BD,
 * n8n u otros servicios. La prueba de rutas, sesión y owner vive en CI aparte.
 *
 * Ejecutar en el runner preparado: node scripts/e2e-inmob.mjs
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
let getCount = 0;
const posts = [];
const sequence = new Map();
const chats = new Map([
  ["buscador", { chatId: "chat_ui_buscador", agent: "buscador", turns: [] }],
  ["secretaria", { chatId: "chat_ui_secretaria", agent: "secretaria", turns: [] }],
]);

function ok(name, condition, detail = "") {
  checks++;
  if (condition) console.log(`  OK  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const harnessSource = `
  import React, { createElement as h, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { InmobChatClient } from "@/components/inmob/chat-client";

  function Harness() {
    const initialAgent = new URLSearchParams(location.search).get("agent");
    const [agent, setAgent] = useState(initialAgent === "secretaria" ? "secretaria" : "buscador");
    return h(React.Fragment, null,
      h("nav", { "aria-label": "Agentes de prueba" },
        h("button", { onClick: () => { setAgent("buscador"); history.replaceState(null, "", "/?agent=buscador"); } }, "Buscador"),
        h("button", { onClick: () => { setAgent("secretaria"); history.replaceState(null, "", "/?agent=secretaria"); } }, "Secretaria")
      ),
      h(InmobChatClient, { key: agent, agent })
    );
  }

  createRoot(document.getElementById("root")).render(h(Harness));
`;

const built = await build({
  stdin: {
    contents: harnessSource,
    resolveDir: ROOT,
    sourcefile: "inmob-e2e-harness.tsx",
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
  const route = url.pathname.match(/^\/api\/inmob\/chats\/(buscador|secretaria)$/);
  if (route) {
    const agent = route[1];
    const chat = chats.get(agent);
    if (req.method === "GET") {
      getCount++;
      // La primera respuesta da tiempo a observar el estado inicial accesible.
      if (getCount === 1) await new Promise((resolveWait) => setTimeout(resolveWait, 180));
      json(res, 200, chat);
      return;
    }
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      posts.push({ agent, ...body });
      const attempt = (sequence.get(body.requestId) ?? 0) + 1;
      sequence.set(body.requestId, attempt);
      const createdAt = new Date().toISOString();
      const baseTurn = {
        requestId: body.requestId,
        message: body.message,
        reply: null,
        status: "running",
        errorCode: null,
        results: [],
        createdAt,
      };
      if (body.message === "fallo conocido" && attempt === 1) {
        // El gateway confirma un rechazo antes de reclamar el turno.
        json(res, 503, { errorCode: "configuration" });
        return;
      }
      if (body.message === "respuesta perdida sin turno" && attempt === 1) {
        // La conexión cae antes de que el servidor persista el UUID.
        req.socket.destroy();
        return;
      }
      chat.turns.push(baseTurn);
      if (body.message === "consulta lenta") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 600));
        Object.assign(baseTurn, { status: "completed", reply: `Respuesta de ${agent}` });
        json(res, 200, { chatId: chat.chatId, agent, turn: baseTurn });
        return;
      }
      if (body.message === "respuesta perdida") {
        Object.assign(baseTurn, { status: "uncertain", errorCode: "gateway_uncertain" });
        // Simula que el servidor registró el turno pero la respuesta no llegó.
        req.socket.destroy();
        return;
      }
      if (body.message === "respuesta perdida completada") {
        Object.assign(baseTurn, { status: "completed", reply: "Resultado reconciliado" });
        // El turno terminó en el servidor aunque el navegador pierda la respuesta.
        req.socket.destroy();
        return;
      }
      if (body.message === "contenido no confiable") {
        Object.assign(baseTurn, {
          status: "completed",
          reply: '<img src=x onerror="window.xssRan=true"> texto seguro',
          results: [
            { title: "Enlace seguro", url: "https://example.test/inmueble", source: "Mock" },
            { title: "Enlace no válido", url: "javascript:window.xssRan=true", source: "Mock" },
          ],
        });
        json(res, 200, { chatId: chat.chatId, agent, turn: baseTurn });
        return;
      }
      Object.assign(baseTurn, { status: "completed", reply: `Respuesta de ${agent}` });
      json(res, 200, { chatId: chat.chatId, agent, turn: baseTurn });
      return;
    }
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chat INMOB E2E</title></head><body><main id="root"></main><script src="/bundle.js"></script></body></html>`);
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
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
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByRole("status").filter({ hasText: /Cargando/ }).waitFor();
  ok("la carga inicial se anuncia con estado accesible", true);
  await page.getByRole("heading", { name: "Buscador" }).waitFor();
  await page.getByText("Historial de Buscador", { exact: true }).waitFor();

  const composer = page.getByRole("textbox", { name: "Mensaje para Buscador" });
  await composer.fill("consulta con Enter");
  await composer.press("Enter");
  await page.getByText("Respuesta de buscador", { exact: true }).waitFor();
  const first = posts[0];
  ok("Enter envía una sola solicitud con UUID y el agente visible", posts.length === 1 && first.agent === "buscador" && /^[0-9a-f-]{36}$/i.test(first.requestId));
  ok("el envío exitoso vacía el composer", (await composer.inputValue()) === "");

  await composer.fill("línea uno");
  await composer.press("Shift+Enter");
  await composer.press("End");
  await composer.type(" línea dos");
  ok("Shift+Enter conserva un salto de línea sin enviar", posts.length === 1 && (await composer.inputValue()).includes("\n"));
  await composer.fill("continuidad al recargar");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByText("Respuesta de buscador", { exact: true }).last().waitFor();
  const beforeReload = posts.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("continuidad al recargar", { exact: true }).waitFor();
  ok("el historial del agente se recupera con GET al recargar", beforeReload === 2 && posts.length === beforeReload);

  const slowComposer = page.getByRole("textbox", { name: "Mensaje para Buscador" });
  await slowComposer.fill("consulta lenta");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByRole("status").filter({ hasText: /Enviando|procesando/i }).waitFor();
  ok("el envío pendiente se anuncia y bloquea envíos duplicados", await page.getByRole("button", { name: "Enviar" }).isDisabled());
  await page.getByRole("button", { name: "Secretaria" }).click();
  await page.getByRole("heading", { name: "Secretaria" }).waitFor();
  await page.waitForTimeout(750);
  const slowCount = posts.filter((post) => post.message === "consulta lenta").length;
  await page.getByText("Historial de Secretaria", { exact: true }).waitFor();
  ok("Secretaria no recibe una respuesta tardía del Buscador", await page.getByText("Respuesta de buscador", { exact: true }).count() === 0 && await page.getByText("consulta lenta", { exact: true }).count() === 0 && slowCount === 1);
  ok("Secretaria abre historial separado del Buscador", await page.getByText("consulta con Enter", { exact: true }).count() === 0);
  await page.getByRole("textbox", { name: "Mensaje para Secretaria" }).fill("hola secretaria");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByText("Respuesta de secretaria", { exact: true }).waitFor();
  ok("el segundo agente conserva identidad y conversación propias", posts.at(-1)?.agent === "secretaria" && chats.get("secretaria").chatId !== chats.get("buscador").chatId);
  const beforeLateRecovery = posts.length;
  await page.getByRole("button", { name: "Buscador" }).click();
  await page.getByRole("heading", { name: "Buscador" }).waitFor();
  await page.getByText("consulta lenta", { exact: true }).waitFor();
  ok("al volver, GET recupera la respuesta tardía sin un segundo POST", await page.getByText("Respuesta de buscador", { exact: true }).last().isVisible() && posts.length === beforeLateRecovery);
  await page.getByRole("button", { name: "Secretaria" }).click();
  await page.getByRole("heading", { name: "Secretaria" }).waitFor();
  await page.getByText("Historial de Secretaria", { exact: true }).waitFor();

  await page.getByRole("textbox", { name: "Mensaje para Secretaria" }).fill("fallo conocido");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByRole("alert").filter({ hasText: /No se pudo|falló|intenta/i }).first().waitFor();
  ok("un rechazo conocido muestra error recuperable y conserva el texto", (await page.getByRole("textbox", { name: "Mensaje para Secretaria" }).inputValue()) === "fallo conocido");
  ok("el rechazo requiere consultar el estado antes de habilitar otro POST", await page.getByRole("button", { name: "Enviar" }).isDisabled());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("El servidor no guardó este mensaje", { exact: false }).waitFor();
  ok("el borrador rechazado sobrevive a una recarga", (await page.getByRole("textbox", { name: "Mensaje para Secretaria" }).inputValue()) === "fallo conocido" && posts.filter((post) => post.message === "fallo conocido").length === 1);
  await page.getByRole("button", { name: "Consultar estado" }).click();
  await page.getByText("El servidor no guardó este mensaje", { exact: false }).waitFor();
  ok("GET confirma que el rechazo no se persistió y restaura el borrador", (await page.getByRole("textbox", { name: "Mensaje para Secretaria" }).inputValue()) === "fallo conocido" && !(await page.getByRole("button", { name: "Enviar" }).isDisabled()));
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByText("Respuesta de secretaria", { exact: true }).last().waitFor();
  const rejectedPosts = posts.filter((post) => post.message === "fallo conocido");
  ok("el reenvío solo ocurre tras el GET y conserva el UUID", rejectedPosts.length === 2 && rejectedPosts[0].requestId === rejectedPosts[1].requestId);

  await page.getByRole("textbox", { name: "Mensaje para Secretaria" }).fill("respuesta perdida completada");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByRole("alert").filter({ hasText: /incierto|confirmar|actualiza/i }).first().waitFor();
  await page.getByRole("button", { name: "Consultar estado" }).click();
  await page.getByText("Resultado reconciliado", { exact: true }).waitFor();
  const completedLossPosts = posts.filter((post) => post.message === "respuesta perdida completada");
  ok("GET reemplaza la incertidumbre local con la respuesta completada del servidor", completedLossPosts.length === 1 && !(await page.getByRole("alert").filter({ hasText: /No pudimos confirmar/ }).count()) && !(await page.getByRole("button", { name: "Enviar" }).isDisabled()));

  await page.getByRole("textbox", { name: "Mensaje para Secretaria" }).fill("respuesta perdida sin turno");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByRole("alert").filter({ hasText: /incierto|confirmar|actualiza/i }).first().waitFor();
  const absentPost = posts.filter((post) => post.message === "respuesta perdida sin turno");
  await page.getByRole("button", { name: "Consultar estado" }).click();
  await page.getByText("El servidor no guardó este mensaje", { exact: false }).waitFor();
  const absentComposer = page.getByRole("textbox", { name: "Mensaje para Secretaria" });
  ok("GET sin el UUID reconcilia la respuesta perdida y restaura el texto exacto", (await absentComposer.inputValue()) === "respuesta perdida sin turno" && await page.getByText("respuesta perdida sin turno", { exact: true }).count() === 0);
  ok("la ausencia habilita una recuperación explícita sin POST automático", absentPost.length === 1 && !(await page.getByRole("button", { name: "Enviar" }).isDisabled()));
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByText("Respuesta de secretaria", { exact: true }).last().waitFor();
  const absentPosts = posts.filter((post) => post.message === "respuesta perdida sin turno");
  ok("el único reenvío explícito usa el UUID original", absentPosts.length === 2 && absentPosts[0].requestId === absentPosts[1].requestId);

  await page.getByRole("textbox", { name: "Mensaje para Secretaria" }).fill("respuesta perdida");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByRole("alert").filter({ hasText: /incierto|confirmar|actualiza/i }).first().waitFor();
  const uncertainPosts = posts.filter((post) => post.message === "respuesta perdida").length;
  await page.getByRole("button", { name: /Consultar estado|Actualizar estado/ }).click();
  await page.getByRole("alert").filter({ hasText: /incierto|confirmar|actualiza/i }).first().waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("alert").filter({ hasText: /incierto|confirmar|actualiza/i }).first().waitFor();
  ok("la respuesta incierta queda persistida sin reenviar al recargar", uncertainPosts === 1 && posts.filter((post) => post.message === "respuesta perdida").length === 1 && await page.getByRole("button", { name: "Continuar con otra consulta" }).isVisible());
  ok("el envío permanece bloqueado hasta reconocer la incertidumbre", await page.getByRole("button", { name: "Enviar" }).isDisabled());
  await page.getByRole("button", { name: "Continuar con otra consulta" }).click();
  const secretaryComposer = page.getByRole("textbox", { name: "Mensaje para Secretaria" });
  await secretaryComposer.fill("respuesta perdida");
  ok("la misma solicitud incierta nunca se ofrece para reenvío", await page.getByRole("button", { name: "Enviar" }).isDisabled() && posts.filter((post) => post.message === "respuesta perdida").length === 1);
  await secretaryComposer.fill("otra consulta después de revisar");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByText("Respuesta de secretaria", { exact: true }).last().waitFor();

  await page.getByRole("textbox", { name: "Mensaje para Secretaria" }).fill("contenido no confiable");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByText("texto seguro", { exact: false }).waitFor();
  ok("la respuesta externa se renderiza como texto, nunca como HTML", (await page.locator("img[onerror]").count()) === 0 && (await page.evaluate(() => window.xssRan)) !== true);
  const safeLink = page.getByRole("link", { name: /Enlace seguro/ });
  ok("los enlaces válidos usan HTTPS y rel seguro", await safeLink.getAttribute("href") === "https://example.test/inmueble" && (await safeLink.getAttribute("rel"))?.includes("noopener"));
  ok("un enlace con esquema activo no se convierte en enlace", await page.getByRole("link", { name: /Enlace no válido/ }).count() === 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  ok("el chat cabe en móvil sin desbordamiento horizontal", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await context.close();
  console.log(`\n${failures === 0 ? `TODO VERDE (${checks} checks)` : `${failures} FALLO(S) de ${checks} checks`}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

process.exitCode = failures ? 1 : 0;
