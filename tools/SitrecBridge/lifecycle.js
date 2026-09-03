export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export function parseIdleTimeout(value) {
    if (value === undefined || value === null || value === "") {
        return DEFAULT_IDLE_TIMEOUT_MS;
    }

    const timeout = Number(value);
    if (!Number.isFinite(timeout) || timeout < 0) {
        return DEFAULT_IDLE_TIMEOUT_MS;
    }

    return Math.floor(timeout);
}

/** Was the idle timeout ASKED for, or is it just the default? See shouldIdleExit. */
export function idleTimeoutIsExplicit(value) {
    if (value === undefined || value === null || value === "") return false;
    const timeout = Number(value);
    return Number.isFinite(timeout) && timeout >= 0;
}

/**
 * Should an idle bridge shut itself down?
 *
 * The idle timer exists to reap ABANDONED bridges so the 20-port fallback range cannot silently
 * fill up. Its problem is the proxy it used: "no MCP tool call for an hour" was taken to mean
 * "nobody is using this", and for a coding agent that is simply false. A Claude Code session
 * routinely spends hours editing, building and running tests without touching the browser once -
 * and the longer and more productive the session, the more certain it was to be killed mid-task.
 * (Measured: a session went 2h37m between its last screenshot and its next browser call, entirely
 * inside one refactor, and lost its bridge.)
 *
 * The honest liveness signal is the PARENT PROCESS, which is watched anyway. So on the DEFAULT
 * timeout a bridge only reaps itself once its parent is actually gone; a live parent means the
 * bridge is quiet, not abandoned. An EXPLICIT timeout is a caller instruction (tests, sandbox
 * supervisors, CI) and is honoured literally.
 *
 * Genuine port pressure is not this function's job: rankTakeoverCandidates handles it, and only
 * when the range is really full.
 */
export function shouldIdleExit({idleTimeoutMs, explicit, busy, msSinceActivity, parentAlive}) {
    if (!(idleTimeoutMs > 0)) return false;
    if (busy) return false;
    if (msSinceActivity < idleTimeoutMs) return false;
    return explicit || !parentAlive;
}

/** Default grace before a bridge that has NEVER relayed a call gives its port back. */
export const DEFAULT_UNUSED_RELEASE_MS = 3 * 60 * 1000;
/** Default grace before a bridge that HAS been used, but has gone quiet, gives its port back. */
export const DEFAULT_IDLE_RELEASE_MS = 30 * 60 * 1000;

/**
 * Should a bridge hand its port back to the pool while staying alive?
 *
 * The 20-port fallback range is a shared resource, but a port used to be held for the entire life
 * of the process that grabbed it. That is far too strong a claim: most bridges are started by
 * processes that will never touch Sitrec at all - `claude bg-spare` pre-warms, `claude
 * --remote-control` instances, and `codex app-server` daemons that outlive their conversations by
 * days. Measured on a normal working machine: 7 of 20 ports held, zero tool calls served between
 * them. The pool then fills, and the only recovery path was to KILL a session's bridge, which is
 * why the range filling up showed up as "I keep having to reconnect".
 *
 * So a port is a lease, not a property. Releasing it is not fatal - the process stays alive and
 * re-acquires a port on the next call that needs one (see ensureBound). That makes contention
 * cheap: a quiet bridge steps aside, and steps back in when it has something to do.
 *
 * Four things pin a lease:
 *   - `paired`      a sandbox bridge owns its port by construction; the container forwards it.
 *   - `busy`        requests are in flight, or Local Compute jobs are running.
 *   - `isActiveFallback`  the extension picked us as the bridge it actually talks to.
 *   - `isAnchor`    we are the oldest bound fallback, so releasing would leave the page with no
 *                   listener at all. Local Compute discovers the bridge by scanning the range from
 *                   the page, with no MCP call involved, so the range must never go empty while any
 *                   bridge exists. Anchoring on "oldest" is a deterministic tie-break: exactly one
 *                   bridge holds, with no negotiation and no race.
 */
export function shouldReleasePort({
    bound,
    paired,
    busy,
    everUsed,
    isActiveFallback,
    isAnchor,
    hasLocalComputeClients,
    msSinceActivity,
    unusedReleaseMs = DEFAULT_UNUSED_RELEASE_MS,
    idleReleaseMs = DEFAULT_IDLE_RELEASE_MS,
}) {
    if (!bound) return false;
    if (paired) return false;
    if (busy) return false;
    if (hasLocalComputeClients) return false;
    if (isActiveFallback) return false;
    if (isAnchor) return false;

    const grace = everUsed ? idleReleaseMs : unusedReleaseMs;
    if (!(grace > 0)) return false;
    return msSinceActivity >= grace;
}

/**
 * Which bound host-fallback bridge is the anchor - the one that must keep its port so the range
 * never goes empty? Oldest wins, with pid as a stable tie-break. Every bridge computes this from
 * the same /status data, so they all reach the same answer independently.
 */
