import { beforeEach, describe, expect, it, vi } from "vitest";

const computeAvailability = vi.fn();
const listBookingsInRange = vi.fn();
const createSessionBooking = vi.fn();
const rescheduleBooking = vi.fn();
const cancelBooking = vi.fn();
const getContactById = vi.fn();
const searchContacts = vi.fn();
const createContact = vi.fn();
const agendaEnabled = vi.fn(() => true);
const inmobEnabled = vi.fn(() => true);

vi.mock("@/server/agenda/flag", () => ({ agendaEnabled }));
vi.mock("@/server/inmob/flag", () => ({ inmobEnabled }));
vi.mock("@/server/agenda/availability", () => ({ computeAvailability }));
vi.mock("@/server/agenda/queries", () => ({ listBookingsInRange }));
vi.mock("@/server/agenda/service", () => ({
  createSessionBooking,
  rescheduleBooking,
  cancelBooking,
}));
vi.mock("@/server/contacts", () => ({ getContactById }));
vi.mock("@/server/inmob/contacts", () => ({ searchContacts, createContact }));

describe("dispatcher nativo de Secretaria", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agendaEnabled.mockReturnValue(true);
    inmobEnabled.mockReturnValue(true);
    computeAvailability.mockResolvedValue([
      { startUtc: "2026-10-14T13:00:00.000Z", endUtc: "2026-10-14T13:30:00.000Z", label: "mié 14 oct, 09:00" },
    ]);
    listBookingsInRange.mockResolvedValue({ bookings: [], truncated: false });
    getContactById.mockResolvedValue({ id: "ct_owned", organizationId: "org_a", name: "Ana" });
    createSessionBooking.mockResolvedValue({ booking: { id: "bk_new" }, label: "mié 14 oct, 09:00" });
    rescheduleBooking.mockResolvedValue({ booking: { id: "bk_owned" }, label: "mié 14 oct, 09:00" });
    cancelBooking.mockResolvedValue(undefined);
    searchContacts.mockResolvedValue([]);
    createContact.mockResolvedValue({ id: "ct_new", name: "Ana" });
  });

  it("rechaza propiedades adicionales antes de despachar cualquier acción", async () => {
    const { executeSecretariaTool } = await import("@/server/inmob/tools");

    const result = await executeSecretariaTool("org_a", {
      name: "agenda_cancel",
      arguments: { bookingId: "bk_1", organizationId: "org_b" },
    });

    expect(result.ok).toBe(false);
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("exige INMOB y AGENDA encendidas antes de consultar la agenda", async () => {
    const { executeSecretariaTool } = await import("@/server/inmob/tools");
    inmobEnabled.mockReturnValue(false);

    const result = await executeSecretariaTool("org_a", {
      name: "agenda_availability",
      arguments: {},
    });

    expect(result.ok).toBe(false);
    expect(computeAvailability).not.toHaveBeenCalled();
  });

  it("devuelve disponibilidad con la zona explícita de La Paz", async () => {
    const { executeSecretariaTool } = await import("@/server/inmob/tools");

    const result = await executeSecretariaTool("org_a", {
      name: "agenda_availability",
      arguments: {},
    });

    expect(result.ok).toBe(true);
    expect(computeAvailability).toHaveBeenCalledWith("org_a");
    expect(result.result).toMatchObject({ timezone: "America/La_Paz" });
  });

  it("crea una cita para el contacto validado en la organización y sin oferta conversacional", async () => {
    const { executeSecretariaTool } = await import("@/server/inmob/tools");

    await executeSecretariaTool("org_a", {
      name: "agenda_create",
      arguments: {
        contactId: "ct_owned",
        startUtc: "2026-10-14T13:00:00.000Z",
        notes: "Visita de prueba",
      },
    });

    expect(getContactById).toHaveBeenCalledWith("org_a", "ct_owned");
    expect(createSessionBooking).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org_a",
      contactId: "ct_owned",
      source: "manual",
      requireOffer: false,
      notes: "Visita de prueba",
    }));
  });

  it("no modifica una cita si el identificador no pertenece a la organización", async () => {
    const { executeSecretariaTool } = await import("@/server/inmob/tools");
    // Un recurso de otro tenant se reporta como no encontrado.
    getContactById.mockResolvedValue(null);

    const result = await executeSecretariaTool("org_a", {
      name: "agenda_create",
      arguments: {
        contactId: "ct_other",
        startUtc: "2026-10-14T13:00:00.000Z",
      },
    });

    expect(result.ok).toBe(false);
    expect(createSessionBooking).not.toHaveBeenCalled();
  });

  it("no expone el mensaje crudo de un error de dominio", async () => {
    const { executeSecretariaTool } = await import("@/server/inmob/tools");
    listBookingsInRange.mockRejectedValue(new Error("postgres://user:secret@db"));

    const result = await executeSecretariaTool("org_a", {
      name: "agenda_list",
      arguments: {
        from: "2026-10-14T00:00:00-04:00",
        to: "2026-10-15T00:00:00-04:00",
      },
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
