// Shared by server and client code, so it must stay free of React and "use client".
export type Lang = "en" | "zh";
export const LANG_COOKIE = "agentrelay_lang";
export const DEFAULT_LANG: Lang = "en";

export function parseLang(value: string | undefined | null): Lang {
  return value === "zh" ? "zh" : DEFAULT_LANG;
}

export function htmlLang(lang: Lang) {
  return lang === "zh" ? "zh-CN" : "en";
}
