// Stable entrypoint for the built local Worker with development-only body draining.
import { runLocalPreview } from "../tooling/environment/run-local-preview.mjs";
await runLocalPreview();
