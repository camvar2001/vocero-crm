import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REQUEST_ID = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const ENV = {
  baseUrl: process.env.INMOB_N8N_BASE_URL,
  token: process.env.INMOB_N8N_TOKEN,
};

function payload(agent: "buscador" | "secretaria" = "buscador") {
  return {
    version: 1 as const,
    requestId: REQUEST_ID,
    agent,
    sessionId: "vocero_inmob:org_primary:usr_owner:buscador:iwc_1",
    organizationId: "org_primary",
    userId: "usr_owner",
    advisorId: "fixture_1",
    advisorPhone: "+59170000000",
    message: "Busco una casa",
    history: [],
  };
}

function completed(agent: "buscador" | "secretaria" = "buscador", requestId = REQUEST_ID) {
  return {
    version: 1,
    requestId,
    agent,
    status: "completed",
    reply: "Encontré una opción.",
    results: [{ title: "Casa central", url: "https://century21.example/listing/1", source: "catálogo" }],
  };
}

describe("cliente del gateway web", () => {
  beforeEach(() => {
    process.env.INMOB_N8N_BASE_URL = "https://century21-dev.intersim.cloud";
    process.env.INMOB_N8N_TOKEN = "unit-test-token";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ENV.baseUrl === undefined) delete process.env.INMOB_N8N_BASE_URL;
    else process.env.INMOB_N8N_BASE_URL = ENV.baseUrl;
    if (ENV.token === undefined) delete process.env.INMOB_N8N_TOKEN;
    else process.env.INMOB_N8N_TOKEN = ENV.token;
  });

  it("sends one authenticated HTTPS POST to the fixed dev gateway without following redirects", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(completed()), { status: 200, headers: { "content-type": "application/json" } })
    );
    const { postInmobGateway } = await import("@/server/inmob/client");

    await postInmobGateway(payload());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://century21-dev.intersim.cloud/webhook/vocero-inmob-chat-v1");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("X-Vocero-Inmob-Token")).toBe("unit-test-token");
    expect(JSON.parse(String(init.body))).toMatchObject({ requestId: REQUEST_ID, agent: "buscador" });
  });

  it.each([
    "http://century21-dev.intersim.cloud",
    "https://century21-dev.intersim.cloud.attacker.example",
    "https://century21.intersim.cloud",
    "https://user:pass@century21-dev.intersim.cloud",
    "https://century21-dev.intersim.cloud/?next=https://attacker.example",
  ])("refuses an unapproved gateway URL before making a request: %s", async (baseUrl) => {
    process.env.INMOB_N8N_BASE_URL = baseUrl;
    const fetchMock = vi.mocked(fetch);
    const { postInmobGateway } = await import("@/server/inmob/client");

    await expect(postInmobGateway(payload())).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a redirect as an error and never follows its Location", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } })
    );
    const { postInmobGateway } = await import("@/server/inmob/client");

    await expect(postInmobGateway(payload())).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a response whose requestId or agent does not match the submitted turn", async () => {
    const fetchMock = vi.mocked(fetch);
    const { postInmobGateway } = await import("@/server/inmob/client");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(completed("buscador", "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2")), { status: 200 }));
    await expect(postInmobGateway(payload())).rejects.toBeDefined();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(completed("secretaria")), { status: 200 }));
    await expect(postInmobGateway(payload())).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts a valid result without a public listing URL or with an HTTPS URL", async () => {
    const noUrl = { title: "Casa central", source: "catálogo" };
    const withUrl = { ...noUrl, url: "https://century21.example/listing/1" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...completed(), results: [noUrl] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...completed(), results: [withUrl] }), { status: 200 }));
    const { postInmobGateway } = await import("@/server/inmob/client");

    await expect(postInmobGateway(payload())).resolves.toMatchObject({ results: [noUrl] });
    await expect(postInmobGateway(payload())).resolves.toMatchObject({ results: [withUrl] });
  });

  it("rejects a provided result URL that is not HTTP or HTTPS", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      ...completed(),
      results: [{ title: "Casa central", source: "catálogo", url: "javascript:alert(1)" }],
    }), { status: 200 }));
    const { postInmobGateway } = await import("@/server/inmob/client");

    await expect(postInmobGateway(payload())).rejects.toBeDefined();
  });

  it("accepts a Secretaria tool request only with the strict discriminated fields", async () => {
    const toolRequest = {
      version: 1,
      requestId: REQUEST_ID,
      agent: "secretaria",
      status: "tool_request",
      toolCallId: "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3",
      tool: { name: "agenda_availability", arguments: {} },
    };
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(toolRequest), { status: 200 }));
    const { postInmobGateway } = await import("@/server/inmob/client");

    await expect(postInmobGateway(payload("secretaria"))).resolves.toMatchObject({ status: "tool_request", tool: { name: "agenda_availability" } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects tool requests from Buscador and unknown gateway states", async () => {
    const fetchMock = vi.mocked(fetch);
    const { postInmobGateway } = await import("@/server/inmob/client");
    const request = {
      version: 1,
      requestId: REQUEST_ID,
      agent: "buscador",
      status: "tool_request",
      toolCallId: "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3",
      tool: { name: "contact_search", arguments: { query: "María" } },
    };

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(request), { status: 200 }));
    await expect(postInmobGateway(payload())).rejects.toBeDefined();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...completed(), status: "started" }), { status: 200 }));
    await expect(postInmobGateway(payload())).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects responses larger than 256 KiB", async () => {
    const largeReply = { ...completed(), reply: "x".repeat(256 * 1024) };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(largeReply), { status: 200 }));
    const { postInmobGateway } = await import("@/server/inmob/client");

    await expect(postInmobGateway(payload())).rejects.toBeDefined();
  });

  it("does not retry POST after a gateway failure or timeout", async () => {
    const fetchMock = vi.mocked(fetch).mockRejectedValue(new Error("socket timeout"));
    const { postInmobGateway } = await import("@/server/inmob/client");

    await expect(postInmobGateway(payload())).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
