// CCustomGraphManager
//
// Owns user-created "Custom Graphs": the "Add Custom Graph" button in the
// Graphs menu, each graph's subfolder of controls, the graph views, their
// serialization, and the registration of every data source into the
// GraphDataManager registry.
//
// Registration is centralized here (rather than scattered across each
// subsystem) because the registry is pull-only: descriptors hold getValue()
// closures that re-resolve the live source every call, so it does not matter
// WHERE they are registered. Centralizing avoids import cycles and keeps the
// subsystem files untouched.
//
// Lifecycle: setup() runs once per moddable sitch load (from CustomManager).
// disposeEverything() calls disposeAll() on each reload.

import {GlobalDateTimeNode, Globals, guiMenus, NodeMan, setRenderOne, Sit, TrackManager, Units} from "./Globals";
import {par} from "./par";
import {t} from "./i18n";
import {EventManager} from "./CEventManager";
import {GraphDataManager} from "./CGraphDataManager";
import {CNodeCustomGraphView} from "./nodes/CNodeCustomGraphView";
import {CNodeDisplayLOS} from "./nodes/CNodeDisplayLOS";
import {trackHeading} from "./trackUtils";
import {getLocalUpVector} from "./SphericalMath";
import {getCelestialDirection} from "./CelestialMath";
import {getHorizonExtractor} from "./CHorizonExtractor";
import {getObjectTracker} from "./CObjectTracking";
import {getMotionAnalyzerForTesting} from "./CMotionAnalysisUI";

const RAD2DEG = 180 / Math.PI;

// One custom graph: a view + a subfolder of controls + the selected series tokens.
class CCustomGraph {
    constructor(id, view) {
        this.id = id;
        this.view = view;
        this.folder = null;
        this.title = "";
        // Rolling window: 0 = plot the whole clip; N > 0 = plot only the last
        // N seconds up to the current frame (scrolls off to the left in play).
        this.lastSeconds = 0;
        // Persistence tokens (registry keys). Kept verbatim even when the source
        // is transiently absent, so the selection reconnects when it reappears.
        this._storedX = "frames";
        this._storedY1 = "None";
        this._storedY2 = "None";
        this._storedY3 = "None";
        // GUI-bound display fields (may fall back to None/frames while invalid).
        this._gs = { x: "frames", y1: "None", y2: "None", y3: "None" };
        this._xCtrl = this._y1Ctrl = this._y2Ctrl = this._y3Ctrl = this._removeCtrl = null;
        this._lastSeriesSig = null;
        this._cachedVersion = -1;
        this._lastRefresh = 0;
    }

    folderTitle() {
        return (this.title && this.title.length) ? this.title : ("Graph " + this.id);
    }

    // Rebuild the X/Y1/Y2/Y3 selectors (+ trailing Remove button) from the
    // current registry contents. Preserves the stored tokens.
    rebuildDropdowns() {
        const f = this.folder;
        if (!f) return;
        for (const ctrl of [this._xCtrl, this._y1Ctrl, this._y2Ctrl, this._y3Ctrl, this._removeCtrl]) {
            if (ctrl) ctrl.destroy();
        }

        const xOptions = GraphDataManager.optionsX();
        const yOptions = GraphDataManager.optionsY(true);
        const validX = new Set(Object.values(xOptions));
        const validY = new Set(Object.values(yOptions));

        // Display fields validate against current options, but the stored tokens
        // are NEVER overwritten here (they survive transient source absence).
        this._gs.x  = validX.has(this._storedX)  ? this._storedX  : "frames";
        this._gs.y1 = validY.has(this._storedY1) ? this._storedY1 : "None";
        this._gs.y2 = validY.has(this._storedY2) ? this._storedY2 : "None";
        this._gs.y3 = validY.has(this._storedY3) ? this._storedY3 : "None";

        const onChange = () => {
            this._storedX  = this._gs.x;
            this._storedY1 = this._gs.y1;
            this._storedY2 = this._gs.y2;
            this._storedY3 = this._gs.y3;
            this.updateGraph(true);
        };

        this._xCtrl  = f.add(this._gs, "x",  xOptions).name(t("graphControls.xAxis")).onChange(onChange);
        this._y1Ctrl = f.add(this._gs, "y1", yOptions).name(t("graphControls.y1Axis")).onChange(onChange);
        this._y2Ctrl = f.add(this._gs, "y2", yOptions).name(t("graphControls.y2Axis")).onChange(onChange);
        this._y3Ctrl = f.add(this._gs, "y3", yOptions).name(t("graphControls.y3Axis")).onChange(onChange);
        this._removeCtrl = f.add({ remove: () => CustomGraphManager.removeGraph(this.id) }, 'remove')
            .name(t("graphControls.remove"));
    }

