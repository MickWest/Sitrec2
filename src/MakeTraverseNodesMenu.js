// IMPORTANT node here
// The LOSTraverseSelect node is the selected LOS traversal method
// We pass in which ones of the above we want, plue any extra ones
// (For example in Agua we add the ufoSplineEditor node)
import {CNodeSwitch} from "./nodes/CNodeSwitch";
import {guiMenus, Sit} from "./Globals";
import {addAnalyzeButton, addAnalyzeTweaks} from "./AnalyzeTraverse";
import {EventManager} from "./CEventManager";

export function MakeTraverseNodesMenu(id, traverseInputs, defaultTraverse, idExtra = "", exportable = true) {


    let traverseInputs2 = {}
    for (var inputID in traverseInputs) {
        traverseInputs2[inputID] = traverseInputs[inputID] + idExtra
    }

    // Global least-squares fits are always available
    traverseInputs2["Global Fit: Constant Velocity"] = "LOSFitCV" + idExtra;
    traverseInputs2["Global Fit: Const Acceleration"] = "LOSFitCA" + idExtra;
    traverseInputs2["Global Fit: Kalman Smoother"] = "LOSFitKalman" + idExtra;
    traverseInputs2["Global Fit: Monte Carlo 1"] = "LOSFitMonteCarlo" + idExtra;
    traverseInputs2["Global Fit: Monte Carlo 2"] = "LOSFitMonteCarlo2" + idExtra;
    traverseInputs2["Global Fit: Physics"] = "LOSFitPhysics" + idExtra;
    traverseInputs2["Global Fit: Plausible"] = "LOSFitPlausible" + idExtra;
    traverseInputs2["Global Fit: Minimum Speed"] = "LOSFitMinSpeed" + idExtra;
    // Stationary-point family: the fixed world point that best fits every
    // sightline (free, or pinned to the sea-level plane = Ground Object), and
    // the moving sightline-meets-ground point (Ground Vehicle). These are the
    // live methods the analysis gallery's corresponding tiles apply to.
    traverseInputs2["Global Fit: Stationary Point"] = "LOSFitStationaryPoint" + idExtra;
    traverseInputs2["Global Fit: Ground Object"] = "LOSFitGroundPoint" + idExtra;
    traverseInputs2["Ground Vehicle"] = "LOSFitGroundVehicle" + idExtra;
    traverseInputs2["Analysis Result Snapshot"] = "LOSFitAnalysisResult" + idExtra;

    let nodeMenu = new CNodeSwitch({
        id: id,
        inputs: traverseInputs2,
        desc: "LOS Traverse Method " + idExtra,
        default: defaultTraverse,
        exportable: exportable,
        // Display-only renames (CNodeSwitch v.labels). Saved sitches serialize the
        // selected option by its KEY, so the legacy per-sitch spellings must stay
        // as keys forever — these unify what the user sees. Keys absent from a
        // given sitch's menu are simply ignored.
        labels: {
            "Constant Speed": "Constant Ground Speed",
            "Const Ground Spd": "Constant Ground Speed",
            "Constant Ground Speed - ": "Constant Ground Speed",
            "Const Air Spd": "Constant Air Speed",
            "Global Fit: Const Acceleration": "Global Fit: Constant Acceleration",
            // "Plausible" claimed a result; the algorithm minimizes acceleration.
            "Global Fit: Plausible": "Global Fit: Minimum Acceleration",
            "Analysis Result Snapshot": "Analysis Snapshot (created by Analyze)",
        },

    }, guiMenus.traverse)

    // One-button multi-method analysis of the LOS (report + best solutions)
    addAnalyzeButton(guiMenus.traverse);
    // Tweaks subfolder: Min/Max analysis distance + hypothesis checkboxes
    addAnalyzeTweaks(guiMenus.traverse);

    // bit of a patch
    nodeMenu.frames = Sit.frames;
    nodeMenu.useSitFrames = true;

    // Every path that mutates Sit.aFrame/bFrame dispatches abFrameChanged
    // (frame-slider marker drags, graph-view marker drags, the I/O keys, the
    // G go-to-frame prompt). Invalidate only the A-B-windowed Global Fit
    // inputs connected to this traverse switch so all interaction paths
    // produce the same A-B result without rebaking the entire node graph.
    // (The sequential Constant Altitude traverse anchors on frame 0 and does
    // not depend on A-B — see CNodeLOSTraverseConstantAltitude.)
    EventManager.addEventListener("abFrameChanged", () => {
        for (const node of Object.values(nodeMenu.inputs)) {
            if (!node || node.id.startsWith("LOSFitAnalysisResult")) continue;
            if (!node.id.startsWith("LOSFit")) continue;
            if ("_dirty" in node) node._dirty = true;
            node.recalculateCascade();
        }
        return false;
    });
    return nodeMenu;

}
