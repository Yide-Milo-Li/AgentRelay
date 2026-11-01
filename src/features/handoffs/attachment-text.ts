import { IMAGE_LIMITS } from "@/shared/contracts/attachments";
import type { Dict } from "@/shared/i18n/messages";
import type { ImageProblem } from "./hooks/use-attachment-uploads";

const grouped = (value: number, locale: string) => new Intl.NumberFormat(locale).format(value);

/** One sentence, in the interface language, that says what is wrong with an image and by how much. */
export function describeImageProblem(problem: ImageProblem, t: Dict, locale: string, errorText: (error: unknown) => string): string {
  const reason = t.images.reason;
  if (problem.kind === "tooMany") return reason.tooMany(IMAGE_LIMITS.maxImages);
  if (problem.kind === "unreadable") return reason.unreadable;
  if (problem.kind === "server") return errorText(problem.error);
  const { values } = problem;
  switch (problem.reason) {
    case "unsupported": return reason.unsupported;
    case "animated": return reason.animated;
    case "empty": return reason.empty;
    case "too_large_bytes": {
      const unit = locale.startsWith("zh") ? "字节" : "bytes";
      return reason.tooLarge(`${grouped(values.bytes ?? 0, locale)} ${unit}`, `${grouped(IMAGE_LIMITS.maxBytes, locale)} ${unit}`);
    }
    case "too_wide": return reason.tooWide(values.width ?? 0, values.height ?? 0, grouped(values.edge ?? 0, locale), grouped(IMAGE_LIMITS.maxEdge, locale));
    case "too_many_pixels": return reason.tooManyPixels(values.width ?? 0, values.height ?? 0, grouped(values.pixels ?? 0, locale), grouped(IMAGE_LIMITS.maxPixels, locale));
    default: return reason.corrupt;
  }
}
