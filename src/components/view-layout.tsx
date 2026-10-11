"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { DEFAULT_VIEW_LAYOUT, normalizeViewLayout, VIEW_LAYOUT_KEY, VIEW_LIMITS, type ViewDimension, type ViewLayout } from "@/lib/view-layout";

let snapshot: ViewLayout | null = null;
const listeners = new Set<() => void>();

function readStored(): ViewLayout {
  try { return normalizeViewLayout(JSON.parse(localStorage.getItem(VIEW_LAYOUT_KEY) ?? "null")); }
  catch { return { ...DEFAULT_VIEW_LAYOUT }; }
}
function getSnapshot() {
  if (!snapshot) snapshot = readStored();
  return snapshot;
}
function getServerSnapshot() { return DEFAULT_VIEW_LAYOUT; }
function onStorage(event: StorageEvent) {
  if (event.key !== VIEW_LAYOUT_KEY && event.key !== null) return;
  snapshot = readStored();
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
function update(patch: Partial<ViewLayout>, persist = true) {
  snapshot = normalizeViewLayout({ ...getSnapshot(), ...patch, version: 1 });
  if (persist) {
    try { localStorage.setItem(VIEW_LAYOUT_KEY, JSON.stringify(snapshot)); }
    catch { /* El ajuste visible funciona también con storage bloqueado. */ }
  }
  listeners.forEach((listener) => listener());
}

export function useViewLayout() {
  const layout = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { layout, update, reset: () => update(DEFAULT_VIEW_LAYOUT) };
}

const LABELS: Record<ViewDimension, string> = {
  headerHeight: "Altura de la cabecera",
  composerHeight: "Altura para redactar",
  navWidth: "Ancho del menú",
};

/** Dialog nativo en el top layer: foco atrapado, Escape y regreso al botón. */
export function ViewLayoutControls({ menu = false }: { menu?: boolean }) {
  const { layout, update, reset } = useViewLayout();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);

  return <>
    <button ref={triggerRef} type="button" className="glass-floating glass-icon-button" aria-label={menu ? "Ajustar menú" : "Ajustar vista"} title={menu ? "Ajustar menú y vista" : "Ajustar vista"} onClick={() => setOpen(true)}>
      <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
    {open && createPortal(<dialog ref={dialogRef} aria-labelledby={menu ? "menu-layout-title" : "chat-layout-title"} className="view-layout-dialog rounded-lg border border-border bg-popover p-5 text-foreground shadow-pop" onClose={() => { setOpen(false); triggerRef.current?.focus(); }} onClick={(event) => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.currentTarget.close(); } }}>
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 id={menu ? "menu-layout-title" : "chat-layout-title"} className="font-display text-lg font-semibold">Ajustar vista</h2>
        <button type="button" className="glass-floating glass-icon-button" aria-label="Cerrar ajustes de vista" onClick={() => dialogRef.current?.close()}><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      <p className="mb-5 text-sm text-text-2">Elige cuánto espacio ocupan el menú y las barras del chat. Se guarda en este navegador.</p>
      <div className="space-y-5">
        {(Object.keys(LABELS) as ViewDimension[]).map((key) => <label key={key} className="block text-sm font-medium">
          <span className="flex items-center justify-between gap-3">{LABELS[key]}<output className="font-mono text-xs text-text-2">{layout[key]} px</output></span>
          <input type="range" className="view-layout-range mt-2 w-full" aria-label={LABELS[key]} min={VIEW_LIMITS[key].min} max={VIEW_LIMITS[key].max} step={4} value={layout[key]} onChange={(event) => update({ [key]: Number(event.target.value) })} />
        </label>)}
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={layout.navCollapsed} onChange={(event) => update({ navCollapsed: event.target.checked })} />Menú retraído en escritorio</label>
      </div>
      <p className="mt-4 text-xs leading-5 text-text-2">También puedes arrastrar los bordes del menú y de las barras. En pantallas pequeñas el alto se adapta para dejar visible la conversación.</p>
      <button type="button" className="glass-floating mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold" onClick={reset}><RotateCcw className="h-4 w-4" aria-hidden="true" />Restablecer tamaños</button>
    </dialog>, document.body)}
  </>;
}