    maybeRebuild() {
        if (this._cachedVersion !== GraphDataManager.version) {
            this._cachedVersion = GraphDataManager.version;
            this.rebuildDropdowns();
        }
    }

    // Called once per render (via the view's rebuildCallback). Throttled so the
    // common path is cheap; re-plots only when the sampled data actually changes.
    refreshIfStale() {
        const now = Date.now();
        // Rolling-window graphs re-sample faster so the scroll looks continuous
        // during playback (the window is small, so the re-sample is cheap).
        const throttle = this.lastSeconds > 0 ? 50 : 200;
        if (now - this._lastRefresh < throttle) return;
        this._lastRefresh = now;
        CustomGraphManager.refreshSources();
        this.maybeRebuild();
        this.updateGraph();
    }

    // Sample the selected series across the full frame range and push to the view.
    // A cheap signature avoids re-autoscaling (and the render it schedules) when
    // nothing changed, so calling this every render is loop-free.
    updateGraph(force = false) {
        if (!this.view) return;
        // "Frame A→B" restricts the plotted range to the in/out points.
        const ab = (this._storedX === "framesAB");
        const baseMin = ab ? Math.max(0, Sit.aFrame ?? 0) : 0;
        const baseMax = ab ? Math.min(Sit.frames - 1, Sit.bFrame ?? (Sit.frames - 1)) : (Sit.frames - 1);
        let fMin = baseMin;
        let fMax = baseMax;
        // Rolling window: clamp the sampled range to the last N seconds ending
        // at the current frame. The signature below includes fMin/fMax, so the
        // plot re-draws (scrolls) as par.frame advances. The AXIS is pinned to
        // a constant N-second span — [start, +N s] while the cursor fills
        // toward the right edge, then [now−N, now] sliding — because
        // autoscaling it to the sampled data would visibly stretch the axis
        // for the first N seconds of the clip.
        let xWindow = null;
        if (this.lastSeconds > 0) {
            const nWin = Math.max(1, Math.round(this.lastSeconds * Sit.fps));
            const cur = Math.max(baseMin, Math.min(baseMax, par.frame));
            fMax = Math.min(fMax, cur);
            fMin = Math.max(fMin, cur - nWin + 1);
            xWindow = { min: Math.max(baseMin, cur - nWin + 1), max: Math.max(cur, baseMin + nWin - 1) };
        }
        const series = [];
        const build = (key, yAxis) => {
            if (!key || key === "None") return;
            const desc = GraphDataManager.get(key);
            const data = [];
            // Windowed mode: scan the WHOLE timeline for the y bounds (so the
            // y scale stays fixed as features scroll in and out of view) while
            // collecting only the in-window points to plot.
            let fullMin = Infinity, fullMax = -Infinity;
            const scanLo = xWindow ? baseMin : fMin;
            const scanHi = xWindow ? baseMax : fMax;
            for (let fr = scanLo; fr <= scanHi; fr++) {
                const yv = GraphDataManager.valueAt(key, fr);
                if (!Number.isFinite(yv)) continue;
                if (yv < fullMin) fullMin = yv;
                if (yv > fullMax) fullMax = yv;
                if (fr < fMin || fr > fMax) continue;
                const xv = GraphDataManager.valueAt(this._storedX, fr);
                if (!Number.isFinite(xv)) continue;
                data.push({ x: xv, y: yv, frame: fr });
            }
            if (data.length === 0) return;
            const s = { data, label: desc ? desc.label : key, yAxis };
            if (desc && Number.isFinite(desc.min) && Number.isFinite(desc.max)) {
                s.fixedMin = desc.min;
                s.fixedMax = desc.max;
            } else if (xWindow && Number.isFinite(fullMin)) {
                // fixed y scale over the entire timeline, padded like the
                // autoscaler so peaks don't touch the frame edge
                if (fullMin === fullMax) { fullMin -= 1; fullMax += 1; }
                const p = (fullMax - fullMin) * 0.05;
                s.fixedMin = fullMin - p;
                s.fixedMax = fullMax + p;
            }
            series.push(s);
        };
        build(this._storedY1, 1);
        build(this._storedY2, 2);
        build(this._storedY3, 3);

        // Explain an empty plot: nothing selected vs selected-but-no-data (the
        // source exists in the menu but its analysis has not been computed yet).
        const anySelected = [this._storedY1, this._storedY2, this._storedY3].some(k => k && k !== "None");
        this.view.emptyMessage = series.length === 0
            ? (anySelected ? "No data yet for the selected series — run its analysis/track first"
                           : "Select a Y1, Y2 or Y3 series to plot")
            : null;

        // Include the frame range so changing the in/out points re-plots in A→B mode.
        const sig = "x:" + this._storedX + ":" + fMin + "-" + fMax + "|" + series.map(s => {
            const n = s.data.length;
            const mid = s.data[n >> 1];
            return `${s.yAxis}:${s.label}:${n}:${s.data[0]?.y ?? ''}:${mid?.y ?? ''}:${s.data[n - 1]?.y ?? ''}:${s.fixedMin ?? ''}:${s.fixedMax ?? ''}`;
        }).join("||");
        if (!force && sig === this._lastSeriesSig) return;
        this._lastSeriesSig = sig;

        const frameX = (this._storedX === "frames" || this._storedX === "framesAB" || !this._storedX);
        this.view.isFrameX = frameX;
        this.view.fixedXRange = frameX ? xWindow : null;
        this.view.xLabel = frameX
            ? (ab ? "Frame (A→B)" : (this.lastSeconds > 0 ? `Frame (last ${this.lastSeconds}s)` : "Frame"))
            : (GraphDataManager.get(this._storedX)?.label ?? "");
        this.view.setSeries(series);
    }

