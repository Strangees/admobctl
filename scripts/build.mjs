// Builds the plugin into plugin/dist/: one readable .mjs file per source module (rolldown preserveModules), entry
// plugin/dist/admobctl.mjs. Anthropic's plugin directory holds any file it cannot read (256 KiB or more), so the
// plugin cannot ship a single 1.7 MB bundle. Our own modules land in dist/src/, dependencies in dist/vendor/ (not
// node_modules/, which git and npm ignore).
//
// `node scripts/build.mjs --standalone <file>` writes the same program as one file instead (the GitHub release asset).
import { rmSync, readFileSync } from "node:fs";
import { build } from "rolldown";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const standalone = process.argv[2] === "--standalone" ? process.argv[3] : undefined;
if (process.argv[2] === "--standalone" && !standalone) throw new Error("usage: node scripts/build.mjs [--standalone <file>]");

const outDir = "plugin/dist";
if (!standalone) rmSync(outDir, { recursive: true, force: true }); // no stale modules from renamed or deleted sources

const shebang = "#!/usr/bin/env node";

await build({
  input: "src/bin.ts",
  platform: "node",
  logLevel: "warn",
  transform: { target: "node20", define: { __ADMOBCTL_VERSION__: JSON.stringify(pkg.version) } },
  output: standalone
    ? { file: standalone, format: "esm", minify: false, banner: shebang }
    : {
        dir: outDir,
        format: "esm",
        minify: false,
        banner: (chunk) => (chunk.isEntry ? shebang : ""),
        preserveModules: true,
        preserveModulesRoot: ".",
        entryFileNames: (chunk) => (chunk.isEntry ? "admobctl.mjs" : `${chunk.name.replace(/^node_modules\//, "vendor/")}.mjs`),
      },
});
