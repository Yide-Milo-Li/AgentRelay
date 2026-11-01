// Plain JavaScript on purpose: the web app (TypeScript) and the device setup scripts (Node) share this one definition.

/** Replace each `{name}` of `values` in every string of a JSON-like value. Only public values belong here, never a secret. */
export function fillValues(value, values) {
  if (typeof value === "string") return Object.entries(values).reduce((text, [name, replacement]) => text.replaceAll(`{${name}}`, replacement), value);
  if (Array.isArray(value)) return value.map((item) => fillValues(item, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillValues(item, values)]));
  return value;
}

/** Replace `{siteUrl}`; the site URL is a public origin, never a secret. */
export const fillSiteUrl = (value, siteUrl) => fillValues(value, { siteUrl });