export function isAnchorBridge(statuses, selfPid) {
    const bound = statuses
        .filter((status) =>
            status?.service === "SitrecBridge" &&
            status.pairedOrigin === null &&
            status.bound !== false &&
            Number.isInteger(status.pid)
        )
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.pid - b.pid);

    if (bound.length === 0) return true;
    return bound[0].pid === selfPid;
}

/**
 * Which peers may be asked to give up their port?
 *
 * The exclusions must match the pins in shouldReleasePort. A voluntary release refuses to drop the
 * extension the browser is routing through, or a connected Local Compute client - so an involuntary
 * takeover must not do it either, because releasePort() force-closes both sockets. (An in-flight
 * Local Compute *job* is already covered by `busy`; this is about an idle client that would simply
 * be disconnected under it.)
 *
 * Excluding them cannot deadlock: a bridge that gets no port now stays alive unbound and tries
 * again on its next call, which is a perfectly good outcome.
 *
 * Pre-v5 bridges report neither field. They stay eligible, which is the old behaviour and correct.
 */
export function rankTakeoverCandidates(statuses, parentPid) {
    return statuses
        .filter((status) =>
            status?.service === "SitrecBridge" &&
            status.pairedOrigin === null &&
            !status.busy &&
            !status.isActiveFallback &&
            !status.localComputeClients &&
            status.controlToken &&
            Number.isInteger(status.port)
        )
        .sort((a, b) => {
            // A bridge that has never relayed a single call is the cheapest thing to take a port
            // from - that is the bg-spare/remote-control/codex population, and taking their port
            // costs them nothing they were going to use.
            const aUsed = a.everUsed ? 1 : 0;
            const bUsed = b.everUsed ? 1 : 0;
            if (aUsed !== bUsed) return aUsed - bUsed;

            const activityDifference =
                (a.lastMcpActivityAt ?? a.startedAt ?? 0) -
                (b.lastMcpActivityAt ?? b.startedAt ?? 0);
            if (activityDifference !== 0) return activityDifference;

            const aSameParent = a.parentPid === parentPid ? 1 : 0;
            const bSameParent = b.parentPid === parentPid ? 1 : 0;
            if (aSameParent !== bSameParent) return bSameParent - aSameParent;

            return (a.startedAt ?? 0) - (b.startedAt ?? 0);
        });
}

// ── Host policy ─────────────────────────────────────────────────────────────

/** Idle exit for a bridge hosted by a batch Codex thread — see isBatchHost. */
export const DEFAULT_BATCH_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Is this bridge hosted by a BATCH Codex thread?
 *
 * `ancestorCommands` is the command line of our parent, then its parent, and so on up.
 *
 * The Codex plugin for Claude Code runs Codex through a detached broker (`app-server-broker.mjs`)
 * that keeps ONE `codex app-server` alive per workspace, starts a fresh thread in it for every
 * stop-time review and rescue task, and never unloads a thread. Codex starts every configured MCP
 * server afresh for each thread, so each of those threads left a bridge behind for the life of the
 * app-server, which is days. Measured 2026-09-02: 99 bridges under two such app-servers, 4.6 GB
 * resident, the oldest 29 hours; and one bridge call in 2,421 of those threads since July. A bridge
 * that finds itself under one is idle for good the moment its thread's turn ends, and its parent
 * being alive says nothing about it — exactly the case the parent-liveness rule in shouldIdleExit
 * gets wrong.
 *
 * An interactive Codex (the desktop app, or `codex` in a terminal) has no broker above it and is NOT
 * a batch host: its threads are long conversations that do come back to the browser after long
 * silences (measured gaps of 25–37 minutes), and for them the parent-liveness rule stays right.
 */
export function isBatchHost(ancestorCommands) {
    if (!Array.isArray(ancestorCommands) || ancestorCommands.length < 2) return false;
    const [parent, ...above] = ancestorCommands;
    if (!/app-server/.test(parent ?? "")) return false;
    return above.some((command) => /app-server-broker/.test(command ?? ""));
}

/**
 * The idle timeout a bridge should run with, and whether it is to be obeyed literally.
 *
 * Precedence: a paired sandbox bridge never idles out (its container owns it); a timeout the caller
 * ASKED for is obeyed literally; a batch host gets DEFAULT_BATCH_IDLE_TIMEOUT_MS, also literal, since
 * its parent outlives the thread by days; everything else gets the default, which only reaps once the
 * parent has actually gone (see shouldIdleExit).
 */
export function resolveIdleTimeout({envValue, paired = false, batchHost = false}) {
    if (paired) return {idleTimeoutMs: 0, explicit: false};
    if (idleTimeoutIsExplicit(envValue)) return {idleTimeoutMs: parseIdleTimeout(envValue), explicit: true};
    if (batchHost) return {idleTimeoutMs: DEFAULT_BATCH_IDLE_TIMEOUT_MS, explicit: true};
    return {idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, explicit: false};
}
