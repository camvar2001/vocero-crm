import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stages: [] as Array<{ id: string }>,
  leads: [] as Array<{ id: string; stageId: string }>,
  insertedContacts: [] as Array<Record<string, unknown>>,
  createLead: vi.fn(),
}));

vi.mock("@/server/inbox/lead-activity", () => ({
  createLeadForContact: state.createLead,
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  const builder = (table?: unknown) => {
    const query: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ["from", "where", "orderBy"]) {
      query[method] = (...args: unknown[]) => {
        if (method === "from") return builder(args[0]);
        return query;
      };
    }
    query.limit = () => Promise.resolve(table === original.schema.pipelineStage ? state.stages : state.leads);
    return query;
  };
  return {
    ...original,
    getDb: () => ({
      select: () => builder(),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              state.insertedContacts.push(value);
              return [{ ...value, archivedAt: null, ficha: {}, createdAt: new Date(), updatedAt: new Date() }];
            },
          }),
        }),
      }),
    }),
  };
});

describe("preflight de etapa al crear un contacto manual", () => {
  beforeEach(() => {
    state.stages = [];
    state.leads = [];
    state.insertedContacts = [];
    state.createLead.mockReset();
  });

  it("sin etapa abierta devuelve no_stage antes de insertar el contacto", async () => {
    const { createManualContact } = await import("@/server/contacts");

    const result = await createManualContact({
      organizationId: "org_a",
      userId: "usr_owner",
      name: "Ana Solís",
      phone: "59170000000",
    });

    expect(result).toEqual({ ok: false, reason: "no_stage" });
    expect(state.insertedContacts).toHaveLength(0);
    expect(state.createLead).not.toHaveBeenCalled();
  });

  it("usa una etapa abierta del mismo tenant antes de guardar el contacto", async () => {
    state.stages = [{ id: "stg_open" }];
    state.createLead.mockResolvedValue({ id: "ld_1", stageId: "stg_open" });
    const { createManualContact } = await import("@/server/contacts");

    const result = await createManualContact({
      organizationId: "org_a",
      userId: "usr_owner",
      name: "Ana Solís",
      phone: "59170000000",
    });

    expect(result.ok).toBe(true);
    expect(state.insertedContacts).toHaveLength(1);
    expect(state.createLead).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org_a",
      stageId: "stg_open",
      actorUserId: "usr_owner",
    }));
  });
});
