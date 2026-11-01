import type { Metadata } from "next";
import { cookies } from "next/headers";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@/app/globals.css";
import { LANG_COOKIE, htmlLang, parseLang } from "@/shared/i18n/locale";
import { ThemeProvider } from "@/components/providers/ThemeProvider";

export const metadata: Metadata = {
  title: "AgentRelay · Cross-device prompt handoff",
  description: "Save a prompt, switch devices, keep working. A private handoff box for you and your agents.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const lang = parseLang((await cookies()).get(LANG_COOKIE)?.value);
  return (
    <html lang={htmlLang(lang)} suppressHydrationWarning>
      <body className="antialiased"><ThemeProvider>{children}</ThemeProvider></body>
    </html>
  );
}
