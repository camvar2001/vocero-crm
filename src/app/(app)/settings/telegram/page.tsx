import { notFound } from "next/navigation";
import { TelegramClient } from "@/components/settings/telegram-client";
import { isChannelEnabled } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default function TelegramSettingsPage() {
  if (!isChannelEnabled("telegram")) notFound();
  return <TelegramClient />;
}
