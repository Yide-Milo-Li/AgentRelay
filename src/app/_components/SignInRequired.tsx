import type { SignInProblem } from "@/shared/contracts/workspace";
import type { Lang } from "@/shared/i18n/locale";
import { dictionaries } from "@/shared/i18n/messages";

/**
 * Shown by a standalone deployment that has nobody to render for: Access is not in front of this route, its settings
 * are missing, or its signing keys can't be reached.
 */
export default function SignInRequired({ lang, problem }: { lang: Lang; problem: SignInProblem }) {
  const t = dictionaries[lang].signInRequired[problem];
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-lg font-semibold">{t.title}</h1>
        <p className="text-sm text-muted-foreground">{t.body}</p>
      </div>
    </main>
  );
}
