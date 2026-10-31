import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	ConfigLoadError,
	DEFAULT_COOLDOWN_MINUTES,
	DEFAULT_WATCHDOG_IDLE_MS,
	createEmptyConfig,
	loadConfig,
	updateConfig,
	type Config,
} from "./config-store.ts";
import { clearAuthKey, syncAuthKey } from "./auth-sync.ts";

const PROVIDER = "opencode-go";
const PROVIDER_ENV_VAR = "OPENCODE_API_KEY";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_USAGE_TIMEOUT_MS = 10_000;
const RANKING_TTL_MS = 15 * 60_000;
const MONTHLY_WINDOW_NAME_RE = /^month/i;
const ROLLING_WINDOW_NAME_RE = /^(rolling|5[-\s]?hour|hourly)/i;
const FIXED_WINDOW_QUOTA_RE = /\b(?:5[- ]hour|weekly|monthly)\b[\s\S]*\b(?:usage\s+)?(?:quota|limit)\b|\b(?:usage|plan)\s+allocated\s+quota\s+exceeded\b|\b(?:quota|limit)\b[\s\S]*\b(?:will\s+reset|resets?\s+at|fixed[- ]window)\b/i;
const TRANSIENT_RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|quota|usage limit|limit reached/i;


function getCooldownMs(config: Config): number {
	return (config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES) * 60_000;
}

function getWatchdogIdleMs(config: Config): number {
	return config.watchdogIdleMs > 0 ? config.watchdogIdleMs : DEFAULT_WATCHDOG_IDLE_MS;
}

export function shouldWatchProvider(provider: string | undefined): boolean {
	return provider === PROVIDER;
}

export type RateLimitKind = "transient" | "fixed-window-quota";

export function classifyRateLimitError(message: string): RateLimitKind | undefined {
	if (FIXED_WINDOW_QUOTA_RE.test(message)) return "fixed-window-quota";
	if (TRANSIENT_RATE_LIMIT_RE.test(message)) return "transient";
	return undefined;
}

export interface TimerApi {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(timer: unknown): void;
}

export interface KeyUsageSummary {
	/** Epoch ms at which the monthly (plan) window resets, when the usage call reported one. */
	readonly monthlyResetAt?: number;
	readonly monthlyPercent?: number;
	/** Epoch ms at which the short rolling window frees up again, used to size a transient bench. */
	readonly rollingResetAt?: number;
}

/** Key index → what the last usage reading said about its windows. Session memory only. */
export type KeyRanking = ReadonlyMap<number, KeyUsageSummary>;

const EMPTY_RANKING: KeyRanking = new Map();

type KeyBench =
	| { readonly kind: "cooldown"; readonly until?: number }
	| { readonly kind: "quota"; readonly blockedUntil: number; readonly authoritative: boolean };


export type ProviderActivityPhase = "waiting-for-response" | "waiting-for-stream" | "streaming";

export interface ProviderTimeoutInfo {
	phase: ProviderActivityPhase;
	idleMs: number;
	elapsedMs: number;
	idleForMs: number;
	lastStatus?: number;
}

export function shouldRotateAfterWatchdogTimeout(timeoutInfo: ProviderTimeoutInfo, rateLimitAlreadyRotated: boolean): boolean {
	return timeoutInfo.lastStatus !== 401 && (timeoutInfo.lastStatus !== 429 || !rateLimitAlreadyRotated);
}


export interface ClockApi {
	now(): number;
}

