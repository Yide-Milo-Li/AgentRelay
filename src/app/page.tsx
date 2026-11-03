import { cookies } from "next/headers";
import { pageIdentity } from "@/server/auth";
import AgentRelayApp from "@/app/_components/AgentRelayApp";
import SignInRequired from "@/app/_components/SignInRequired";
import { LANG_COOKIE, parseLang } from "@/shared/i18n/locale";
export const dynamic = "force-dynamic";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const { user, problem } = await pageIdentity("/");
  const lang = parseLang((await cookies()).get(LANG_COOKIE)?.value);
  if (!user) return <SignInRequired lang={lang} problem={problem} />;
  const { handoff, view } = await searchParams;
  return <AgentRelayApp displayName={user.fullName} initialLang={lang} initialHandoff={typeof handoff === "string" && handoff ? handoff : null} initialView={view === "agent" ? "agent" : null} />;
}
