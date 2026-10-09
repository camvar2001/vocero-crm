"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AlertTriangle, ArrowUp, CalendarDays, Clock3, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { InmobAgent, InmobChat, InmobResult, InmobTurn } from "@/lib/inmob";

type RecoveryDraft = { requestId: string; message: string; createdAt: string };

const AGENT_COPY: Record<InmobAgent, { title: string; description: string; hint: string }> = {
  buscador: {
    title: "Buscador",
    description: "Encuentra opciones por zona, precio y características.",
    hint: "Cuéntame qué tipo de inmueble estás buscando…",
  },
  secretaria: {
    title: "Secretaria",
    description: "Organiza clientes y agenda desde una conversación.",
    hint: "¿Qué necesitas organizar hoy?",
  },
};

function storageKey(chatId: string) {
  return `vocero:inmob:pending:${chatId}`;
}

function readRecovery(chatId: string): RecoveryDraft | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(chatId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RecoveryDraft>;
    if (
      typeof value.requestId === "string" &&
      typeof value.message === "string" &&
      typeof value.createdAt === "string"
    ) {
      return { requestId: value.requestId, message: value.message, createdAt: value.createdAt };
    }
  } catch {
    // El historial del servidor sigue siendo la fuente de verdad si el storage
    // está bloqueado o contiene una preferencia dañada.
  }
  return null;
}

function writeRecovery(chatId: string, value: RecoveryDraft | null) {
  try {
    if (value) window.sessionStorage.setItem(storageKey(chatId), JSON.stringify(value));
    else window.sessionStorage.removeItem(storageKey(chatId));
  } catch {
    // La conversación sigue funcionando aunque el navegador no permita guardar.
  }
}