    serialize() {
        return {
            id: this.id,
            title: this.title,
            dark: this.view ? this.view.dark : true,
            showLegend: this.view ? this.view.showLegend : true,
            show: this.view ? this.view.visible : true,
            xSeries: this._storedX,
            y1Series: this._storedY1,
            y2Series: this._storedY2,
            y3Series: this._storedY3,
            lastSeconds: this.lastSeconds,
        };
    }
}

class CCustomGraphManager {
    constructor() {
        this.list = {};                  // id -> CCustomGraph
        this._nextId = 0;
        this._osdArrays = {};            // OSD name -> dense per-frame value array
        this._osdNameSig = undefined;    // membership signature for OSD keys
        this._trackIdSig = undefined;    // membership signature for track keys
        this._tracksChangedListener = null;
        this._lastSourceRefresh = 0;
    }

    // --- setup / teardown ---------------------------------------------------

    // Called once per moddable sitch load.
    setup() {
        // EventManager.removeAll() ran during dispose, so (re)wire our listener.
        if (this._tracksChangedListener) {
            EventManager.removeEventListener("tracksChanged", this._tracksChangedListener);
        }
        this._tracksChangedListener = () => {
            this._trackIdSig = undefined;   // force track re-registration
            this.reregisterTracks();
            setRenderOne();
        };
        EventManager.addEventListener("tracksChanged", this._tracksChangedListener);

        this.registerStaticSeries();
        this.refreshSources(true);

        // "Add Custom Graph" button. The host folder is permanent; the button is
        // not (it is re-added each moddable load and removed by the non-perm
        // menu teardown), so the feature is correctly scoped to moddable sitches.
        const folder = guiMenus.showhidegraphs;
        if (folder && !folder._addCustomGraphBtn) {
            folder._addCustomGraphBtn = folder
                .add({ add: () => this.addGraph() }, 'add')
                .name(t("menus.showHide.graphs.addCustom.label"))
                .tooltip(t("menus.showHide.graphs.addCustom.tooltip"));
        }
    }

