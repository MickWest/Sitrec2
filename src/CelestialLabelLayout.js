export const DEFAULT_CELESTIAL_LABEL_DENSITY = 0.25;

export function celestialLabelDensity(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_CELESTIAL_LABEL_DENSITY;
}

const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x
    && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

// One layout per view, in display pixels (including the video's letterbox clip).
// Names stay beside their objects; suppress a crowded name rather than move it
// onto another star. A little extra clearance for newcomers reduces flicker.
export class CelestialLabelLayout {
    constructor() {
        this.previous = new Set();
    }

    place(labels, rect, density, obstacles = []) {
        density = celestialLabelDensity(density);
        const candidates = labels.filter(({box: b}) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite)
            && b.x >= rect.x + 2 && b.y >= rect.y + 2
            && b.x + b.w <= rect.x + rect.w - 2 && b.y + b.h <= rect.y + rect.h - 2);
        const faintDeepSky = label => label.kind === "deepSky" && !label.prominent ? 1 : 0;
        const magnitude = label => Number.isFinite(label.magnitude) ? label.magnitude : 20;
        candidates.sort((a, b) => faintDeepSky(a) - faintDeepSky(b)
            || magnitude(a) - magnitude(b) || a.id.localeCompare(b.id));
        const available = [];
        for (const label of candidates) {
            const gap = this.previous.has(label.id) ? 4 : 6;
            if (obstacles.some(box => overlaps(label.box, box, gap))
                || available.some(other => overlaps(label.box, other.box, gap))) continue;
            available.push(label);
        }
        // Scale the readable set, not the raw catalog count: otherwise a dense
        // patch of faint objects inflates the budget even though their names
        // could never fit, leaving far too many labels at the default setting.
        const placed = available.slice(0, Math.ceil(available.length * density));
        this.previous = new Set(placed.map(label => label.id));
        this.placed = placed;
        this.candidateCount = candidates.length;
        this.availableCount = available.length;
        return placed;
    }
}
