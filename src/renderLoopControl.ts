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

export function shouldSleepAnimationLoop({hidden, paused, renderOne, nodeList}: SleepAnimationLoopArgs): boolean {
    if (hidden) {
        return true;
    }

    return paused && !renderOne && !hasPausedBackgroundWork(nodeList);
}