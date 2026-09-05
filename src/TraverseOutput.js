// Keep the custom traverse's visible line, measurements, and exports on the
// same final output. Run during setup so this also repairs older saved graphs.
export function connectTraverseOutput(nodeMan) {
    const selector = nodeMan.get("LOSTraverseSelectTrack", false);
    const output = nodeMan.get("traverseSmoothedTrack", false);
    if (!selector || !output) return;
    for (const [id, input] of [
        ["traverseDisplayTrack", "track"],
        ["targetDistanceGraph_GenericJetGraph_Munge", "targetTrack"],
    ]) {
        const consumer = nodeMan.get(id, false);
        if (consumer?.in[input] !== selector) continue;
        consumer.removeInput(input);
        consumer.addInput(input, output);
        consumer.recalculateCascade();
    }
    // Export routing is not a computational input: output already depends on
    // selector, so registering the reverse edge would create a graph cycle.
    selector.exportTrackSource = output;
}
