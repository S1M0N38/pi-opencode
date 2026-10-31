import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyConfig, type Config } from "../src/config-store.ts";
import { rankKeyIndices, summarizeUsage, type KeyRanking } from "../src/index.ts";

function makeConfig(names: string[]): Config {
	const config = createEmptyConfig();
	config.keys = names.map((name) => ({ name, key: `sk-${name}` }));
	config.activeKeyIndex = 0;
	return config;
}

function rankingOf(entries: Array<[number, { monthlyResetAt?: number; monthlyPercent?: number }]>): KeyRanking {
	return new Map(entries);
}

test("rankKeyIndices puts the earliest monthly reset first", () => {
	const config = makeConfig(["one", "two", "three"]);
	const ranking = rankingOf([
		[0, { monthlyResetAt: Date.parse("2026-11-30T09:44:52Z"), monthlyPercent: 0 }],
		[1, { monthlyResetAt: Date.parse("2026-11-13T13:45:01Z"), monthlyPercent: 44 }],
		[2, { monthlyResetAt: Date.parse("2026-12-20T00:00:00Z"), monthlyPercent: 70 }],
	]);

	assert.deepEqual(rankKeyIndices(config, ranking), [1, 0, 2]);
});

test("rankKeyIndices breaks a shared reset by the percentage already used, then by index", () => {
	const reset = Date.parse("2026-11-13T13:45:01Z");
	const config = makeConfig(["one", "two", "three"]);
	const ranking = rankingOf([
		[0, { monthlyResetAt: reset, monthlyPercent: 10 }],
		[1, { monthlyResetAt: reset, monthlyPercent: 60 }],
		[2, { monthlyResetAt: reset, monthlyPercent: 60 }],
	]);

	assert.deepEqual(rankKeyIndices(config, ranking), [1, 2, 0]);
});

test("rankKeyIndices never promotes a key whose expiry is unknown", () => {
	const config = makeConfig(["one", "two", "three"]);
	const ranking = rankingOf([[1, { monthlyResetAt: Date.parse("2026-12-01T00:00:00Z") }]]);

	assert.deepEqual(rankKeyIndices(config, ranking), [1, 0, 2]);
	assert.deepEqual(rankKeyIndices(config, new Map()), [0, 1, 2]);
});

test("summarizeUsage reads the monthly and rolling deadlines from the live response shape", () => {
	const now = Date.parse("2026-10-31T01:52:00Z");
	const summary = summarizeUsage({
		windows: [
			{ name: "rolling", status: "active", usagePercent: 1, resetAt: "2026-10-31T05:09:37Z" },
			{ name: "weekly", status: "active", usagePercent: 27, resetAt: "2026-11-02T00:00:00Z" },
			{ name: "monthly", status: "active", usagePercent: 44, resetAt: "2026-11-13T13:45:01Z" },
		],
	}, now);

	assert.equal(summary.monthlyResetAt, Date.parse("2026-11-13T13:45:01Z"));
	assert.equal(summary.monthlyPercent, 44);
	assert.equal(summary.rollingResetAt, Date.parse("2026-10-31T05:09:37Z"));
});

test("summarizeUsage understands a relative reset and ignores windows without a name", () => {
	const now = 1_000;
	const summary = summarizeUsage({
		windows: [
			{ status: "active", usagePercent: 99, resetAt: "2026-11-13T13:45:01Z" },
			{ name: "5-hour", status: "active", resetInSec: 600 },
			{ name: "monthly", status: "active", usagePercent: 12 },
		],
	}, now);

	assert.equal(summary.monthlyResetAt, undefined);
	assert.equal(summary.monthlyPercent, 12);
	assert.equal(summary.rollingResetAt, now + 600_000);
});
