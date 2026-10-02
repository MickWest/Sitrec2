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
import {defaultViewDark} from "./Theme";
import {viewMenuKey} from "./ViewUIBarMenus";
import {CNodeCustomGraphView} from "./nodes/CNodeCustomGraphView";
import {CNodeDisplayLOS} from "./nodes/CNodeDisplayLOS";
import {shortObjectName} from "./nodes/CNode3DObject";
import {altitudeHAE, getLocalUpVector, getLocalNorthVector, getLocalEastVector} from "./SphericalMath";
import {objectFocusTrack} from "./CameraFocusUI";
import {graphPosition, graphVelocity, graphGroundSpeed, graphVerticalSpeed, graphSlantRange, graphHeading, graphAcceleration} from "./CustomGraphMeasurements";
import {getCelestialDirection} from "./CelestialMath";
import {getHorizonExtractor} from "./CHorizonExtractor";
import {getObjectTracker} from "./CObjectTracking";
import {getMotionAnalyzerForTesting} from "./CMotionAnalysisUI";

const RAD2DEG = 180 / Math.PI;

// One custom graph: a view + a subfolder of controls + the selected series tokens.
export class CCustomGraph {
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
        // GUI fields retain saved selections, including unavailable sources.
        this._entities = {x: "timeline", y1: "None", y2: "None", y3: "None"};
        this._gs = {x: "frames", y1: "None", y2: "None", y3: "None"};
        this._axisControls = [];
        this._xCtrl = this._y1Ctrl = this._y2Ctrl = this._y3Ctrl = this._removeCtrl = null;
        this._tabMirrorKeys = new Set();
        this._lastSeriesSig = null;
        this._cachedVersion = -1;
        this._lastRefresh = 0;
    }

    folderTitle() {
        return (this.title && this.title.length) ? this.title : ("Graph " + this.id);
    }

    // Entity selectors keep the measurement menus short. Persisted tokens are
    // independent from each control, including while a source is unavailable.
    rebuildDropdowns() {
        const folder = this.folder;
        if (!folder) return;
        for (const control of this._axisControls) control.destroy();
        this._axisControls = [];
        this._removeCtrl?.destroy();
        for (const axis of ["x", "y1", "y2", "y3"]) {
            const storedProperty = "_stored" + axis.toUpperCase();
            const token = this[storedProperty];
            const entity = token !== "None" ? GraphDataManager.entityForSeries(token) : this._entities[axis];
            this._entities[axis] = entity;
            const entities = GraphDataManager.entities(axis !== "x", axis === "x");
            if (!Object.values(entities).includes(entity)) entities[`${entity} (unavailable)`] = entity;
            const measurements = GraphDataManager.measurements(entity, axis !== "x");
            if (!Object.values(measurements).includes(token)) {
                measurements[`${GraphDataManager.get(token)?.measurement ?? token.split(".").pop()} (unavailable)`] = token;
            }
            this._gs[axis] = token;
            const axisLabel = t("graphControls." + (axis === "x" ? "xAxis" : axis + "Axis"));
            const entityControl = folder.add(this._entities, axis, entities).name(axisLabel.replace(/ (\(.+\))$/, " entity $1") + (axis === "x" ? " entity" : ""))
                .tooltip("Choose the object, track or analysis to measure")
                .onChange(value => {
                    const previous = GraphDataManager.get(this[storedProperty]);
                    const options = GraphDataManager.measurements(value, axis !== "x");
                    const keys = Object.values(options).filter(key => key !== "None");
                    const previousMetric = previous?.measurementId ?? this[storedProperty].split(".").pop();
                    this[storedProperty] = value === "None" ? "None" :
                        keys.find(key => (GraphDataManager.get(key)?.measurementId ?? key.split(".").pop()) === previousMetric)
                        ?? keys.find(key => key.endsWith(".speed")) ?? keys[0] ?? (axis === "x" ? "frames" : "None");
                    this.rebuildDropdowns();
                    this.updateGraph(true);
                });
            const measurementControl = folder.add(this._gs, axis, measurements).name(axis.toUpperCase() + " measure")
                .tooltip("Choose a measurement for this axis; None hides this series")
                .onChange(value => {
                    // Changing one axis must never clear an unavailable selection
                    // on a different axis.
                    this[storedProperty] = value;
                    this.updateGraph(true);
                });
            if (entity === "None") measurementControl.disable();
            this._axisControls.push(entityControl, measurementControl);
            this["_" + axis + "Ctrl"] = measurementControl;
        }
        this._removeCtrl = folder.add({remove: () => CustomGraphManager.removeGraph(this.id)}, "remove")
            .name(t("graphControls.remove"));
        this.mirrorControlsToTabMenu();
    }

    mirrorControlsToTabMenu() {
        const menu = this.view?.tabMenu;
        if (!menu || !this.folder) return;
        for (const controller of this.folder.controllers) {
            const kind = controller.object === this._entities ? "entity:" : "";
            const key = viewMenuKey(this.id, `graph:${kind}${controller.property}`);
            // Publishing replacement dropdowns rebuilds their existing mirrors.
            // Subscribe once so refreshing the sources never duplicates rows.
            controller.shareAs(key);
            if (!this._tabMirrorKeys.has(key)) {
                menu.addMirror(key);
                this._tabMirrorKeys.add(key);
            }
        }
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
            const hasFixedBounds = desc && Number.isFinite(desc.min) && Number.isFinite(desc.max);
            const s = {data, label: GraphDataManager.seriesLabel(key), yAxis,
                minimumRange: hasFixedBounds ? undefined : desc?.minimumRange};
            if (hasFixedBounds) {
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
            ? (anySelected ? "No data for the selected measurement — restore its source or run its analysis"
                           : "Select an entity and measurement for Y1, Y2 or Y3")
            : null;

        const xDescriptor = GraphDataManager.get(this._storedX);
        const yDescriptor = GraphDataManager.get(this._storedY1);
        const spatialMetrics = new Set(["x", "y", "xSmooth", "ySmooth", "dx", "dy"]);
        this.view.equalAspect = !!(xDescriptor && yDescriptor
            && GraphDataManager.entityForSeries(this._storedX) === GraphDataManager.entityForSeries(this._storedY1)
            && ["pointTrack", "analyzeMotion", "cameraMotion"].includes(xDescriptor.entity)
            && spatialMetrics.has(xDescriptor.measurementId) && spatialMetrics.has(yDescriptor.measurementId)
            && xDescriptor.units === yDescriptor.units);

        // Include labels and axis mode, and compare every sampled X/Y value:
        // editing an interior keyframe must refresh even when the endpoints stay.
        // Include the frame range so changing the in/out points re-plots in A→B mode.
        const sig = "x:" + this._storedX + ":" + GraphDataManager.seriesLabel(this._storedX) + ":" + this.view.equalAspect + ":" + this.view.emptyMessage + ":" + fMin + "-" + fMax + "|" + series.map(s => {
            const n = s.data.length;
            const mid = s.data[n >> 1];
            return `${s.yAxis}:${s.label}:${n}:${s.data[0]?.y ?? ''}:${mid?.y ?? ''}:${s.data[n - 1]?.y ?? ''}:${s.fixedMin ?? ''}:${s.fixedMax ?? ''}:${s.minimumRange ?? ''}`;
        }).join("||");
        const sameData = this._lastSeriesData?.length === series.length && series.every((s, index) => {
            const old = this._lastSeriesData[index].data;
            return old.length === s.data.length && s.data.every((p, i) =>
                p.frame === old[i].frame && p.x === old[i].x && p.y === old[i].y);
        });
        if (!force && sig === this._lastSeriesSig && sameData) return;
        this._lastSeriesSig = sig;
        this._lastSeriesData = series;

        const frameX = (this._storedX === "frames" || this._storedX === "framesAB" || !this._storedX);
        this.view.isFrameX = frameX;
        this.view.fixedXRange = frameX ? xWindow : null;
        this.view.xLabel = frameX
            ? (ab ? "Frame (A→B)" : (this.lastSeconds > 0 ? `Frame (last ${this.lastSeconds}s)` : "Frame"))
            : GraphDataManager.seriesLabel(this._storedX);
        this.view.setSeries(series);
    }

    serialize() {
        return {
            id: this.id,
            title: this.title,
            // Saved when the user set this graph on purpose, or when it is not in its default
            // mode. A graph with no saved mode follows the theme of the person who opens the sitch.
            dark: this.view && (this.view.themeExplicit || this.view.dark !== defaultViewDark(true))
                ? this.view.dark : undefined,
            showLegend: this.view ? this.view.showLegend : true,
            show: this.view ? this.view.visible : true,
            xEntity: this._entities.x,
            y1Entity: this._entities.y1,
            y2Entity: this._entities.y2,
            y3Entity: this._entities.y3,
            xSeries: this._storedX,
            y1Series: this._storedY1,
            y2Series: this._storedY2,
            y3Series: this._storedY3,
            lastSeconds: this.lastSeconds,
        };
    }
}

