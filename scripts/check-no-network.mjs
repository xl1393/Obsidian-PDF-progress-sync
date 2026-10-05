// Fails the build if the bundle contains anything that can talk to the network
// or reach outside the vault. This plugin only reads and writes small JSON files
// through Obsidian's vault adapter; none of these should ever appear.
import { readFileSync } from "fs";

const bundle = readFileSync("main.js", "utf8");
const forbidden = [
	/\bfetch\s*\(/,
	/\brequestUrl\b/,
	/\brequest\s*\(/,
	/XMLHttpRequest/,
	/WebSocket/,
	/EventSource/,
	/sendBeacon/,
	/window\.open/,
	/https?:\/\//,
	/\brequire\(\s*["'](?!obsidian["'])/,
	/\beval\s*\(/,
	/new\s+Function\s*\(/,
];

const hits = forbidden.filter((re) => re.test(bundle));
if (hits.length) {
	console.error("check-no-network: forbidden pattern(s) in main.js:");
	for (const re of hits) console.error("  " + re);
	process.exit(1);
}
console.log("check-no-network: ok");
