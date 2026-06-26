type NodeLike = {
    isController?: boolean;
    update?: unknown;
    updateWhilePaused?: boolean;
};

type NodeListEntry = {
    data?: NodeLike;
};

type NodeList = Record<string, NodeListEntry> | undefined | null;

type SleepAnimationLoopArgs = {
    hidden: boolean;
    focused: boolean;
    paused: boolean;
    renderOne: boolean | number | undefined;
    nodeList: NodeList;
    forceRender?: boolean;
};

export function hasPausedBackgroundWork(nodeList: NodeList): boolean {
    if (!nodeList) {
        return false;
    }

    for (const entry of Object.values(nodeList)) {
        const node = entry.data;
        if (!node?.isController && node.update !== undefined && node.updateWhilePaused) {
            return true;
        }
    }

    return false;
}

export function shouldSleepAnimationLoop({hidden, focused, paused, renderOne, nodeList, forceRender}: SleepAnimationLoopArgs): boolean {
    // Debug/MCP override: never sleep, even when the tab is hidden, so the render
    // loop keeps running and terrain LOD subdivision / tile loading / etc. proceed
    // while the scene is inspected via the bridge in a backgrounded tab.
    if (forceRender) {
        return false;
    }
    if (hidden) {
        return true;
    }

    // Paused + window unfocused: user isn't viewing playback or interacting,
    // so skip background updates too (e.g. terrain tile loading can wait).
    if (paused && !focused) {
        return true;
    }

    return paused && !renderOne && !hasPausedBackgroundWork(nodeList);
}