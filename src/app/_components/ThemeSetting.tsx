"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useLang } from "@/components/providers/LanguageProvider";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const OPTIONS = [["system", Monitor], ["light", Sun], ["dark", Moon]] as const;

export default function ThemeSetting() {
  const { t } = useLang();
  const { theme, setTheme } = useTheme();
  // Storage is unavailable during SSR; keep the initial markup stable without hiding the control.
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const preference = mounted && (theme === "light" || theme === "dark") ? theme : "system";
  const labels = { system: t.themeSystem, light: t.themeLight, dark: t.themeDark };

  return <div className="segmented theme-setting" role="group" aria-label={t.theme} data-theme-preference={preference}>
    {OPTIONS.map(([value, Icon]) => <button key={value} type="button" className="theme-option" data-theme-value={value}
      aria-pressed={preference === value} disabled={!mounted} onClick={() => setTheme(value)}>
      <Icon size={14} aria-hidden="true" />{labels[value]}
    </button>)}
  </div>;
}
