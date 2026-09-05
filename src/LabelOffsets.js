// Saved label offsets historically use half a screen pixel per unit. Keep that
// convention at the label boundary, while geometric pixel helpers use full pixels.
export function labelPixelOffset(label) {
    return {x: (label.offset?.x ?? 0) * 0.5, y: (label.offset?.y ?? 0) * 0.5};
}
