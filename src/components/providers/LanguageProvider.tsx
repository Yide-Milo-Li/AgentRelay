"use client";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { LANG_COOKIE, htmlLang, type Lang } from "@/shared/i18n/locale";
import { dictionaries, type Dict } from "@/shared/i18n/messages";
import { describeError } from "@/shared/i18n/describe-error";

type Ctx = { lang: Lang; t: Dict; locale: string; setLang: (lang: Lang) => void; errorText: (error: unknown) => string };
const LangContext = createContext<Ctx | null>(null);

export function LangProvider({ initial, children }: { initial: Lang; children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    document.documentElement.lang = htmlLang(next);
    // A cookie lets the server render the chosen language on the next load without a flash.
    document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }, []);
  const value = useMemo<Ctx>(() => ({
    lang, t: dictionaries[lang], locale: lang === "zh" ? "zh-CN" : "en-GB", setLang,
    errorText: (error: unknown) => describeError(error, lang),
  }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used inside LangProvider");
  return ctx;
}
