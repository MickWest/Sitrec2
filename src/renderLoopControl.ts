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

export function shouldSleepAnimationLoop({hidden, paused, renderOne, nodeList, forceRender}: SleepAnimationLoopArgs): boolean {
    // Debug/MCP override: never sleep, even when the tab is hidden, so the render
    // loop keeps running and terrain LOD subdivision / tile loading / etc. proceed
    // while the scene is inspected via the bridge in a backgrounded tab.
    if (forceRender) {
        return false;
    }

    // A hidden tab (background tab / minimised window) can't be seen, so sleep — the
    // visibilitychange handler re-arms + wakes the loop when it becomes visible again.
    if (hidden) {
        return true;
    }

    // An explicitly-requested render (renderOne) must ALWAYS run — the user changed something
    // (toggled a layer, FOV, fullscreen, …) and expects to see it.
    if (renderOne) {
        return false;
    }

    // A VISIBLE tab does its work regardless of OS window focus: stay awake while paused if any
    // node still needs background updates (terrain LOD subdivision, video decode). Those producers
    // self-disable updateWhilePaused once they settle (see CNodeTerrainUI / CNodeBuildings3DTiles),
    // so an idle paused tab still sleeps. NOTE: this relies on hasPausedBackgroundWork() eventually
    // returning false — a node that sets updateWhilePaused permanently would keep a visible tab
    // awake forever. (We do NOT gate on window focus: doing so froze finite terrain-tile loading on
    // a visible-but-unfocused window, leaving tiles missing until the user interacted.)
    return paused && !hasPausedBackgroundWork(nodeList);
}