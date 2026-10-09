import { InmobAgentSchema, InmobPostBodySchema } from "@/lib/inmob";
import { requireSession } from "@/lib/auth/session";
import { apiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { inmobDisabledResponse, inmobEnabled } from "@/server/inmob/flag";
import { getInmobChat, submitInmobMessage } from "@/server/inmob/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agent: string }> };
const MAX_BODY_BYTES = 16 * 1024;

async function routeAgent(context: RouteContext) {
  const { agent } = await context.params;
  const parsed = InmobAgentSchema.safeParse(agent);
  return parsed.success ? parsed.data : null;
}

async function authorizedSession() {
  try {
    const session = await requireSession();
    const ownerId = process.env.INMOB_OWNER_USER_ID?.trim();
    if (!ownerId || session.userId !== ownerId || session.role !== "owner") {
      return { ok: false as const, response: apiError(403, "forbidden", "Acceso no autorizado") };
    }
    return { ok: true as const, session };
  } catch (error) {
    if (
      error instanceof Error && (error.name === "UnauthorizedError" || error.message === "unauthorized")
    ) {
      return { ok: false as const, response: apiError(401, "unauthorized", "No autenticado") };
    }
    return { ok: false as const, response: apiError(503, "auth_unavailable", "No se pudo verificar la sesión") };
  }
}

function sameOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(getEnv().APP_BASE_URL).origin;
  } catch {
    return false;
  }
}

async function readLimitedJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false };
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return { ok: false };
  if (!req.body) return { ok: false };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown };
  } catch {
    return { ok: false };
  }
}

export async function GET(_req: Request, context: RouteContext): Promise<Response> {
  if (!inmobEnabled()) return inmobDisabledResponse();
  const agent = await routeAgent(context);
  if (!agent) return apiError(404, "not_found", "Agente no encontrado");
  const auth = await authorizedSession();
  if (!auth.ok) return auth.response;
  try {
    return Response.json(await getInmobChat({
      organizationId: auth.session.organizationId,
      userId: auth.session.userId,
      agent,
    }));
  } catch {
    return apiError(503, "inmob_unavailable", "El chat no está disponible en este momento");
  }
}

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  if (!inmobEnabled()) return inmobDisabledResponse();
  const agent = await routeAgent(context);
  if (!agent) return apiError(404, "not_found", "Agente no encontrado");
  const auth = await authorizedSession();
  if (!auth.ok) return auth.response;
  if (!sameOrigin(req.headers.get("origin"))) return apiError(403, "origin_forbidden", "Origen no autorizado");

  const parsedBody = await readLimitedJson(req);
  if (!parsedBody.ok) return apiError(400, "invalid_body", "El body debe ser JSON válido de hasta 16 KiB");
  const body = InmobPostBodySchema.safeParse(parsedBody.value);
  if (!body.success) return apiError(400, "invalid_body", "Se requiere requestId UUID y mensaje de 1 a 4000 caracteres");

  const result = await submitInmobMessage({
    organizationId: auth.session.organizationId,
    userId: auth.session.userId,
    agent,
    requestId: body.data.requestId,
    message: body.data.message,
  });
  return Response.json(result.body, { status: result.statusCode });
}
