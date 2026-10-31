import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export declare function shouldWatchProvider(provider: string | undefined): boolean;
export type RateLimitKind = "transient" | "fixed-window-quota";
export declare function classifyRateLimitError(message: string): RateLimitKind | undefined;
export interface TimerApi {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(timer: unknown): void;
}
export type ProviderActivityPhase = "waiting-for-response" | "waiting-for-stream" | "streaming";
export interface ProviderTimeoutInfo {
    phase: ProviderActivityPhase;
    idleMs: number;
    elapsedMs: number;
    idleForMs: number;
    lastStatus?: number;
}
export declare function shouldRotateAfterWatchdogTimeout(timeoutInfo: ProviderTimeoutInfo, rateLimitAlreadyRotated: boolean): boolean;
export interface ClockApi {
    now(): number;
}
export interface FetchResponseApi {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
}
export type FetchApi = (url: string, init: {
    method: "GET";
    headers: Record<string, string>;
    signal?: AbortSignal;
}) => Promise<FetchResponseApi>;
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
export declare class ProviderIdleWatchdog {
    private timer;
    private active;
    private timedOut;
    private phase;
    private startedAt;
    private lastActivityAt;
    private lastStatus;
    private timeoutInfo;
    private readonly options;
    constructor(options: {
        idleMs: number;
        onTimeout: () => void;
        timers?: TimerApi;
        clock?: ClockApi;
    });
    start(): void;
    response(status: number): void;
    streamActivity(): void;
    activity(): void;
    stop(): void;
    consumeTimeoutInfo(): ProviderTimeoutInfo | undefined;
    currentTimeoutInfo(): ProviderTimeoutInfo | undefined;
    private markActivity;
    private now;
    private getTimers;
    private schedule;
    private clear;
}
export declare function parseOpenCodeGoUsage(value: unknown): OpenCodeGoUsageResponse | undefined;
export declare function formatResetIn(seconds: number): string;
export declare function formatUsageStatus(result: UsageFetchResult): string;
export declare function createOpencodeGoRotationExtension(options?: ExtensionOptions): (pi: ExtensionAPI) => void;
declare const extension: (pi: ExtensionAPI) => void;
export default extension;
