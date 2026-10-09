import { notFound, redirect } from "next/navigation";
import { InmobChatClient } from "@/components/inmob/chat-client";
import { getSessionOrNull } from "@/lib/auth/session";
import { INMOB_AGENTS, type InmobAgent } from "@/lib/inmob";
import { inmobEnabled } from "@/server/inmob/flag";

export const dynamic = "force-dynamic";

export default async function InmobChatPage({
  params,
}: {
  params: Promise<{ agent: string }>;
}) {
  const { agent: value } = await params;
  if (!inmobEnabled() || !INMOB_AGENTS.includes(value as InmobAgent)) notFound();

  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  const ownerId = process.env.INMOB_OWNER_USER_ID?.trim();
  if (session.role !== "owner" || !ownerId || session.userId !== ownerId) notFound();

  return <InmobChatClient agent={value as InmobAgent} />;
}