    disposeAll() {
        for (const id of Object.keys(this.list)) this.removeGraph(id);
        this.list = {};
        this._osdArrays = {};
        this._osdNameSig = undefined;
        this._trackIdSig = undefined;
        this._losSig = undefined;
        this._footballAvail = undefined;
        this._sunDirArr = null;
        this._sunKey = undefined;
        if (this._tracksChangedListener) {
            EventManager.removeEventListener("tracksChanged", this._tracksChangedListener);
            this._tracksChangedListener = null;
        }
        // Drop our stale button reference; the controller itself is destroyed by
        // the non-perm menu teardown (menuBar.destroy(false)).
        const folder = guiMenus.showhidegraphs;
        if (folder) folder._addCustomGraphBtn = undefined;
    }

    // --- graph create / remove ---------------------------------------------

    addGraph(config = {}) {
        const id = config.id ?? ("customGraph" + (this._nextId++));
        const m = /customGraph(\d+)/.exec(id);
        if (m) this._nextId = Math.max(this._nextId, parseInt(m[1], 10) + 1);

        if (this.list[id]) this.removeGraph(id);

        // Spawn each new graph in a DISTINCT, mostly non-overlapping position so it is
        // obviously a new independent window. The old 0.04*(n%6) step offset each graph only
        // ~4% from the previous — but graphs are 0.4 (40%) wide, so they piled up ~90% on top
        // of each other (and the 7th wrapped exactly onto the 1st), making "Add Custom Graph"
        // look like it re-used the current graph. Cycle the four corners + centre (which do not
        // overlap for a 0.4x0.4 graph), nudging each further cycle so later graphs don't land
        // exactly on earlier ones. (Deserialized graphs get their saved position restored over
        // this initial one by the view serialization layer, so this only affects fresh adds.)
        const n = Object.keys(this.list).length;
        const ANCHORS = [[0.05, 0.05], [0.55, 0.05], [0.05, 0.50], [0.55, 0.50], [0.30, 0.28]];
        const anchor = ANCHORS[n % ANCHORS.length];
        const cycle = Math.floor(n / ANCHORS.length);
        const left = Math.min(0.58, anchor[0] + 0.03 * cycle);
        const top  = Math.min(0.55, anchor[1] + 0.03 * cycle);
        const view = new CNodeCustomGraphView({
            id,
            menuName: config.title ?? ("Graph " + id),
            title: config.title ?? "",
            dark: config.dark ?? true,
            showLegend: config.showLegend ?? true,
            visible: config.show ?? true,
            left,
            top,
            width: 0.4,
            height: 0.4,
            draggable: true, resizable: true, freeAspect: true, shiftDrag: false,
        });

        const graph = new CCustomGraph(id, view);
        graph.title = config.title ?? "";
        graph._storedX  = config.xSeries  ?? "frames";
        graph._storedY1 = config.y1Series ?? "None";
        graph._storedY2 = config.y2Series ?? "None";
        graph._storedY3 = config.y3Series ?? "None";
        graph.lastSeconds = config.lastSeconds ?? 0;
        view.title = graph.title;

        const folder = guiMenus.showhidegraphs.addFolder(graph.folderTitle());
        graph.folder = folder;
        folder.onOpenClose(() => {
            this.refreshSources();
            graph.maybeRebuild();
            graph.updateGraph();
        });

        folder.add(graph, 'title').name(t("graphControls.title")).onChange(() => {
            folder.title(graph.folderTitle());
            view.title = graph.title;
            setRenderOne();
        });
        const showProxy = { get show() { return view.visible; }, set show(v) { view.show(v); } };
        folder.add(showProxy, 'show').name(t("graphControls.show")).listen();
        folder.add(view, 'dark').name(t("graphControls.dark")).onChange(() => setRenderOne());
        folder.add({ legend: () => { view.showLegend = !view.showLegend; setRenderOne(); } }, 'legend')
            .name(t("graphControls.toggleLegend"));
        folder.add(graph, 'lastSeconds', 0, 30, 0.5).name("Show Last (secs)")
            .tooltip("0 = plot the whole clip. Otherwise plot only the last N seconds up to the "
                + "current frame, so the trace scrolls off to the left during playback")
            .onChange(() => { graph.updateGraph(true); setRenderOne(); });

        // Refresh the registry BEFORE building the dropdowns: conditional
        // sources (e.g. the football ball g-force) may not have been polled
        // since they became available, and building first then refreshing
        // would swallow the version bump into _cachedVersion below — leaving
        // the new graph's dropdowns permanently missing the source.
        this.refreshSources(true);
        graph.rebuildDropdowns();
        view.rebuildCallback = () => graph.refreshIfStale();

        this.list[id] = graph;

        graph._cachedVersion = GraphDataManager.version;
        graph.updateGraph(true);

        return graph;
    }

