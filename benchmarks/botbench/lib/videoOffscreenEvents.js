// Smooth operator excursions outside the horizontal field, followed by reacquisition.
// The regular drift continues underneath; each excursion blends out and back
// with zero added velocity at its boundaries. Timings describe the maneuver,
// not the shorter interval during which the target is actually out of frame.
export function applyVideoOffscreenEvents(wobble, events = [], fps, horizontalFOV) {
    return wobble.map((offset, frame) => {
        let pan = offset.pan;
        for (const event of events) {
            const progress = (frame / fps - event.startSeconds) / event.durationSeconds;
            if (progress <= 0 || progress >= 1) continue;
            const weight = Math.sin(Math.PI * progress) ** 2;
            pan += (event.direction * horizontalFOV * .7 - pan) * weight;
        }
        return {...offset, pan};
    });
}
