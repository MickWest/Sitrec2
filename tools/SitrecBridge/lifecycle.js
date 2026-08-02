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

export function rankTakeoverCandidates(statuses, parentPid) {
    return statuses
        .filter((status) =>
            status?.service === "SitrecBridge" &&
            status.pairedOrigin === null &&
            !status.busy &&
            status.controlToken &&
            Number.isInteger(status.port)
        )
        .sort((a, b) => {
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