export interface FetchResponseApi {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export type FetchApi = (url: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponseApi>;

export interface ExtensionOptions {
	timers?: TimerApi;
	clock?: ClockApi;
	fetch?: FetchApi;
}

export type OpenCodeGoUsageWindowStatus = "active" | "rate-limited" | "unknown";

export interface OpenCodeGoUsageWindow {
	name?: string;
	status: OpenCodeGoUsageWindowStatus;
	usagePercent?: number;
	resetInSec?: number;
	used?: number;
	limit?: number;
	remaining?: number;
	resetAt?: string;
	startAt?: string;
	endAt?: string;
}

export interface OpenCodeGoUsageResponse {
	windows: OpenCodeGoUsageWindow[];
}

type UsageFetchResult = {
	ok: true;
	keyName: string;
	usage: OpenCodeGoUsageResponse;
} | {
	ok: false;
	keyName?: string;
	message: string;
};

interface UsageLookupTarget {
	readonly keyIndex: number;
	readonly keyName: string;
	readonly bearerToken: string;
}

interface UsageDecisionIdentity {
	readonly epoch: number;
	readonly target: UsageLookupTarget;
}

interface RequestRateLimitState {
	readonly decision: UsageDecisionIdentity;
	readonly responseHandled: boolean;
}


export class ProviderIdleWatchdog {
	private timer: unknown | undefined;
	private active = false;
	private timedOut = false;
	private phase: ProviderActivityPhase = "waiting-for-response";
	private startedAt = 0;
	private lastActivityAt = 0;
	private lastStatus: number | undefined;
	private timeoutInfo: ProviderTimeoutInfo | undefined;
	private readonly options: {
		idleMs: number;
		onTimeout: () => void;
		timers?: TimerApi;
		clock?: ClockApi;
	};

	constructor(options: {
		idleMs: number;
		onTimeout: () => void;
		timers?: TimerApi;
		clock?: ClockApi;
	}) {
		this.options = options;
	}

	start(): void {
		const now = this.now();
		this.active = true;
		this.timedOut = false;
		this.timeoutInfo = undefined;
		this.phase = "waiting-for-response";
		this.startedAt = now;
		this.lastActivityAt = now;
		this.lastStatus = undefined;
		this.schedule();
	}

	response(status: number): void {
		if (!this.active || this.timedOut) return;
		this.phase = "waiting-for-stream";
		this.lastStatus = status;
		this.markActivity();
	}

	streamActivity(): void {
		if (!this.active || this.timedOut) return;
		this.phase = "streaming";
		this.markActivity();
	}

	activity(): void {
		if (!this.active || this.timedOut) return;
		this.markActivity();
	}

	stop(): void {
		this.active = false;
		this.clear();
	}


	consumeTimeoutInfo(): ProviderTimeoutInfo | undefined {
		const result = this.timeoutInfo;
		this.timeoutInfo = undefined;
		this.timedOut = false;
		return result;
	}

	currentTimeoutInfo(): ProviderTimeoutInfo | undefined {
		return this.timeoutInfo;
	}

	private markActivity(): void {
		this.lastActivityAt = this.now();
		this.schedule();
	}

	private now(): number {
		return this.options.clock?.now() ?? Date.now();
	}

	private getTimers(): TimerApi {
		return this.options.timers ?? {
			setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
			clearTimeout: (timer) => globalThis.clearTimeout(timer as Parameters<typeof globalThis.clearTimeout>[0]),
		};
	}

	private schedule(): void {
		this.clear();
		const timers = this.getTimers();
		this.timer = timers.setTimeout(() => {
			if (!this.active || this.timedOut) return;
			const now = this.now();
			this.timeoutInfo = {
				phase: this.phase,
				idleMs: this.options.idleMs,
				elapsedMs: Math.max(0, now - this.startedAt),
				idleForMs: Math.max(0, now - this.lastActivityAt),
				lastStatus: this.lastStatus,
			};
			this.timedOut = true;
			this.active = false;
			this.timer = undefined;
			this.options.onTimeout();
		}, this.options.idleMs);
	}

	private clear(): void {
		if (this.timer === undefined) return;
		const timers = this.getTimers();
		timers.clearTimeout(this.timer);
		this.timer = undefined;
	}
}

function getQuotaBlockedUntil(config: Config, keyIndex: number, now: number): number | undefined {
	const blockedUntil = config.quotaBlockedUntil[keyIndex];
	return typeof blockedUntil === "number" && Number.isFinite(blockedUntil) && blockedUntil > now
		? blockedUntil
		: undefined;
}

/** Keys held by a live recorded block, optionally ignoring the key that just failed. */
function getQuotaBlockedTargets(config: Config, now: number, skipKeyIndex?: number): UsageLookupTarget[] {
	const targets: UsageLookupTarget[] = [];
	for (let keyIndex = 0; keyIndex < config.keys.length; keyIndex++) {
		if (keyIndex === skipKeyIndex) continue;
		if (getQuotaBlockedUntil(config, keyIndex, now) === undefined) continue;
		const target = getUsageTargetForKeyIndex(config, keyIndex);
		if (target) targets.push(target);
	}
	return targets;
}

function getCooldownUntil(config: Config, keyIndex: number, now: number): number | undefined {
	const until = config.cooldownUntil[keyIndex];
	return typeof until === "number" && Number.isFinite(until) && until > now ? until : undefined;
}

/** A key can serve traffic only while it carries no quota block and no transient bench. */
function isKeyEligible(config: Config, keyIndex: number, now: number): boolean {
	if (config.keys[keyIndex] === undefined) return false;
	if (getQuotaBlockedUntil(config, keyIndex, now) !== undefined) return false;
	return getCooldownUntil(config, keyIndex, now) === undefined;
}

/**
 * Ordering rule of the whole extension: spend the quota that expires first. Keys with a known
 * monthly reset rank by that deadline, then by the percentage already burned (a same-day pair
 * should drain the fuller one first), then by index so the order is deterministic. A key whose
 * expiry could not be read ranks last: never promote a deadline we do not know.
 */
export function rankKeyIndices(config: Config, ranking: KeyRanking): number[] {
	return config.keys.map((_, index) => index).sort((a, b) => {
		const left = ranking.get(a);
		const right = ranking.get(b);
		const leftReset = left?.monthlyResetAt ?? Number.POSITIVE_INFINITY;
		const rightReset = right?.monthlyResetAt ?? Number.POSITIVE_INFINITY;
		if (leftReset !== rightReset) return leftReset < rightReset ? -1 : 1;
		const leftPercent = left?.monthlyPercent ?? -1;
		const rightPercent = right?.monthlyPercent ?? -1;
		if (leftPercent !== rightPercent) return rightPercent - leftPercent;
		// Last resort: stay on the key this installation last picked, so an unreadable ranking
		// never silently reverts the selection to key #1 at every start.
		if (a !== b && a === config.activeKeyIndex) return -1;
		if (a !== b && b === config.activeKeyIndex) return 1;
		return a - b;
	});
}

function firstEligibleRankedKey(config: Config, ranking: KeyRanking, now: number, excludeKeyIndex?: number): number | undefined {
	for (const index of rankKeyIndices(config, ranking)) {
		if (index === excludeKeyIndex) continue;
		if (isKeyEligible(config, index, now)) return index;
	}
	return undefined;
}

/** The key a request should use: a session pin wins, otherwise the best-ranked eligible key. */
function selectPreferredKeyIndex(config: Config, ranking: KeyRanking, now: number, pinnedKeyIndex?: number): number | undefined {
	if (pinnedKeyIndex !== undefined && isKeyEligible(config, pinnedKeyIndex, now)) return pinnedKeyIndex;
	return firstEligibleRankedKey(config, ranking, now);
}

function benchKey(config: Config, keyIndex: number, bench: KeyBench, now: number): void {
	if (bench.kind === "quota") {
		if (bench.authoritative) config.quotaBlockedUntil[keyIndex] = bench.blockedUntil;
		else setQuotaBlock(config, keyIndex, bench.blockedUntil, now);
		return;
	}
	const until = bench.until !== undefined && bench.until > now ? bench.until : now + getCooldownMs(config);
	config.cooldownUntil[keyIndex] = Math.max(getCooldownUntil(config, keyIndex, now) ?? 0, until);
}

/**
 * Bench the key that just failed, then take the best eligible replacement. When every key is
 * benched, a transient cooldown is cleared rather than keeping a key that is known to be
 * exhausted active -- but a quota block is never cleared automatically.
 */
function benchAndSelectNextKey(config: Config, ranking: KeyRanking, failedKeyIndex: number, bench: KeyBench, now: number): number | undefined {
	benchKey(config, failedKeyIndex, bench, now);
	const eligible = firstEligibleRankedKey(config, ranking, now, failedKeyIndex);
	if (eligible !== undefined) {
		config.activeKeyIndex = eligible;
		return eligible;
	}
	for (const candidate of rankKeyIndices(config, ranking)) {
		if (candidate === failedKeyIndex) continue;
		if (getQuotaBlockedUntil(config, candidate, now) !== undefined) continue;
		delete config.cooldownUntil[candidate];
		config.activeKeyIndex = candidate;
		return candidate;
	}
	return undefined;
}


interface RuntimeKeyStore {
	setRuntimeApiKey(provider: string, key: string): void | Promise<void>;
	removeRuntimeApiKey(provider: string): void | Promise<void>;
}

// Key equality detects credential changes, but persisted history has no issuer
// provenance (including after reload). Never replay signed reasoning on this
// rotating route, even before this process observes its first rotation.
const droppedReasoningDetail = Symbol("dropped-caller-bound-reasoning");

function projectReasoningDetails(details: unknown[]): unknown[] {
	// map/filter, never flatMap: entries that are not plain reasoning detail
	// objects (nested arrays, numbers, booleans, ...) must pass through as the
	// same element in the same position, with their original shape intact.
	return details
		.map((detail) => {
			if (!isRecord(detail)) return detail;
			if (detail.type === "reasoning.encrypted") return droppedReasoningDetail;
			const { signature: _signature, ...unsigned } = detail;
			return unsigned;
		})
		.filter((detail) => detail !== droppedReasoningDetail);
}

/**
 * Anthropic serializes signed thinking as `thinking` blocks and opaque redacted
 * reasoning as `redacted_thinking`. Emit the SDK's own unsigned shape instead: a
 * plain text block. Drop entries emptied by that projection, and report an
 * assistant message for omission only when the projection emptied it.
 */
function projectAssistantContent(content: unknown[]): unknown[] | undefined {
	let projected = false;
	const result: unknown[] = [];
	for (const block of content) {
		if (!isRecord(block)) {
			result.push(block);
			continue;
		}
		if (block.type === "thinking") {
			projected = true;
			const thinking = typeof block.thinking === "string" ? block.thinking : "";
			if (block.redacted !== true && thinking.trim().length > 0) result.push({ type: "text", text: thinking });
			continue;
		}
		if (block.type === "redacted_thinking") {
			projected = true;
			continue;
		}
		result.push(block);
	}
	if (!projected) return content;
	return result.length === 0 ? undefined : result;
}

function sanitizeReasoningPayload(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const request: Record<string, unknown> = { ...payload };
	if (Array.isArray(request.messages)) {
		const messages: unknown[] = [];
		for (const message of request.messages) {
			if (!isRecord(message) || message.role !== "assistant") {
				messages.push(message);
				continue;
			}
			let projected = message;
			if (Array.isArray(message.content)) {
				const content = projectAssistantContent(message.content);
				if (content === undefined) continue;
				if (content !== message.content) projected = { ...projected, content };
			}
			if (Array.isArray(message.reasoning_details)) {
				const { reasoning_details: _details, ...visible } = projected;
				const reasoning_details = projectReasoningDetails(message.reasoning_details);
				// Strip the key entirely when nothing remains to send: an empty array is an
				// unvalidated request shape, and this sanitiser exists to emit only shapes the
				// provider accepts. Non-detail entries above keep identity/position/shape.
				projected = reasoning_details.length === 0 ? visible : { ...visible, reasoning_details };
			}
			messages.push(projected);
		}
		request.messages = messages;
	}
	if (Array.isArray(request.input)) {
		request.input = request.input.filter((item: unknown) =>
			!isRecord(item) || item.type !== "reasoning");
	}
	return request;
}

const lastAppliedRuntimeKeys = new WeakMap<object, string>();
/** Value this extension put in the provider env var, if it seeded it. */
let seededProviderEnvValue: string | undefined;

interface RuntimeKeyStoreHost {
	authStorage?: RuntimeKeyStore;
	runtime?: RuntimeKeyStore;
}

// pi >= 1.0 exposes its ModelRuntime as a private field on ModelRegistry.
// Read it structurally so the runtime key override keeps working on both layouts.
function getRuntimeKeyStore(modelRegistry: object): RuntimeKeyStore {
	const host = modelRegistry as RuntimeKeyStoreHost;
	const store = host.authStorage ?? host.runtime;
	if (!store) throw new Error("Model registry does not expose runtime API key storage");
	return store;
}

function ignoreAsyncRefresh(result: void | Promise<void>): void {
	void result?.catch(() => {});
}

/** Set the best-ranked key as runtime override (highest priority in auth chain). */
function applyActiveKey(
	config: Config,
	modelRegistry: object,
	now = Date.now(),
	ranking: KeyRanking = EMPTY_RANKING,
	pinnedKeyIndex?: number,
): string | undefined {
	const idx = selectPreferredKeyIndex(config, ranking, now, pinnedKeyIndex);
	if (idx === undefined) return undefined;
	if (config.activeKeyIndex !== idx) config.activeKeyIndex = idx;
	const key = config.keys[idx].key;
	if (lastAppliedRuntimeKeys.get(modelRegistry) !== key) {
		lastAppliedRuntimeKeys.set(modelRegistry, key);
		ignoreAsyncRefresh(getRuntimeKeyStore(modelRegistry).setRuntimeApiKey(PROVIDER, key));
	}
	return config.keys[idx].name || `key-${idx + 1}`;
}

/**
 * Pi resolves `enabledModels` and the startup model before `session_start`, so the runtime
 * key applied there arrives too late: `opencode-go` looks unconfigured and its configured
 * models are filtered out of the scope. Seed the environment credential at load time so
 * the provider and its models are visible to startup selection and `pi --list-models`.
 * Requests still use the runtime override, so rotation and quota recovery are unchanged.
 */
function seedProviderEnv(config: Config, now = Date.now()): void {
	if (process.env[PROVIDER_ENV_VAR]) return;
	if (config.keys.length === 0) return;
	const index = selectPreferredKeyIndex(config, EMPTY_RANKING, now) ?? config.activeKeyIndex;
	const key = config.keys[index]?.key;
	if (!key) return;
	process.env[PROVIDER_ENV_VAR] = key;
	seededProviderEnvValue = key;
}

/** Clear the seeded credential, but never a value the user set before us. */
function clearSeededProviderEnv(): void {
	if (seededProviderEnvValue === undefined) return;
	if (process.env[PROVIDER_ENV_VAR] === seededProviderEnvValue) {
		delete process.env[PROVIDER_ENV_VAR];
	}
	seededProviderEnvValue = undefined;
}

function getUsageTargetForKeyIndex(config: Config, keyIndex: number): UsageLookupTarget | undefined {
	const entry = config.keys[keyIndex];
	if (!entry) return undefined;
	return {
		keyIndex,
		keyName: entry.name || `key-${keyIndex + 1}`,
		bearerToken: entry.key,
	};
}

function getActiveUsageTarget(config: Config): UsageLookupTarget | undefined {
	return getUsageTargetForKeyIndex(config, config.activeKeyIndex);
}

interface SelectionSnapshot extends UsageLookupTarget {
	readonly blockedUntil: number | undefined;
	readonly cooldownUntil: number | undefined;
}

interface RotationOperation {
	readonly epoch: number;
	readonly currentTime: number;
	readonly selection: SelectionSnapshot;
}

type RotationMode = KeyBench;

type RotationOutcome =
	| { readonly kind: "rotated"; readonly keyIndex: number; readonly completion: RotationOperation }
	| { readonly kind: "none"; readonly completion: RotationOperation }
	| { readonly kind: "cancelled" }
	| { readonly kind: "unavailable" };

type RotationCompletion = Extract<RotationOutcome, { completion: RotationOperation }>;

type LockedStep<T> = { readonly outcome: "cancelled" } | { readonly outcome: "done"; readonly value: T };

function captureSelectionSnapshot(config: Config, currentTime: number, keyIndex: number): SelectionSnapshot | undefined {
	const target = getUsageTargetForKeyIndex(config, keyIndex);
	if (!target) return undefined;
	return {
		...target,
		blockedUntil: getQuotaBlockedUntil(config, target.keyIndex, currentTime),
		cooldownUntil: config.cooldownUntil[target.keyIndex],
	};
}

/**
 * A deferred decision owns one credential, selection, block and cooldown. Every later
 * mutation re-checks that exact snapshot under the lock, so an operation that started
 * before an external update can never write to the replacement state.
 */
function matchesSelectionSnapshot(config: Config, snapshot: SelectionSnapshot, currentTime: number): boolean {
	const entry = config.keys[snapshot.keyIndex];
	if (entry === undefined) return false;
	if ((entry.name || `key-${snapshot.keyIndex + 1}`) !== snapshot.keyName) return false;
	if (entry.key !== snapshot.bearerToken) return false;
	if (getQuotaBlockedUntil(config, snapshot.keyIndex, currentTime) !== snapshot.blockedUntil) return false;
	return config.cooldownUntil[snapshot.keyIndex] === snapshot.cooldownUntil;
}

function captureRotationOperation(config: Config, currentTime: number, keyIndex: number, epoch: number): RotationOperation | undefined {
	const selection = captureSelectionSnapshot(config, currentTime, keyIndex);
	return selection ? { epoch, currentTime, selection } : undefined;
}

function isRotationOperationCurrent(operation: RotationOperation, config: Config, epoch: number): boolean {
	return epoch === operation.epoch
		&& config.activeKeyIndex === operation.selection.keyIndex
		&& matchesSelectionSnapshot(config, operation.selection, operation.currentTime);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function parseOpenCodeGoUsageWindow(value: unknown): OpenCodeGoUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const status: OpenCodeGoUsageWindowStatus = value.status === "ok" || value.status === "active"
		? "active"
		: value.status === "rate-limited" ? "rate-limited" : "unknown";
	const name = readString(value, ["name", "window", "period", "label"]);
	const usagePercent = readNumber(value, ["usagePercent", "usage_percent", "percent"]);
	const resetInSec = readNumber(value, ["resetInSec", "reset_in_sec", "resetSeconds", "reset_seconds"]);
	const used = readNumber(value, ["used", "usage", "usedTokens"]);
	const limit = readNumber(value, ["limit", "quota", "total"]);
	const remaining = readNumber(value, ["remaining", "remainingTokens"]);
	const resetAt = readString(value, ["resetAt", "reset_at", "resetsAt", "resets_at"]);
	const startAt = readString(value, ["startAt", "start_at", "startsAt", "starts_at"]);
	const endAt = readString(value, ["endAt", "end_at", "endsAt", "ends_at"]);
	return {
		status,
		...(name === undefined ? {} : { name }),
		...(usagePercent === undefined ? {} : { usagePercent }),
		...(resetInSec === undefined ? {} : { resetInSec }),
		...(used === undefined ? {} : { used }),
		...(limit === undefined ? {} : { limit }),
		...(remaining === undefined ? {} : { remaining }),
		...(resetAt === undefined ? {} : { resetAt }),
		...(startAt === undefined ? {} : { startAt }),
		...(endAt === undefined ? {} : { endAt }),
	};
}

export function parseOpenCodeGoUsage(value: unknown): OpenCodeGoUsageResponse | undefined {
	if (!isRecord(value)) return undefined;
	const windows: OpenCodeGoUsageWindow[] = [];
	if (Array.isArray(value.windows)) {
		for (const window of value.windows) {
			const parsed = parseOpenCodeGoUsageWindow(window);
			if (!parsed) return undefined;
			windows.push(parsed);
		}
		return { windows };
	}
	if (!isRecord(value.usage)) return undefined;
	for (const [name, window] of Object.entries(value.usage)) {
		const parsed = parseOpenCodeGoUsageWindow(window);
		if (!parsed) return undefined;
		windows.push(parsed.name === undefined ? { ...parsed, name } : parsed);
	}
	return { windows };
}

function getWindowResetAt(window: OpenCodeGoUsageWindow, now: number): number | undefined {
	if (window.resetAt !== undefined) {
		const parsed = Date.parse(window.resetAt);
		if (Number.isFinite(parsed) && parsed > now) return parsed;
	}
	if (window.resetInSec !== undefined && Number.isFinite(window.resetInSec) && window.resetInSec > 0) {
		return now + window.resetInSec * 1000;
	}
	return undefined;
}

/** Reduce a usage response to the two deadlines the selection rule cares about. */
export function summarizeUsage(usage: OpenCodeGoUsageResponse, now: number): KeyUsageSummary {
	let monthly: OpenCodeGoUsageWindow | undefined;
	let rolling: OpenCodeGoUsageWindow | undefined;
	for (const window of usage.windows) {
		if (monthly === undefined && window.name !== undefined && MONTHLY_WINDOW_NAME_RE.test(window.name)) monthly = window;
		else if (rolling === undefined && window.name !== undefined && ROLLING_WINDOW_NAME_RE.test(window.name)) rolling = window;
	}
	const monthlyResetAt = monthly ? getWindowResetAt(monthly, now) : undefined;
	const rollingResetAt = rolling ? getWindowResetAt(rolling, now) : undefined;
	return {
		...(monthlyResetAt === undefined ? {} : { monthlyResetAt }),
		...(monthly?.usagePercent === undefined ? {} : { monthlyPercent: monthly.usagePercent }),
		...(rollingResetAt === undefined ? {} : { rollingResetAt }),
	};
}

/** When the short window reopens, which is how long a rate-limited key is really unusable. */
function getRollingResetUntil(usage: OpenCodeGoUsageResponse, now: number): number | undefined {
	for (const window of usage.windows) {
		if (window.name === undefined || !ROLLING_WINDOW_NAME_RE.test(window.name)) continue;
		const reset = getWindowResetAt(window, now);
		if (reset !== undefined) return reset;
	}
	return undefined;
}

async function fetchOpenCodeGoUsage(target: UsageLookupTarget | undefined, fetchApi: FetchApi, timers?: TimerApi): Promise<UsageFetchResult> {
	if (!target) return { ok: false, message: "No OpenCode keys configured." };
	const controller = new AbortController();
	const timeoutFailure: UsageFetchResult = { ok: false, keyName: target.keyName, message: "Usage request timed out after 10s." };
	const timerApi = timers ?? {
		setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
		clearTimeout: (timer) => globalThis.clearTimeout(timer as Parameters<typeof globalThis.clearTimeout>[0]),
	};
	let didTimeout = false;
	let timeout: unknown;
	const request = (async (): Promise<UsageFetchResult> => {
		try {
			const response = await fetchApi(OPENCODE_GO_USAGE_URL, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${target.bearerToken}`,
				},
				signal: controller.signal,
			});
			if (!response.ok) {
				return { ok: false, keyName: target.keyName, message: `Usage request failed with HTTP ${response.status}.` };
			}
			const usage = parseOpenCodeGoUsage(await response.json());
			if (!usage) return { ok: false, keyName: target.keyName, message: "Usage response did not match the expected OpenCode Go shape." };
			return { ok: true, keyName: target.keyName, usage };
		} catch {
			if (didTimeout) return timeoutFailure;
			return { ok: false, keyName: target.keyName, message: "Usage request failed." };
		}
	})();
	const timedOut = new Promise<UsageFetchResult>((resolve) => {
		timeout = timerApi.setTimeout(() => {
			didTimeout = true;
			controller.abort();
			resolve(timeoutFailure);
		}, OPENCODE_GO_USAGE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([request, timedOut]);
	} finally {
		timerApi.clearTimeout(timeout);
	}
}

function captureUsageDecision(config: Config, epoch: number): UsageDecisionIdentity | undefined {
	const target = getActiveUsageTarget(config);
	return target ? { epoch, target } : undefined;
}

function isValidUsageDecisionTarget(decision: UsageDecisionIdentity, config: Config, epoch: number): boolean {
	return epoch === decision.epoch && matchesUsageTarget(config, decision.target);
}

function matchesUsageTarget(config: Config, target: UsageLookupTarget): boolean {
	const entry = config.keys[target.keyIndex];
	return entry !== undefined
		&& (entry.name || `key-${target.keyIndex + 1}`) === target.keyName
		&& entry.key === target.bearerToken;
}

function hasRateLimitedUsageWindow(result: UsageFetchResult): boolean {
	return result.ok && result.usage.windows.some((window) => window.status === "rate-limited");
}

/**
 * A recorded block can go stale: the plan was topped up, or the window reset before the
 * deadline we stored. Only a clean reading releases it -- a failed or unrecognised usage
 * response is not evidence of headroom. A response with no windows, or with any window
 * that is not positively active, stays conservative and keeps the recorded block.
 */
function hasConfirmedHeadroom(result: UsageFetchResult): boolean {
	return result.ok
		&& result.usage.windows.length > 0
		&& result.usage.windows.every((window) => window.status === "active");
}

function getRateLimitedUntil(usage: OpenCodeGoUsageResponse, now: number, fallbackMs: number): number {
	let blockedUntil = now;
	for (const window of usage.windows) {
		if (window.status !== "rate-limited") continue;
		const resetTimes: number[] = [];
		if (window.resetInSec !== undefined) {
			const reset = now + window.resetInSec * 1000;
			if (Number.isFinite(reset) && reset > now) resetTimes.push(reset);
		}
		for (const timestamp of [window.resetAt, window.endAt]) {
			if (!timestamp) continue;
			const parsed = Date.parse(timestamp);
			if (Number.isFinite(parsed) && parsed > now) resetTimes.push(parsed);
		}
		blockedUntil = Math.max(
			blockedUntil,
			resetTimes.length > 0 ? Math.max(...resetTimes) : now + fallbackMs,
		);
	}
	return blockedUntil > now ? blockedUntil : now + fallbackMs;
}

function parseFixedWindowQuotaReset(message: string, now: number): number | undefined {
	const resetText = message.match(/\b(?:will\s+)?resets?(?:\s+at|\s+on)?\s+([^.;\n]+)/i)?.[1];
	if (resetText) {
		const parsed = Date.parse(resetText.trim());
		if (Number.isFinite(parsed) && parsed > now) return parsed;
	}
	return undefined;
}

function getEarliestQuotaReset(config: Config, now: number): number | undefined {
	const resets = Object.values(config.quotaBlockedUntil).filter(
		(reset) => typeof reset === "number" && Number.isFinite(reset) && reset > now,
	);
	return resets.length > 0 ? Math.min(...resets) : undefined;
}

function setQuotaBlock(config: Config, keyIndex: number, blockedUntil: number, now: number): void {
	config.quotaBlockedUntil[keyIndex] = Math.max(
		getQuotaBlockedUntil(config, keyIndex, now) ?? 0,
		blockedUntil,
	);
}

function reindexAfterRemoval(record: Record<number, number>, removedIndex: number): Record<number, number> {
	const shifted: Record<number, number> = {};
	for (const [key, value] of Object.entries(record)) {
		const index = Number(key);
		if (index === removedIndex) continue;
		shifted[index > removedIndex ? index - 1 : index] = value;
	}
	return shifted;
}

function formatUsageAmount(value: number | undefined): string | undefined {
	return value === undefined ? undefined : value.toLocaleString("en-US");
}

export function formatResetIn(seconds: number): string {
	if (seconds <= 0) return "now";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.ceil((seconds % 3_600) / 60);
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return minutes > 0 ? `${minutes}m` : "less than 1m";
}

function formatUsageWindow(window: OpenCodeGoUsageWindow, index: number): string {
	const label = window.name ?? `window ${index + 1}`;
	const details = [`${label}: ${window.status}`];
	const used = formatUsageAmount(window.used);
	const limit = formatUsageAmount(window.limit);
	const remaining = formatUsageAmount(window.remaining);
	if (window.usagePercent !== undefined) details.push(`${Math.round(window.usagePercent)}% used`);
	if (used !== undefined && limit !== undefined) details.push(`${used}/${limit} used`);
	else if (used !== undefined) details.push(`${used} used`);
	if (remaining !== undefined) details.push(`${remaining} remaining`);
	if (window.resetInSec !== undefined) details.push(`resets in ${formatResetIn(window.resetInSec)}`);
	else if (window.resetAt) details.push(`resets ${window.resetAt}`);
	else if (window.endAt) details.push(`ends ${window.endAt}`);
	return details.join("; ");
}

export function formatUsageStatus(result: UsageFetchResult): string {
	if (!result.ok) {
		return `OpenCode usage unavailable${result.keyName ? ` for ${result.keyName}` : ""}: ${result.message}`;
	}
	if (result.usage.windows.length === 0) return `OpenCode usage for ${result.keyName}: no usage windows returned.`;
	return [`OpenCode usage for ${result.keyName}:`, ...result.usage.windows.map(formatUsageWindow)].join("\n");
}

export interface FooterUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
	/** Cache hit rate of the latest assistant message, in percent. */
	readonly cacheHitRate?: number;
	/** The provider bills a subscription rather than per token. */
	readonly subscription: boolean;
}

export interface FooterSnapshot {
	readonly cwd: string;
	readonly home?: string;
	readonly branch: string | null;
	readonly sessionName?: string;
	/** Name of the key requests currently go out with. */
	readonly keyName?: string;
	readonly usage: FooterUsage;
	readonly context?: { readonly percent: number | null; readonly contextWindow: number };
	/** Suffix the built-in footer adds when auto-compaction is on. */
	readonly autoCompact?: boolean;
	readonly modelId?: string;
	readonly provider?: string;
	/** Number of providers with available models; the provider prefix only appears above one. */
	readonly providerCount?: number;
	readonly thinkingLevel?: string;
	readonly extensionStatuses: ReadonlyMap<string, string>;
}

const FOOTER_STATUS_KEY = "opencode";

function formatFooterCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const prefix = home.endsWith("/") ? home : `${home}/`;
	if (cwd === home) return "~";
	return cwd.startsWith(prefix) ? `~/${cwd.slice(prefix.length)}` : cwd;
}

function formatFooterTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Place `right` flush against the terminal edge, truncating the left side when they collide. */
function composeFooterLine(left: string, right: string, width: number): string {
	if (right === "") return truncateToWidth(left, width, "…");
	const rightWidth = visibleWidth(right);
	const leftBudget = width - rightWidth - 1;
	if (leftBudget <= 0) return truncateToWidth(right, width);
	const leftText = truncateToWidth(left, leftBudget, "…");
	const pad = " ".repeat(Math.max(1, width - visibleWidth(leftText) - rightWidth));
	return truncateToWidth(leftText + pad + right, width);
}

/**
 * The footer Pi would render, plus the active key right-aligned on the folder line.
 * Kept as a pure function so the layout is testable without a terminal.
 */
export function renderFooterLines(snapshot: FooterSnapshot, theme: Theme, width: number): string[] {
	const location = [
		formatFooterCwd(snapshot.cwd, snapshot.home),
		snapshot.branch === null ? "" : ` (${snapshot.branch})`,
		snapshot.sessionName === undefined ? "" : ` • ${snapshot.sessionName}`,
	].join("");
	// Plain dim text, like the rest of the status bar: the name alone, no prefix, no highlight.
	const keyLabel = snapshot.keyName === undefined ? "" : theme.fg("dim", snapshot.keyName);

	// Same tokens, same order as Pi's built-in footer.
	const stats: string[] = [];
	const usage = snapshot.usage;
	const experimental = process.env.PI_EXPERIMENTAL === "1";
	if (usage.input > 0) stats.push(`↑${formatFooterTokens(usage.input)}`);
	if (usage.output > 0) stats.push(`↓${formatFooterTokens(usage.output)}`);
	if (usage.cacheRead > 0) stats.push(`R${formatFooterTokens(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) stats.push(`W${formatFooterTokens(usage.cacheWrite)}`);
	if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.cacheHitRate !== undefined) {
		stats.push(`CH${usage.cacheHitRate.toFixed(1)}%`);
	}
	if (usage.cost > 0 || usage.subscription) stats.push(`$${usage.cost.toFixed(3)}${usage.subscription ? " (sub)" : ""}`);
	const contextUsage = snapshot.context;
	if (contextUsage !== undefined) {
		const window = formatFooterTokens(contextUsage.contextWindow);
		const auto = snapshot.autoCompact === false ? "" : " (auto)";
		const text = contextUsage.percent === null ? `?/${window}${auto}` : `${contextUsage.percent.toFixed(1)}%/${window}${auto}`;
		const severity = contextUsage.percent ?? 0;
		stats.push(severity > 90 ? theme.fg("error", text) : severity > 70 ? theme.fg("warning", text) : text);
	}
	if (experimental) stats.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
	const thinking = snapshot.thinkingLevel === undefined
		? ""
		: snapshot.thinkingLevel === "off" ? " • thinking off" : ` • ${snapshot.thinkingLevel}`;
	const modelName = snapshot.modelId === undefined ? "" : `${snapshot.modelId}${thinking}`;
	const modelLabel = modelName === "" || snapshot.provider === undefined || (snapshot.providerCount ?? 0) <= 1
		? modelName
		: `(${snapshot.provider}) ${modelName}`;

	const lines = [
		composeFooterLine(theme.fg("dim", location), keyLabel, width),
		composeFooterLine(theme.fg("dim", stats.join(" ")), theme.fg("dim", modelLabel), width),
	];
	const otherStatuses = [...snapshot.extensionStatuses.entries()]
		.filter(([key]) => key !== FOOTER_STATUS_KEY)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
		.filter((text) => text.length > 0)
		.join(" ");
	if (otherStatuses.length > 0) lines.push(truncateToWidth(otherStatuses, width));
	return lines;
}

function formatStatus(config: Config, ranking: KeyRanking, pinnedKeyIndex: number | undefined, now = Date.now()): string {
	const watchdogStatus = `Watchdog: ${config.watchdogEnabled ? "on" : "off"} (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)`;
	if (config.keys.length === 0) {
		return `No keys configured. Use /opencode add <name> <key>.\n${watchdogStatus}`;
	}
	const ranked = rankKeyIndices(config, ranking);
	const preferred = selectPreferredKeyIndex(config, ranking, now, pinnedKeyIndex);
	const lines = ranked.map((keyIndex, position) => {
		const key = config.keys[keyIndex];
		const summary = ranking.get(keyIndex);
		const roles: string[] = [];
		if (pinnedKeyIndex === keyIndex) roles.push("pinned");
		else if (preferred === keyIndex) roles.push("primary");
		else roles.push("fallback");
		const quotaReset = getQuotaBlockedUntil(config, keyIndex, now);
		if (quotaReset !== undefined) roles.push(`quota-blocked ${formatResetIn(Math.ceil((quotaReset - now) / 1000))}`);
		else {
			const cooldownUntil = getCooldownUntil(config, keyIndex, now);
			if (cooldownUntil !== undefined) roles.push(`cooling ${formatResetIn(Math.ceil((cooldownUntil - now) / 1000))}`);
		}
		const expiry = summary?.monthlyResetAt === undefined
			? "monthly expiry unknown"
			: `monthly ${summary.monthlyPercent === undefined ? "?" : `${Math.round(summary.monthlyPercent)}%`} · resets in ${formatResetIn(Math.ceil((summary.monthlyResetAt - now) / 1000))}`;
		return `  #${position + 1} ${key.name} (${roles.join(", ")}) ${expiry}`;
	});
	const heading = preferred === undefined
		? "OpenCode keys — every key is blocked until its reset"
		: `OpenCode keys — primary: ${config.keys[preferred]?.name ?? `key-${preferred + 1}`} (earliest monthly reset first)`;
	const authLine = config.syncAuthFile
		? "auth.json mirror: on (active key, for --no-extensions callers)"
		: "auth.json mirror: off";
	return `${[heading, ...lines, `Cooldown fallback: ${config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES} min`, authLine, watchdogStatus].join("\n")}`;
}

interface WatchdogEvent {
	time: number;
	keyName?: string;
	rotatedTo?: string;
	activeKey?: string;
	phase: ProviderActivityPhase;
	idleMs: number;
	elapsedMs: number;
	idleForMs: number;
	lastStatus?: number;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatTimeoutInfo(info: ProviderTimeoutInfo): string {
	const status = info.lastStatus === undefined ? "" : `, last HTTP ${info.lastStatus}`;
	return `${info.phase.replaceAll("-", " ")} stalled after ${formatDuration(info.elapsedMs)} (${formatDuration(info.idleForMs)} idle${status})`;
}

function formatWatchdogEvents(events: WatchdogEvent[], now = Date.now()): string {
	if (events.length === 0) return "No OpenCode Go watchdog timeouts recorded this session.";
	return events
		.slice()
		.reverse()
		.map((event, index) => {
			const age = formatDuration(now - event.time);
			const key = event.keyName ? ` key=${event.keyName}` : "";
			const rotation = event.rotatedTo ? ` rotated=${event.rotatedTo}` : event.activeKey ? ` using=${event.activeKey}` : " rotated=none";
			const status = event.lastStatus === undefined ? "" : ` status=${event.lastStatus}`;
			return `${index + 1}. ${age} ago ${event.phase.replaceAll("-", " ")}${status}${key}${rotation} elapsed=${formatDuration(event.elapsedMs)} idle=${formatDuration(event.idleForMs)}`;
		})
		.join("\n");
}


// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export function createOpencodeGoRotationExtension(options: ExtensionOptions = {}) {
	return function opencodeGoRotationExtension(pi: ExtensionAPI) {
		let config = createEmptyConfig();
		let configError: string | undefined;
		let watchdog: ProviderIdleWatchdog | undefined;
		let watchdogAbortPending = false;
		let watchdogAbortMessage: string | undefined;
		let watchdogTimeoutInfo: ProviderTimeoutInfo | undefined;
		let watchdogRequestTimedOut = false;
		let usageDecisionEpoch = 0;
		let requestRateLimitState: RequestRateLimitState | undefined;
		let keyRanking: KeyRanking = EMPTY_RANKING;
		let rankingFetchedAt: number | undefined;
		let rankingRefresh: Promise<void> | undefined;
		let expiryWarningShown = false;
		/** Session-scoped manual pick; `/opencode use|next` sets it, `session_start` clears it. */
		let pinnedKeyIndex: number | undefined;
		/** Key name shown in the footer; undefined before a key is applied. */
		let footerKeyName: string | undefined;
		let footerTui: TUI | undefined;
		let authFileNoticeShown = false;
		const watchdogEvents: WatchdogEvent[] = [];

		const now = (): number => options.clock?.now() ?? Date.now();
		const fetchApi: FetchApi = options.fetch ?? globalThis.fetch.bind(globalThis);

		// Runs while pi loads extensions, before it resolves the session's model scope.
		try {
			seedProviderEnv(loadConfig(), now());
		} catch {
			// Invalid configuration is reported on session_start; never break startup.
		}

		function formatConfigError(error: unknown): string {
			if (error instanceof ConfigLoadError) return error.message;
			if (error instanceof Error) return error.message;
			return "Unknown configuration error";
		}

		function refreshConfig(): boolean {
			try {
				config = loadConfig();
				configError = undefined;
				return true;
			} catch (error) {
				configError = formatConfigError(error);
				return false;
			}
		}

		function mutateSharedConfig<T>(mutator: (freshConfig: Config) => T): T | undefined {
			try {
				const updated = updateConfig(mutator);
				config = updated.config;
				configError = undefined;
				return updated.result;
			} catch (error) {
				configError = formatConfigError(error);
				return undefined;
			}
		}

		function ensureConfig(ctx: Pick<ExtensionContext, "ui">): boolean {
			if (refreshConfig()) return true;
			ctx.ui.notify(`OpenCode: ${configError}. No configuration was changed.`, "error");
			return false;
		}

		function applySynchronizedActiveKey(ctx: Pick<ExtensionContext, "modelRegistry">): string | undefined {
			if (!refreshConfig()) return undefined;
			const currentTime = now();
			const availableIndex = selectPreferredKeyIndex(config, keyRanking, currentTime, pinnedKeyIndex);
			if (availableIndex !== undefined && availableIndex !== config.activeKeyIndex) {
				const selectedIndex = mutateSharedConfig((freshConfig) => {
					const freshAvailableIndex = selectPreferredKeyIndex(freshConfig, keyRanking, currentTime, pinnedKeyIndex);
					if (freshAvailableIndex !== undefined) freshConfig.activeKeyIndex = freshAvailableIndex;
					return freshAvailableIndex;
				});
				if (selectedIndex === undefined) return undefined;
			}
			return applyKey(ctx, currentTime);
		}

		/**
		 * Rank the keys by the expiry the usage endpoint reports. The probe is deliberately never
		 * on a blocking path: a rate limit or a slow usage call must not delay a turn. A landed
		 * ranking is applied at the next request boundary, so a key never changes mid-turn.
		 */
		async function collectRanking(ctx: Pick<ExtensionContext, "ui">, warn: boolean): Promise<void> {
			if (!refreshConfig()) return;
			const probeTime = now();
			const targets = config.keys
				.map((_, index) => getUsageTargetForKeyIndex(config, index))
				.filter((target): target is UsageLookupTarget => target !== undefined);
			if (targets.length === 0) {
				keyRanking = EMPTY_RANKING;
				rankingFetchedAt = probeTime;
				return;
			}
			const results = await Promise.all(targets.map((target) => fetchOpenCodeGoUsage(target, fetchApi, options.timers)));
			if (!refreshConfig()) return;
			const next = new Map<number, KeyUsageSummary>();
			let successful = 0;
			targets.forEach((target, position) => {
				const result = results[position];
				// A key removed or replaced while the probe was in flight must not inherit its reading.
				if (!matchesUsageTarget(config, target)) return;
				if (!result.ok) return;
				successful++;
				next.set(target.keyIndex, summarizeUsage(result.usage, probeTime));
			});
			keyRanking = next;
			rankingFetchedAt = probeTime;
			if (warn && successful === 0 && config.keys.length > 1 && !expiryWarningShown) {
				expiryWarningShown = true;
				ctx.ui.notify(
					"OpenCode: could not read key expiry from the usage endpoint; using the configured key order.",
					"warning",
				);
			}
		}

		function refreshKeyRanking(ctx: Pick<ExtensionContext, "ui">, options: { force?: boolean; warn?: boolean } = {}): Promise<void> {
			const currentTime = now();
			const fresh = rankingFetchedAt !== undefined && currentTime - rankingFetchedAt < RANKING_TTL_MS;
			if (!options.force && fresh) return Promise.resolve();
			if (rankingRefresh) return rankingRefresh;
			const run = collectRanking(ctx, options.warn ?? false).finally(() => {
				rankingRefresh = undefined;
			});
			rankingRefresh = run;
			return run;
		}

		function invalidateAutomaticDecisions(): void {
			usageDecisionEpoch++;
		}

		/** Keep the footer label in step with the key actually applied. */
		function updateFooterKey(keyName: string | undefined): void {
			if (keyName === undefined || keyName === footerKeyName) return;
			footerKeyName = keyName;
			footerTui?.requestRender();
		}

		/** Apply the selected key and refresh the footer instead of printing a startup notice. */
		function applyKey(ctx: Pick<ExtensionContext, "modelRegistry">, currentTime = now()): string | undefined {
			const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime, keyRanking, pinnedKeyIndex);
			updateFooterKey(keyName);
			if (keyName !== undefined) mirrorActiveKeyInAuthFile();
			return keyName;
		}

		/**
		 * Callers that spawn `pi --no-extensions` (commit-message generators, scripts) load no
		 * extensions, so the runtime override is invisible to them and the provider looks
		 * unconfigured. Mirroring the active key into auth.json fixes those without touching the
		 * rotation this session uses.
		 */
		function mirrorActiveKeyInAuthFile(): void {
			if (!config.syncAuthFile) return;
			const key = config.keys[config.activeKeyIndex]?.key;
			if (key === undefined) return;
			const result = syncAuthKey(PROVIDER, key, config.keys.map((entry) => entry.key));
			if (result === "kept-foreign" && !authFileNoticeShown) {
				authFileNoticeShown = true;
				// Another credential (an OAuth login) owns the entry: leave it alone.
				return;
			}
		}

		function buildFooterSnapshot(
			ctx: ExtensionContext,
			footerData: {
				getGitBranch(): string | null;
				getExtensionStatuses(): ReadonlyMap<string, string>;
				getAvailableProviderCount(): number;
			},
		): { snapshot: FooterSnapshot; entryCount: number } {
			let input = 0;
			let output = 0;
			let cacheRead = 0;
			let cacheWrite = 0;
			let cost = 0;
			let cacheHitRate: number | undefined;
			const entries = ctx.sessionManager.getEntries();
			const addUsage = (usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } }): void => {
				input += usage.input;
				output += usage.output;
				cacheRead += usage.cacheRead;
				cacheWrite += usage.cacheWrite;
				cost += usage.cost.total;
			};
			for (const entry of entries) {
				if (entry.type === "usage") {
					addUsage(entry.usage);
				} else if (entry.type === "message") {
					const message = entry.message;
					if (message.role === "assistant") {
						addUsage(message.usage);
						// Same definition as Pi's footer: cache reads over the whole prompt of the turn.
						const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
						cacheHitRate = promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
					} else if (message.role === "toolResult" && message.usage !== undefined) {
						addUsage(message.usage);
					}
				} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage !== undefined) {
					addUsage(entry.usage);
				}
			}
			const contextUsage = ctx.getContextUsage();
			// Optional calls: these are newer than the oldest pi this extension accepts.
			const settings = typeof pi.getSettings === "function" ? pi.getSettings() : undefined;
			const model = ctx.model;
			const provider = model?.provider;
			const subscription = model !== undefined && provider !== undefined
				&& ctx.modelRegistry.isUsingOAuth?.(model) === true
				&& ctx.modelRegistry.getProvider?.(provider)?.auth.oauth?.isSubscription === true;
			const snapshot: FooterSnapshot = {
				cwd: ctx.cwd,
				home: process.env.HOME || process.env.USERPROFILE,
				branch: footerData.getGitBranch(),
				sessionName: ctx.sessionManager.getSessionName(),
				keyName: footerKeyName,
				usage: { input, output, cacheRead, cacheWrite, cost, cacheHitRate, subscription },
				context: contextUsage === undefined
					? undefined
					: { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow },
				autoCompact: settings?.compaction?.enabled ?? true,
				modelId: model?.id,
				provider,
				providerCount: footerData.getAvailableProviderCount(),
				thinkingLevel: model?.reasoning ? (pi.getThinkingLevel?.() ?? "off") : undefined,
				extensionStatuses: footerData.getExtensionStatuses(),
			};
			return { snapshot, entryCount: entries.length };
		}

		/** Replace the built-in footer so the active key sits on the folder line, right-aligned. */
		function installFooter(ctx: ExtensionContext): void {
			if (ctx.mode !== "tui") return;
			ctx.ui.setFooter((tui, theme, footerData) => {
				footerTui = tui;
				const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
				let cachedWidth: number | undefined;
				let cachedKey: string | undefined;
				let cachedEntryCount = -1;
				let cachedLines: string[] | undefined;
				const invalidate = (): void => { cachedLines = undefined; };
				return {
					dispose: unsubscribe,
					invalidate,
					render(width: number): string[] {
						const { snapshot, entryCount } = buildFooterSnapshot(ctx, footerData);
						if (cachedLines && cachedWidth === width && cachedKey === footerKeyName && cachedEntryCount === entryCount) {
							return cachedLines;
						}
						cachedWidth = width;
						cachedKey = footerKeyName;
						cachedEntryCount = entryCount;
						cachedLines = renderFooterLines(snapshot, theme, width);
						return cachedLines;
					},
				} satisfies Component & { dispose(): void };
			});
		}

		function beginProviderRequest(ctx: Pick<ExtensionContext, "modelRegistry" | "ui">): void {
			invalidateAutomaticDecisions();
			// A ranking older than the TTL is refreshed in the background for the next boundary.
			ignoreAsyncRefresh(refreshKeyRanking(ctx));
			if (applySynchronizedActiveKey(ctx) === undefined) {
				requestRateLimitState = undefined;
				return;
			}
			const decision = captureUsageDecision(config, usageDecisionEpoch);
			requestRateLimitState = decision ? { decision, responseHandled: false } : undefined;
		}

		function getCurrentRequestRateLimitState(): RequestRateLimitState | undefined {
			if (!requestRateLimitState) return undefined;
			return isValidUsageDecisionTarget(requestRateLimitState.decision, config, usageDecisionEpoch)
				? requestRateLimitState
				: undefined;
		}

		function markResponseRateLimitHandled(decision: UsageDecisionIdentity): void {
			requestRateLimitState = {
				decision: { ...decision, epoch: usageDecisionEpoch },
				responseHandled: true,
			};
		}

		function currentRotationOperation(currentTime: number): RotationOperation | undefined {
			return captureRotationOperation(config, currentTime, config.activeKeyIndex, usageDecisionEpoch);
		}

		/** Post-await effects are allowed only while the completed decision still owns the state. */
		function isCompletionCurrent(outcome: RotationOutcome): outcome is RotationCompletion {
			return (outcome.kind === "rotated" || outcome.kind === "none")
				&& refreshConfig()
				&& isRotationOperationCurrent(outcome.completion, config, usageDecisionEpoch);
		}

		/**
		 * A benched key can become usable again after we recorded its block. Probe the blocked
		 * keys without mutating anything; only a positive reading is collected as candidate
		 * headroom. The probes are data-only, so a stale result can never be applied without the
		 * guarded commit re-checking the credential, block and cooldown it was sampled from.
		 */
		async function probeRecoveredHeadroom(currentTime: number, skipKeyIndex?: number): Promise<SelectionSnapshot[]> {
			if (!refreshConfig()) return [];
			const candidates = getQuotaBlockedTargets(config, currentTime, skipKeyIndex)
				.map((target) => captureSelectionSnapshot(config, currentTime, target.keyIndex))
				.filter((snapshot): snapshot is SelectionSnapshot => snapshot !== undefined);
			const recovered: SelectionSnapshot[] = [];
			for (const candidate of candidates) {
				const usage = await fetchOpenCodeGoUsage(candidate, fetchApi, options.timers);
				if (hasConfirmedHeadroom(usage)) recovered.push(candidate);
				// Keep the in-memory config aligned with writers active during the probes.
				if (!refreshConfig()) break;
			}
			return recovered;
		}

		function selectNextKey(mode: RotationMode, freshConfig: Config, startIndex: number, currentTime: number): number | undefined {
			return benchAndSelectNextKey(freshConfig, keyRanking, startIndex, mode, currentTime);
		}

		/**
		 * Block the failed key and select a replacement, re-probing benched keys only when the
		 * fast path found nothing. Every mutation re-validates the operation snapshot under the
		 * lock, so a decision invalidated while probes were in flight is cancelled instead of
		 * being rebased onto the newer state.
		 */
		async function rotateWithRecovery(
			ctx: Pick<ExtensionContext, "modelRegistry" | "ui">,
			operation: RotationOperation,
			currentTime: number,
			mode: RotationMode,
		): Promise<RotationOutcome> {
			const startIndex = operation.selection.keyIndex;
			const fast = mutateSharedConfig((freshConfig): LockedStep<number | undefined> => {
				if (!isRotationOperationCurrent(operation, freshConfig, usageDecisionEpoch)) {
					return { outcome: "cancelled" };
				}
				return { outcome: "done", value: selectNextKey(mode, freshConfig, startIndex, currentTime) };
			});
			if (fast === undefined) return { kind: "unavailable" };
			if (fast.outcome === "cancelled") return { kind: "cancelled" };
			if (fast.value !== undefined && fast.value !== startIndex) {
				const completion = currentRotationOperation(currentTime);
				return completion ? { kind: "rotated", keyIndex: fast.value, completion } : { kind: "cancelled" };
			}

			// Snapshot the state this operation just produced, so a later commit can detect any
			// external change to the same credential, block, cooldown or selection.
			const retryOperation = currentRotationOperation(currentTime);
			const failedKey = captureSelectionSnapshot(config, currentTime, startIndex);
			if (!retryOperation || !failedKey) return { kind: "cancelled" };

			const recovered = await probeRecoveredHeadroom(currentTime, startIndex);
			if (configError) return { kind: "unavailable" };
			if (usageDecisionEpoch !== operation.epoch) return { kind: "cancelled" };
			if (recovered.length === 0) {
				// Still verify the state this operation owns: a shared writer may have moved the
				// selection, credential, block or cooldown while the probes were in flight.
				const current = matchesSelectionSnapshot(config, failedKey, currentTime)
					&& isRotationOperationCurrent(retryOperation, config, usageDecisionEpoch);
				return current ? { kind: "none", completion: retryOperation } : { kind: "cancelled" };
			}

			const commit = mutateSharedConfig((freshConfig): LockedStep<number | undefined> => {
				if (!isRotationOperationCurrent(retryOperation, freshConfig, usageDecisionEpoch)) return { outcome: "cancelled" };
				if (!matchesSelectionSnapshot(freshConfig, failedKey, currentTime)) return { outcome: "cancelled" };
				if (!recovered.every((snapshot) => matchesSelectionSnapshot(freshConfig, snapshot, currentTime))) return { outcome: "cancelled" };
				for (const snapshot of recovered) {
					delete freshConfig.quotaBlockedUntil[snapshot.keyIndex];
					delete freshConfig.cooldownUntil[snapshot.keyIndex];
				}
				return { outcome: "done", value: selectNextKey(mode, freshConfig, startIndex, currentTime) };
			});
			if (commit === undefined) return { kind: "unavailable" };
			if (commit.outcome === "cancelled") return { kind: "cancelled" };
			for (const snapshot of recovered) {
				ctx.ui.notify(`OpenCode: ${snapshot.keyName} has headroom again → quota block cleared`, "info");
			}
			const completion = currentRotationOperation(currentTime);
			if (!completion) return { kind: "cancelled" };
			const selected = commit.value;
			return selected === undefined || selected === startIndex
				? { kind: "none", completion }
				: { kind: "rotated", keyIndex: selected, completion };
		}

		/** Guarded startup/reload recovery: clears only blocks whose snapshot is still current. */
		async function recoverQuotaBlocksGuarded(
			ctx: Pick<ExtensionContext, "ui">,
			operation: RotationOperation,
			currentTime: number,
		): Promise<"recovered" | "none" | "cancelled" | "unavailable"> {
			const recovered = await probeRecoveredHeadroom(currentTime);
			if (configError) return "unavailable";
			if (usageDecisionEpoch !== operation.epoch) return "cancelled";
			if (recovered.length === 0) {
				return isRotationOperationCurrent(operation, config, usageDecisionEpoch) ? "none" : "cancelled";
			}
			const commit = mutateSharedConfig((freshConfig): LockedStep<true> => {
				if (!isRotationOperationCurrent(operation, freshConfig, usageDecisionEpoch)) return { outcome: "cancelled" };
				if (!recovered.every((snapshot) => matchesSelectionSnapshot(freshConfig, snapshot, currentTime))) return { outcome: "cancelled" };
				for (const snapshot of recovered) {
					delete freshConfig.quotaBlockedUntil[snapshot.keyIndex];
					delete freshConfig.cooldownUntil[snapshot.keyIndex];
				}
				return { outcome: "done", value: true };
			});
			if (commit === undefined) return "unavailable";
			if (commit.outcome === "cancelled") return "cancelled";
			for (const snapshot of recovered) {
				ctx.ui.notify(`OpenCode: ${snapshot.keyName} has headroom again → quota block cleared`, "info");
			}
			return "recovered";
		}

		function reportQuotaExhausted(ctx: Pick<ExtensionContext, "ui">, exhaustedName: string, currentTime: number): void {
			if (configError) {
				ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
				return;
			}
			invalidateAutomaticDecisions();
			const earliestReset = getEarliestQuotaReset(config, currentTime);
			const reset = earliestReset === undefined
				? "an unknown reset time"
				: formatResetIn(Math.ceil((earliestReset - currentTime) / 1000));
			ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota; all configured keys are quota-blocked. Earliest reset in ${reset}.`, "warning");
		}

		function stopWatchdog(): ProviderTimeoutInfo | undefined {
			const timeoutInfo = watchdog?.consumeTimeoutInfo();
			watchdog?.stop();
			watchdog = undefined;
			return timeoutInfo;
		}

		function resetWatchdogAbortState(): void {
			watchdogAbortPending = false;
			watchdogAbortMessage = undefined;
			watchdogTimeoutInfo = undefined;
		}

		function clearWatchdogTimeoutGuard(): void {
			watchdogRequestTimedOut = false;
		}

		function recordWatchdogEvent(event: WatchdogEvent): void {
			watchdogEvents.push(event);
			while (watchdogEvents.length > 10) watchdogEvents.shift();
		}

		function rotateForWatchdog(ctx: Pick<ExtensionContext, "modelRegistry" | "ui">, timeoutInfo: ProviderTimeoutInfo, rateLimitAlreadyRotated: boolean): { keyName?: string; rotated: boolean } {
			if (!refreshConfig()) return { rotated: false };
			const currentTime = now();
			if (config.keys.length <= 1) return { rotated: false };
			if (shouldRotateAfterWatchdogTimeout(timeoutInfo, rateLimitAlreadyRotated)) {
				const previousIndex = config.activeKeyIndex;
				const nextIndex = mutateSharedConfig((freshConfig) => benchAndSelectNextKey(
					freshConfig,
					keyRanking,
					freshConfig.activeKeyIndex,
					{ kind: "cooldown" },
					currentTime,
				));
				if (nextIndex === undefined) return { keyName: applyKey(ctx, currentTime), rotated: false };
				const rotated = nextIndex !== previousIndex;
				if (rotated) invalidateAutomaticDecisions();
				return { keyName: applyKey(ctx, currentTime), rotated };
			}
			return { keyName: applyKey(ctx, currentTime), rotated: false };
		}

		function startWatchdog(ctx: Pick<ExtensionContext, "modelRegistry" | "ui" | "abort">): void {
			if (!refreshConfig()) return;
			applyKey(ctx);
			stopWatchdog();
			resetWatchdogAbortState();
			clearWatchdogTimeoutGuard();
			if (!config.watchdogEnabled) return;
			const idleMs = getWatchdogIdleMs(config);
			watchdog = new ProviderIdleWatchdog({
				idleMs,
				onTimeout: () => {
					const rateLimitAlreadyHandled = getCurrentRequestRateLimitState()?.responseHandled ?? false;
					invalidateAutomaticDecisions();
					watchdogRequestTimedOut = true;
					const timeoutInfo = watchdog?.currentTimeoutInfo() ?? {
						phase: "waiting-for-response",
						idleMs,
						elapsedMs: idleMs,
						idleForMs: idleMs,
					};
					const previousKey = config.keys[config.activeKeyIndex]?.name;
					const rotation = rotateForWatchdog(ctx, timeoutInfo, rateLimitAlreadyHandled);
					watchdogTimeoutInfo = timeoutInfo;
					recordWatchdogEvent({
						time: now(),
						keyName: previousKey,
						rotatedTo: rotation.rotated ? rotation.keyName : undefined,
						activeKey: rotation.keyName,
						...timeoutInfo,
					});
					watchdogAbortPending = true;
					watchdogAbortMessage = rotation.keyName
						? `OpenCode Go timeout: ${formatTimeoutInfo(timeoutInfo)}; ${rotation.rotated ? "rotated to" : "using"} ${rotation.keyName}; retrying.`
						: `OpenCode Go timeout: ${formatTimeoutInfo(timeoutInfo)}; no other key available.`;
					ctx.ui.notify(watchdogAbortMessage, rotation.keyName ? "info" : "warning");
					ctx.abort();
				},
				timers: options.timers,
				clock: options.clock,
			});
			watchdog.start();
		}

		async function autoImportFromAuth(ctx: Pick<ExtensionContext, "modelRegistry" | "ui">): Promise<boolean> {
			const authKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
			if (!authKey) return false;
			const imported = mutateSharedConfig((freshConfig) => {
				if (freshConfig.keys.some((entry) => entry.key === authKey)) return false;
				freshConfig.keys.push({ name: "auth", key: authKey });
				return true;
			});
			return imported === true;
		}

		pi.on("session_start", async (event, ctx) => {
			lastAppliedRuntimeKeys.delete(ctx.modelRegistry);
			invalidateAutomaticDecisions();
			requestRateLimitState = undefined;
			clearWatchdogTimeoutGuard();
			// A manual pick lasts for the session that made it, never across sessions.
			pinnedKeyIndex = undefined;
			expiryWarningShown = false;
			if (!ensureConfig(ctx)) return;
			// Decide the session's key from the monthly reset the provider reports. The probe is
			// started here but never awaited: it lands before the first request in practice, and a
			// slow or failed usage call must not hold up startup. Nothing is announced: the footer
			// label follows whichever key ends up applied.
			ignoreAsyncRefresh(refreshKeyRanking(ctx, { force: true, warn: true }));
			installFooter(ctx);
			// A block recorded in an earlier session can be stale: the plan was topped up, or the
			// window reset before the deadline we stored. Re-check before it decides which key this
			// session uses, rather than benching a key that is usable again -- or leaving every key
			// held by a block with nothing left to rotate to.
			if (config.keys.length > 0) {
				const currentTime = now();
				const activeBlocked = getQuotaBlockedUntil(config, config.activeKeyIndex, currentTime) !== undefined;
				if (activeBlocked || selectPreferredKeyIndex(config, keyRanking, currentTime, pinnedKeyIndex) === undefined) {
					const operation = currentRotationOperation(currentTime);
					if (!operation) return;
					const recovery = await recoverQuotaBlocksGuarded(ctx, operation, currentTime);
					// A startup continuation invalidated while probes were in flight must not
					// clear blocks or re-apply a key on top of the newer decision.
					if (recovery === "cancelled") return;
					if (usageDecisionEpoch !== operation.epoch) return;
					if (!refreshConfig()) return;
				}
			}
			// On reload: re-apply active key, skip auto-import
			if (event.reason === "reload") {
				applySynchronizedActiveKey(ctx);
				return;
			}
			if (config.keys.length === 0) {
				if (await autoImportFromAuth(ctx)) {
					const keyName = applySynchronizedActiveKey(ctx);
					if (keyName) ctx.ui.notify(`OpenCode: Imported key from auth.json → ${keyName}`, "info");
				} else if (configError) {
					ctx.ui.notify(`OpenCode: ${configError}.`, "error");
					return;
				} else {
					ctx.ui.notify("OpenCode: No keys configured. Use /opencode add <name> <key>", "warning");
					return;
				}
			}
			applySynchronizedActiveKey(ctx);
		});

		pi.on("before_provider_request", (event, ctx) => {
			if (!shouldWatchProvider(ctx.model?.provider)) {
				invalidateAutomaticDecisions();
				requestRateLimitState = undefined;
				stopWatchdog();
				resetWatchdogAbortState();
				clearWatchdogTimeoutGuard();
				return;
			}
			beginProviderRequest(ctx);
			startWatchdog(ctx);
			return sanitizeReasoningPayload(event.payload);
		});

		pi.on("message_update", (event) => {
			const message = event.message;
			if (message.role !== "assistant" || !shouldWatchProvider(message.provider)) return;
			watchdog?.streamActivity();
		});

		pi.on("message_end", async (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant" || message.provider !== PROVIDER) return;

			const timeoutInfo = stopWatchdog() ?? watchdogTimeoutInfo;
			if (timeoutInfo || watchdogAbortPending) {
				const errorMessage = watchdogAbortMessage ?? `OpenCode Go timeout: ${timeoutInfo ? formatTimeoutInfo(timeoutInfo) : "no provider activity"}; retrying.`;
				resetWatchdogAbortState();
				return {
					message: {
						...message,
						stopReason: "error",
						errorMessage,
					},
				};
			}

			if (message.stopReason !== "error") {
				invalidateAutomaticDecisions();
				return;
			}
			const rateLimitKind = classifyRateLimitError(message.errorMessage ?? "");
			if (!rateLimitKind) {
				invalidateAutomaticDecisions();
				return;
			}
			if (!refreshConfig()) return;
			const requestState = getCurrentRequestRateLimitState();
			if (!requestState) return;
			if (rateLimitKind === "fixed-window-quota") {
				const currentTime = now();
				const authoritativeReset = parseFixedWindowQuotaReset(message.errorMessage ?? "", currentTime);
				const blockedUntil = authoritativeReset ?? currentTime + getCooldownMs(config);
				const exhaustedName = config.keys[requestState.decision.target.keyIndex]?.name
					|| `key-${requestState.decision.target.keyIndex + 1}`;
				if (requestState.responseHandled) {
					const persisted = mutateSharedConfig((freshConfig) => {
						// The handled response may upgrade the reset of its own credential, but never
						// of whatever credential now occupies that index.
						if (!matchesUsageTarget(freshConfig, requestState.decision.target)) return false;
						if (authoritativeReset === undefined) {
							setQuotaBlock(freshConfig, requestState.decision.target.keyIndex, blockedUntil, currentTime);
						} else {
							freshConfig.quotaBlockedUntil[requestState.decision.target.keyIndex] = authoritativeReset;
						}
						return true;
					});
					if (persisted !== true && configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
					invalidateAutomaticDecisions();
					return;
				}
				const operation = currentRotationOperation(currentTime);
				if (!operation || operation.selection.keyIndex !== requestState.decision.target.keyIndex) return;
				const outcome = await rotateWithRecovery(ctx, operation, currentTime, {
					kind: "quota",
					blockedUntil,
					authoritative: authoritativeReset !== undefined,
				});
				if (outcome.kind === "cancelled") return;
				if (outcome.kind === "unavailable") {
					if (usageDecisionEpoch !== operation.epoch) return;
					reportQuotaExhausted(ctx, exhaustedName, currentTime);
					return;
				}
				if (!isCompletionCurrent(outcome)) return;
				if (outcome.kind === "none") {
					reportQuotaExhausted(ctx, exhaustedName, currentTime);
					return;
				}
				invalidateAutomaticDecisions();
				const keyName = applyKey(ctx, currentTime) ?? `key-${outcome.keyIndex + 1}`;
				ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota → rotated to ${keyName}`, "info");
				return;
			}
			if (requestState.responseHandled) {
				invalidateAutomaticDecisions();
				return;
			}

			if (config.keys.length <= 1) {
				invalidateAutomaticDecisions();
				ctx.ui.notify("OpenCode: Rate limited — no other keys to rotate to.", "warning");
				return;
			}

			const currentTime = now();
			const operation = currentRotationOperation(currentTime);
			if (!operation || operation.selection.keyIndex !== requestState.decision.target.keyIndex) return;
			const cachedRollingReset = keyRanking.get(operation.selection.keyIndex)?.rollingResetAt;
			const outcome = await rotateWithRecovery(ctx, operation, currentTime, {
				kind: "cooldown",
				until: cachedRollingReset !== undefined && cachedRollingReset > currentTime ? cachedRollingReset : undefined,
			});
			if (outcome.kind === "cancelled") return;
			if (outcome.kind === "unavailable") {
				if (usageDecisionEpoch !== operation.epoch) return;
				ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
				return;
			}
			// Never finalize a decision that lost ownership while the rotation was in flight.
			if (!isCompletionCurrent(outcome)) return;
			if (outcome.kind === "none") {
				invalidateAutomaticDecisions();
				ctx.ui.notify("OpenCode: Rate limited; all other keys are quota-blocked.", "warning");
				return;
			}
			invalidateAutomaticDecisions();
			const keyName = applyKey(ctx, currentTime);
			ctx.ui.notify(`OpenCode: Rate-limited → rotated to ${keyName ?? `key-${outcome.keyIndex + 1}`}`, "info");
		});