export class CCustomGraphManager {
    constructor() {
        this.list = {};                  // id -> CCustomGraph
        this._nextId = 0;
        this._osdArrays = {};            // OSD name -> dense per-frame value array
        this._osdNameSig = undefined;    // membership signature for OSD keys
        this._trackIdSig = undefined;    // membership signature for track keys
        this._tracksChangedListener = null;
        this._addGraphForEntityListener = null;
        this._extraTrackIds = new Set();
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
        if (this._addGraphForEntityListener) {
            EventManager.removeEventListener("addCustomGraphForEntity", this._addGraphForEntityListener);
        }
        this._addGraphForEntityListener = payload => {
            if (payload?.entityId) this.addGraphForEntity(payload.entityId, {title: payload.title});
        };
        EventManager.addEventListener("addCustomGraphForEntity", this._addGraphForEntityListener);

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
        this._objectIdSig = undefined;
        this._extraTrackIds.clear();
        this._losSig = undefined;
        this._footballAvail = undefined;
        this._sunDirArr = null;
        this._sunKey = undefined;
        if (this._tracksChangedListener) {
            EventManager.removeEventListener("tracksChanged", this._tracksChangedListener);
            this._tracksChangedListener = null;
        }
        if (this._addGraphForEntityListener) {
            EventManager.removeEventListener("addCustomGraphForEntity", this._addGraphForEntityListener);
            this._addGraphForEntityListener = null;
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
            dark: config.dark,   // undefined = the global theme
            showLegend: config.showLegend ?? true,
            visible: config.show ?? true,
            left,
            top,
            width: 0.4,
            height: 0.4,
            preserveGaps: true, equalAspect: false,
            draggable: true, resizable: true, freeAspect: true, shiftDrag: false,
        });

