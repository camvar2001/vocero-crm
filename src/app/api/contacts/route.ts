import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { digitsOnly, normalizeText } from "@/lib/search";
import { createManualContact, serializeContact } from "@/server/contacts";

export const dynamic = "force-dynamic";

/**
 * Búsqueda tolerante en SQL, espejo de `matchesQuery` del cliente:
 * - nombre sin acentos ni mayúsculas (`translate`, sin depender de la
 *   extensión `unaccent`, que exigiría privilegios en la BD);
 * - teléfono por DÍGITOS, para poder teclearlo como se ve ("+52 462 134…").
 */
const UNACCENT_FROM = "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ";
const UNACCENT_TO = "aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC";

export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const stage = url.searchParams.get("stage")?.trim();
  const includeArchived = url.searchParams.get("archived") === "true";

  const db = getDb();

  // Etapa de cada contacto en una consulta aparte: una subconsulta
  // correlacionada aquí choca con el `id` de `lead` ("column reference id is
  // ambiguous"), y un join duplicaría contactos con más de un lead.
  const leadStages = await db
    .select({
      contactId: schema.lead.contactId,
      stageName: schema.pipelineStage.name,
      priority: schema.lead.priority,
    })
    .from(schema.lead)
    .innerJoin(
      schema.pipelineStage,
      eq(schema.pipelineStage.id, schema.lead.stageId)
    )
    .where(scoped(schema.lead.organizationId, session.organizationId));
  const stageByContact = new Map(
    leadStages.map((r) => [r.contactId, r.stageName])
  );
  const priorityByContact = new Map(
    leadStages.map((r) => [r.contactId, r.priority])
  );

  const qDigits = q ? digitsOnly(q) : "";
  // El patrón viaja normalizado igual que la columna, y con los comodines de
  // LIKE escapados para que un "%" tecleado no liste todo.
  const qLike = q ? normalizeText(q).replace(/[\\%_]/g, "\\$&") : "";
  const search =
    q && q.length > 0
      ? or(
          sql`lower(translate(${schema.contact.name}, ${UNACCENT_FROM}, ${UNACCENT_TO}))
              like ${`%${qLike}%`}`,
          // Un dígito suelto barrería el directorio entero: mínimo 3.
          qDigits.length >= 3
            ? sql`regexp_replace(coalesce(${schema.contact.phone}, ''), '\\D', '', 'g')
                  like ${`%${qDigits}%`}`
            : undefined
        )
      : undefined;

  // El filtro de etapa se aplica ANTES del límite: si no, un contacto de la
  // etapa buscada podría quedar fuera por el corte de 200.
  const stageContactIds = stage
    ? leadStages.filter((r) => r.stageName === stage).map((r) => r.contactId)
    : null;
  if (stageContactIds?.length === 0) return Response.json({ contacts: [] });

  const rows = await db
    .select()
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        session.organizationId,
        search,
        stageContactIds ? inArray(schema.contact.id, stageContactIds) : undefined
      )
    )
    .orderBy(desc(schema.contact.updatedAt))
    .limit(200);

  const contacts = rows
    .filter((c) => includeArchived || !c.archivedAt)
    .map((c) =>
      serializeContact(
        c,
        stageByContact.get(c.id) ?? null,
        priorityByContact.get(c.id) ?? null
      )
    );
  return Response.json({ contacts });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /**
   * EXIGE código de país. Un número local crearía un contacto que jamás casaría
   * con los mensajes entrantes —Meta siempre manda la identidad completa— y el
   * dueño acabaría con dos fichas de la misma persona. No se asume un país:
   * diez dígitos son válidos en varios, y asumir mal produce un número
   * silenciosamente equivocado.
   */
  phone: z
    .string()
    .trim()
    .regex(/^\d{7,15}$/, "Teléfono en dígitos, con código de país (ej. 5215512345678)"),
  notes: z.string().max(4000).optional(),
  source: z.enum(["anuncio", "organico", "referido", "conocido", "otro"]).optional(),
  /** Etapa inicial del lead; si no viene, la primera abierta del tablero. */
  stageId: z.string().min(1).optional(),
});

export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  const result = await createManualContact({
    organizationId: session.organizationId,
    userId: session.userId,
    ...body.data,
  });
  if (!result.ok && result.reason === "duplicate") {
    return apiError(409, "duplicate", "Ya existe un contacto con ese teléfono");
  }
  if (!result.ok && result.reason === "uncertain") {
    return apiError(503, "create_uncertain", "No se pudo confirmar el alta del contacto");
  }
  if (!result.ok) {
    return apiError(
      422,
      "no_stage",
      "El tablero no tiene etapas abiertas donde colocar al prospecto"
    );
  }

  return Response.json(
    { contact: result.contact, lead: { id: result.leadId } },
    { status: 201 }
  );
});
