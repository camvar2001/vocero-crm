/** Keep a queued turn tied to the inbound message that created its durable job. */
export function messagesThroughTelegramTrigger<T extends { id: string }>(messages: T[], triggerMessageId: string): T[] {
  const triggerIndex = messages.findIndex((message) => message.id === triggerMessageId);
  return triggerIndex < 0 ? [] : messages.slice(0, triggerIndex + 1);
}
