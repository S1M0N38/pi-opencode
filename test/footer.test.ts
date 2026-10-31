import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderFooterLines, type FooterSnapshot } from "../src/index.ts";

const ANSI: Record<string, string> = {
	dim: "\x1b[2m",
	muted: "\x1b[90m",
	accent: "\x1b[36m",
	error: "\x1b[31m",
	warning: "\x1b[33m",
};

/** A theme whose escapes are zero-width, so layout assertions match what a terminal shows. */
const plainTheme = {
	fg: (color: string, text: string) => `${ANSI[color] ?? ""}${text}\x1b[0m`,
} as unknown as Theme;

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

function snapshot(patch: Partial<FooterSnapshot> = {}): FooterSnapshot {
	return {
		cwd: "/Users/simo/Developer/forks/pi-opencode",
		home: "/Users/simo",
		branch: "main",
		sessionName: undefined,
		keyName: "university",
		usage: { input: 1_500, output: 220, cacheRead: 8_400, cacheWrite: 900, cost: 0.0123, cacheHitRate: 78.4, subscription: false },
		context: { percent: 42, contextWindow: 200_000 },
		modelId: "claude-sonnet-4",
		thinkingLevel: undefined,
		extensionStatuses: new Map(),
		...patch,
	};
}

test("the key is right-aligned on the folder line, in the same dim text as the rest", () => {
	const [first] = renderFooterLines(snapshot(), plainTheme, 80);

	assert.ok(strip(first).startsWith("~/Developer/forks/pi-opencode (main)"));
	assert.ok(strip(first).endsWith("university"));
	assert.equal(visibleWidth(first), 80, "the line fills the terminal width");
	assert.ok(first.includes(`${ANSI.dim}university`), "the key uses the same dim text as the folder line");
	assert.ok(!first.includes(ANSI.accent), "the key is not highlighted");
});

test("the model stays on the second line, so the folder line has room for the key", () => {
	const lines = renderFooterLines(snapshot(), plainTheme, 80);

	assert.match(strip(lines[1]), /\$0\.012/);
	assert.match(strip(lines[1]), /42\.0%\/200k/);
	assert.ok(strip(lines[1]).endsWith("claude-sonnet-4"));
});

test("nothing the built-in footer showed is dropped from the stats line", () => {
	const stats = strip(renderFooterLines(snapshot(), plainTheme, 100)[1]);

	// Same tokens, same order as Pi's footer: input, output, cache read, cache write,
	// cache hit rate, cost, context percentage with the auto-compact marker.
	assert.match(stats, /↑1\.5k ↓220 R8\.4k/);
	assert.match(stats, /W900/);
	assert.match(stats, /CH78\.4%/);
	assert.match(stats, /\$0\.012/);
	assert.match(stats, /42\.0%\/200k \(auto\)/);
});

test("subscription billing and the provider prefix are preserved", () => {
	const lines = renderFooterLines(snapshot({
		usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, subscription: true },
		provider: "anthropic",
		providerCount: 3,
	}), plainTheme, 100);

	const stats = strip(lines[1]);
	assert.match(stats, /\$0\.000 \(sub\)/);
	assert.ok(stats.endsWith("(anthropic) claude-sonnet-4"));
	assert.doesNotMatch(stats, /R0|W0|CH/);
});

test("a reasoning model with thinking off reads like the built-in footer", () => {
	const lines = renderFooterLines(snapshot({ thinkingLevel: "off" }), plainTheme, 100);

	assert.ok(strip(lines[1]).endsWith("claude-sonnet-4 • thinking off"));
});

test("auto-compaction off removes the marker, and a single provider hides its name", () => {
	const stats = strip(renderFooterLines(snapshot({ autoCompact: false }), plainTheme, 100)[1]);

	assert.doesNotMatch(stats, /\(auto\)/);
	assert.doesNotMatch(stats, /\(anthropic\)/);
});

test("a narrow terminal truncates the path but keeps the key readable", () => {
	const [first] = renderFooterLines(snapshot(), plainTheme, 40);

	assert.ok(strip(first).endsWith("university"));
	assert.ok(visibleWidth(first) <= 40);
	assert.doesNotMatch(strip(first), /pi-opencode/);
});

test("no key is configured: the folder line is rendered alone", () => {
	const [first] = renderFooterLines(snapshot({ keyName: undefined }), plainTheme, 80);

	assert.ok(strip(first).trimEnd().endsWith("(main)"), "no key label on the right");
	assert.ok(visibleWidth(first) <= 80);
});

test("statuses from other extensions keep their own line, ours does not", () => {
	const lines = renderFooterLines(snapshot({
		extensionStatuses: new Map([["ssh", "SSH: box"], ["opencode", "ignored"]]),
	}), plainTheme, 80);

	assert.equal(lines.length, 3);
	assert.match(strip(lines[2]), /SSH: box/);
	assert.doesNotMatch(strip(lines[2]), /ignored/);
});

test("an unknown context size renders a question mark instead of NaN", () => {
	const lines = renderFooterLines(snapshot({
		context: { percent: null, contextWindow: 200_000 },
	}), plainTheme, 80);

	assert.match(strip(lines[1]), /\?\/200k/);
	assert.doesNotMatch(strip(lines[1]), /NaN|null/);
});
