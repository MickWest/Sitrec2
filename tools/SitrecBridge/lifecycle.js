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
