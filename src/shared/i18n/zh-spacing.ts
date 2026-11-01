/**
 * A name placed in Chinese text, spaced from the characters around it only where it begins or ends with a Latin letter
 * or digit, as Chinese typesetting does ("在 Laptop 上", "在笔记本上"). Pass `before` or `after` as false next to
 * punctuation, which never takes a space.
 */
export function around(name: string, { before = true, after = true }: { before?: boolean; after?: boolean } = {}) {
  const latin = /[A-Za-z0-9]/;
  return `${before && latin.test(name.charAt(0)) ? " " : ""}${name}${after && latin.test(name.charAt(name.length - 1)) ? " " : ""}`;
}
