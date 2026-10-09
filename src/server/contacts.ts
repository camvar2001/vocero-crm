import { asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { normalizeMx } from "@/lib/meta/client";
import { digitsOnly, normalizeText } from "@/lib/search";
import { effectiveSource } from "@/server/contact-source";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import type { FichaDto, PriorityValue } from "@/lib/types";

export function serializeContact(
  c: typeof schema.contact.$inferSelect,
  stageName: string | null = null,
  priority: PriorityValue | null = null,
  /** 018: si llegó por un anuncio, la fuente no capturada se deduce "anuncio". */
  llegoPorAnuncio = false
) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    notes: c.notes,
    stageName,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    source: effectiveSource(c.source, llegoPorAnuncio),
    priority,
    // Viaja siempre, aunque esté vacía: la pantalla necesita distinguir "aún
    // no la han llenado" de "este contacto no la trae".
    ficha: (c.ficha as FichaDto | null) ?? {},
  };
}

export async function getContactById(
  organizationId: string,
  contactId: string
) {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Candidatos para las acciones de Secretaria; nunca escoge por el agente. */
export async function searchContactsForTool(
  organizationId: string,
  query: string
): Promise<Array<{ id: string; name: string; phone: string | null }>> {
  const db = getDb();
  const qDigits = digitsOnly(query);
  const qLike = normalizeText(query).replace(/[\\%_]/g, "\\$&");
  const nameMatch = sql`lower(translate(${schema.contact.name}, ${UNACCENT_FROM}, ${UNACCENT_TO})) like ${`%${qLike}%`}`;
  const phoneMatch =
    qDigits.length >= 3
      ? sql`regexp_replace(coalesce(${schema.contact.phone}, ''), '\\D', '', 'g') like ${`%${qDigits}%`}`
      : undefined;
  const rows = await db
    .select({ id: schema.contact.id, name: schema.contact.name, phone: schema.contact.phone })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        isNull(schema.contact.archivedAt),
        or(nameMatch, phoneMatch)
      )
    )
    .orderBy(desc(schema.contact.updatedAt))
    .limit(20);
  return rows;
}

export type ManualContactCreateResult =
  | { ok: true; contact: ReturnType<typeof serializeContact>; leadId: string }
  | { ok: false; reason: "duplicate" | "no_stage" | "uncertain" };

/** Alta compartida por el endpoint manual y el dispatcher de Secretaria. */
export async function createManualContact(input: {
  organizationId: string;
  userId: string | null;
  name: string;
  phone: string;
  notes?: string;
  source?: "anuncio" | "organico" | "referido" | "conocido" | "otro";
  stageId?: string;
  /** Monotonic deadline supplied by a bounded agent tool invocation. */
  deadline?: number;
}): Promise<ManualContactCreateResult> {
  const db = getDb();
  const availableStages = await db
    .select({ id: schema.pipelineStage.id })
    .from(schema.pipelineStage)
    .where(scoped(
      schema.pipelineStage.organizationId,
      input.organizationId,
      eq(schema.pipelineStage.kind, "open"),
      input.stageId ? eq(schema.pipelineStage.id, input.stageId) : undefined
    ))
    .orderBy(asc(schema.pipelineStage.position))
    .limit(1);
  const stageId = availableStages[0]?.id;
  if (!stageId) return { ok: false, reason: "no_stage" };
  if (input.deadline !== undefined && globalThis.performance.now() >= input.deadline) {
    throw new Error("contact_create_deadline");
  }

  const phone = normalizeMx(input.phone);
  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId: input.organizationId,
      name: input.name,
      phone,
      waIdentity: phone,
      notes: input.notes ?? null,
      source: input.source ?? null,
    })
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  const contact = inserted[0];
  if (!contact) return { ok: false, reason: "duplicate" };

  if (input.deadline !== undefined && globalThis.performance.now() >= input.deadline) {
    throw new Error("contact_create_deadline");
  }

  const lead = await createLeadForContact({
    organizationId: input.organizationId,
    contactId: contact.id,
    stageId,
    source: "dueno",
    actorUserId: input.userId,
  });
  if (!lead) {
    // Another writer may have created the lead after our preflight. Reconcile
    // that race; if no lead is visible, the contact write may be partial.
    const existingLead = await db
      .select({ id: schema.lead.id })
      .from(schema.lead)
      .where(scoped(
        schema.lead.organizationId,
        input.organizationId,
        eq(schema.lead.contactId, contact.id)
      ))
      .limit(1);
    if (!existingLead[0]) return { ok: false, reason: "uncertain" };
    return { ok: true, contact: serializeContact(contact), leadId: existingLead[0].id };
  }

  return {
    ok: true,
    contact: serializeContact(contact),
    leadId: lead.id,
  };
}

const UNACCENT_FROM = "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ";
const UNACCENT_TO = "aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC";

/** Etapa actual del lead del contacto (si existe). */
export async function getContactStage(
  organizationId: string,
  contactId: string
) {
  const db = getDb();
  const rows = await db
    .select({ stage: schema.pipelineStage, lead: schema.lead })
    .from(schema.lead)
    .innerJoin(
      schema.pipelineStage,
      eq(schema.lead.stageId, schema.pipelineStage.id)
    )
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
