const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000], ["month", 30 * 86_400_000], ["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000],
];

/** "3 minutes ago" or "in 12 days", in the viewer's language. Differences under a minute read as "now". */
export function formatRelative(value: number, now: number, locale: string) {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diff = value - now, size = Math.abs(diff);
  const [unit, span] = UNITS.find(([, span]) => size >= span) ?? ["second", 1000];
  if (unit === "second") return format.format(0, "second");
  return format.format(Math.trunc(diff / span), unit);
}
