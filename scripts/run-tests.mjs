// Bundles each test/*.test.ts with esbuild and runs them with node's test runner,
// so tests need no TypeScript support in Node and no extra dependencies.
import esbuild from "esbuild";
import { readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";

const outdir = ".test-build";
rmSync(outdir, { recursive: true, force: true });
const entries = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => path.join("test", f));
await esbuild.build({
	entryPoints: entries,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	outdir,
	outExtension: { ".js": ".mjs" },
	external: ["obsidian"],
	logLevel: "warning",
});
const files = readdirSync(outdir).map((f) => path.join(outdir, f));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
rmSync(outdir, { recursive: true, force: true });
process.exit(result.status ?? 1);
