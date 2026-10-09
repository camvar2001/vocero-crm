const ENABLED_VALUES = new Set(["on", "1", "true", "sí", "si", "yes"]);

export function inmobEnabled(): boolean {
  return ENABLED_VALUES.has((process.env.INMOB ?? "").trim().toLowerCase());
}

export function inmobDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
