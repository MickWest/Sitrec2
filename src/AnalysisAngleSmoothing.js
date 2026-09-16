import {NodeMan, setRenderOne} from "./Globals";

// Follow the selected sightline and active camera controllers. A shared window
// drives all six recorded angle columns, so change each control only once.
function angleInputGraph(root) {
    const visited = new Set();
    const windows = new Set();
    const visit = node => {
        if (!node || visited.has(node) || (node.isController && node.enabled === false)) return;
        if (node.isController && node.in?.enabled && !node.in.enabled.v0) return;
        visited.add(node);
        if (typeof node.getObject === "function") {
            visit(node.getObject());
            return;
        }
        if (node.smoothingKind === "column" && node.degrees && node.in?.smooth) {
            windows.add(node.in.smooth);
        }
        if (node.isAnalysisSnapshot) return;
        for (const input of Object.values(node.in ?? node.inputs ?? {})) visit(input);
    };
    visit(root);
    return {windows: [...windows], nodes: [...visited]};
}

// Analysis must combine tracked pixels with the recorded camera attitude.
// Keep the graph unfiltered for the whole run: live fit nodes, cache keys, and
// the captured processing summary all need the same angles as the dataset.
export async function withUnfilteredAnalysisAngles(losNode, analyze) {
    const {windows, nodes} = angleInputGraph(losNode);
    const changed = windows
        .filter(node => node.value > 0)
        .map(node => ({node, value: node.value}));
    const refresh = node => {
        // Analysis is a consumer even when the selected path has no visible
        // display. Do not let the rendering optimization leave baked LOS stale.
        const gated = nodes.filter(input => input.checkDisplayOutputs);
        try {
            for (const input of gated) input.checkDisplayOutputs = false;
            node.recalculateCascade();
        } finally {
            for (const input of gated) input.checkDisplayOutputs = true;
        }
        node.guiEntry?.updateDisplay();
        setRenderOne(true);
    };
    try {
        for (const {node} of changed) node.value = 0;
        for (const {node} of changed) refresh(node);
        return await analyze();
    } finally {
        // Do not restore into a new sitch, or overwrite an edit made during
        // analysis. This also runs on cancellation, failure and cache hits.
        const restore = changed.filter(({node}) => NodeMan.get(node.id, false) === node && node.value === 0);
        for (const {node, value} of restore) node.value = value;
        for (const {node} of restore) refresh(node);
    }
}
