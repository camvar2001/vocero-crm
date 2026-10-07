import { getSql } from "@/lib/db";
import { isChannelEnabled } from "@/server/channels/enabled";
import { getTelegramCredentialsByOrg, listConnectedTelegramOrganizations, advanceTelegramCursor, updateTelegramState } from "@/server/telegram/credentials";
import { TelegramApiError, TelegramClient } from "@/server/telegram/client";
import { ingestTelegramUpdate, TelegramIngestPausedError } from "@/server/telegram/ingest";
import { scheduleTelegramAgentWork, schedulePendingTelegramAgentWork, recoverTelegramAgentWork } from "@/server/telegram/agent-work";
import { recoverOrphanedTelegramDeliveries } from "@/server/telegram/delivery";
import type { TelegramCredentials } from "@/server/telegram/credentials";

type LockSession = Awaited<ReturnType<ReturnType<typeof getSql>["reserve"]>>;
type PollerHandle = { stop: () => Promise<void>; done: Promise<void> };

const globalForTelegram = globalThis as unknown as {
  __telegramPollers?: Map<string, PollerHandle>;
};

function pollers(): Map<string, PollerHandle> {
  return (globalForTelegram.__telegramPollers ??= new Map());
}

export function telegramBackoffMs(attempt: number, retryAfterSeconds?: number | null): number {
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(24 * 60 * 60 * 1000, Math.ceil(retryAfterSeconds) * 1000);
  }
  return Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, Math.trunc(attempt))));
}

export function isTelegramPollerCredentialsCurrent(
  started: TelegramCredentials,
  current: TelegramCredentials | null,
): current is TelegramCredentials {
  return Boolean(current?.connected
    && current.token
    && current.botId === started.botId
    && current.token === started.token
    && current.allowedUserIds.length === started.allowedUserIds.length
    && current.allowedUserIds.every((id, index) => id === started.allowedUserIds[index]));
}

export function startTelegramPoller(credentials: TelegramCredentials): PollerHandle | null {
  if (!isChannelEnabled("telegram") || !credentials.token || !credentials.connected || !credentials.allowedUserIds.length) return null;
  const active = pollers().get(credentials.botId);
  if (active) return active;
  const controller = new AbortController();
  const stop = async () => {
    controller.abort();
    await activeHandle?.done;
  };
  const done = runPoller(credentials, controller.signal)
    .finally(() => pollers().delete(credentials.botId));
  const activeHandle: PollerHandle = { stop, done };
  pollers().set(credentials.botId, activeHandle);
  return activeHandle;
}

export async function startTelegramPollers(): Promise<void> {
  if (!isChannelEnabled("telegram")) return;
  const organizations = await listConnectedTelegramOrganizations();
  for (const organizationId of organizations) {
    const credentials = await getTelegramCredentialsByOrg(organizationId);
    if (credentials?.connected && credentials.token) startTelegramPoller(credentials);
  }
}

export async function stopTelegramPollers(): Promise<void> {
  await Promise.all([...pollers().values()].map((handle) => handle.stop()));
}

export async function stopTelegramPoller(botId: string): Promise<void> {
  const handle = pollers().get(botId);
  if (handle) await handle.stop();
}

/** Wait for any poller in another Node process to release the bot's DB session lock. */
export async function withTelegramSessionLock<T>(botId: string, operation: () => Promise<T>): Promise<T> {
  const lock = await getSql().reserve();
  let acquired = false;
  try {
    await lock.unsafe("select pg_advisory_lock(hashtextextended($1, 0))", [botId]);
    acquired = true;
    return await operation();
  } finally {
    if (acquired) {
      try {
        await lock.unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [botId]);
      } catch {
        // Releasing the reserved session also releases its session lock.
      }
    }
    lock.release();
  }
}