        const graph = new CCustomGraph(id, view);
        graph.title = config.title ?? "";
        graph._storedX  = config.xSeries  ?? "frames";
        graph._storedY1 = config.y1Series ?? "None";
        graph._storedY2 = config.y2Series ?? "None";
        graph._storedY3 = config.y3Series ?? "None";
        for (const axis of ["x", "y1", "y2", "y3"]) {
            graph._entities[axis] = config[axis + "Entity"] ?? GraphDataManager.entityForSeries(graph["_stored" + axis.toUpperCase()]);
        }
        // A saved standalone track is not necessarily in TrackManager. Retain
        // its entity even when all its measurements were set to None.
        for (const entity of Object.values(graph._entities)) {
            if (entity?.startsWith("node.")) this._extraTrackIds.add(entity.slice(5));
        }
        for (const key of [graph._storedX, graph._storedY1, graph._storedY2, graph._storedY3]) {
            if (key?.startsWith("node.")) this._extraTrackIds.add(key.slice(5, key.lastIndexOf(".")));
        }
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
        // listen(): the view header's Dark / Light button changes the same flag.
        // setDark(): a change here is a choice for this graph, so it is saved.
        folder.add(view, 'dark').name(t("graphControls.dark")).onChange((value) => view.setDark(value)).listen();
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

