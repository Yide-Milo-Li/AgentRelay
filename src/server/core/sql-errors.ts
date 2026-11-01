/** D1 reports constraint failures only through the message, sometimes on the wrapped cause. */
export function isUniqueViolation(error: unknown) {
  const text = [(error as Error)?.message, (error as { cause?: Error })?.cause?.message].join(" ");
  return /UNIQUE constraint failed/i.test(text);
}
