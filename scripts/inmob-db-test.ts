import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, getSql, schema } from "@/lib/db";
import { createPostgresInmobRepository } from "@/server/inmob/service";

// CI only: refuses every database except the explicitly named isolated fixture.
const url = new URL(process.env.DATABASE_URL ?? "");
assert.equal(url.hostname, "localhost");
assert.equal(url.pathname, "/inmob_ci");
assert.equal(process.env.INMOB_DB_TEST, "isolated-ci");
const db = getDb();
const repo = createPostgresInmobRepository();
let checks = 0;
function check(condition: unknown, label: string) {
  assert.ok(condition, label);
  checks++;
  console.log(`OK ${label}`);
}
const a = { organizationId: "inmob_ci_org_a", userId: "inmob_ci_user_a" };
const b = { organizationId: "inmob_ci_org_b", userId: "inmob_ci_user_b" };
const now = new Date();
try {
  for (const [index, identity] of [a, b].entries()) {
    await db.insert(schema.organization).values({ id: identity.organizationId, name: `Fixture ${index}` });
    await db.insert(schema.user).values({ id: identity.userId, name: `Fixture ${index}`, email: `fixture-${index}@example.invalid` });
  }
  const chatA = await repo.getChat({ ...a, agent: "buscador" });
  const chatB = await repo.getChat({ ...b, agent: "buscador" });
  check(chatA.id !== chatB.id, "tenant chats are distinct");
  const secretariat = await repo.getChat({ ...a, agent: "secretaria" });
  check(secretariat.id !== chatA.id, "agents have separate chats");

  const requests = Array.from({ length: 16 }, () => randomUUID());
  const raced = await Promise.all(requests.map((requestId) => repo.claimTurn({ ...a, agent: "buscador", requestId, message: "Race fixture", now })));
  check(raced.filter((r) => r.kind === "claimed").length === 1, "sixteen concurrent sends have exactly one durable claim");
  check(raced.filter((r) => r.kind === "chat_busy").length === 15, "losing requests do not create executable turns");
  const winnerIndex = raced.findIndex((r) => r.kind === "claimed");
  const winner = raced[winnerIndex];
  assert.equal(winner.kind, "claimed");
  if (winner.kind !== "claimed") throw new Error("claim missing");
  const requestId = requests[winnerIndex];
  check((await repo.claimTurn({ ...a, agent: "buscador", requestId, message: "Race fixture", now })).kind === "existing", "request replay returns previous claim");
  check((await repo.claimTurn({ ...a, agent: "secretaria", requestId, message: "Race fixture", now })).kind === "conflict", "same ID cannot switch agent");
  check((await repo.claimTurn({ ...a, agent: "buscador", requestId, message: "Changed fixture", now })).kind === "conflict", "same ID cannot change message");
  check(await repo.findTurn({ ...b, requestId }) === null, "other tenant cannot read turn by request ID");
  await assert.rejects(repo.readChat({ ...b, chatId: chatA.id }));
  checks++;

  const action = { ...a, turnId: winner.turnId, toolCallId: randomUUID(), name: "contact_create", inputHash: "fixture-hash", now };
  const toolRaced = await Promise.all(Array.from({ length: 12 }, () => repo.claimToolAction(action)));
  check(toolRaced.filter((r) => r.kind === "claimed").length === 1, "twelve concurrent tool requests have one effect claim");
  check(toolRaced.filter((r) => r.kind === "uncertain").length === 11, "running tool replay cannot reexecute");
  const toolWinner = toolRaced.find((r) => r.kind === "claimed");
  assert.ok(toolWinner && toolWinner.kind === "claimed");
  if (!toolWinner || toolWinner.kind !== "claimed") throw new Error("tool claim missing");
  const result = { toolCallId: action.toolCallId, name: "contact_create" as const, ok: true, result: { contactId: "fixture-contact" } };
  await repo.finishToolAction({ ...a, actionId: toolWinner.actionId, result, now });
  const replay = await repo.claimToolAction(action);
  check(replay.kind === "existing", "completed tool returns stored result");
  if (replay.kind === "existing") assert.deepEqual(replay.result, result);
  check((await repo.claimToolAction({ ...action, inputHash: "different" })).kind === "conflict", "tool ID with different inputs is rejected");
  await repo.markToolActionUncertain({ ...a, actionId: toolWinner.actionId, now });
  check((await repo.claimToolAction(action)).kind === "existing", "late uncertainty does not overwrite completed tool");

  await repo.completeTurn({ ...a, turnId: winner.turnId, reply: "Fixture complete", results: [], now });
  await repo.markTurnUncertain({ ...a, turnId: winner.turnId, errorCode: "late", now });
  check((await repo.findTurn({ ...a, requestId }))?.status === "completed", "late timeout does not overwrite completion");
  check((await repo.listHistory({ ...b, chatId: chatA.id, limit: 20 })).length === 0, "history query cannot cross tenant");

  const expiredId = randomUUID();
  const old = new Date(now.getTime() - 120_000);
  const expired = await repo.claimTurn({ ...a, agent: "buscador", requestId: expiredId, message: "Lost response fixture", now: old });
  assert.equal(expired.kind, "claimed");
  check(await repo.expireRunningTurns({ ...a, chatId: chatA.id, before: new Date(now.getTime() - 60_000) }) === 1, "restart recovery expires only running claim");
  check((await repo.claimTurn({ ...a, agent: "buscador", requestId: expiredId, message: "Lost response fixture", now })).kind === "existing", "expired request is never reclaimed");
  check((await repo.findTurn({ ...a, requestId: expiredId }))?.status === "uncertain", "expired outcome remains uncertain");
  if (expired.kind === "claimed") {
    await assert.rejects(repo.completeTurn({ ...a, turnId: expired.turnId, reply: "Late fixture", results: [], now }));
    checks++;
  }
  const visible = await repo.readChat({ ...a, chatId: chatA.id });
  check(visible.turns.length === 2, "history contains only winner and uncertain request");
  console.log(`PostgreSQL integration: ${checks} checks passed`);
} finally {
  await getSql().end();
}
