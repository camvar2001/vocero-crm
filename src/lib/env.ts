import { z } from "zod";

/**
 * Validación central del entorno.
 *
 * Lazy + memoizada: se evalúa en el primer uso en runtime, nunca al importar.
 * Durante `next build` no hay secretos (la imagen se construye sin ellos), así
 * que en esa fase se aceptan placeholders — los valores reales llegan al boot.
 */

const envSchema = z.object({
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message:
        "ENCRYPTION_KEY debe ser 32 bytes en base64 (genera con: openssl rand -base64 32)",
    }),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(8),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v25.0"),
  META_GRAPH_BASE_URL: z.string().url().default("https://graph.facebook.com"),
  OPENROUTER_API_TOKEN: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api"),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_JUDGE_MODEL: z.string().optional(),
  // 014/017: canales encendidos, separados por coma. WhatsApp siempre esta on.
  // Ej.: CHANNELS=whatsapp,instagram,messenger. Sin ella, la instancia es solo
  // WhatsApp y las superficies de los demas canales responden 404.
  CHANNELS: z.string().optional(),
  // 015: motor de agenda. Apagado por defecto — sin el, toda la superficie de
  // agenda responde 404 y la UI no la menciona. Ej.: AGENDA=on
  AGENDA: z.string().optional(),
  // 016: atribucion de anuncios y reporte a la Conversions API de Meta.
  // Apagada por defecto: sin ella no se captura de que anuncio vino una
  // conversacion, no se le reporta nada a Meta y la superficie da 404.
  // Ej.: ATRIBUCION=on
  ATRIBUCION: z.string().optional(),
  // Chats inmobiliarios opcionales; cada módulo comprueba sus variables sin
  // hacer que una configuración incompleta afecte al arranque del CRM.
  INMOB: z.string().optional(),
  INMOB_OWNER_USER_ID: z.string().optional(),
  INMOB_N8N_BASE_URL: z.string().optional(),
  INMOB_N8N_TOKEN: z.string().optional(),
  INMOB_TEST_ADVISOR_ID: z.string().optional(),
  INMOB_TEST_PHONE: z.string().optional(),
  // 015: bases de los conectores. Solo se sobreescriben para apuntar a los
  // mocks en el self-test; en producción se usan las reales.
  ZOOM_BASE_URL: z.string().url().default("https://api.zoom.us/v2"),
  ZOOM_OAUTH_BASE_URL: z.string().url().default("https://zoom.us"),
  GOOGLE_CAL_BASE_URL: z
    .string()
    .url()
    .default("https://www.googleapis.com/calendar/v3"),
  GOOGLE_OAUTH_BASE_URL: z.string().url().default("https://oauth2.googleapis.com"),
  ALLOW_SIGNUP: z.string().optional(),
  AGENT_COALESCE_MS: z.coerce.number().int().min(0).default(6000),
  WA_MOCK_ENABLED: z.string().optional(),
  // API key de un cerebro externo que conduzca la conversación por /api/bot/*.
  // Sin ella, toda esa superficie responde 401.
  BOT_API_KEY: z.string().optional(),
  // «Quién responde a tus clientes»: el /health del cerebro externo (Nea),
  // consultado desde el servidor. Ej.: http://nea:8000/health (alias de la
  // red de Coolify). Sin ella, la tarjeta del Agente no pregunta a nadie.
  // No se valida aquí a propósito: es opcional y solo de diagnóstico, y con
  // `.url()` un valor mal escrito tumbaba el CRM entero (el entorno no
  // validaba y todo respondía 503). La tarjeta la marca como problema de
  // configuración y lo demás sigue funcionando (server/bot/status.ts).
  BRAIN_HEALTH_URL: z.string().optional(),
  // 008: volumen local de adjuntos (constitución II: sin S3/R2).
  MEDIA_DIR: z.string().default("./.dev-media"),
  NODE_ENV: z.string().default("development"),
});

export type Env = z.infer<typeof envSchema>;

const BUILD_PLACEHOLDERS: Record<string, string> = {
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://build:build@localhost:5432/build",
  BETTER_AUTH_SECRET: "placeholder-build-secret",
  ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  META_WEBHOOK_VERIFY_TOKEN: "placeholder-verify-token",
};

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const isBuild = process.env.NEXT_PHASE === "phase-production-build";
  // Los strings vacíos cuentan como ausentes: los compose/paneles suelen
  // inyectar VAR="" para opcionales y eso debe activar los defaults.
  const source = isBuild
    ? { ...BUILD_PLACEHOLDERS, ...stripEmpty(process.env) }
    : stripEmpty(process.env);
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
    throw new Error(
      `Variables de entorno inválidas o faltantes:\n  ${missing}\n` +
        "Revisa .env.example para la guía de cada variable."
    );
  }
  cached = parsed.data;
  return cached;
}

function stripEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

/** true si el entorno de pruebas interno (mocks) está habilitado y NO es producción. */
export function isMockEnabled(): boolean {
  return (
    process.env.WA_MOCK_ENABLED === "true" &&
    process.env.NODE_ENV !== "production"
  );
}

/** true si hay proveedor de IA configurado (token presente y no vacío). */
export function isAiConfigured(): boolean {
  const token = process.env.OPENROUTER_API_TOKEN;
  return typeof token === "string" && token.trim().length > 0;
}
