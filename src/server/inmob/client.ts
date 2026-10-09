import {
  InmobGatewayBaseRequestSchema,
  parseInmobGatewayResponse,
  type InmobAgent,
  type InmobGatewayRequest,
  type InmobGatewayResponse,
} from "@/lib/inmob";

const ALLOWED_HOST = "century21-dev.intersim.cloud";
const WEBHOOK_PATH = "/webhook/vocero-inmob-chat-v1";
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 50_000;

export class InmobGatewayError extends Error {
  constructor(
    readonly code: "configuration" | "rejected" | "unavailable" | "invalid_response",
    readonly retrySafe: boolean,
    message: string
  ) {
    super(message);
    this.name = "InmobGatewayError";
  }
}

export type GatewayOptions = {
  /** Shared absolute deadline for the complete turn, including continuations. */
  deadline?: number;
  signal?: AbortSignal;
};

function gatewayUrl(): string {
  const raw = process.env.INMOB_N8N_BASE_URL;
  const token = process.env.INMOB_N8N_TOKEN;
  if (!raw || !token) {
    throw new InmobGatewayError("configuration", true, "Gateway INMOB no configurado");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InmobGatewayError("configuration", true, "Gateway INMOB no configurado correctamente");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== ALLOWED_HOST ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new InmobGatewayError("configuration", true, "Host del gateway INMOB no permitido");
  }
  return `https://${ALLOWED_HOST}${WEBHOOK_PATH}`;
}

export function assertInmobGatewayConfigured(): void {
  void gatewayUrl();
}

async function readBoundedBody(response: Response): Promise<string> {
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
    throw new InmobGatewayError("invalid_response", false, "Respuesta del gateway demasiado grande");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new InmobGatewayError("invalid_response", false, "Respuesta del gateway demasiado grande");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function postInmobGateway(
  payload: InmobGatewayRequest,
  options: GatewayOptions = {}
): Promise<InmobGatewayResponse> {
  const url = gatewayUrl();
  const parsedPayload = InmobGatewayBaseRequestSchema.safeParse(payload);
  if (!parsedPayload.success) {
    throw new InmobGatewayError("invalid_response", true, "Solicitud interna INMOB inválida");
  }

  const token = process.env.INMOB_N8N_TOKEN!;
  const remaining = options.deadline === undefined
    ? REQUEST_TIMEOUT_MS
    : Math.min(REQUEST_TIMEOUT_MS, options.deadline - Date.now());
  if (remaining <= 0) {
    throw new InmobGatewayError("unavailable", false, "Se agotó el tiempo del turno");
  }

  const timeoutSignal = AbortSignal.timeout(remaining);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: {
        "content-type": "application/json",
        "X-Vocero-Inmob-Token": token,
      },
      body: JSON.stringify(parsedPayload.data),
    });
  } catch {
    throw new InmobGatewayError("unavailable", false, "No se pudo confirmar la respuesta del gateway");
  }

  if (response.status >= 300 && response.status < 400) {
    throw new InmobGatewayError("unavailable", false, "El gateway respondió con redirección");
  }
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      throw new InmobGatewayError("rejected", true, "El gateway rechazó la solicitud antes de ejecutarla");
    }
    throw new InmobGatewayError("unavailable", false, "El gateway no está disponible");
  }

  let raw: string;
  try {
    raw = await readBoundedBody(response);
  } catch (error) {
    if (error instanceof InmobGatewayError) throw error;
    throw new InmobGatewayError("unavailable", false, "No se pudo leer la respuesta del gateway");
  }
  try {
    const value: unknown = JSON.parse(raw);
    return parseInmobGatewayResponse(value, {
      requestId: parsedPayload.data.requestId,
      agent: parsedPayload.data.agent as InmobAgent,
    });
  } catch {
    throw new InmobGatewayError("invalid_response", false, "Respuesta del gateway inválida o incierta");
  }
}
