import { beforeEach, describe, expect, it, vi } from "vitest";

const createMeeting = vi.fn(async () => ({
  externalId: "external_1",
  joinUrl: "https://meeting.example/1",
}));
const updateMeeting = vi.fn(async () => {});
const deleteMeeting = vi.fn(async () => {});
const bindConnector = vi.fn(async () => ({
  id: "zoom",
  createMeeting,
  updateMeeting,
  deleteMeeting,
  testConnection: async () => ({ ok: true as const }),
}));

vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => ({
    weeklyHours: { wed: [{ start: "09:00", end: "18:00" }] },
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 7,
    timezone: "America/La_Paz",
    connector: "zoom",
    meetingLink: null,
  }),
}));
vi.mock("@/server/agenda/availability", () => ({
  findSlot: async (_organizationId: string, startUtc: string) => {
    if (slotDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, slotDelayMs));
    return {
      startUtc,
      endUtc: "2026-10-14T13:30:00.000Z",
      label: "mié 14 oct, 09:00",
    };
  },
  computeAvailability: async () => [],
}));
vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return {
    ...original,
    clearOffers: async () => {},
    getOffers: async () => [],
  };
});
vi.mock("@/server/agenda/connectors", () => ({
  bindConnector,
  markConnectorAuthError: async () => {},
}));
vi.mock("@/server/agenda/connectors/types", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/connectors/types")>();
  return {
    ...original,
    LOCAL_ONLY_CONNECTOR_ID: "local",
    isLocalOnlyConnector: (connectorId: string | null | undefined) => connectorId === "local",
  };
});
vi.mock("@/server/leads/stage-history", () => ({
  moveLeadToStage: async () => ({ ok: true }),
}));
vi.mock("@/server/events/bus", () => ({ publish: vi.fn() }));

const selectRows: unknown[][] = [];
let inserted: Record<string, unknown> | null = null;
let updated: Record<string, unknown> = {};
let insertCalls = 0;
let updateCalls = 0;
let selectDelayMs = 0;
let slotDelayMs = 0;

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "innerJoin", "leftJoin"]) {
    chain[method] = () => chain;
  }
  chain.limit = () => new Promise((resolve) => {
    setTimeout(() => resolve(rows), selectDelayMs);
  });
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => selectChain(selectRows.shift() ?? []),
    insert: () => {
      insertCalls += 1;
      return {
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            inserted = values;
            return [{ ...values, scheduledAt: new Date(SLOT), externalRef: null, linkPending: false }];
          },
        }),
      };
    },
    update: () => {
      updateCalls += 1;
      return {
        set: (values: Record<string, unknown>) => ({
          where: () => ({ returning: async () => [{ ...updated, ...values }] }),
        }),
      };
    },
  }),
  schema: {
    booking: {},
    conversation: { organizationId: "organizationId", id: "id" },
    contact: { organizationId: "organizationId", id: "id", name: "name" },
    lead: { organizationId: "organizationId", contactId: "contactId" },
    pipelineStage: { organizationId: "organizationId" },
  },
}));

const SLOT = "2026-10-14T13:00:00.000Z";
const LOCAL_BOOKING = {
  id: "bk_local",
  organizationId: "org_a",
  scheduledAt: new Date(SLOT),
  durationMinutes: 30,
  status: "agendada",
  isTest: false,
  connector: "local",
  externalRef: null,
  meetingLink: null,
  linkPending: false,
  notes: null,
  contactId: "ct_a",
};

describe("citas nativas locales de Secretaria", () => {
  beforeEach(() => {
    selectRows.length = 0;
    inserted = null;
    updated = { ...LOCAL_BOOKING };
    insertCalls = 0;
    updateCalls = 0;
    selectDelayMs = 0;
    slotDelayMs = 0;
    createMeeting.mockClear();
    updateMeeting.mockClear();
    deleteMeeting.mockClear();
    bindConnector.mockClear();
  });

  it("consume un horario real, persiste el marcador local y no crea reunión externa", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    selectRows.push([{ name: "Ana" }]); // contacto
    selectRows.push([]); // lead existente

    const result = await createSessionBooking({
      organizationId: "org_a",
      contactId: "ct_a",
      startUtc: SLOT,
      source: "manual",
      requireOffer: false,
      delivery: "local-only",
      advanceLead: false,
    });

    expect(result.booking.isTest).toBe(false);
    expect(inserted).toMatchObject({ isTest: false, source: "manual", connector: "local" });
    expect(bindConnector).not.toHaveBeenCalled();
    expect(createMeeting).not.toHaveBeenCalled();
  });

  it("reprogramar una cita con marcador local conserva el hueco sin llamar al conector", async () => {
    const { rescheduleBooking } = await import("@/server/agenda/service");
    selectRows.push([{ ...LOCAL_BOOKING, externalRef: "" }]);

    await rescheduleBooking({
      organizationId: "org_a",
      bookingId: "bk_local",
      startUtc: SLOT,
    });

    expect(bindConnector).not.toHaveBeenCalled();
    expect(updateMeeting).not.toHaveBeenCalled();
  });

  it("cancelar una cita con marcador local no borra nada en un proveedor", async () => {
    const { cancelBooking } = await import("@/server/agenda/service");
    selectRows.push([{ ...LOCAL_BOOKING, externalRef: "" }]);

    await cancelBooking({ organizationId: "org_a", bookingId: "bk_local" });

    expect(bindConnector).not.toHaveBeenCalled();
    expect(deleteMeeting).not.toHaveBeenCalled();
  });

  it("no inserta una cita si una lectura de contacto vence el deadline compartido", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    selectRows.push([{ name: "Ana" }]);
    selectDelayMs = 25;

    await expect(createSessionBooking({
      organizationId: "org_a",
      contactId: "ct_a",
      startUtc: SLOT,
      source: "manual",
      requireOffer: false,
      delivery: "local-only",
      advanceLead: false,
      deadline: globalThis.performance.now() + 5,
    })).rejects.toThrow(/deadline/i);

    expect(insertCalls).toBe(0);
    expect(inserted).toBeNull();
  });

  it("no reprograma si la disponibilidad termina de leerse después del deadline", async () => {
    const { rescheduleBooking } = await import("@/server/agenda/service");
    selectRows.push([{ ...LOCAL_BOOKING, externalRef: "" }]);
    slotDelayMs = 25;

    await expect(rescheduleBooking({
      organizationId: "org_a",
      bookingId: "bk_local",
      startUtc: SLOT,
      deadline: globalThis.performance.now() + 5,
    })).rejects.toThrow(/deadline/i);

    expect(updateCalls).toBe(0);
  });

  it("no cancela si la lectura de la cita termina después del deadline", async () => {
    const { cancelBooking } = await import("@/server/agenda/service");
    selectRows.push([{ ...LOCAL_BOOKING, externalRef: "" }]);
    selectDelayMs = 25;

    await expect(cancelBooking({
      organizationId: "org_a",
      bookingId: "bk_local",
      deadline: globalThis.performance.now() + 5,
    })).rejects.toThrow(/deadline/i);

    expect(updateCalls).toBe(0);
  });
});
