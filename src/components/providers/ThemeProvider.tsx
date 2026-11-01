"use client";

import { ThemeProvider as NextThemeProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // next-themes restores the preference before paint and follows OS changes only in system mode.
  return <NextThemeProvider attribute="data-theme" storageKey="agentrelay-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
    {children}
  </NextThemeProvider>;
}