function newRequestId(): string {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mergeTurn(turns: InmobTurn[], next: InmobTurn): InmobTurn[] {
  const index = turns.findIndex((turn) => turn.requestId === next.requestId);
  if (index < 0) return [...turns, next];
  const merged = [...turns];
  // El historial persistido puede llegar después de una respuesta rápida del
  // POST. Un estado final nunca retrocede a running.
  const previous = merged[index];
  merged[index] = previous.status === "running" ? next : previous;
  return merged;
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Enlaces web clicables dentro de texto plano, con el resto como nodos React. */
function PlainText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const output: ReactNode[] = [];
    const pattern = /https?:\/\/[^\s<>"']+/gi;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      const index = match.index ?? 0;
      let candidate = raw;
      let punctuation = "";
      while (/[.,!?;:)}\]]$/.test(candidate)) {
        punctuation = candidate.slice(-1) + punctuation;
        candidate = candidate.slice(0, -1);
      }
      const href = safeHttpUrl(candidate);
      if (!href) continue;
      if (index > cursor) output.push(text.slice(cursor, index));
      output.push(
        <a
          key={`${index}:${href}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all font-medium text-brand-ink underline decoration-brand-soft underline-offset-2 hover:decoration-brand"
        >
          {candidate}
        </a>
      );
      if (punctuation) output.push(punctuation);
      cursor = index + raw.length;
    }
    if (cursor < text.length) output.push(text.slice(cursor));
    return output;
  }, [text]);

  return <>{parts}</>;
}

function friendlyError(code: string | null): string {
  switch (code) {
    case "gateway_uncertain":
    case "action_uncertain":
    case "network_uncertain":
    case "uncertain":
      return "No pudimos confirmar si la solicitud terminó. Actualiza el estado antes de repetir una acción parecida.";
    case "chat_busy":
      return "Este chat todavía está procesando otra solicitud. Actualiza el estado en un momento.";
    case "configuration":
      return "El chat no está listo para responder. Tu mensaje quedó conservado.";
    default:
      return "No se pudo completar el mensaje. Conservamos tu texto en esta conversación.";
  }
}

function TurnStatus({ turn }: { turn: InmobTurn }) {
  if (turn.status === "running") {
    return (
      <p role="status" aria-live="polite" className="mt-2 flex items-center gap-1.5 text-xs text-text-2">
        <Clock3 className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
        Enviando…
      </p>
    );
  }
  if (turn.status === "uncertain") {
    return (
      <p role="alert" className="mt-2 flex max-w-xl items-start gap-1.5 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs leading-5 text-warning-text">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {friendlyError(turn.errorCode)}
      </p>
    );
  }
  if (turn.status === "failed") {
    return (
      <p role="alert" className="mt-2 flex max-w-xl items-start gap-1.5 rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-xs leading-5 text-danger-text">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {friendlyError(turn.errorCode)}
      </p>
    );
  }
  return null;
}

function ResultCards({ results }: { results: InmobResult[] }) {
  const safeResults = results.flatMap((result) => {
    const url = safeHttpUrl(result.url);
    return url ? [{ ...result, url }] : [];
  });
  if (!safeResults.length) return null;
  return (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {safeResults.map((result, index) => (
        <li key={`${result.url}:${index}`}>
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group block rounded-lg border border-border-strong bg-background px-3.5 py-3 transition-colors hover:border-brand-soft hover:bg-brand-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="block text-sm font-semibold text-foreground group-hover:text-brand-text">
              {result.title}
            </span>
            <span className="mt-1 block text-xs text-text-2">Fuente: {result.source}</span>
            <span className="mt-2 block truncate text-[11px] text-brand-ink">{result.url}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function InmobChatClient({ agent }: { agent: InmobAgent }) {
  const copy = AGENT_COPY[agent];
  const [chat, setChat] = useState<InmobChat | null>(null);
  const [turns, setTurns] = useState<InmobTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryDraft | null>(null);
  const submittingRef = useRef(false);
  const sequence = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);

  const readHistory = useCallback(async (initial = false) => {
    const requestSequence = ++sequence.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/inmob/chats/${agent}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as InmobChat | null;
      if (requestSequence !== sequence.current) return;
      if (!response.ok || !body || body.agent !== agent || !Array.isArray(body.turns)) {
        throw new Error("history_unavailable");
      }
      const serverTurns = body.turns;
      setChat(body);
      setTurns((current) => {
        const byId = new Map(serverTurns.map((turn) => [turn.requestId, turn]));
        // Conserva de forma visible un envío local cuya respuesta pudo perderse,
        // incluso si el GET todavía no lo alcanza a ver.
        const combined = serverTurns.map((turn) => {
          const previous = current.find((item) => item.requestId === turn.requestId);
          return previous && previous.status !== "running" ? previous : turn;
        });
        for (const turn of current) {
          if (!byId.has(turn.requestId) && turn.status !== "completed") combined.push(turn);
        }
        return combined.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
      const saved = readRecovery(body.chatId);
      const recovered = saved && serverTurns.some((turn) => turn.requestId === saved.requestId);
      if (saved && recovered) {
        writeRecovery(body.chatId, null);
        setRecovery(null);
      } else if (saved) {
        setRecovery(saved);
        setTurns((current) => mergeTurn(current, {
          requestId: saved.requestId,
          message: saved.message,
          reply: null,
          status: "uncertain",
          errorCode: "network_uncertain",
          results: [],
          createdAt: saved.createdAt,
        }));
      } else {
        setRecovery(null);
      }
    } catch {
      if (requestSequence === sequence.current) {
        setLoadError("No se pudo cargar la conversación. Revisa tu conexión e inténtalo de nuevo.");
      }
    } finally {
      if (requestSequence === sequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [agent]);

  useEffect(() => {
    void readHistory(true);
    return () => {
      sequence.current++;
    };
  }, [readHistory]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns, submitting]);

  const hasRunning = turns.some((turn) => turn.status === "running");
  const canSend = Boolean(draft.trim()) && draft.length <= 4000 && !loading && !submitting && !hasRunning && Boolean(chat);
  const needsRefresh = hasRunning || turns.some((turn) => turn.status === "uncertain") || Boolean(recovery);

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const message = draft.trim();
    if (!chat || !message || message.length > 4000 || submittingRef.current || hasRunning) return;

    const priorUncertain = [...turns].reverse().find(
      (turn) => turn.status === "uncertain" && turn.message === message
    );
    const pending: RecoveryDraft = priorUncertain
      ? { requestId: priorUncertain.requestId, message, createdAt: priorUncertain.createdAt }
      : { requestId: newRequestId(), message, createdAt: new Date().toISOString() };
    writeRecovery(chat.chatId, pending);
    setRecovery(pending);
    setRequestError(null);
    setDraft("");
    submittingRef.current = true;
    setSubmitting(true);
    setTurns((current) => mergeTurn(current, {
      ...pending,
      reply: null,
      status: "running",
      errorCode: null,
      results: [],
    }));

    try {
      const response = await fetch(`/api/inmob/chats/${agent}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: pending.requestId, message }),
      });
      const body = (await response.json().catch(() => null)) as {
        chatId?: string;
        agent?: InmobAgent;
        turn?: InmobTurn;
        errorCode?: string;
        error?: { code?: string; message?: string };
      } | null;
      if (
        body?.turn &&
        body.chatId === chat.chatId &&
        body.agent === agent &&
        body.turn.requestId === pending.requestId
      ) {
        setTurns((current) => mergeTurn(current, body.turn!));
        if (body.turn.status !== "running") {
          writeRecovery(chat.chatId, null);
          setRecovery(null);
        }
        if (body.turn.status === "failed" || body.turn.status === "uncertain") {
          setRequestError(friendlyError(body.turn.errorCode));
        }
        return;
      }

      if (!response.ok) {
        const code = body?.errorCode ?? body?.error?.code ?? "send_failed";
        const knownFailure: InmobTurn = {
          ...pending,
          reply: null,
          status: "failed",
          errorCode: code,
          results: [],
        };
        setTurns((current) => mergeTurn(current, knownFailure));
        writeRecovery(chat.chatId, null);
        setRecovery(null);
        setRequestError(friendlyError(code));
        return;
      }

      // Una respuesta sin el turno esperado no demuestra que el agente terminó.
      throw new Error("turn_missing");
    } catch {
      const uncertain: InmobTurn = {
        ...pending,
        reply: null,
        status: "uncertain",
        errorCode: "network_uncertain",
        results: [],
      };
      setTurns((current) => mergeTurn(current, uncertain));
      setRecovery(pending);
      setRequestError(friendlyError("network_uncertain"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <section aria-labelledby="inmob-chat-title" className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border bg-background px-4 py-4 sm:px-6 sm:py-5">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-brand-soft bg-brand-tint text-brand-text">
            {agent === "buscador" ? <Search className="h-5 w-5" aria-hidden="true" /> : <CalendarDays className="h-5 w-5" aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="kicker text-brand-ink">Century 21 · conversación</p>
            <h1 id="inmob-chat-title" className="mt-0.5 text-lg font-bold tracking-tight text-foreground sm:text-xl">
              {copy.title}
            </h1>
            <p className="mt-0.5 text-xs leading-5 text-text-2 sm:text-sm">{copy.description}</p>
          </div>
          <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-success-soft bg-success-tint px-3 py-1.5 text-xs font-medium text-success-text sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
            Listo para conversar
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-chat-bg px-3 py-5 sm:px-6 sm:py-7">
        <div className="mx-auto flex min-h-full max-w-4xl flex-col">
          <div className="mb-5 flex items-center justify-between gap-3">
            <p className="kicker text-text-3">Historial de {copy.title}</p>
            {needsRefresh && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={refreshing}
                onClick={() => void readHistory(false)}
              >
                {refreshing ? "Consultando…" : "Consultar estado"}
              </Button>
            )}
          </div>

          {loading ? (
            <div role="status" aria-live="polite" className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-text-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-soft border-t-brand" aria-hidden="true" />
              Cargando conversación…
            </div>
          ) : loadError ? (
            <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
              <p role="alert" className="max-w-md text-sm leading-6 text-danger-text">{loadError}</p>
              <Button className="mt-4" variant="outline" onClick={() => void readHistory(false)}>
                Volver a cargar
              </Button>
            </div>
          ) : turns.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-brand-soft bg-background text-brand">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-base font-semibold text-foreground">Empecemos por aquí</h2>
              <p className="mt-1 max-w-sm text-sm leading-6 text-text-2">{copy.hint}</p>
            </div>
          ) : (
            <ol aria-label={`Historial de ${copy.title}`} className="space-y-6 pb-3">
              {turns.map((turn) => (
                <li key={turn.requestId} className="space-y-3">
                  <div className="ml-auto max-w-[92%] sm:max-w-[80%]">
                    <div className="mb-1.5 flex justify-end text-[11px] font-semibold text-text-2">Tú</div>
                    <div className="rounded-2xl rounded-tr-md border border-bubble-in-border bg-bubble-in px-3.5 py-3 text-sm leading-6 text-foreground shadow-sm sm:px-4">
                      <p className="whitespace-pre-wrap break-words"><PlainText text={turn.message} /></p>
                    </div>
                  </div>
                  {(turn.reply || turn.status !== "running" || turn.results.length > 0) && (
                    <div className="max-w-[96%] sm:max-w-[88%]">
                      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-text-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand text-brand-fg">
                          {agent === "buscador" ? <Search className="h-3 w-3" aria-hidden="true" /> : <CalendarDays className="h-3 w-3" aria-hidden="true" />}
                        </span>
                        {copy.title}
                      </div>
                      <div className="rounded-2xl rounded-tl-md border border-bubble-out-border bg-bubble-out px-3.5 py-3 text-sm leading-6 text-bubble-out-text shadow-sm sm:px-4">
                        {turn.reply ? <p className="whitespace-pre-wrap break-words"><PlainText text={turn.reply} /></p> : null}
                        <ResultCards results={turn.results} />
                        {turn.status === "completed" && !turn.reply && turn.results.length === 0 && (
                          <p className="text-text-2">No hay resultados para mostrar en esta respuesta.</p>
                        )}
                      </div>
                      <TurnStatus turn={turn} />
                    </div>
                  )}
                  {turn.status === "running" && !turn.reply && turn.results.length === 0 && (
                    <div className="max-w-[88%]">
                      <p className="mb-1.5 text-[11px] font-semibold text-text-2">{copy.title}</p>
                      <div className="inline-flex items-center gap-2 rounded-2xl rounded-tl-md border border-bubble-out-border bg-bubble-out px-4 py-3 text-sm text-text-2">
                        <span className="flex gap-1" aria-hidden="true"><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand [animation-delay:-0.2s]" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand [animation-delay:-0.1s]" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand" /></span>
                        <span className="sr-only">{copy.title} está preparando una respuesta</span>
                        <span aria-hidden="true">Un momento…</span>
                      </div>
                      <TurnStatus turn={turn} />
                    </div>
                  )}
                </li>
              ))}
              <li ref={endRef} aria-hidden="true" className="h-0 list-none" />
            </ol>
          )}
        </div>
      </div>

      <footer className="shrink-0 border-t border-border bg-background px-3 py-3 sm:px-6 sm:py-4">
        <div className="mx-auto max-w-4xl">
          {requestError && <p role="alert" className="mb-2 text-xs leading-5 text-danger-text">{requestError}</p>}
          <form
            onSubmit={(event) => void submit(event)}
            className="rounded-xl border border-border-strong bg-background p-2 shadow-sm transition-colors focus-within:border-brand-soft focus-within:ring-2 focus-within:ring-brand-soft sm:p-2.5"
          >
            <label className="sr-only" htmlFor={`inmob-message-${agent}`}>Mensaje para {copy.title}</label>
            <Textarea
              id={`inmob-message-${agent}`}
              aria-label={`Mensaje para ${copy.title}`}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setRequestError(null);
              }}
              onKeyDown={onComposerKeyDown}
              placeholder={copy.hint}
              maxLength={4000}
              rows={2}
              disabled={!chat || loading || submitting || hasRunning}
              className="min-h-[58px] resize-y border-0 bg-transparent px-2 py-1 shadow-none focus-visible:border-transparent focus-visible:ring-0"
            />
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-border px-1 pt-2">
              <div className="flex min-w-0 items-center gap-2 text-[11px] text-text-3">
                <span className="hidden sm:inline">Enter envía · Shift+Enter agrega una línea</span>
                <span className="sm:hidden">Enter para enviar</span>
                <span aria-live="polite" className={draft.length > 4000 ? "text-danger-text" : "tabular-nums"}>
                  {draft.length}/4000
                </span>
              </div>
              <Button type="submit" size="sm" disabled={!canSend} aria-label="Enviar">
                Enviar
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          </form>
          <p className="mt-2 text-center text-[10.5px] leading-4 text-text-3">
            {agent === "secretaria" ? "Revisa los datos de una cita antes de confirmarla." : "Los resultados pueden variar según la información disponible."}
          </p>
        </div>
      </footer>
    </section>
  );
}
