// GroundPaintState.js
//
// The hooks "Paint On Ground" (GroundPaint.js) attaches to a three.js Texture,
// split into their own DEPENDENCY-FREE module so the tile-material pipeline can
// consult them without importing the painter — which drags in the views, the
// scene and the brush, none of which belong anywhere near QuadTreeTileMaterial.
// Keep this file importing nothing.

// Per-texture paint state, set by CGroundPainter._initTexCanvas:
//   {canvas, ctx, orig, applied, gen, dead}
// `orig` is the texture's ORIGINAL source image, kept so an erase dab (and
// "Clear Paint") can restore the untouched imagery. A Symbol so it cannot collide
// with anything three.js or a loader puts on a Texture.
export const PAINT_TEX_STATE = Symbol("groundPaint_texState");

// The texture's imagery WITHOUT any paint on it.
//
// Call this instead of reading texture.image whenever a tile's imagery is being
// resampled to derive ANOTHER tile's texture. While a tile is painted its
// texture.image is the painter's canvas, so deriving a child tile from it bakes
// the paint into the child's source image — and the painter then stashes that
// already-painted image as the child's `orig`. Every operation that means "put the
// original imagery back" (Alt-erase, undo, Clear Paint) would restore the paint
// instead, and visibly fail on exactly those fallback tiles until the child's real
// imagery finished downloading.
//
// Deriving from the clean image is right in its own terms too: the painter replays
// the dab list onto the child in the child's own resolution a frame later, so the
// stroke arrives sharper than an upscaled copy of the parent's paint would be.
export function unpaintedTextureImage(texture) {
    if (!texture) return null;
    const state = texture[PAINT_TEX_STATE];
    return (state && state.orig) ? state.orig : texture.image;
}
