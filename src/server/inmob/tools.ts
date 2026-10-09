import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { labelInTz, partsInTz } from "@/lib/time/slots";
import { agendaEnabled } from "@/server/agenda/flag";
import { computeAvailability } from "@/server/agenda/availability";
import { cancelBooking, createSessionBooking, rescheduleBooking, BookingError } from "@/server/agenda/service";
import { listBookingsInRange } from "@/server/agenda/queries";
import { createManualContact, getContactById, searchContactsForTool } from "@/server/contacts";
import { inmobEnabled } from "@/server/inmob/flag";
import { LOCAL_ONLY_CONNECTOR_ID } from "@/server/agenda/connectors/types";

const LA_PAZ = "America/La_Paz" as const;
const instant = z.string().datetime({ offset: true }).refine(
  (value) => /(?:Z|[+-]\d{2}:\d{2})$/.test(value),
  "La fecha debe incluir Z o un desfase UTC"
);

const toolSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("contact_search"), arguments: z.object({ query: z.string().trim().min(1).max(120) }).strict() }).strict(),
  z.object({ name: z.literal("contact_create"), arguments: z.object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().regex(/^\d{7,15}$/),
    notes: z.string().max(4000).optional(),
  }).strict() }).strict(),
  z.object({ name: z.literal("agenda_availability"), arguments: z.object({}).strict() }).strict(),
  z.object({ name: z.literal("agenda_list"), arguments: z.object({
    from: instant,
    to: instant,
  }).strict().refine((v) => Date.parse(v.to) >= Date.parse(v.from) && Date.parse(v.to) - Date.parse(v.from) <= 31 * 86_400_000) }).strict(),
  z.object({ name: z.literal("agenda_create"), arguments: z.object({
    contactId: z.string().min(1).max(200),
    startUtc: instant,
    notes: z.string().max(4000).optional(),
  }).strict() }).strict(),
  z.object({ name: z.literal("agenda_update"), arguments: z.object({
    bookingId: z.string().min(1).max(200),
    startUtc: instant,
  }).strict() }).strict(),
  z.object({ name: z.literal("agenda_cancel"), arguments: z.object({
    bookingId: z.string().min(1).max(200),
  }).strict() }).strict(),
]);

type Tool = z.infer<typeof toolSchema>;
type DispatchResult = { ok: boolean; result: unknown; uncertain?: boolean };
type ToolExecutionOptions = { deadline?: number };

/** Executa únicamente operaciones nativas; la organización viene de sesión. */
export async function executeSecretariaTool(
  organizationId: string,
  tool: unknown,
  userId?: string,
  options: ToolExecutionOptions = {}
): Promise<DispatchResult> {
  const parsed = toolSchema.safeParse(tool);
  if (!parsed.success) return failure("La solicitud de acción no es válida.");
  if (!inmobEnabled() || !agendaEnabled()) {
    return failure("Secretaria no está disponible en esta instancia.");
  }

  try {
    return await dispatch(organizationId, parsed.data, userId, options);
  } catch (error) {
    if (error instanceof BookingError) {
      return failure(safeBookingMessage(error));
    }
    return failure("No se pudo confirmar el resultado de la acción.", true);
  }
}

