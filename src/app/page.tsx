import { cookies } from "next/headers";
import { requireChatGPTUser } from "@/server/auth";
import AgentRelayApp from "@/app/_components/AgentRelayApp";
import { LANG_COOKIE, parseLang } from "@/shared/i18n/locale";
export const dynamic = "force-dynamic";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireChatGPTUser("/");
  const { handoff, view } = await searchParams;
  const lang = parseLang((await cookies()).get(LANG_COOKIE)?.value);
  return <AgentRelayApp displayName={user.fullName} initialLang={lang} initialHandoff={typeof handoff === "string" && handoff ? handoff : null} initialView={view === "agent" ? "agent" : null} />;
}
