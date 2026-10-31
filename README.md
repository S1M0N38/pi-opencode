# pi-opencode

Spend the OpenCode Go plan that expires first. The extension ranks your keys by the monthly reset the usage endpoint reports, uses the earliest-expiring key as primary, keeps the others as fallbacks, and only leaves the primary when it is rate-limited, quota-blocked, or stalled.

## Install

pi installs this extension straight from git; no npm release is involved.

```bash
pi install git:github.com/S1M0N38/pi-opencode
```

That tracks the `main` branch. To stay on a known-good release, pin a tag:

```bash
pi install git:github.com/S1M0N38/pi-opencode@v1.5.3
```

A pinned tag does not move. Update an unpinned install with:

```bash
pi update git:github.com/S1M0N38/pi-opencode
```

The clone lands in `~/.pi/agent/git/github.com/S1M0N38/pi-opencode`, which is a package, so `pi remove git:github.com/S1M0N38/pi-opencode` uninstalls it.

## Setup

Add your API keys:

```
/opencode add personal sk-xxxx
/opencode add work sk-yyyy
/opencode add backup sk-zzzz
```

The first key added becomes active immediately.

## How it works

The extension sets the active key as a runtime override, which takes priority over `OPENCODE_API_KEY` environment variables and `auth.json` credentials.

Pi resolves `enabledModels` and the startup model before `session_start`, so the runtime override alone is too late for startup model selection: `opencode-go` looks unconfigured and its configured models are filtered out until the model scope is reopened. To keep the provider visible at startup, the extension also seeds `OPENCODE_API_KEY` from the active key when that variable is unset. Requests still use the runtime override, so rotation is unchanged. Removing the last key clears a variable the extension seeded; a value you set yourself is left untouched.

### Selection: earliest monthly reset first

At `session_start` the extension calls `https://opencode.ai/zen/go/v1/usage` once per key (fire-and-forget, never on the request path) and ranks them:

1. earliest `monthly.resetsAt` first — spend the quota that is about to be thrown away,
2. then the highest `monthly.percent` — between two keys on the same reset day, drain the fuller plan,
3. then the key this installation used last, so a stale or unreadable ranking never silently reverts to key #1,
4. then key index, so the order is deterministic.

A key whose expiry cannot be read ranks last; the extension never promotes a deadline it does not know. The ranking is cached for 15 minutes and re-read at the next `session_start` or request boundary after that, so the primary flips by itself once the current month's earliest plan renews. No key is hard-coded.

The ranking only decides *order*. A key is skipped while it carries a quota block or a transient cooldown, and `/opencode use <n>` or `/opencode next` pins a key for the rest of the session.

### Status bar

Nothing is printed at startup. The key in use is shown in the status bar instead, right-aligned on the first line, next to the project directory:

```
~/Developer/forks/pi-opencode (main)                            university
↑12k ↓3.1k R96k W4.2k CH85.3% $0.481 40.2%/200k (auto)   (anthropic) claude-sonnet-4-5 • medium
```

The name is drawn in the same dim text as the rest of the status bar, with no prefix and no highlight. It follows every switch (rotation, manual pin, quota recovery) and stays empty while no key is configured.

Because the extension owns the footer in interactive mode, it reproduces every field Pi's footer shows, in the same order: folder (with git branch and session name), token input/output, `R`/`W` cache read and write, `CH` cache hit rate, cost (with `(sub)` for subscription providers), context percentage and window with the `(auto)` compaction marker, and the model with its thinking level and `(provider)` prefix when more than one provider has models. Token totals include tool, compaction, and branch-summary usage, and the separate line used by other extensions' `ctx.ui.setStatus()` texts is still rendered.

One field cannot be reproduced: for routed virtual models Pi shows `model → routed-model`, and that routing is not exposed to extensions. `/opencode status` still prints the full ranked list. Non-interactive modes are left alone: Pi's built-in footer stays in charge.

### Callers that run `pi --no-extensions`

