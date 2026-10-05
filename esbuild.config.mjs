import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	// Provided by Obsidian at runtime.
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
	],
	format: "cjs",
	target: "es2018",
	platform: "browser",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: false,
});

if (prod) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}
