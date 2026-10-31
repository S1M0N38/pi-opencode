import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Subprocesses that run `pi --no-extensions` (commit-message generators, editor
 * integrations, scripts) load no extensions, so they never see the runtime key this
 * extension applies. They do read pi's own credential store, so the active key is mirrored
 * into auth.json. Pi's auth chain prefers the runtime override, so normal sessions still
 * rotate exactly as before; the mirrored key only matters to extensionless callers.
 */
export const AUTH_FILE_NAME = "auth.json";
const AUTH_FILE_MODE = 0o600;
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export function getAuthFilePath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env[AGENT_DIR_ENV];
	const base = agentDir !== undefined && agentDir.length > 0
		? agentDir.replace(/^~(?=$|\/)/, homedir())
		: join(homedir(), ".pi", "agent");
	return join(base, AUTH_FILE_NAME);
}

export type AuthSyncResult = "written" | "unchanged" | "kept-foreign" | "unreadable";

interface StoredCredential {
	type?: unknown;
	key?: unknown;
	[field: string]: unknown;
}

type AuthFile = Record<string, StoredCredential>;

function readAuthFile(path: string): AuthFile | undefined {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as AuthFile;
	} catch {
		return undefined;
	}
}

function writeAuthFile(path: string, data: AuthFile): void {
	const serialized = `${JSON.stringify(data, null, 2)}\n`;
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		mkdirSync(dirname(path), { recursive: true });
		descriptor = openSync(temporaryPath, "wx", AUTH_FILE_MODE);
		writeSync(descriptor, serialized, undefined, "utf-8");
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(temporaryPath, AUTH_FILE_MODE);
		renameSync(temporaryPath, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporaryPath, { force: true });
	}
}

/**
 * Mirror `key` as the provider's API-key credential.
 *
 * A manual OAuth login, or an API key the user typed himself, is never replaced: only an
 * absent entry, an entry we already own, or a key that is one of this extension's keys is
 * rewritten. That keeps `/login` authoritative for people who do not use this extension's
 * rotation for subprocesses.
 */
export function syncAuthKey(
	provider: string,
	key: string,
	ownedKeys: readonly string[],
	path = getAuthFilePath(),
): AuthSyncResult {
	const data = readAuthFile(path);
	if (data === undefined) return "unreadable";
	const current = data[provider];
	if (current !== undefined && current.type === "api_key" && current.key === key) return "unchanged";
	const replaceable = current === undefined
		|| (current.type === "api_key" && typeof current.key === "string" && ownedKeys.includes(current.key));
	if (!replaceable) return "kept-foreign";
	writeAuthFile(path, { ...data, [provider]: { ...current, type: "api_key", key } });
	return "written";
}

/** Remove the mirrored credential when no key is configured, but only if it is still ours. */
export function clearAuthKey(
	provider: string,
	ownedKeys: readonly string[],
	path = getAuthFilePath(),
): "cleared" | "kept" | "missing" {
	const data = readAuthFile(path);
	if (data === undefined) return "kept";
	const current = data[provider];
	if (current === undefined) return "missing";
	if (current.type !== "api_key" || typeof current.key !== "string" || !ownedKeys.includes(current.key)) return "kept";
	const next = { ...data };
	delete next[provider];
	writeAuthFile(path, next);
	return "cleared";
}

/** True when auth.json exists and is a readable object; used for status output. */
export function authFileIsPresent(path = getAuthFilePath()): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}