Some tools (T3 Code's commit-message and PR-text generation, editor integrations, scripts) spawn a second `pi` with `--no-extensions`. That process loads no extensions, so the runtime key this extension applies is invisible to it, `opencode-go` looks unconfigured, and the request fails with `Model not found: opencode-go/...`.

To fix that, the active key is mirrored into pi's own credential store (`~/.pi/agent/auth.json`, mode `0600`) as the provider's `api_key` credential. Those callers read it without loading any extension, and normal sessions are unaffected because pi's auth chain still prefers the runtime override. The mirror is rewritten on every key switch, so an extensionless caller uses the same primary the session would.

It is conservative: an OAuth login, or an API key you typed yourself and that is not one of this extension's keys, is never replaced. Removing the last key removes the mirrored entry. Turn it off with `/opencode authfile off` (the setting is `syncAuthFile` in the config file). The write is atomic (`tmp` + `rename`) but does not take pi's credential lock, so avoid running `/login` for `opencode-go` at the exact moment a rotation happens.

### Fallback paths

1. **Usage-verified Go quota exhaustion**: when OpenCode Go returns HTTP 429, the extension sends the active key only to `https://opencode.ai/zen/go/v1/usage`. If a usage window is `rate-limited`, the failed key is blocked until the latest reported reset and the next non-quota-blocked key is activated. Rotation prefers keys outside transient cooldown, but can clear a cooldown rather than keep using an exhausted key. Repeated failures try each configured key once. When every key is quota-blocked, rotation stops and reports the earliest reset instead of cycling.
2. **Transient limit errors**: when the usage endpoint is unavailable, does not report a rate-limited window, or does not finish within 10 seconds, the key is benched until its `rolling` window reopens (that deadline is in the usage response). Only when no deadline is known does the configured cooldown apply. The next eligible key in the ranking takes over.
3. **Silent stalls**: when an `opencode-go` provider request has no response or stream activity for the watchdog window, the extension moves to the next eligible key in the ranking, aborts the hung turn, and rewrites the abort as a retryable timeout error.
4. **Rejected credential (HTTP 401)**: the key is not blocked -- it is a key problem, not a quota one. The session falls back to the next eligible key and warns; fix the key with `/opencode add`.

Beyond the ranking probe, the extension never pre-checks limits: a key is only aborted or rotated in reaction to a real failure.

Fixed-window Go plan quota errors reported at message end follow the same rotation path. A parseable reset timestamp is authoritative; otherwise the configured cooldown duration is used as the block duration. A response-hook rotation is deduplicated so the matching message-end error cannot rotate twice.

Pi's built-in auto-retry picks up the new key on the next request.

Cooldowns default to 60 minutes and are only the blind fallback. Quota blocks expire at their persisted deadline. Manual `/opencode use <n>` and `/opencode next` clear both restrictions on the selected key and pin it for the session, so the next rotation does not snap back.

Usage commands use `https://opencode.ai/zen/go/v1/usage` and stop waiting after 10 seconds. A timeout reports `Usage request timed out after 10s.`.

## Commands

| Command | Description |
|---------|-------------|
| `/opencode` or `/opencode status` | Show keys ranked by monthly reset, primary/fallback role, monthly usage, cooldown and quota-blocked status |
| `/opencode usage` or `/opencode quota` | Fetch OpenCode Go usage for the active key without showing key material |
| `/opencode use <n>` | Switch to key number `n` (1-based), clear its cooldown and quota block, and pin it for this session |
| `/opencode next` | Advance to the next configured key (wrapping), clear its restrictions, and pin it for this session |
| `/opencode add <name> <key>` | Add a new key |
| `/opencode rm <n>` | Remove key number `n` |
| `/opencode reset` | Clear all cooldowns, quota blocks, and the session pin |
| `/opencode cooldown <min>` | Set or view cooldown duration in minutes |
| `/opencode authfile [on\|off]` | Mirror the active key into `auth.json` for callers that run `pi --no-extensions` |
| `/opencode events` | Show recent watchdog timeout history (last 10) |
| `/opencode watchdog [status\|on\|off\|<seconds>]` | Configure silent-stall detection |

## Configuration

Keys are stored in `~/.pi/agent/opencode-keys.json` with file permissions `0600`. Status output shows key names only; it does not display key material.

```json
{
  "keys": [
    { "name": "personal", "key": "sk-xxx" },
    { "name": "work", "key": "sk-yyy" }
  ],
  "activeKeyIndex": 0,
  "cooldownMinutes": 60,
  "watchdogEnabled": true,
  "watchdogIdleMs": 90000,
  "syncAuthFile": true,
  "cooldownUntil": {},
  "quotaBlockedUntil": {}
}
```

### Retry settings

Pair with pi's auto-retry for best results. In `~/.pi/agent/settings.json`:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3
  }
}
```

Set `maxRetries` to at least the number of keys so all keys get a chance before pi gives up.

## Limitations

- The watchdog is scoped to the `opencode-go` provider only. Other providers are not aborted or rotated.
- A legitimate long-running request with no stream activity can be treated as stalled; tune with `/opencode watchdog <seconds>` or disable with `/opencode watchdog off`.
- When all non-quota-blocked keys are transiently cooling down, the extension may clear a cooldown early. It never automatically clears or force-selects a quota-blocked key.
- The expiry probe is deliberately off the request path. If the very first request of a session starts before the usage call answers, it uses the previously persisted key and the ranked key applies from the next request on; the status bar follows whichever key is actually applied.
- Expansion is ranking-only: the extension never splits a single conversation across keys, because switching keys mid-turn costs a retry.
- When all keys are quota-blocked, automatic rotation stops on the current runtime key until a block expires or a manual command clears one.
- Go plan usage limits are tied to the subscription workspace; multiple keys from one workspace should not be assumed to provide independent quota. See the [OpenCode Go documentation](https://opencode.ai/docs/go/).
- Keys added via `/opencode add` are stored in plaintext. The config file is created and maintained with `0600` permissions.
- The `auth.json` mirror writes the same plaintext key into pi's credential store (also `0600`). Disable it with `/opencode authfile off` if you prefer the extension to leave that file untouched.

## Development

Pi loads `src/index.ts` directly, so there is no build step and no compiled output to keep in sync.

```bash
npm install
npm test
npm run typecheck
```

To load your working copy instead of the clone in `~/.pi/agent/git`, point pi at the path:

```bash
pi install ./   # adds the working directory to ~/.pi/agent/settings.json
```

## License

MIT
