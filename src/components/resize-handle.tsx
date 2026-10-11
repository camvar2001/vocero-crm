"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

/** Separador ajustable con mouse, lápiz, touch y teclado. */
export function ResizeHandle({ label, axis, value, min, max, defaultValue, reverse = false, onChange, className }: {
  label: string; axis: "x" | "y"; value: number; min: number; max: number; defaultValue: number;
  reverse?: boolean; onChange: (value: number, persist?: boolean) => void; className?: string;
}) {
  const drag = useRef<{ pointerId: number; start: number; value: number; latest: number } | null>(null);
  function clamp(next: number) { return Math.max(min, Math.min(max, Math.round(next / 4) * 4)); }
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation={axis === "x" ? "vertical" : "horizontal"} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} píxeles`} title={`${label} · arrastra o usa las flechas · doble clic para restablecer`} className={cn("view-resize", axis === "x" ? "view-resize-x" : "view-resize-y", className)}
    onDoubleClick={() => onChange(defaultValue, true)}
    onKeyDown={(event) => {
      let next: number | null = null;
      if (event.key === "Home") next = min;
      if (event.key === "End") next = max;
      const negative = axis === "x" ? "ArrowLeft" : "ArrowUp";
      const positive = axis === "x" ? "ArrowRight" : "ArrowDown";
      if (event.key === negative) next = value - (reverse ? -1 : 1) * (event.shiftKey ? 24 : 8);
      if (event.key === positive) next = value + (reverse ? -1 : 1) * (event.shiftKey ? 24 : 8);
      if (next !== null) { event.preventDefault(); onChange(clamp(next), true); }
    }}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      drag.current = { pointerId: event.pointerId, start: axis === "x" ? event.clientX : event.clientY, value, latest: value };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      active.latest = clamp(active.value + ((axis === "x" ? event.clientX : event.clientY) - active.start) * (reverse ? -1 : 1));
      onChange(active.latest, false);
    }}
    onPointerUp={(event) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      drag.current = null;
      onChange(active.latest, true);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { if (drag.current) onChange(drag.current.value, true); drag.current = null; }}
    onLostPointerCapture={() => { if (drag.current) onChange(drag.current.latest, true); drag.current = null; }}
  ><span aria-hidden="true" /></div>;
}
