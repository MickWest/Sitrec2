// Metadata follows the values actually consumed, not every invalidation edge.
// In particular, a ground-derived ray consumes camera position, not attitude.
export function analysisNodeEnabled(node) {
    return !!node && !(node.isController && (node.enabled === false
        || (node.in?.enabled && !(node.in.enabled.v0 ?? node.in.enabled.value))));
}

export function analysisInputEdges(node, context = {}, component = "all") {
    if (!analysisNodeEnabled(node)) return [];
    if (typeof node.getObject === "function") return [{node: node.getObject(), component}];
    if (node.getAnalysisInputs) return node.getAnalysisInputs(context, component);
    return Object.entries(node.in ?? node.inputs ?? {}).filter(([key]) =>
        key !== "smoothedTrack" || node.tiltType === undefined
        || ["banking", "axialpush", "axialpull", "axialpushzerog", "axialpullzerog"].includes(node.tiltType.toLowerCase())
    ).map(([, input]) => ({node: input, component: "all"}));
}

export function dependsOnCameraHeading(root, context = {}) {
    const seen = new Map();
    const visit = (node, component = "all") => {
        if (!analysisNodeEnabled(node)) return false;
        const components = seen.get(node) ?? new Set();
        if (components.has(component)) return false;
        components.add(component);
        seen.set(node, components);
        if (node.id === "JetLOSCameraCenter" && component !== "position") return true;
        return analysisInputEdges(node, context, component).some(edge => visit(edge.node, edge.component));
    };
    return visit(root);
}