    // Used by track and object menus. Resolve the live node each sample so
    // changing an object's position controller or reloading a track stays live.
    addGraphForEntity(nodeOrId, {title} = {}) {
        const id = typeof nodeOrId === "string" ? nodeOrId : nodeOrId?.id;
        const node = NodeMan.get(id, false);
        let entity;
        let name = title ?? node?.displayName ?? node?.menuName ?? id;
        const imported = TrackManager.get(id, false) ?? TrackManager.trackForObject?.(id);
        if (imported?.trackNode) {
            entity = "track." + imported.trackID;
            name = title ?? imported.displayName ?? imported.menuText ?? name;
        } else {
            TrackManager.iterate((trackId, ob) => {
                if (!entity && ob.trackNode?.id === id) entity = "track." + trackId;
            });
            if (!entity && node?.exportTrackNode) entity = "object." + id;
            if (!entity) {
                // A displayed camera/traverse track may already drive an object
                // with the same measurements. Reuse that entity instead of
                // adding a second copy of every series under a node token.
                NodeMan.iterate((objectId, object) => {
                    if (entity || !object.exportTrackNode || TrackManager.trackForObject?.(objectId)) return;
                    if (objectFocusTrack(object)?.id === id) {
                        entity = "object." + objectId;
                        name = title ?? object.displayName ?? object.menuName ?? name;
                    }
                });
            }
            if (!entity && node?.p) {
                entity = "node." + id;
                this._extraTrackIds.add(id);
            }
        }
        if (!entity) return null;
        this.refreshSources(true);
        const graph = this.addGraph({
            title: `${shortObjectName(name)} — Speed & altitude`,
            y1Series: entity + ".speed", y2Series: entity + ".altitude",
        });
        graph.folder.open();
        graph.view.tabMenu?.open();
        graph.view.uiBar?.onMenuStateChange?.();
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

        const originalRegister = G.register.bind(G);
        const register = (key, descriptor) => {
            descriptor.measurement = descriptor.label
                .replace(/^(CamMotion|Point Track|Analyze Motion|Horizon) /, "");
            descriptor.measurementId = key.split(".").pop();
            originalRegister(key, descriptor);
        };

        // Camera Motion: cumulative + per-frame rotation, and image translation.
        register("cameraMotion.rotCumulative", {
            label: "CamMotion Rotation (cumulative)", group: "Camera Motion", entity: "cameraMotion", entityLabel: "CamMotion",
            available: () => !!(Globals.cameraMotionData?.length || NodeMan.get("cameraMotionTrack", false)?.array?.length), units: "deg",
            getValue: f => {
                const a = NodeMan.get("cameraMotionTrack", false)?.array?.[f]?.imageRot;
                return (a != null) ? a * RAD2DEG : NaN;
            },
        });
        register("cameraMotion.rotPerFrame", {
            label: "CamMotion Rotation (per-frame)", group: "Camera Motion", entity: "cameraMotion", entityLabel: "CamMotion",
            available: () => !!(Globals.cameraMotionData?.length || NodeMan.get("cameraMotionTrack", false)?.array?.length), units: "deg",
            getValue: f => { const mo = Globals.cameraMotionData?.[f]; return mo ? mo.theta * RAD2DEG : NaN; },
        });
        register("cameraMotion.dx", {
            label: "CamMotion X", group: "Camera Motion", entity: "cameraMotion", entityLabel: "CamMotion",
            available: () => !!(Globals.cameraMotionData?.length || NodeMan.get("cameraMotionTrack", false)?.array?.length), units: "px",
            getValue: f => Globals.cameraMotionData?.[f]?.dx ?? NaN,
        });
        register("cameraMotion.dy", {
            label: "CamMotion Y", group: "Camera Motion", entity: "cameraMotion", entityLabel: "CamMotion",
            available: () => !!(Globals.cameraMotionData?.length || NodeMan.get("cameraMotionTrack", false)?.array?.length), units: "px",
            getValue: f => Globals.cameraMotionData?.[f]?.dy ?? NaN,
        });

        // Point Track (single object tracker).
        register("pointTrack.x", {
            label: "Point Track X", group: "Point Track", entity: "pointTrack", entityLabel: "Point Track",
            available: () => !!(getObjectTracker()?.enabled || getObjectTracker()?.trackedPositions?.size), units: "px",
            getValue: f => getObjectTracker()?.getInterpolatedPosition(f)?.x ?? NaN,
        });
        register("pointTrack.y", {
            label: "Point Track Y", group: "Point Track", entity: "pointTrack", entityLabel: "Point Track",
            available: () => !!(getObjectTracker()?.enabled || getObjectTracker()?.trackedPositions?.size), units: "px",
            getValue: f => getObjectTracker()?.getInterpolatedPosition(f)?.y ?? NaN,
        });

        // Analyze Motion: raw consensus + smoothed direction. Sparse by design
        // (only analyzed frames are populated; gaps are skipped when plotting).
        const am = () => getMotionAnalyzerForTesting();
        register("analyzeMotion.x", {
            label: "Analyze Motion X (raw)", group: "Analyze Motion", entity: "analyzeMotion", entityLabel: "Analyze Motion",
            available: () => !!am()?.resultCache?.size, units: "px",
            getValue: f => am()?.resultCache.get(f)?.flowData?.consensus?.dx ?? NaN,
        });
        register("analyzeMotion.y", {
            label: "Analyze Motion Y (raw)", group: "Analyze Motion", entity: "analyzeMotion", entityLabel: "Analyze Motion",
            available: () => !!am()?.resultCache?.size, units: "px",
            getValue: f => am()?.resultCache.get(f)?.flowData?.consensus?.dy ?? NaN,
        });
        register("analyzeMotion.xSmooth", {
            label: "Analyze Motion X (smoothed)", group: "Analyze Motion", entity: "analyzeMotion", entityLabel: "Analyze Motion",
            available: () => !!am()?.resultCache?.size, units: "px",
            getValue: f => am()?.resultCache.get(f)?.smoothedDirection?.x ?? NaN,
        });
        register("analyzeMotion.ySmooth", {
            label: "Analyze Motion Y (smoothed)", group: "Analyze Motion", entity: "analyzeMotion", entityLabel: "Analyze Motion",
            available: () => !!am()?.resultCache?.size, units: "px",
            getValue: f => am()?.resultCache.get(f)?.smoothedDirection?.y ?? NaN,
        });

        // Horizon Extractor: raw horizon angle (CW-positive degrees).
        register("horizon.angle", {
            label: "Horizon Angle", group: "Horizon", entity: "horizon", entityLabel: "Horizon",
            available: () => !!(getHorizonExtractor()?.enabled || getHorizonExtractor()?.keyframes?.size), units: "deg",
            getValue: f => getHorizonExtractor()?.getHorizonAt(f)?.angle ?? NaN,
        });
    }

