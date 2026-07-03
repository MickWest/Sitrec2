// IMPORTANT node here
// The LOSTraverseSelect node is the selected LOS traversal method
// We pass in which ones of the above we want, plue any extra ones
// (For example in Agua we add the ufoSplineEditor node)
import {CNodeSwitch} from "./nodes/CNodeSwitch";
import {guiMenus, Sit} from "./Globals";
import {addAnalyzeButton, addAnalyzeTweaks} from "./AnalyzeTraverse";

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

    let nodeMenu = new CNodeSwitch({
        id: id,
        inputs: traverseInputs2,
        desc: "LOS Traverse Method " + idExtra,
        default: defaultTraverse,
        exportable: exportable,

    }, guiMenus.traverse)

    // One-button multi-method analysis of the LOS (report + best solutions)
    addAnalyzeButton(guiMenus.traverse);
    // Tweaks subfolder: Min/Max analysis distance + hypothesis checkboxes
    addAnalyzeTweaks(guiMenus.traverse);

    // bit of a patch
    nodeMenu.frames = Sit.frames;
    nodeMenu.useSitFrames = true;
    return nodeMenu;

}