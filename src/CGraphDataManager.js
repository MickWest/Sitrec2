// CGraphDataManager
//
// Runtime-only registry of per-frame, single-number data series that subsystems
// (camera motion, point track, motion analysis, horizon, OSD series, tracks, ...)
// expose for plotting in user-created "Custom Graphs".
//
// Pull-only by design (mirrors CKeyframeRegistry): nothing is dispatched on
// register/unregister. A dispatched "series changed" event would recurse, because
// the bulk re-registration paths call register() many times. Instead the registry
// keeps a monotonic `version` counter and consumers (graphs) poll it to decide
// when to rebuild their selectors. Series VALUES are always read live through
// getValue(), so a graph re-plots simply by re-sampling.
//
// This registry is NEVER serialized. Series are re-registered fresh on each
// (moddable) sitch load by CCustomGraphManager. What persists in the sitch is
// only the stable string `key` a graph selected (e.g. "horizon.angle").
//
// Descriptor shape:
//   key      unique stable string, ALSO the serialized token. e.g.
//            "cameraMotion.dx", "horizon.angle", "osd.<name>", "track.<id>.speed".
//            Never an array index (those are not stable across loads).
//   label    display string for the dropdowns and the on-graph legend.
//   group    bucket used to group + sort the dropdown ("Tracks", "OSD", ...).
//   getValue (frame:int) => number | NaN. MUST re-resolve the live source every
//            call (never snapshot). Returns NaN for "no sample at this frame".
//   min,max  OPTIONAL fixed range. If BOTH are finite the hosting axis uses them
//            verbatim (no auto-range, no padding).
//   units    OPTIONAL units label string (informational).

class CGraphDataManager {
    constructor() {
        this.series = new Map();   // key -> descriptor
        this.version = 0;          // bumped whenever the set of keys changes
    }

    // Overwrite-safe. Bumps version (cheap; consumers debounce via their own
    // cached version so a few redundant bumps are harmless).
    register(key, descriptor) {
        descriptor.key = key;
        this.series.set(key, descriptor);
        this.version++;
    }

    unregister(key) {
        if (this.series.delete(key)) this.version++;
    }

    // Bulk-clear every key under a prefix (used for the churn-y groups: "osd.",
    // "track."). Caller re-registers the current set afterwards.
    unregisterGroup(prefix) {
        let changed = false;
        for (const k of [...this.series.keys()]) {
            if (k.startsWith(prefix)) { this.series.delete(k); changed = true; }
        }
        if (changed) this.version++;
    }

    disposeAll() {
        const had = this.series.size > 0;
        this.series.clear();
        if (had) this.version++;
    }

    get(key) { return this.series.get(key) || null; }
    has(key) { return this.series.has(key); }

    // { displayLabel: key } suitable for lil-gui .add(obj, prop, options).
    // Grouped then label-sorted so the dropdown order is stable across rebuilds.
    optionsY(includeNone = true) {
        const o = includeNone ? { "None": "None" } : {};
        const arr = [...this.series.values()].sort((a, b) =>
            (a.group || "").localeCompare(b.group || "") || a.label.localeCompare(b.label));
        for (const d of arr) o[d.label] = d.key;
        return o;
    }

    // X axis additionally offers "Frame" (the full clip) and "Frame A→B" (just the
    // in/out range Sit.aFrame..Sit.bFrame). Both map the X value to the frame index.
    optionsX() {
        return { "Frame": "frames", "Frame A→B": "framesAB", ...this.optionsY(false) };
    }

    // Tolerant per-frame resolver. "frames"/"framesAB" -> the frame index; unknown/None -> NaN.
    valueAt(key, frame) {
        if (!key || key === "None") return NaN;
        if (key === "frames" || key === "framesAB") return frame;
        const d = this.series.get(key);
        if (!d) return NaN;
        try {
            const v = d.getValue(frame);
            return (v == null) ? NaN : v;
        } catch (e) {
            return NaN;   // a flaky source must not break the graph
        }
    }
}

export const GraphDataManager = new CGraphDataManager();

// Expose for dev/debug consoles and MCP eval. Reads have no side effects.
if (typeof window !== "undefined") {
    window.GraphDataManager = GraphDataManager;
}