async function runPoller(
  credentials: TelegramCredentials,
  signal: AbortSignal,
): Promise<void> {
  let lock: LockSession | null = null;
  const organizationId = credentials.organizationId;
  try {
    lock = await getSql().reserve();
    const lockRows = await lock.unsafe<{ locked: boolean }[]>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [credentials.botId],
    );
    if (!lockRows[0]?.locked) {
      await updateTelegramState(organizationId, { status: "conflict", lastErrorCode: "consumer_conflict", connected: false });
      return;
    }

    const startupCredentials = await getTelegramCredentialsByOrg(organizationId);
    if (!isTelegramPollerCredentialsCurrent(credentials, startupCredentials)) return;
    const client = new TelegramClient(startupCredentials.token!);
    await recoverOrphanedTelegramDeliveries(organizationId);
    await recoverTelegramAgentWork(startupCredentials);
    await schedulePendingTelegramAgentWork(startupCredentials);
    await updateTelegramState(organizationId, { status: "connected", lastErrorCode: null });
    let offset = startupCredentials.nextUpdateId ? Number(startupCredentials.nextUpdateId) : null;
    if (offset !== null && !Number.isSafeInteger(offset)) {
      await updateTelegramState(organizationId, { status: "error", lastErrorCode: "invalid_cursor" });
      return;
    }
    let attempt = 0;
    while (!signal.aborted) {
      try {
        // The dedicated connection owns the session lock. A dead/evicted
        // connection must stop this consumer before it starts another poll.
        await lock.unsafe("select 1");
        const activeCredentials = await getTelegramCredentialsByOrg(organizationId);
        if (!isTelegramPollerCredentialsCurrent(credentials, activeCredentials)) break;
        const requestSignal = combineAbortSignals(signal, AbortSignal.timeout(25_000));
        const updates = await client.getUpdates(offset, requestSignal);
        let stillConnected = true;
        for (const update of updates) {
          if (signal.aborted) break;
          const latest = await getTelegramCredentialsByOrg(organizationId);
          if (!isTelegramPollerCredentialsCurrent(credentials, latest)) {
            stillConnected = false;
            break;
          }
          if (update.update_id >= Number.MAX_SAFE_INTEGER) {
            await updateTelegramState(organizationId, { status: "error", lastErrorCode: "invalid_update_id" });
            return;
          }
          const result = await ingestTelegramUpdate(latest, update.update_id, update.message);
          if (result.jobId) void scheduleTelegramAgentWork(latest, result.jobId);
          offset = update.update_id + 1;
          await advanceTelegramCursor(organizationId, String(offset));
        }
        if (!stillConnected) break;
        attempt = 0;
        if (updates.length === 0) await updateTelegramState(organizationId, { status: "connected", lastErrorCode: null });
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof TelegramIngestPausedError) break;
        if (error instanceof TelegramApiError && error.code === "unauthorized") {
          await updateTelegramState(organizationId, { connected: false, status: "error", lastErrorCode: "invalid_token" });
          return;
        }
        if (error instanceof TelegramApiError && error.code === "conflict") {
          await updateTelegramState(organizationId, { connected: false, status: "conflict", lastErrorCode: "consumer_conflict" });
          return;
        }
        const retryAfter = error instanceof TelegramApiError && error.code === "rate_limited"
          ? error.retryAfterSeconds
          : null;
        const code = error instanceof TelegramApiError ? error.code : "poll_failed";
        await updateTelegramState(organizationId, { status: "error", lastErrorCode: code });
        await wait(telegramBackoffMs(attempt++, retryAfter), signal);
      }
    }
  } catch {
    if (!signal.aborted) {
      await updateTelegramState(organizationId, { status: "error", lastErrorCode: "poller_unavailable" }).catch(() => {});
    }
  } finally {
    if (lock) {
      try {
        await lock.unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [credentials.botId]);
      } catch {
        // Closing the dedicated connection also releases its session lock.
      }
      lock.release();
    }
  }
}

function combineAbortSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  return AbortSignal.any([first, second]);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