    removeGraph(id) {
        const g = this.list[id];
        if (!g) return;
        if (g.folder) {
            try { g.folder.destroy(); } catch (e) { /* already gone */ }
            g.folder = null;
        }
        if (g.view && NodeMan.exists(g.view.id)) {
            NodeMan.disposeRemove(g.view.id, true);
        }
        g.view = null;
        delete this.list[id];
        setRenderOne();
    }

    // --- serialization ------------------------------------------------------

    serialize() {
        const arr = [];
        for (const id of Object.keys(this.list)) arr.push(this.list[id].serialize());
        return arr;
    }

    deserialize(arr) {
        if (!arr || !arr.length) return;
        for (const cfg of arr) {
            try { this.addGraph(cfg); }
            catch (e) { console.error("Custom graph deserialize failed", cfg, e); }
        }
    }

    // --- registry population ------------------------------------------------

    // Single-instance sources whose KEY set never changes. Registered once per
    // setup; getValue tolerates the source not existing yet (returns NaN).
    registerStaticSeries() {
        const G = GraphDataManager;

        // Camera Motion: cumulative + per-frame rotation, and image translation.
        G.register("cameraMotion.rotCumulative", {
            label: "CamMotion Rotation (cumulative)", group: "Camera Motion", units: "deg",
            getValue: f => {
                const a = NodeMan.get("cameraMotionTrack", false)?.array?.[f]?.imageRot;
                return (a != null) ? a * RAD2DEG : NaN;
            },
        });
        G.register("cameraMotion.rotPerFrame", {
            label: "CamMotion Rotation (per-frame)", group: "Camera Motion", units: "deg",
            getValue: f => { const mo = Globals.cameraMotionData?.[f]; return mo ? mo.theta * RAD2DEG : NaN; },
        });
        G.register("cameraMotion.dx", {
            label: "CamMotion X", group: "Camera Motion", units: "px",
            getValue: f => Globals.cameraMotionData?.[f]?.dx ?? NaN,
        });
        G.register("cameraMotion.dy", {
            label: "CamMotion Y", group: "Camera Motion", units: "px",
            getValue: f => Globals.cameraMotionData?.[f]?.dy ?? NaN,
        });

        // Point Track (single object tracker).
        G.register("pointTrack.x", {
            label: "Point Track X", group: "Point Track", units: "px",
            getValue: f => getObjectTracker()?.getInterpolatedPosition(f)?.x ?? NaN,
        });
        G.register("pointTrack.y", {
            label: "Point Track Y", group: "Point Track", units: "px",
            getValue: f => getObjectTracker()?.getInterpolatedPosition(f)?.y ?? NaN,
        });

        // Analyze Motion: raw consensus + smoothed direction. Sparse by design
        // (only analyzed frames are populated; gaps are skipped when plotting).
        const am = () => getMotionAnalyzerForTesting();
        G.register("analyzeMotion.x", {
            label: "Analyze Motion X (raw)", group: "Analyze Motion", units: "px",
            getValue: f => am()?.resultCache.get(f)?.flowData?.consensus?.dx ?? NaN,
        });
        G.register("analyzeMotion.y", {
            label: "Analyze Motion Y (raw)", group: "Analyze Motion", units: "px",
            getValue: f => am()?.resultCache.get(f)?.flowData?.consensus?.dy ?? NaN,
        });
        G.register("analyzeMotion.xSmooth", {
            label: "Analyze Motion X (smoothed)", group: "Analyze Motion", units: "px",
            getValue: f => am()?.resultCache.get(f)?.smoothedDirection?.x ?? NaN,
        });
        G.register("analyzeMotion.ySmooth", {
            label: "Analyze Motion Y (smoothed)", group: "Analyze Motion", units: "px",
            getValue: f => am()?.resultCache.get(f)?.smoothedDirection?.y ?? NaN,
        });

        // Horizon Extractor: raw horizon angle (CW-positive degrees).
        G.register("horizon.angle", {
            label: "Horizon Angle", group: "Horizon", units: "deg",
            getValue: f => getHorizonExtractor()?.getHorizonAt(f)?.angle ?? NaN,
        });
    }

