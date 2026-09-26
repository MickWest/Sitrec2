// Keep generated bakes in memory for reuse, but do not bundle orphaned GLBs when
// an object has switched back to an editable recipe. Ordinary imported files
// retain FileManager's normal lifetime and serialization behavior.
export function refreshVehicleBakeUsage(files, nodes) {
    const used = new Set();
    for (const entry of Object.values(nodes ?? {})) {
        const node = entry.data;
        if (node?.modelOrGeometry !== "model") continue;
        if (node.proceduralModel?.mode === "frozen") used.add(node.proceduralModel.file);
        else if (!node.proceduralModel) used.add(node.selectModel);
    }
    for (const [id,file] of Object.entries(files ?? {})) {
        if (file.proceduralBake) file.skipSerialization = !used.has(id);
    }
}
