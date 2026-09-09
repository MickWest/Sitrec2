// Preserve the original file for a version switch. Parsing a legacy mod merges
// runtime functions into it, which cannot be cloned into browser storage.
const texts = new WeakMap();
export function rememberSitchText(object, text) {
    if (object && typeof object === 'object') texts.set(object, text);
    return object;
}
export function getSitchText(object) { return texts.get(object); }
