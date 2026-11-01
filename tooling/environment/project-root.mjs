import { fileURLToPath } from "node:url";

/** Resolve from this module so tools also work when launched outside the checkout. */
export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
