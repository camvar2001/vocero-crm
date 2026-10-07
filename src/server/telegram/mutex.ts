import { getSql } from "@/lib/db";

const globalForTelegramLocks = globalThis as unknown as {
  __telegramBotLocks?: Map<string, Promise<void>>;
};

function locks(): Map<string, Promise<void>> {
  return (globalForTelegramLocks.__telegramBotLocks ??= new Map());
}

/** In-process serialization for Bot API sends and connection mutations. */
export async function withTelegramBotLock<T>(botId: string, operation: () => Promise<T>): Promise<T> {
  const map = locks();
  const previous = map.get(botId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  map.set(botId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (map.get(botId) === tail) map.delete(botId);
  }
}

/** Persist human takeover before waiting behind an in-flight Bot API request. */
export async function withTelegramManualTakeover<T>(takeover: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  await takeover();
  return operation();
}

/** Cross-process fence shared by Telegram sends and settings mutations. */
export async function withTelegramOperationLock<T>(botId: string, operation: () => Promise<T>): Promise<T> {
  const session = await getSql().reserve();
  const lockKey = `telegram-operation:${botId}`;
  let acquired = false;
  try {
    await session.unsafe("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    acquired = true;
    return await operation();
  } finally {
    if (acquired) {
      try {
        await session.unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      } catch {
        // Releasing the reserved session also releases its advisory lock.
      }
    }
    session.release();
  }
}
