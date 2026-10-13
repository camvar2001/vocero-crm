import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW_LAYOUT, normalizeViewLayout } from "@/lib/view-layout";

describe("preferencias de tamaño de vista", () => {
  it("conserva el inicio compacto si el almacenamiento es inválido", () => {
    for (const value of [null, undefined, "corrupto", [], { version: 2 }, { headerHeight: 200 }]) {
      expect(normalizeViewLayout(value)).toEqual(DEFAULT_VIEW_LAYOUT);
    }
  });
  it("limita tamaños extremos para mantener navegación y escritura utilizables", () => {
    expect(normalizeViewLayout({ version: 1, navWidth: 9999, headerHeight: -40, composerHeight: 1000, navCollapsed: true, inboxWidth: -20, inboxCollapsed: true })).toEqual({ ...DEFAULT_VIEW_LAYOUT, navWidth: 360, headerHeight: 64, composerHeight: 220, navCollapsed: true, inboxWidth: 260, inboxCollapsed: true });
  });
  it("ignora números no finitos y valores de tipos incorrectos", () => {
    expect(normalizeViewLayout({ version: 1, navWidth: NaN, headerHeight: Infinity, composerHeight: "180", navCollapsed: "true" })).toEqual(DEFAULT_VIEW_LAYOUT);
  });
  it("mantiene el ajuste elegido y elimina propiedades ajenas a la presentación", () => {
    expect(normalizeViewLayout({ version: 1, navWidth: 283, headerHeight: 96, composerHeight: 164, navCollapsed: true, token: "no se conserva" })).toEqual({ ...DEFAULT_VIEW_LAYOUT, navWidth: 284, headerHeight: 96, composerHeight: 164, navCollapsed: true });
  });
  it("añade la bandeja sin perder preferencias guardadas antes de la ampliación", () => {
    expect(normalizeViewLayout({ version: 1, navWidth: 320, navCollapsed: true, headerHeight: 80, composerHeight: 120 })).toEqual({ ...DEFAULT_VIEW_LAYOUT, navWidth: 320, navCollapsed: true, headerHeight: 80, composerHeight: 120 });
  });
});
