// Sites identity headers are trustworthy only behind the Sites platform, which strips them from client requests.
// A `cloudflare` build has no such platform in front of it, so its output must not read them at all.
const SITES_IDENTITY_HEADER = "oai-authenticated-user";

export function deploymentTargetGuard(target) {
  return {
    name: "agentrelay-deployment-target-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      if (target !== "cloudflare") return;
      for (const [file, output] of Object.entries(bundle)) {
        // A source map embeds the original source of every module in its chunk's graph, tree-shaken ones included,
        // and executes nothing; only code and other assets the Worker can serve or run are checked.
        if (output.type === "asset" && file.endsWith(".map")) continue;
        const text = output.type === "chunk" ? output.code : typeof output.source === "string" ? output.source : "";
        if (text.includes(SITES_IDENTITY_HEADER)) {
          this.error(`${file} still reads Sites identity headers; a cloudflare build must not contain them.`);
        }
      }
    },
  };
}
