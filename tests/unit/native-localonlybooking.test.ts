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
  findSlot: async (_organizationId: string, startUtc: string) => ({
    startUtc,
    endUtc: "2026-10-14T13:30:00.000Z",
    label: "mié 14 oct, 09:00",
  }),
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
vi.mock("@/server/leads/stage-history", () => ({
  moveLeadToStage: async () => ({ ok: true }),
}));
vi.mock("@/server/events/bus", () => ({ publish: vi.fn() }));

const selectRows: unknown[][] = [];
let inserted: Record<string, unknown> | null = null;
let updated: Record<string, unknown> = {};

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "innerJoin", "leftJoin"]) {
    chain[method] = () => chain;
  }
  chain.limit = () => Promise.resolve(rows);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => selectChain(selectRows.shift() ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserted = values;
          return [{ ...values, scheduledAt: new Date(SLOT), externalRef: null, linkPending: false }];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({ returning: async () => [{ ...updated, ...values }] }),
      }),
    }),
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
});