async function dispatch(organizationId: string, tool: Tool, userId: string | undefined, options: ToolExecutionOptions): Promise<DispatchResult> {
  switch (tool.name) {
    case "contact_search":
      return success({ candidates: await searchContactsForTool(organizationId, tool.arguments.query) });

    case "contact_create": {
      const result = await createManualContact({
        organizationId,
        userId: userId ?? null,
        name: tool.arguments.name,
        phone: tool.arguments.phone,
        notes: tool.arguments.notes,
        deadline: options.deadline,
      });
      if (!result.ok) {
        if (result.reason === "uncertain") {
          return failure("No se pudo confirmar el resultado del alta del contacto.", true);
        }
        return failure(result.reason === "duplicate"
          ? "Ya existe un contacto con ese teléfono."
          : "No se pudo crear el contacto porque el pipeline no tiene etapas abiertas.");
      }
      return success({ contact: result.contact, leadId: result.leadId });
    }

    case "agenda_availability": {
      const slots = await computeAvailability(organizationId);
      return success({
        timezone: LA_PAZ,
        slots: slots.map((slot) => ({
          startUtc: slot.startUtc,
          endUtc: slot.endUtc,
          label: labelInTz(slot.startUtc, LA_PAZ),
        })),
      });
    }

    case "agenda_list": {
      const from = partsInTz(tool.arguments.from, LA_PAZ).date;
      const to = partsInTz(tool.arguments.to, LA_PAZ).date;
      const { bookings, truncated } = await listBookingsInRange(organizationId, { from, to });
      return success({
        timezone: LA_PAZ,
        truncated,
        bookings: bookings.map((booking) => {
          const local = partsInTz(booking.scheduledAtUtc, LA_PAZ);
          return {
            id: booking.id,
            status: booking.status,
            scheduledAtUtc: booking.scheduledAtUtc,
            durationMinutes: booking.durationMinutes,
            date: local.date,
            time: local.time,
            label: labelInTz(booking.scheduledAtUtc, LA_PAZ),
            contact: booking.contact,
            notes: booking.notes,
          };
        }),
      });
    }

    case "agenda_create": {
      const contact = await getContactById(organizationId, tool.arguments.contactId);
      if (!contact || contact.archivedAt) return failure("No encontramos ese contacto activo.");
      assertBeforeDeadline(options);
      const result = await createSessionBooking({
        organizationId,
        contactId: contact.id,
        startUtc: tool.arguments.startUtc,
        source: "manual",
        requireOffer: false,
        notes: tool.arguments.notes,
        delivery: "local-only",
        advanceLead: false,
        deadline: options.deadline,
      });
      return success({
        bookingId: result.booking.id,
        scheduledAtUtc: result.booking.scheduledAt.toISOString(),
        timezone: LA_PAZ,
        label: labelInTz(result.booking.scheduledAt.toISOString(), LA_PAZ),
      });
    }

    case "agenda_update": {
      if (!(await isLocalBooking(organizationId, tool.arguments.bookingId))) {
        return failure("Solo puedes reprogramar citas creadas localmente por Secretaria.");
      }
      assertBeforeDeadline(options);
      const result = await rescheduleBooking({
        organizationId,
        bookingId: tool.arguments.bookingId,
        startUtc: tool.arguments.startUtc,
        deadline: options.deadline,
      });
      return success({
        bookingId: result.booking.id,
        scheduledAtUtc: result.booking.scheduledAt.toISOString(),
        timezone: LA_PAZ,
        label: labelInTz(result.booking.scheduledAt.toISOString(), LA_PAZ),
      });
    }

    case "agenda_cancel":
      if (!(await isLocalBooking(organizationId, tool.arguments.bookingId))) {
        return failure("Solo puedes cancelar citas creadas localmente por Secretaria.");
      }
      assertBeforeDeadline(options);
      await cancelBooking({ organizationId, bookingId: tool.arguments.bookingId, deadline: options.deadline });
      return success({ bookingId: tool.arguments.bookingId, status: "cancelada" });
  }
}

function assertBeforeDeadline(options: ToolExecutionOptions): void {
  if (options.deadline !== undefined && globalThis.performance.now() >= options.deadline) {
    throw new Error("secretaria_tool_deadline");
  }
}

async function isLocalBooking(organizationId: string, bookingId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.select({ connector: schema.booking.connector })
    .from(schema.booking)
    .where(scoped(
      schema.booking.organizationId,
      organizationId,
      eq(schema.booking.id, bookingId)
    ))
    .limit(1);
  return rows[0]?.connector === LOCAL_ONLY_CONNECTOR_ID;
}

function safeBookingMessage(error: BookingError): string {
  switch (error.code) {
    case "slot_taken":
      return "Ese horario ya no está disponible. Consulta los horarios libres.";
    case "slot_not_offered":
      return "Ese horario no se ofreció. Consulta la disponibilidad actual.";
    case "not_found":
      return "No encontramos la cita solicitada en esta organización.";
    case "invalid":
      return "La acción no se pudo completar con esos datos.";
  }
}

function success(result: unknown): DispatchResult {
  return { ok: true, result };
}

function failure(message: string, uncertain = false): DispatchResult {
  return { ok: false, result: { error: message }, ...(uncertain ? { uncertain: true } : {}) };
}
