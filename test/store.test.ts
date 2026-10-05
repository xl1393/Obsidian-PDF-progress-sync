import { test } from "node:test";
import assert from "node:assert/strict";
import {
	type DeviceFile,
	FORMAT_VERSION,
	emptyDeviceFile,
	isDeviceFileName,
	newestRecord,
	parseDeviceFile,
	renameInOwnFile,
	serializeDeviceFile,
	withRecord,
	withoutRecord,
} from "../src/store";

function device(name: string, books: DeviceFile["books"] = {}): DeviceFile {
	return { version: FORMAT_VERSION, device: name, updated: 0, books };
}

test("serialize and parse round-trip", () => {
	const file = withRecord(emptyDeviceFile("win-abc123"), "Books/A.pdf", { page: 12, pages: 300, ts: 1000 });
	assert.deepEqual(parseDeviceFile(serializeDeviceFile(file)), file);
});

test("parse rejects files that are not device files", () => {
	for (const text of ["", "not json", "[]", "null", "{}", '{"version":2,"device":"x","books":{}}', '{"version":1,"books":{}}', '{"version":1,"device":"x"}', '{"version":1,"device":"","books":{}}']) {
		assert.equal(parseDeviceFile(text), null, text);
	}
});

test("parse drops malformed records and keeps good ones", () => {
	const text = JSON.stringify({
		version: 1,
		device: "mac-xyz789",
		updated: 5,
		books: {
			"ok.pdf": { page: 3, ts: 10 },
			"with-pages.pdf": { page: 2, pages: 9, ts: 11 },
			"bad-pages.pdf": { page: 2, pages: -1, ts: 12 },
			"zero-page.pdf": { page: 0, ts: 10 },
			"fraction.pdf": { page: 1.5, ts: 10 },
			"string-page.pdf": { page: "4", ts: 10 },
			"no-ts.pdf": { page: 4 },
			"bad-ts.pdf": { page: 4, ts: -3 },
			"null.pdf": null,
		},
	});
	const parsed = parseDeviceFile(text);
	assert.ok(parsed);
	assert.deepEqual(parsed.books, {
		"ok.pdf": { page: 3, ts: 10 },
		"with-pages.pdf": { page: 2, pages: 9, ts: 11 },
		"bad-pages.pdf": { page: 2, ts: 12 },
	});
	assert.equal(parsed.updated, 5);
});

test("newest record wins across devices", () => {
	const files = [
		device("win", { "A.pdf": { page: 10, ts: 100 }, "B.pdf": { page: 1, ts: 900 } }),
		device("mac", { "A.pdf": { page: 25, ts: 300 } }),
		device("ios", { "A.pdf": { page: 18, ts: 200 } }),
	];
	assert.deepEqual(newestRecord(files, "A.pdf"), { page: 25, ts: 300, device: "mac" });
	assert.deepEqual(newestRecord(files, "B.pdf"), { page: 1, ts: 900, device: "win" });
	assert.equal(newestRecord(files, "C.pdf"), null);
	assert.equal(newestRecord([], "A.pdf"), null);
});

test("withRecord and withoutRecord do not mutate their input", () => {
	const original = device("win", { "A.pdf": { page: 1, ts: 1 } });
	const snapshot = structuredClone(original);
	const added = withRecord(original, "B.pdf", { page: 2, ts: 50 });
	const removed = withoutRecord(added, "A.pdf");
	assert.deepEqual(original, snapshot);
	assert.deepEqual(added.books, { "A.pdf": { page: 1, ts: 1 }, "B.pdf": { page: 2, ts: 50 } });
	assert.equal(added.updated, 50);
	assert.deepEqual(removed.books, { "B.pdf": { page: 2, ts: 50 } });
	assert.equal(withoutRecord(original, "missing.pdf"), original);
});

test("rename copies the newest record from any device into the own file", () => {
	const own = device("win", { "old.pdf": { page: 5, ts: 100 } });
	const others = [device("mac", { "old.pdf": { page: 40, ts: 500 } })];
	const next = renameInOwnFile(own, others, "old.pdf", "new.pdf");
	assert.deepEqual(next.books, { "new.pdf": { page: 40, ts: 500 } });
	assert.deepEqual(own.books, { "old.pdf": { page: 5, ts: 100 } }, "input untouched");
});

test("rename keeps newer progress already recorded for the new path", () => {
	const own = device("win", { "old.pdf": { page: 5, ts: 100 }, "new.pdf": { page: 9, ts: 700 } });
	const next = renameInOwnFile(own, [], "old.pdf", "new.pdf");
	assert.deepEqual(next.books, { "new.pdf": { page: 9, ts: 700 } });
});

test("rename of a book with no records leaves the file unchanged", () => {
	const own = device("win", { "other.pdf": { page: 1, ts: 1 } });
	assert.deepEqual(renameInOwnFile(own, [], "old.pdf", "new.pdf").books, own.books);
});

test("device file names", () => {
	assert.equal(isDeviceFileName("win-abc123.json"), true);
	assert.equal(isDeviceFileName("win-abc123.sync-conflict-20261001-030413-H2VZFVG.json"), true);
	assert.equal(isDeviceFileName(".win-abc123.json.tmp"), false);
	assert.equal(isDeviceFileName("~syncthing~win-abc123.json.tmp"), false);
	assert.equal(isDeviceFileName("win-abc123.json.tmp"), false);
	assert.equal(isDeviceFileName("notes.txt"), false);
});

test("subpathPage reads both link forms", async () => {
	const { subpathPage } = await import("../src/pdf");
	assert.equal(subpathPage('[19,{"name":"FitBH"},null]'), 20);
	assert.equal(subpathPage("[0,{\"name\":\"XYZ\"},10,700,null]"), 1);
	assert.equal(subpathPage("#page=12"), 12);
	assert.equal(subpathPage("#page=7&selection=1,2,3,4"), 7);
	assert.equal(subpathPage("#Chapter 3"), null);
	assert.equal(subpathPage(null), null);
});
