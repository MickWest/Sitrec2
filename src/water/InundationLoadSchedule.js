import {inundationMaskIntersects} from "./InundationLoadMask";

// Refine a small part of the calculation domain at a time. Retained geometry
// samples let the display cache release earlier blocks and admit the next one.
export class InundationLoadSchedule {
    constructor(mask, size, radiusCells, blockCells, minCells, frame) {
        this.size = size;
        this.minCells = minCells;
        this.queue = [];
        this.cacheLimited = false;
        this.attempted = 0;
        const center = size / 2;
        for (let y = Math.floor((center - radiusCells) / blockCells) * blockCells; y < center + radiusCells; y += blockCells) {
            for (let x = Math.floor((center - radiusCells) / blockCells) * blockCells; x < center + radiusCells; x += blockCells) {
                const block = {x0: Math.max(0, x), y0: Math.max(0, y), x1: Math.min(size, x + blockCells), y1: Math.min(size, y + blockCells)};
                if (block.x1 <= block.x0 || block.y1 <= block.y0) continue;
                const dx = Math.max(block.x0 - center, 0, center - block.x1);
                const dy = Math.max(block.y0 - center, 0, center - block.y1);
                if (dx * dx + dy * dy <= radiusCells * radiusCells && this.needed(mask, block)) this.queue.push(block);
            }
        }
        this.queue.sort((a, b) => this.distance(a, center) - this.distance(b, center));
        this.select(mask, frame);
    }

    distance(b, center) { return ((b.x0 + b.x1) / 2 - center) ** 2 + ((b.y0 + b.y1) / 2 - center) ** 2; }

    needed(mask, b) { return inundationMaskIntersects(mask, this.size, b.x0, b.y0, b.x1 - 1, b.y1 - 1); }

    select(mask, frame) {
        this.current = null;
        while (this.queue.length) {
            const next = this.queue.shift();
            if (this.needed(mask, next)) { this.current = next; break; }
        }
        this.activationFrame = frame;
    }

    advance(mask, settled, frame, limited) {
        const b = this.current;
        // Old zero-load stats do not describe a newly selected block. Wait for
        // its traversal, any cache eviction retry, and geometry rasterization.
        if (!b || !settled || frame <= this.activationFrame) return false;
        if (this.needed(mask, b) && limited) {
            if (b.x1 - b.x0 > this.minCells || b.y1 - b.y0 > this.minCells) {
                const xm = Math.floor((b.x0 + b.x1) / 2), ym = Math.floor((b.y0 + b.y1) / 2);
                const children = [
                    {x0: b.x0, y0: b.y0, x1: xm, y1: ym}, {x0: xm, y0: b.y0, x1: b.x1, y1: ym},
                    {x0: b.x0, y0: ym, x1: xm, y1: b.y1}, {x0: xm, y0: ym, x1: b.x1, y1: b.y1},
                ].filter(c => c.x1 > c.x0 && c.y1 > c.y0);
                this.queue.unshift(...children);
            } else this.cacheLimited = true;
        }
        this.attempted++;
        // Missing source geometry may never reach 100%. Attempt it once, then
        // move on; changing the domain/level or Recalculate starts a new pass.
        this.select(mask, frame);
        return true;
    }
}
