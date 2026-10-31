import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAuthKey, getAuthFilePath, syncAuthKey } from "../src/auth-sync.ts";

function tempAuthPath(): { directory: string; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "opencode-auth-sync-test-"));
	return { directory, path: join(directory, "auth.json") };
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8"));
}

test("the mirrored key is written as an api_key credential with 0600 permissions", () => {
	const { directory, path } = tempAuthPath();
	try {
		assert.equal(syncAuthKey("opencode-go", "sk-one", ["sk-one", "sk-two"], path), "written");
		assert.deepEqual(readJson(path), { "opencode-go": { type: "api_key", key: "sk-one" } });
		assert.equal(statSync(path).mode & 0o777, 0o600);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rotating to another configured key rewrites the entry", () => {
	const { directory, path } = tempAuthPath();
	try {
		syncAuthKey("opencode-go", "sk-one", ["sk-one", "sk-two"], path);
		assert.equal(syncAuthKey("opencode-go", "sk-two", ["sk-one", "sk-two"], path), "written");
		assert.deepEqual(readJson(path)["opencode-go"], { type: "api_key", key: "sk-two" });
		assert.equal(syncAuthKey("opencode-go", "sk-two", ["sk-one", "sk-two"], path), "unchanged");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an OAuth login or a user-typed key is never replaced", () => {
	const { directory, path } = tempAuthPath();
	try {
		writeFileSync(path, JSON.stringify({ "opencode-go": { type: "oauth", refresh: "r", access: "a", expires: 1 } }));
		assert.equal(syncAuthKey("opencode-go", "sk-one", ["sk-one"], path), "kept-foreign");

		writeFileSync(path, JSON.stringify({ "opencode-go": { type: "api_key", key: "sk-manual" } }));
		assert.equal(syncAuthKey("opencode-go", "sk-one", ["sk-one"], path), "kept-foreign");
		assert.deepEqual(readJson(path)["opencode-go"], { type: "api_key", key: "sk-manual" });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("other providers and unrelated fields survive the rewrite", () => {
	const { directory, path } = tempAuthPath();
	try {
		writeFileSync(path, JSON.stringify({ anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 }, note: "keep" }));
		syncAuthKey("opencode-go", "sk-one", ["sk-one"], path);
		const data = readJson(path);
		assert.equal(data.note, "keep");
		assert.deepEqual(data.anthropic, { type: "oauth", refresh: "r", access: "a", expires: 1 });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an unreadable auth.json is left untouched instead of being replaced", () => {
	const { directory, path } = tempAuthPath();
	try {
		writeFileSync(path, "{ not json");
		assert.equal(syncAuthKey("opencode-go", "sk-one", ["sk-one"], path), "unreadable");
		assert.equal(readFileSync(path, "utf-8"), "{ not json");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("removing the last key clears our entry but keeps a foreign one", () => {
	const { directory, path } = tempAuthPath();
	try {
		syncAuthKey("opencode-go", "sk-one", ["sk-one"], path);
		assert.equal(clearAuthKey("opencode-go", ["sk-one"], path), "cleared");
		assert.deepEqual(readJson(path), {});

		writeFileSync(path, JSON.stringify({ "opencode-go": { type: "api_key", key: "sk-manual" } }));
		assert.equal(clearAuthKey("opencode-go", ["sk-one"], path), "kept");
		assert.deepEqual(readJson(path)["opencode-go"], { type: "api_key", key: "sk-manual" });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the auth path honours PI_CODING_AGENT_DIR", () => {
	assert.equal(getAuthFilePath({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" }), "/tmp/agent-dir/auth.json");
	assert.ok(getAuthFilePath({}).endsWith("/.pi/agent/auth.json"));
});