    // Re-register variable-cardinality sources (OSD series, tracks). Called from
    // refreshSources; each has its own membership guard so the registry version
    // only bumps when the set of keys actually changes.
    refreshSources(force = false) {
        const now = Date.now();
        if (!force && now - this._lastSourceRefresh < 150) return;
        this._lastSourceRefresh = now;
        this.reregisterTracks();
        this.reregisterOSD();
        this.reregisterLOS();
        this.reregisterFootball();
    }

    // Ball g-force (football feature). Registered only while the ball is
    // enabled ("Show Football"), so the source doesn't clutter the dropdowns
    // in the (many) custom sitches where the feature is unused. A graph's
    // stored series token survives the source being absent, so toggling the
    // ball off and back on reconnects an existing g-force graph.
    reregisterFootball() {
        const avail = !!(NodeMan.get("footballTrack", false)?.gForce
            && NodeMan.get("footballShowBall", false)?.v(0));
        if (avail === this._footballAvail) return;
        this._footballAvail = avail;
        GraphDataManager.unregisterGroup("football.");
        if (avail) {
            GraphDataManager.register("football.gforce", {
                label: "Ball G-Force", group: "Football", units: "g",
                getValue: f => NodeMan.get("footballTrack", false)?.gForce?.[f] ?? NaN,
            });
        }
    }

    // Sun-vs-LOS angles. For each CNodeDisplayLOS (its .in.LOS gives the look
    // camera's per-frame line of sight as {position, heading}), register:
    //   - the total angle between the LOS forward and the direction to the Sun
    //   - the signed "up" angle (sun elevation offset, in the LOS vertical plane)
    //   - the signed "left" angle (sun azimuth offset, in the LOS horizontal plane)
    // LOS-display node ids vary per sitch (JetLOSDisplayNode, DisplayJetLOS2, ...)
    // and there may be more than one, so we enumerate them.
    reregisterLOS() {
        const nodes = [];
        NodeMan.iterate((id, node) => {
            if (node instanceof CNodeDisplayLOS && node.in && node.in.LOS) nodes.push(node);
        });
        const sig = nodes.map(n => n.id).join("|");
        if (sig === this._losSig) return;
        this._losSig = sig;

        GraphDataManager.unregisterGroup("sunLOS.");
        const multi = nodes.length > 1;
        for (const node of nodes) {
            const tag = multi ? " [" + node.id + "]" : "";
            const los = node.in.LOS;
            GraphDataManager.register("sunLOS." + node.id + ".angle", {
                label: "Sun-LOS angle" + tag, group: "Sun", units: "deg",
                getValue: f => this._sunLOSAngle(los, f, "total"),
            });
            GraphDataManager.register("sunLOS." + node.id + ".up", {
                label: "Sun-LOS up" + tag, group: "Sun", units: "deg",
                getValue: f => this._sunLOSAngle(los, f, "up"),
            });
            GraphDataManager.register("sunLOS." + node.id + ".left", {
                label: "Sun-LOS left" + tag, group: "Sun", units: "deg",
                getValue: f => this._sunLOSAngle(los, f, "left"),
            });
        }
    }

