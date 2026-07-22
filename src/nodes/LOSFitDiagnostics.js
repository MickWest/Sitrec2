// LOSFitDiagnostics.js — shared "Fit Diagnostics" rows for the live global-fit
// traverse nodes (CV, CA, Kalman, Monte Carlo 1/2).
//
// WHY: the perpendicular-distance fits collapse onto the sensor whenever the
// sensor's own path is CV/CA-representable (straight or gently-arcing flight
// — see the contract note at the top of LOSFitting.js). The live nodes used
// to publish that degenerate track with nothing flagging it. This surfaces
// the BOT-Bench-validated CV-family conditioning diagnostic and the fitted
// track's collapse state, per the repo philosophy: SURFACE the problem,
// never silently alter the fit.
//
// Follows CNodeLOSFitPlausible's results-folder pattern: a lil-gui folder in
// guiMenus.traverse with disabled string rows, rebuilt per compute and
// destroyed with the node.

import {guiMenus} from "../Globals";
import {METERS_PER_NM} from "../TraverseAnalysis";

// Wording is calibrated to the evidence (one-way warning, never a proof):
// "poor" is a measured HIGH RISK of collapse, not a certainty — the
// benchmark's collapse rate was 82% in its log10(rcond) ~ -3 bin and 72% in
// the -2.5 bin, and 0% above -2 (GEO-DURATION block).
function conditioningText(a) {
    if (a.rcond === null) return "unknown (too few frames)";
    const r = a.rcond.toExponential(1);
    if (a.conditioning === "poor") {
        return `POOR (rcond ${r}) — high collapse risk; CV-family range unreliable`;
    }
    if (a.conditioning === "marginal") {
        return `marginal (rcond ${r}) — range weakly determined`;
    }
    return `good (rcond ${r}) — not a guarantee of range`;
}

function locationText(a) {
    if (a.collapseReason === "on-sensor" || a.collapseReason === "behind-sensor") {
        return "ON/BEHIND the camera — the fit collapsed; its range is meaningless";
    }
    if (a.collapseReason === "near-camera-weak-geometry") {
        return "near the camera under weak geometry — range likely an artifact";
    }
    if (a.medianSignedRangeM !== null && a.medianSignedRangeM !== undefined) {
        return `median range ${(a.medianSignedRangeM / METERS_PER_NM).toFixed(2)} NM`;
    }
    return "n/a";
}

/**
 * Rebuild the node's diagnostics folder from an assessLinearFitConditioning
 * result. Call at the end of _doCompute; safe when guiMenus.traverse is
 * absent (headless/tests). Stores folder state on the node as
 * node._fitDiagFolder.
 */
export function updateFitDiagnosticsGUI(node, folderTitle, assessment) {
    if (!guiMenus.traverse) return;
    disposeFitDiagnosticsGUI(node);
    const folder = guiMenus.traverse.addFolder(folderTitle);
    const rows = {
        _cond: conditioningText(assessment),
        _loc: locationText(assessment),
    };
    folder.add(rows, "_cond").name("CV-family conditioning").disable();
    folder.add(rows, "_loc").name("Fitted location").disable();
    // Open the folder only when there is something the user must see.
    if (assessment.collapse || assessment.conditioning === "poor") folder.open();
    else folder.close();
    node._fitDiagFolder = folder;
}

export function disposeFitDiagnosticsGUI(node) {
    if (node._fitDiagFolder) {
        node._fitDiagFolder.destroy();
        node._fitDiagFolder = null;
    }
}
