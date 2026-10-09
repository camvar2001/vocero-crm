import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true,
  ownerId: "usr_owner",
  session: { userId: "usr_owner", organizationId: "org_primary", role: "owner" } as
    | { userId: string; organizationId: string; role: string }
    | null,
  getChat: vi.fn(async () => ({ chatId: "iwc_1", agent: "buscador", turns: [] })),
  submit: vi.fn(async (input: Record<string, unknown>) => ({
    statusCode: 200,
    body: {
      chatId: "iwc_1",
      agent: String(input.agent),
      turn: {
        requestId: String(input.requestId),
        message: String(input.message),
        reply: "Respuesta",
        status: "completed",
        errorCode: null,
        results: [],
        createdAt: "2026-10-08T12:00:00.000Z",
      },
    },
  })),
}));

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => {
    if (!state.session) throw new Error("unauthorized");
    return state.session;
  },
}));
vi.mock("@/server/inmob/flag", () => ({
  inmobEnabled: () => state.enabled,
  inmobDisabledResponse: () => new Response(null, { status: 404 }),
}));
vi.mock("@/server/inmob/service", () => ({
  getInmobChat: state.getChat,
  submitInmobMessage: state.submit,
}));

const { GET, POST } = await import("@/app/api/inmob/chats/[agent]/route");
const OWNER_ENV = process.env.INMOB_OWNER_USER_ID;

function request(method: "GET" | "POST", body?: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/inmob/chats/buscador", {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const route = { params: Promise.resolve({ agent: "buscador" }) };

async function responseBody(response: Response) {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

describe("INMOB chat API authorization and input contract", () => {
  beforeEach(() => {
    state.enabled = true;
    state.ownerId = "usr_owner";
    state.session = { userId: "usr_owner", organizationId: "org_primary", role: "owner" };
    state.getChat.mockClear();
    state.submit.mockClear();
    process.env.INMOB_OWNER_USER_ID = state.ownerId;
  });

  it("returns indistinguishable 404s while the module is disabled", async () => {
    state.enabled = false;
    state.session = null;
    expect((await GET(request("GET"), route)).status).toBe(404);
    expect((await POST(request("POST", { requestId: "x", message: "hola" }), route)).status).toBe(404);
  });

  it("requires an authenticated session and returns 401 for anonymous access", async () => {
    state.session = null;
    expect((await GET(request("GET"), route)).status).toBe(401);
  });

  it("allows only the exact configured owner identity", async () => {
    state.session = { userId: "usr_member", organizationId: "org_primary", role: "owner" };
    expect((await GET(request("GET"), route)).status).toBe(403);
    state.session = { userId: "usr_owner", organizationId: "org_primary", role: "member" };
    expect((await GET(request("GET"), route)).status).toBe(403);
    expect(state.getChat).not.toHaveBeenCalled();
  });

  it("rejects POST requests without a same-origin Origin header", async () => {
    expect((await POST(request("POST", { requestId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1", message: "hola" }, ""), route)).status).toBe(403);
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("rejects a foreign Origin even when the request host is valid", async () => {
    expect((await POST(request("POST", { requestId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1", message: "hola" }, "https://attacker.example"), route)).status).toBe(403);
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("accepts exactly the required POST keys and passes session identity from the server", async () => {
    const response = await POST(
      request("POST", { requestId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1", message: "Buscar una casa" }),
      route
    );
    expect(response.status).toBe(200);
    expect(state.submit).toHaveBeenCalledWith(expect.objectContaining({
      agent: "buscador",
      organizationId: "org_primary",
      userId: "usr_owner",
      requestId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
      message: "Buscar una casa",
    }));
    expect(await responseBody(response)).toMatchObject({
      chatId: "iwc_1",
      agent: "buscador",
      turn: { status: "completed", reply: "Respuesta" },
    });
  });

  it("rejects extra identity fields instead of trusting browser-supplied tenant data", async () => {
    const response = await POST(request("POST", {
      requestId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
      message: "hola",
      organizationId: "org_attacker",
      userId: "usr_attacker",
      advisorId: "advisor_attacker",
    }), route);
    expect(response.status).toBe(400);
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("accepts 4000 characters and rejects 4001 characters", async () => {
    const requestId = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
    expect((await POST(request("POST", { requestId, message: "x".repeat(4000) }), route)).status).toBe(200);
    state.submit.mockClear();
    expect((await POST(request("POST", { requestId, message: "x".repeat(4001) }), route)).status).toBe(400);
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("rejects a body larger than 16 KiB before handing it to the service", async () => {
    const tooLarge = JSON.stringify({
      requestId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
      message: "x".repeat(16 * 1024),
    });
    const response = await POST(new Request("http://localhost/api/inmob/chats/buscador", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: tooLarge,
    }), route);
    expect(response.status).toBe(400);
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("keeps Secretaria and Buscador as the only route agents", async () => {
    const badRoute = { params: Promise.resolve({ agent: "admin" }) };
    expect((await GET(request("GET"), badRoute)).status).toBe(404);
    expect(state.getChat).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  if (OWNER_ENV === undefined) delete process.env.INMOB_OWNER_USER_ID;
  else process.env.INMOB_OWNER_USER_ID = OWNER_ENV;
});
