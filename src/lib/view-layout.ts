/** Preferencias de presentación locales; nunca contienen datos de chats. */
export type ViewLayout = {
  version: 1;
  navWidth: number;
  navCollapsed: boolean;
  inboxWidth: number;
  inboxCollapsed: boolean;
  headerHeight: number;
  composerHeight: number;
};

export const VIEW_LAYOUT_KEY = "vocero:view-layout:v1";
export const VIEW_LIMITS = {
  navWidth: { min: 200, max: 360, default: 240 },
  inboxWidth: { min: 260, max: 480, default: 360 },
  headerHeight: { min: 64, max: 144, default: 64 },
  composerHeight: { min: 64, max: 220, default: 64 },
} as const;
export type ViewDimension = keyof typeof VIEW_LIMITS;
export const DEFAULT_VIEW_LAYOUT: ViewLayout = {
  version: 1, navWidth: 240, navCollapsed: false, inboxWidth: 360, inboxCollapsed: false, headerHeight: 64, composerHeight: 64,
};

export function normalizeViewLayout(value: unknown): ViewLayout {
  if (!value || typeof value !== "object") return { ...DEFAULT_VIEW_LAYOUT };
  const candidate = value as Partial<ViewLayout>;
  if (candidate.version !== 1) return { ...DEFAULT_VIEW_LAYOUT };
  const result = { ...DEFAULT_VIEW_LAYOUT };
  for (const key of Object.keys(VIEW_LIMITS) as ViewDimension[]) {
    const number = candidate[key];
    const limit = VIEW_LIMITS[key];
    if (typeof number === "number" && Number.isFinite(number)) {
      result[key] = Math.max(limit.min, Math.min(limit.max, Math.round(number / 4) * 4));
    }
  }
  result.navCollapsed = candidate.navCollapsed === true;
  result.inboxCollapsed = candidate.inboxCollapsed === true;
  return result;
}
