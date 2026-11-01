import { runLocalPreview } from "../../tooling/environment/run-local-preview.mjs";
import { startStorageFixtureServer } from "./storage-fixture-server.mjs";

await runLocalPreview({ onReady: async preview => {
  const fixtures = await startStorageFixtureServer({ token: process.env.AGENTRELAY_TEST_FIXTURE_TOKEN,
    getD1Database: preview.getD1Database, getR2Bucket: preview.getR2Bucket });
  // Only the non-secret address is announced; the per-process credential travels through the environment.
  console.log(`Local storage fixtures ready on ${fixtures.url}`);
  return fixtures.close;
} });