		pi.on("after_provider_response", async (event, ctx) => {
			if (ctx.model?.provider !== PROVIDER) return;
			watchdog?.response(event.status);
			if (event.status !== 429 && event.status !== 401) return;
			if (watchdogRequestTimedOut) return;
			if (!refreshConfig()) return;
			const requestState = getCurrentRequestRateLimitState();
			if (!requestState) return;
			const decision = requestState.decision;
			const operation = currentRotationOperation(now());
			if (!operation || operation.selection.keyIndex !== decision.target.keyIndex) return;
			// Bookkeeping for this response is allowed only while it still owns the request state.
			const markHandledIfOwned = () => {
				if (requestRateLimitState === requestState) markResponseRateLimitHandled(decision);
			};
			if (event.status === 401) requestRateLimitState = undefined;
			const usage = await fetchOpenCodeGoUsage(decision.target, fetchApi, options.timers);
			if (!refreshConfig()) return;
			if (!isRotationOperationCurrent(operation, config, usageDecisionEpoch)) return;
			const currentTime = now();
			const exhaustedName = config.keys[decision.target.keyIndex]?.name || `key-${decision.target.keyIndex + 1}`;
			if (usage.ok) {
				// The response carried a fresh reading: it supersedes whatever the last probe said.
				keyRanking = new Map(keyRanking).set(decision.target.keyIndex, summarizeUsage(usage.usage, currentTime));
			}
			if (usage.ok && hasRateLimitedUsageWindow(usage)) {
				const outcome = await rotateWithRecovery(ctx, operation, currentTime, {
					kind: "quota",
					blockedUntil: getRateLimitedUntil(usage.usage, currentTime, getCooldownMs(config)),
					authoritative: false,
				});
				if (outcome.kind === "cancelled") return;
				if (outcome.kind === "unavailable") {
					if (usageDecisionEpoch !== operation.epoch) return;
					reportQuotaExhausted(ctx, exhaustedName, currentTime);
				} else if (!isCompletionCurrent(outcome)) {
					return;
				} else if (outcome.kind === "rotated") {
					invalidateAutomaticDecisions();
					const keyName = applyKey(ctx, currentTime) ?? `key-${outcome.keyIndex + 1}`;
					ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota → rotated to ${keyName}`, "info");
				} else {
					reportQuotaExhausted(ctx, exhaustedName, currentTime);
				}
				if (event.status === 429) markHandledIfOwned();
				ctx.ui.notify(formatUsageStatus(usage), "warning");
				return;
			}
			if (event.status === 401) {
				// A rejected credential is a key problem, not a quota problem: hand the session to
				// the fallback and leave the key unblocked so it can be fixed with `/opencode add`.
				if (config.keys.length <= 1) {
					ctx.ui.notify(`OpenCode: ${exhaustedName} was rejected (HTTP 401) and no fallback key is configured.`, "warning");
					return;
				}
				const fallback = firstEligibleRankedKey(config, keyRanking, currentTime, decision.target.keyIndex);
				if (fallback === undefined) {
					ctx.ui.notify(`OpenCode: ${exhaustedName} was rejected (HTTP 401); every fallback key is blocked.`, "warning");
					return;
				}
				pinnedKeyIndex = fallback;
				invalidateAutomaticDecisions();
				const fallbackName = applyKey(ctx, currentTime)
					?? `key-${fallback + 1}`;
				ctx.ui.notify(`OpenCode: ${exhaustedName} was rejected (HTTP 401) → using ${fallbackName}. Replace that key with /opencode add.`, "warning");
				return;
			}
			if (config.keys.length <= 1) {
				markHandledIfOwned();
				return;
			}

			const usageRollingReset = usage.ok ? getRollingResetUntil(usage.usage, currentTime) : undefined;
			const cachedRollingReset = keyRanking.get(decision.target.keyIndex)?.rollingResetAt;
			const outcome = await rotateWithRecovery(ctx, operation, currentTime, {
				kind: "cooldown",
				until: usageRollingReset
					?? (cachedRollingReset !== undefined && cachedRollingReset > currentTime ? cachedRollingReset : undefined),
			});
			if (outcome.kind === "cancelled") return;
			if (outcome.kind === "unavailable") {
				if (usageDecisionEpoch !== operation.epoch) return;
				if (configError) ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
				else {
					invalidateAutomaticDecisions();
					markHandledIfOwned();
					ctx.ui.notify("OpenCode: HTTP 429; all other keys are quota-blocked.", "warning");
				}
				return;
			}
			if (!isCompletionCurrent(outcome)) return;
			if (outcome.kind === "none") {
				if (configError) ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
				else {
					invalidateAutomaticDecisions();
					markHandledIfOwned();
					ctx.ui.notify("OpenCode: HTTP 429; all other keys are quota-blocked.", "warning");
				}
				return;
			}
			invalidateAutomaticDecisions();
			markHandledIfOwned();
			const keyName = applyKey(ctx, currentTime);
			ctx.ui.notify(`OpenCode: Proactive rate-limit detection (HTTP 429) → rotated to ${keyName ?? `key-${outcome.keyIndex + 1}`}`, "info");
		});

		pi.registerCommand("opencode", {
			description: "Manage OpenCode API key rotation",
			handler: async (args, ctx) => {
				if (!ensureConfig(ctx)) return;
				const parts = args.trim().split(/\s+/);
				const subcommand = parts[0] || "status";
				const indexArg = parseInt(parts[1] ?? "", 10);

				switch (subcommand) {
					case "status":
					case "list":
					case "ls": {
						await refreshKeyRanking(ctx, { warn: true });
						if (!refreshConfig()) return;
						ctx.ui.notify(formatStatus(config, keyRanking, pinnedKeyIndex, now()), "info");
						break;
					}

					case "events":
					case "timeouts": {
						ctx.ui.notify(formatWatchdogEvents(watchdogEvents, now()), "info");
						break;
					}

					case "usage":
					case "quota": {
						applySynchronizedActiveKey(ctx);
						const usage = await fetchOpenCodeGoUsage(getActiveUsageTarget(config), fetchApi, options.timers);
						ctx.ui.notify(formatUsageStatus(usage), usage.ok ? "info" : "warning");
						break;
					}

					case "use": {
						const targetIndex = indexArg - 1;
						invalidateAutomaticDecisions();
						const result = mutateSharedConfig((freshConfig) => {
							if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= freshConfig.keys.length) {
								return { error: `Invalid index. Use 1-${freshConfig.keys.length}.` };
							}
							freshConfig.activeKeyIndex = targetIndex;
							delete freshConfig.cooldownUntil[targetIndex];
							delete freshConfig.quotaBlockedUntil[targetIndex];
							return { index: targetIndex };
						});
						if (!result) {
							if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
							return;
						}
						if ("error" in result && typeof result.error === "string") {
							ctx.ui.notify(result.error, "warning");
							return;
						}
						if ("index" in result && typeof result.index === "number") pinnedKeyIndex = result.index;
						const keyName = applyKey(ctx);
						ctx.ui.notify(`Switched to ${keyName} (pinned for this session)`, "info");
						break;
					}

					case "next": {
						invalidateAutomaticDecisions();
						const currentIndex = config.activeKeyIndex;
						// `next` stays a plain advance through the configured list: predictable, and the
						// pin it sets is what actually overrides the expiry ranking.
						const nextIndex = config.keys.length === 0 ? undefined : (currentIndex + 1) % config.keys.length;
						if (nextIndex === undefined) {
							ctx.ui.notify("No keys configured. Use /opencode add <name> <key>.", "warning");
							return;
						}
						const result = mutateSharedConfig((freshConfig) => {
							if (freshConfig.keys.length === 0) return { error: "No keys configured. Use /opencode add <name> <key>." };
							freshConfig.activeKeyIndex = Math.min(nextIndex, freshConfig.keys.length - 1);
							delete freshConfig.cooldownUntil[freshConfig.activeKeyIndex];
							delete freshConfig.quotaBlockedUntil[freshConfig.activeKeyIndex];
							return { index: freshConfig.activeKeyIndex };
						});
						if (!result) {
							if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
							return;
						}
						if ("error" in result && typeof result.error === "string") {
							ctx.ui.notify(result.error, "warning");
							return;
						}
						if ("index" in result && typeof result.index === "number") pinnedKeyIndex = result.index;
						const keyName = applyKey(ctx);
						ctx.ui.notify(`Switched to ${keyName} (pinned for this session)`, "info");
						break;
					}

					case "add": {
						const name = parts[1];
						const key = parts[2];
						if (!name || !key) {
							ctx.ui.notify("Usage: /opencode add <name> <key>", "warning");
							return;
						}
						invalidateAutomaticDecisions();
						const count = mutateSharedConfig((freshConfig) => {
							freshConfig.keys.push({ name, key });
							if (freshConfig.keys.length === 1) freshConfig.activeKeyIndex = 0;
							return freshConfig.keys.length;
						});
						if (count === undefined) {
							if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
							return;
						}
						if (count === 1) applyKey(ctx);
						ctx.ui.notify(`Added "${name}" (${count} keys)`, "info");
						break;
					}

					case "remove":
					case "rm": {
						const removeIndex = indexArg - 1;
						invalidateAutomaticDecisions();
						const result = mutateSharedConfig((freshConfig) => {
							if (isNaN(removeIndex) || removeIndex < 0 || removeIndex >= freshConfig.keys.length) {
								return { error: `Invalid index. Use 1-${freshConfig.keys.length}.` };
							}
							const removed = freshConfig.keys.splice(removeIndex, 1)[0];
							freshConfig.cooldownUntil = reindexAfterRemoval(freshConfig.cooldownUntil, removeIndex);
							freshConfig.quotaBlockedUntil = reindexAfterRemoval(freshConfig.quotaBlockedUntil, removeIndex);
							if (freshConfig.activeKeyIndex >= freshConfig.keys.length) freshConfig.activeKeyIndex = 0;
							else if (removeIndex < freshConfig.activeKeyIndex) freshConfig.activeKeyIndex--;
							if (pinnedKeyIndex === removeIndex) pinnedKeyIndex = undefined;
							else if (pinnedKeyIndex !== undefined && removeIndex < pinnedKeyIndex) pinnedKeyIndex--;
							return { removedName: removed.name, count: freshConfig.keys.length };
						});
						if (!result) {
							if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
							return;
						}
						if ("error" in result && typeof result.error === "string") {
							ctx.ui.notify(result.error, "warning");
							return;
						}
						if (config.keys.length > 0) applyKey(ctx);
						else {
							lastAppliedRuntimeKeys.delete(ctx.modelRegistry);
							clearSeededProviderEnv();
							clearAuthKey(PROVIDER, []);
							ignoreAsyncRefresh(getRuntimeKeyStore(ctx.modelRegistry).removeRuntimeApiKey(PROVIDER));
						}
						ctx.ui.notify(`Removed "${result.removedName}" (${result.count} left)`, "info");
						break;
					}

					case "reset": {
						invalidateAutomaticDecisions();
						const result = mutateSharedConfig((freshConfig) => {
							freshConfig.cooldownUntil = {};
							freshConfig.quotaBlockedUntil = {};
							return true;
						});
						if (result !== true) {
							if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
							return;
						}
						pinnedKeyIndex = undefined;
						ctx.ui.notify("All cooldowns and quota blocks cleared; key order reset", "info");
						break;
					}

					case "cooldown": {
						const minutes = parseInt(parts[1], 10);
						if (isNaN(minutes) || minutes < 1) {
							ctx.ui.notify(`Cooldown: ${config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES} min`, "info");
							return;
						}
						const result = mutateSharedConfig((freshConfig) => {
							freshConfig.cooldownMinutes = minutes;
							return true;
						});
						if (result !== true) {
							if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
							return;
						}
						ctx.ui.notify(`Cooldown set to ${minutes} min`, "info");
						break;
					}

					case "authfile": {
						const value = parts[1];
						if (value !== "on" && value !== "off") {
							ctx.ui.notify(`auth.json mirror: ${config.syncAuthFile ? "on" : "off"} (usage: /opencode authfile on|off)`, "info");
							return;
						}
						const enabled = value === "on";
						const result = mutateSharedConfig((freshConfig) => {
							freshConfig.syncAuthFile = enabled;
							return true;
						});
						if (result !== true) {
							if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
							return;
						}
						if (enabled) mirrorActiveKeyInAuthFile();
						else clearAuthKey(PROVIDER, config.keys.map((entry) => entry.key));
						ctx.ui.notify(`auth.json mirror ${enabled ? "enabled" : "disabled"}`, "info");
						break;
					}

					case "watchdog": {
						const value = parts[1];
						if (!value || value === "status") {
							const events = formatWatchdogEvents(watchdogEvents, now());
							ctx.ui.notify(`Watchdog: ${config.watchdogEnabled ? "on" : "off"} (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)\n${events}`, "info");
							return;
						}
						if (value === "on" || value === "off") {
							const enabled = value === "on";
							const result = mutateSharedConfig((freshConfig) => {
								freshConfig.watchdogEnabled = enabled;
								return true;
							});
							if (result !== true) {
								if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
								return;
							}
							if (!enabled) {
								stopWatchdog();
								resetWatchdogAbortState();
							}
							ctx.ui.notify(enabled ? `Watchdog enabled (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)` : "Watchdog disabled", "info");
							return;
						}
						const seconds = parseInt(value, 10);
						if (isNaN(seconds) || seconds < 1) {
							ctx.ui.notify("Usage: /opencode watchdog [status|on|off|<seconds>]", "warning");
							return;
						}
						const result = mutateSharedConfig((freshConfig) => {
							freshConfig.watchdogEnabled = true;
							freshConfig.watchdogIdleMs = seconds * 1000;
							return true;
						});
						if (result !== true) {
							if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
							return;
						}
						ctx.ui.notify(`Watchdog enabled (${seconds}s idle)`, "info");
						break;
					}

					default:
						ctx.ui.notify(
							"Usage: /opencode [status|usage|quota|events|use <n>|next|add <name> <key>|rm <n>|reset|cooldown <min>|authfile [on|off]|watchdog [status|on|off|<seconds>]]",
							"info",
						);
				}
			},
		});

		function cleanupLifecycleState(): void {
			invalidateAutomaticDecisions();
			requestRateLimitState = undefined;
			stopWatchdog();
			resetWatchdogAbortState();
			clearWatchdogTimeoutGuard();
		}

		pi.on("agent_end", () => {
			cleanupLifecycleState();
		});

		pi.on("session_shutdown", (_event, ctx) => {
			cleanupLifecycleState();
			// The footer is ours: restore Pi's built-in one when this session goes away.
			footerTui = undefined;
			footerKeyName = undefined;
			if (ctx?.mode === "tui") ctx.ui.setFooter(undefined);
		});
	};
}

const extension = createOpencodeGoRotationExtension();
export default extension;