    // Direction to the Sun in world coordinates for frame f. Cached per frame:
    // the Astronomy computation is the only expensive part and depends (for the
    // Sun) essentially only on the date, so a date+frames key invalidates it.
    _sunDir(f, observerPos) {
        const key = (() => { try { return GlobalDateTimeNode.frameToDate(0).getTime() + ":" + Sit.frames; } catch (e) { return "none"; } })();
        if (this._sunKey !== key) { this._sunKey = key; this._sunDirArr = []; }
        let s = this._sunDirArr[f];
        if (s === undefined) {
            try {
                const date = GlobalDateTimeNode.frameToDate(f);
                s = date ? getCelestialDirection("Sun", date, observerPos) : null;
            } catch (e) { s = null; }
            this._sunDirArr[f] = s;
        }
        return s;
    }

    _sunLOSAngle(los, f, which) {
        if (!los || typeof los.v !== "function") return NaN;
        const v = los.v(f);
        if (!v || !v.heading || !v.position) return NaN;
        const F = v.heading;                 // unit forward (LOS direction)
        const A = v.position;                // LOS start (camera position)
        const S = this._sunDir(f, A);        // unit direction to the Sun
        if (!S) return NaN;
        if (which === "total") {
            const d = Math.max(-1, Math.min(1, F.dot(S)));
            return Math.acos(d) * 180 / Math.PI;
        }
        // Build a roll-independent LOS frame from world-up at the camera.
        const up = getLocalUpVector(A);
        const left = up.clone().cross(F).normalize();          // up x forward = left
        if (which === "left") {
            return Math.atan2(S.dot(left), S.dot(F)) * 180 / Math.PI;
        }
        const camUp = F.clone().cross(left).normalize();        // forward x left = up-in-plane
        return Math.atan2(S.dot(camUp), S.dot(F)) * 180 / Math.PI;
    }

    reregisterTracks() {
        const ids = [];
        TrackManager.iterate((id, ob) => { if (ob.trackNode) ids.push(id); });
        const sig = ids.join("|");
        if (sig === this._trackIdSig) return;   // membership unchanged; data read live
        this._trackIdSig = sig;

        GraphDataManager.unregisterGroup("track.");
        TrackManager.iterate((id, ob) => {
            const node = ob.trackNode;
            if (!node) return;
            const sn = ob.menuText ?? node.shortName ?? id;
            GraphDataManager.register("track." + id + ".heading", {
                label: sn + " heading", group: "Tracks", units: "deg", min: -180, max: 180,
                getValue: f => { const h = trackHeading(node, f); return Number.isFinite(h) ? h : NaN; },
            });
            GraphDataManager.register("track." + id + ".speed", {
                label: sn + " speed", group: "Tracks", units: Units ? Units.speedUnits : "m/s",
                getValue: f => {
                    let ff = f;
                    if (ff < 1) ff = 1;
                    if (ff > Sit.frames - 1) ff = Sit.frames - 1;
                    const p1 = node.p(ff);
                    const p0 = node.p(ff - 1);
                    if (!p0 || !p1) return NaN;
                    const v = p1.clone().sub(p0);
                    const up = getLocalUpVector(p1);
                    v.sub(up.clone().multiplyScalar(v.dot(up)));   // ground speed
                    return v.length() * Sit.fps / (Sit.simSpeed ?? 1) * (Units ? Units.m2Speed : 1);
                },
            });
        });
    }

    reregisterOSD() {
        const c = NodeMan.get("osdDataSeriesController", false);
        // Rebuild the dense value cache every call so OSD edits stay fresh.
        const arrays = {};
        const names = [];
        if (c) {
            for (const tr of c.tracks) {
                if (!c._isNumericSeries(tr)) continue;   // skip non-numeric (e.g. MGRS Zone)
                arrays[tr.name] = c._buildExpandedArray(tr);
                names.push(tr.name);
            }
        }
        this._osdArrays = arrays;

        // Only touch registry membership (and bump version) when the name set changes.
        const sig = names.join("|");
        if (sig === this._osdNameSig) return;
        this._osdNameSig = sig;

        GraphDataManager.unregisterGroup("osd.");
        for (const name of names) {
            GraphDataManager.register("osd." + name, {
                label: "OSD-" + name, group: "OSD",
                getValue: f => this._osdArrays[name]?.[f] ?? NaN,
            });
        }
    }
}

export const CustomGraphManager = new CCustomGraphManager();

if (typeof window !== "undefined") {
    window.CustomGraphManager = CustomGraphManager;
}
