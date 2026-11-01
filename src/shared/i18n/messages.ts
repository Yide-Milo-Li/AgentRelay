import { en, type Dict } from "./en";
import { zh } from "./zh";
import type { Lang } from "./locale";

export type { Dict };
export const dictionaries: Record<Lang, Dict> = { en, zh };
