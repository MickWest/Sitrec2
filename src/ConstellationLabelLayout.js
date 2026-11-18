const EDGE_MARGIN = 8;
const STICK_DISTANCE = 64;
const REENTRY_MARGIN = 16;
const NEW_PLACEMENT_GAP = 6;
const OFFSETS = [[0, 0]];
for (const radius of [24, 48, 72, 96]) {
    for (let step = 0; step < 8; step++) {
        const angle = step * Math.PI / 4;
        OFFSETS.push([Math.round(radius * Math.cos(angle)), Math.round(radius * Math.sin(angle))]);
    }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x
    && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

// One instance per view. Point labels keep their measured positions; these region
// names may move locally. Retain a clear placement even when a nearer slot opens.
export class ConstellationLabelLayout {
    constructor() {
        this.previous = new Map();
    }

    place(labels, rect, obstacles = []) {
        const next = new Map(), placed = [], occupied = [...obstacles];
        const left = rect.x + EDGE_MARGIN, top = rect.y + EDGE_MARGIN;
        const right = rect.x + rect.w - EDGE_MARGIN, bottom = rect.y + rect.h - EDGE_MARGIN;
        // Existing names have first claim on their space. A name entering the view
        // must not push an already readable name to another slot.
        const ordered = [...labels].sort((a, b) =>
            Number(this.previous.get(b.id)?.visible ?? false) - Number(this.previous.get(a.id)?.visible ?? false)
            || a.id.localeCompare(b.id));
        for (const label of ordered) {
            const {id, x, y, w, h} = label;
            const old = this.previous.get(id);
            if (![x, y, w, h].every(Number.isFinite) || w > right - left || h > bottom - top) continue;
            // Slightly offscreen anchors can stay readable, but never pull a name
            // in from a different part of the sky. Re-entry needs extra clearance.
            const reach = STICK_DISTANCE - (old?.visible ? 0 : REENTRY_MARGIN);
            if (x < rect.x - reach || x > rect.x + rect.w + reach
                || y < rect.y - reach || y > rect.y + rect.h + reach) continue;

            const baseX = clamp(x, left + w / 2, right - w / 2);
            const baseY = clamp(y, top + h / 2, bottom - h / 2);
            const candidate = offset => {
                const cx = clamp(baseX + offset[0], left + w / 2, right - w / 2);
                const cy = clamp(baseY + offset[1], top + h / 2, bottom - h / 2);
                return {...label, x: cx, y: cy, offset,
                    box: {x: cx - w / 2, y: cy - h / 2, w, h}};
            };
            const free = (p, gap) => !occupied.some(box => overlaps(p.box, box, gap));
            let chosen = old?.visible ? candidate(old.offset) : null;
            // A new slot has more clearance than an existing slot needs. Small
            // motions near the clearance threshold therefore do not cause reflows.
            if (!chosen || !free(chosen, 1)) {
                const candidates = OFFSETS.map(candidate).sort((a, b) => {
                    const cost = p => (p.x - baseX) ** 2 + (p.y - baseY) ** 2
                        + (old ? 0.5 * ((p.x - baseX - old.offset[0]) ** 2
                            + (p.y - baseY - old.offset[1]) ** 2) : 0);
                    return cost(a) - cost(b);
                });
                chosen = candidates.find(p => free(p, NEW_PLACEMENT_GAP));
            }
            next.set(id, {offset: chosen?.offset ?? old?.offset ?? [0, 0], visible: !!chosen});
            if (!chosen) continue;
            placed.push(chosen);
            occupied.push(chosen.box);
        }
        this.previous = next;
        this.placed = placed;
        return placed;
    }
}