    // Re-register variable-cardinality sources (OSD series, tracks). Called from
    // refreshSources; each has its own guard so the registry version only bumps
    // when the available sources or their labels change.
    refreshSources(force = false) {
        const now = Date.now();
        if (!force && now - this._lastSourceRefresh < 150) return;
        this._lastSourceRefresh = now;
        this.reregisterTracks();
        this.reregisterObjects();
        this.reregisterOSD();
        this.reregisterLOS();
        this.reregisterFootball();
        GraphDataManager.refreshAvailability();
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
                label: "Ball G-Force", measurement: "G-force", entity: "football", entityLabel: "Football", group: "Football", units: "g",
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
                label: "Sun-LOS angle" + tag, measurement: "LOS angle", entity: "sunLOS." + node.id, entityLabel: "Sun" + tag, group: "Sun", units: "deg",
                getValue: f => this._sunLOSAngle(los, f, "total"),
            });
            GraphDataManager.register("sunLOS." + node.id + ".up", {
                label: "Sun-LOS up" + tag, measurement: "LOS up", entity: "sunLOS." + node.id, entityLabel: "Sun" + tag, group: "Sun", units: "deg",
                getValue: f => this._sunLOSAngle(los, f, "up"),
            });
            GraphDataManager.register("sunLOS." + node.id + ".left", {
                label: "Sun-LOS left" + tag, measurement: "LOS left", entity: "sunLOS." + node.id, entityLabel: "Sun" + tag, group: "Sun", units: "deg",
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

    _measurementUnits() {
        return {
            speed: Units?.speedUnits ?? "m/s",
            altitude: Units?.smallUnitsAbbrev ?? "m",
            range: Units?.bigUnitsAbbrev ?? "m",
            vertical: Units?.vsUnits ?? "m/s",
        };
    }

    _lookCameraSource() {
        const camera = NodeMan.get("lookCamera", false);
        return camera ? objectFocusTrack(camera) : null;
    }

    _registerPositionSeries(entity, name, resolveSource) {
        const units = this._measurementUnits();
        const context = () => ({frames: Sit.frames, fps: Sit.fps, simSpeed: Sit.simSpeed ?? 1});
        const register = (metric, measurement, unit, getValue, extra = {}) => GraphDataManager.register(entity + "." + metric, {
            entity, entityLabel: name, group: "Tracks", measurementId: metric,
            measurement, label: name + " " + measurement.toLowerCase(), units: unit, getValue, ...extra,
        });
        register("speed", "Ground speed", units.speed, f => graphGroundSpeed(resolveSource(), f, context(), getLocalUpVector) * (Units?.m2Speed ?? 1), {minimumRange: 10});
        register("altitude", "Altitude HAE", units.altitude, f => {
            const p = graphPosition(resolveSource(), f);
            return p ? altitudeHAE(p) * (Units?.m2Small ?? 1) : NaN;
        }, {minimumRange: 10});
        register("speed3D", "3D speed", units.speed, f => graphVelocity(resolveSource(), f, context())?.velocity.length() * (Units?.m2Speed ?? 1), {minimumRange: 10});
        register("verticalSpeed", "Vertical speed", units.vertical, f => graphVerticalSpeed(resolveSource(), f, context(), altitudeHAE) / (Units?.vs2mps ?? 1), {minimumRange: 10});
        register("heading", "Heading", "deg", f => graphHeading(resolveSource(), f, context(),
            getLocalUpVector, getLocalNorthVector, getLocalEastVector), {min: -180, max: 180});
        register("gforce", "Acceleration", "g", f => graphAcceleration(resolveSource(), f, context()));
        if (NodeMan.exists("lookCamera")) {
            register("slantRange", "Slant range to look camera", units.range,
                f => graphSlantRange(resolveSource(), this._lookCameraSource(), f) * (Units?.m2Big ?? 1));
        }
    }

    reregisterTracks() {
        const tracks = [];
        TrackManager.iterate((id, ob) => {
            if (!ob.trackNode) return;
            const name = shortObjectName(ob.displayName ?? ob.displayTargetSphere?.menuName
                ?? ob.menuText ?? ob.trackNode.shortName ?? id);
            tracks.push({id, name});
        });
        const sig = JSON.stringify([tracks, this._measurementUnits(), NodeMan.exists("lookCamera")]);
        if (sig === this._trackIdSig) return;
        this._trackIdSig = sig;
        GraphDataManager.unregisterGroup("track.");
        for (const {id, name} of tracks) {
            this._registerPositionSeries("track." + id, name, () => TrackManager.get(id, false)?.trackNode);
        }
    }

    reregisterObjects() {
        const objects = [];
        NodeMan.iterate((id, node) => {
            if (!node.exportTrackNode || TrackManager.trackForObject?.(id)) return;
            objects.push({id, name: shortObjectName(node.displayName ?? node.menuName ?? id)});
        });
        const extraTracks = [...this._extraTrackIds].filter(id => NodeMan.exists(id));
        const sig = JSON.stringify([objects, extraTracks, this._measurementUnits(), NodeMan.exists("lookCamera")]);
        if (sig === this._objectIdSig) return;
        this._objectIdSig = sig;
        GraphDataManager.unregisterGroup("object.");
        GraphDataManager.unregisterGroup("node.");
        for (const {id, name} of objects) {
            this._registerPositionSeries("object." + id, name, () => {
                const object = NodeMan.get(id, false);
                return object ? objectFocusTrack(object) : null;
            });
        }
        for (const id of extraTracks) {
            const node = NodeMan.get(id, false);
            this._registerPositionSeries("node." + id, shortObjectName(node.displayName ?? node.menuName ?? id),
                () => NodeMan.get(id, false));
        }
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
                label: "OSD-" + name, measurement: name, entity: "osd", entityLabel: "OSD", group: "OSD",
                getValue: f => this._osdArrays[name]?.[f] ?? NaN,
            });
        }
    }
}

export const CustomGraphManager = new CCustomGraphManager();

if (typeof window !== "undefined") {
    window.CustomGraphManager = CustomGraphManager;
}
