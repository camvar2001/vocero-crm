import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getSessionOrNull } from "@/lib/auth/session";
import { normalizeThemePreference, THEME_COOKIE } from "@/lib/theme";
import { getBranding } from "@/server/branding";
import { AppShell } from "@/components/app-shell";
import { resolveCommit } from "@/lib/version";
import { agendaEnabled } from "@/server/agenda/flag";
import { inmobEnabled } from "@/server/inmob/flag";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  const branding = await getBranding(session.organizationId);
  const authSession = await getAuth().api.getSession({
    headers: await headers(),
  });
  const theme = normalizeThemePreference(
    (await cookies()).get(THEME_COOKIE)?.value
  );

  return (
    <AppShell
      branding={branding}
      userName={authSession?.user.name ?? "Usuario"}
      role={session.role}
      theme={theme}
      // Se resuelve aquí, en el servidor: el cliente no ve `SOURCE_COMMIT`.
      // Baja con su procedencia, para que la insignia no presente como
      // verificado un commit que no salió del build (#50).
      commit={resolveCommit()}
      // Qué módulos opcionales existen se decide en el servidor y baja por
      // prop, igual que los canales de la Bandeja. El nav es un componente de
      // cliente: no puede —ni debe— leer variables de entorno.
      agenda={agendaEnabled()}
      inmob={
        inmobEnabled() &&
        session.role === "owner" &&
        Boolean(process.env.INMOB_OWNER_USER_ID?.trim()) &&
        session.userId === process.env.INMOB_OWNER_USER_ID?.trim()
      }
    >
      {children}
    </AppShell>
  );
}
