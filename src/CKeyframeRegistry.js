// Generic keyframe registry. Any tool that maintains a set of frame numbers
// it cares about (manual horizon keyframes, auto-tracker hits, motion-analysis
// events, etc.) registers a provider here. The frame slider then renders the
// union of those frames as yellow diamonds, and `<`/`>` (Shift+,/Shift+.)
// step through them, together with the timeline markers and the In/Out frames
// (KeyBoardHandler navigationStops, TimelineMarkers.js).
//
// Providers expose a getFrames() callback returning an iterable of frame
// numbers. The registry polls on each slider redraw and on each navigation
// keypress, so providers don't need to push updates — they just maintain
// their own state and the registry pulls it lazily.
//
// Usage:
//   KeyframeRegistry.register('horizon', { getFrames: () => myMap.keys() });
//   KeyframeRegistry.unregister('horizon');  // on dispose/sitch-reload

class CKeyframeRegistry {
    constructor() {
        this.providers = new Map();
    }

    register(id, provider) {
        this.providers.set(id, provider);
    }

    unregister(id) {
        this.providers.delete(id);
    }

    // Union of all frame numbers across all providers, sorted ascending.
    getAllFrames() {
        const set = new Set();
        for (const p of this.providers.values()) {
            try {
                const frames = p.getFrames();
                if (!frames) continue;
                for (const f of frames) {
                    if (Number.isFinite(f)) set.add(Math.floor(f));
                }
            } catch (e) {
                // A flaky provider shouldn't break navigation for the rest.
            }
        }
        return Array.from(set).sort((a, b) => a - b);
    }

    // Cheap fingerprint the slider compares each tick to decide whether to
    // redraw the diamond layer. Length + first + last + a tail-sample is
    // good enough — false positives only cost one extra redraw.
    signature() {
        const frames = this.getAllFrames();
        const n = frames.length;
        if (n === 0) return "0";
        return `${n}:${frames[0]}:${frames[n - 1]}:${frames[(n - 1) >> 1]}`;
    }
}

export const KeyframeRegistry = new CKeyframeRegistry();

// Expose for dev/debug consoles and MCP eval. Cheap and the registry has
// no side effects on read — providers don't run until poll time.
if (typeof window !== "undefined") {
    window.KeyframeRegistry = KeyframeRegistry;
}
