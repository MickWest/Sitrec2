/**
 * Shared mutable bindings for the CMotionAnalysis / CMotionAnalysisUI pair.
 *
 * CMotionAnalysis.js (analyzer) and CMotionAnalysisUI.js (menu + sliders) are
 * two halves of the same subsystem. The UI assigns callbacks + helpers on
 * startup; the analyzer calls them during its run. Putting these three
 * bindings in a third module avoids the Analysis <-> UI circular import that
 * would otherwise arise (UI already imports the analyzer class + helpers
 * from CMotionAnalysis, so adding the reverse import closes a cycle that
 * webpack's circular-dependency-plugin flags as an error).
 *
 * Both files import from here; assignment happens inside the UI module.
 */

export let updateGuiValues = null;
export let updateOptimizeStatus = null;
export let startAnalysis = null;

export function setUpdateGuiValues(fn) { updateGuiValues = fn; }
export function setUpdateOptimizeStatus(fn) { updateOptimizeStatus = fn; }
export function setStartAnalysis(fn) { startAnalysis = fn; }
