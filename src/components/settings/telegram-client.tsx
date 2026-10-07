"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleOff, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  parseTelegramAllowedIds,
  telegramAllowlistMatchesSaved,
  telegramStatusLabel,
  type TelegramChannelStatus,
} from "@/lib/telegram-settings";

type TelegramSettings = {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  bot: { id: string; username: string } | null;
  allowedUserIds: string[];
  status: TelegramChannelStatus;
  cursor: string | null;
  counts: { pending: number; failed: number; uncertain: number };
};

const STATUS_STYLE: Record<TelegramChannelStatus, string> = {
  disconnected: "border-border-strong bg-chip text-text-2",
  connecting: "border-info-soft bg-info-tint text-info-text",
  connected: "border-success-soft bg-success-tint text-success-text",
  error: "border-danger-soft bg-danger-tint text-danger-text",
  conflict: "border-danger-soft bg-danger-tint text-danger-text",
};

export function TelegramClient() {
  const [settings, setSettings] = useState<TelegramSettings | null>(null);
  const [allowedText, setAllowedText] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/settings/telegram", { cache: "no-store" }).catch(
      () => null
    );
    if (!res?.ok) {
      setError("No se pudo consultar el estado. Comprueba que tienes acceso de propietario.");
      setLoading(false);
      return;
    }
    const data = (await res.json()) as TelegramSettings;
    setSettings(data);
    setAllowedText(data.allowedUserIds.join("\n"));
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const parsed = parseTelegramAllowedIds(allowedText);

  async function save() {
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const body: { allowedUserIds: string[]; token?: string } = {
      allowedUserIds: parsed.ids,
    };
    const replacement = token.trim();
    if (replacement) body.token = replacement;
    const res = await fetch("/api/settings/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError("No se pudo guardar. Verifica el token, el bot y los IDs permitidos.");
      return;
    }
    setToken("");
    setNotice("Configuración guardada. Telegram y la IA siguen bajo control explícito.");
    await refetch();
  }

  async function setConnected(connected: boolean) {
    if (!settings) return;
    if (connected && (parsed.error || parsed.ids.length === 0)) {
      setError(parsed.error ?? "Añade al menos un ID permitido antes de conectar.");
      return;
    }
    if (
      connected &&
      !telegramAllowlistMatchesSaved(parsed.ids, settings.allowedUserIds)
    ) {
      setError("Guarda primero los cambios de IDs permitidos y después conecta el bot.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const res = await fetch("/api/settings/telegram", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connected }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(
        connected
          ? "No se pudo iniciar el bot. Revisa la configuración y el estado de exclusividad."
          : "No se pudo detener el bot."
      );
      return;
    }
    setNotice(connected ? "Bot conectado. La IA no se ha activado." : "Bot detenido.");
    await refetch();
  }

  async function revoke() {
    if (!window.confirm("¿Revocar el token y desconectar este bot de Vocero?")) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const res = await fetch("/api/settings/telegram", { method: "DELETE" }).catch(
      () => null
    );
    setSaving(false);
    if (!res?.ok) {
      setError("No se pudo revocar la credencial. El historial se conserva.");
      return;
    }
    setToken("");
    setNotice("Bot desconectado y credencial revocada. El historial se conserva.");
    await refetch();
  }

  if (loading) return <p className="text-sm text-text-3">Cargando Telegram…</p>;
  if (!settings) {
    return (
      <p role="alert" className="text-sm text-danger-text">
        {error ?? "No se pudo cargar Telegram."}
      </p>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-card p-4">
        {settings.status === "connected" ? (
          <CheckCircle2 className="h-5 w-5 text-success" />
        ) : settings.status === "error" || settings.status === "conflict" ? (
          <AlertTriangle className="h-5 w-5 text-destructive" />
        ) : (
          <CircleOff className="h-5 w-5 text-text-3" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{telegramStatusLabel(settings.status)}</p>
          <p className="mt-0.5 text-xs text-text-3">
            {settings.bot
              ? `Bot @${settings.bot.username} · ID ${settings.bot.id}`
              : "Todavía no hay un bot configurado."}
          </p>
        </div>
        <Badge className={STATUS_STYLE[settings.status]}>
          {settings.status === "connected"
            ? "Canal activo"
            : settings.connected
              ? "Conexión pendiente"
              : "Canal detenido"}
        </Badge>
      </div>

      {(settings.status === "error" || settings.status === "conflict") && (
        <div role="status" className="rounded-lg border border-danger-soft bg-danger-tint p-3 text-sm text-danger-text">
          {settings.status === "conflict"
            ? "Telegram detectó otro consumidor de este bot. Vocero detuvo el canal; revisa que este bot sea exclusivo del piloto."
            : "El bot requiere atención. Revisa el token y vuelve a conectar de forma explícita."}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Conectar un bot exclusivo</CardTitle>
          <CardDescription>
            Vocero consulta Telegram desde esta Mac por una conexión saliente. No requiere webhook público, puertos del router ni activa la IA.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start gap-2 rounded-md border border-info-soft bg-info-tint p-3 text-xs text-info-text">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Usa un bot nuevo creado para este piloto y habla con él en un chat privado. El token se guarda de forma protegida y nunca vuelve a mostrarse después de guardarlo.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="telegram-token">Token del bot {settings.configured && "(opcional para rotar)"}</Label>
            <Input
              id="telegram-token"
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={settings.configured ? "Deja vacío para conservar el token actual" : "Pega aquí el token nuevo"}
              spellCheck={false}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="telegram-allowed-ids">IDs de usuario permitidos</Label>
            <textarea
              id="telegram-allowed-ids"
              rows={4}
              value={allowedText}
              onChange={(event) => setAllowedText(event.target.value)}
              placeholder="Un ID decimal por línea"
              inputMode="numeric"
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm outline-none placeholder:text-text-3 focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-text-3">
              Solo se atienden mensajes privados de estos IDs. Una lista vacía mantiene detenido el canal.
            </p>
            {parsed.error && <p className="text-xs text-danger-text">{parsed.error}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void save()} disabled={saving || !!parsed.error}>
              {saving ? "Guardando…" : "Guardar configuración"}
            </Button>
            {settings.connected ? (
              <Button variant="outline" onClick={() => void setConnected(false)} disabled={saving}>
                Detener bot
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => void setConnected(true)}
                disabled={saving || !settings.configured || parsed.ids.length === 0 || !!parsed.error}
              >
                Conectar bot
              </Button>
            )}
            {settings.configured && (
              <Button variant="ghost" onClick={() => void revoke()} disabled={saving}>
                Revocar y desconectar
              </Button>
            )}
          </div>

          {error && <p role="alert" className="text-sm text-danger-text">{error}</p>}
          {notice && <p role="status" className="text-sm text-success-text">{notice}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actividad del canal</CardTitle>
          <CardDescription>Contadores operativos sin mostrar contenido de mensajes ni credenciales.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3 text-center">
          {([
            ["Pendientes", settings.counts.pending],
            ["Fallidos", settings.counts.failed],
            ["Inciertos", settings.counts.uncertain],
          ] as const).map(([label, count]) => (
            <div key={label} className="rounded-md border border-border-strong bg-subtle px-2 py-3">
              <p className="font-mono text-xl font-semibold">{count}</p>
              <p className="mt-1 text-xs text-text-3">{label}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
