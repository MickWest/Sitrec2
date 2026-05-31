// given an array of "positions" smooth the x,y,and z tracks by moving average
// or other techniques
// optionally copy any other data (like color, fov, etc) to the new array
import {GlobalDateTimeNode, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {RollingAveragePolyEdge, SavitzkyGolay, SlidingAverage} from "../smoothing";
import {CatmullRomCurve3} from "three";
import {V3} from "../threeUtils";
import {assert} from "../assert";
import {CNodeTrack} from "./CNodeTrack";
import {t} from "../i18n";
import {saveAs} from "file-saver";

export class CNodeSmoothedPositionTrack extends CNodeTrack {
    constructor(v) {
        super(v)
        this.method = v.method || "moving"
        this.isDynamicSmoothing = v.isDynamicSmoothing ?? false
        this.input("source") // source array node

        if (this.isDynamicSmoothing) {
            // Dynamic mode: register all inputs upfront so we can switch methods at runtime
            this.input("window")
            this.input("tension")
            this.input("intervals")
            this.optionalInputs(["iterations", "dataTrack", "polyOrder", "edgeOrder", "fitWindow"])
            this.guiFolder = v.guiFolder
            if (typeof this.guiFolder === "string") {
                this.guiFolder = guiMenus[this.guiFolder.toLowerCase()]
            }
            if (!this.guiFolder) {
                this.guiFolder = guiMenus.physics
            }
        } else {
            // Static mode: only register inputs needed for the current method
            if (this.method === "moving" || this.method === "movingPolyEdge" || this.method === "sliding" || this.method === "savgol") {
                this.input("window")
                this.optionalInputs(["iterations", "polyOrder", "edgeOrder", "fitWindow"])
            }
            if (this.method === "catmull") {
                this.input("tension")
                this.input("intervals")
            }
        }

        this.frames = this.in.source.frames;
        this.useSitFrames = this.in.source.useSitFrames;

        this.copyData = v.copyData ?? false;

        this._needsRecalculate = true;

        if (this.isDynamicSmoothing) {
            this._setupDynamicSmoothingGUI()
        }

        this.exportable = v.exportable ?? false;
        if (this.exportable) {
            NodeMan.addExportButton(this, "exportTrackCSV")
            NodeMan.addExportButton(this, "exportTrackKML")
        }
    }

    _setupDynamicSmoothingGUI() {
        if (this.smoothingMethodController) {
            this._updateParameterVisibility();
            return;
        }

        // Prefer an explicit guiFolder when provided, otherwise fall back to the window control's folder.
        const parameterFolder = this.guiFolder ?? this.in.window?.gui ?? guiMenus.physics;
        this.guiFolder = parameterFolder;

        const methods = ["none", "moving", "movingPolyEdge", "sliding", "savgol", "spline"];
        this.smoothingMethodController = this.guiFolder.add(this, "method", methods)
            .name(t("misc.smoothingMethod.label"))
            .tooltip(t("misc.smoothingMethod.tooltip"))
            .onChange(() => this._onMethodChanged());
        // Set initial visibility, and defer a second pass to ensure the GUI is fully settled
        this._updateParameterVisibility();
        setTimeout(() => this._updateParameterVisibility(), 0);

        // Refresh visibility when the folder is opened
        this.guiFolder.onOpenClose((gui) => {
            if (!gui._closed) {
                this._updateParameterVisibility();
            }
        });
    }

    _onMethodChanged() {
        this._updateParameterVisibility();
        this.recalculateCascade();
        setRenderOne(true);
    }

    _updateParameterVisibility() {
        const isCatmull = this.method === "catmull";
        const isSpline = this.method === "spline";
        const isDataTrackSpline = isSpline && !!this.in.dataTrack;
        const isNone = this.method === "none";
        const usesWindow = !isCatmull && !isDataTrackSpline && !isNone;
        const usesPoly = this.method === "savgol" || (isSpline && !isDataTrackSpline);
        const usesEdgeFit = this.method === "savgol" || this.method === "movingPolyEdge" || (isSpline && !isDataTrackSpline);
        const usesIntervals = isCatmull || (isSpline && !isDataTrackSpline);

        if (this.in.window?.show) this.in.window.show(usesWindow);
        if (this.in.tension?.show) this.in.tension.show(isCatmull);
        if (this.in.intervals?.show) this.in.intervals.show(usesIntervals);

        if (this.in.polyOrder?.show) this.in.polyOrder.show(usesPoly);
        if (this.in.edgeOrder?.show) this.in.edgeOrder.show(usesEdgeFit);
        if (this.in.fitWindow?.show) this.in.fitWindow.show(usesEdgeFit);
    }


    exportTrackCSV(inspect=false) {
        return this.exportArray(inspect);

    }

    recalculate() {

        assert(this.in.source !== undefined, "CNodeSmoothedPositionTrack: source input is undefined, id=" + this.id)

        // Passthrough: if the source resolves (through a switch) to a lazily-
        // interpolated track that stores no per-frame array (the synthetic app
        // flight), don't bake. Delegate getValue/getValueFrame to the source so
        // the camera gets on-demand smooth values. Re-evaluated every cascade, so
        // switching camera tracks turns this on/off dynamically.
        const resolved = (typeof this.in.source.getObject === 'function')
            ? this.in.source.getObject() : this.in.source;
        if (resolved?.lazyInterpolated === true) {
            this._passthrough = true;
            // Propagate the lazy flag so a smoother-of-this-smoother (e.g. the
            // ObjectTilt orientation smoothers chained off cameraTrackSwitchSmooth)
            // also takes the passthrough path instead of baking 414k entries.
            this.lazyInterpolated = true;
            this.frames = this.in.source.frames;
            this.array = undefined;
            return;
        }
        this._passthrough = false;
        this.lazyInterpolated = false;   // clear when the source is no longer lazy

        assert(!this.in.source._needsRecalculate,
            "CNodeSmoothedPositionTrack(" + this.id + "): direct lazy source " + this.in.source.id + " not supported; use a switch or materialize first");
        this.sourceArray = this.in.source.array;

        if (this.sourceArray === undefined) {
            // need to build it from source node, possibly calculating the values
            // this gives us a per-frame array of {position:...} type vectors
            // and the original data if we want to copy that
            this.sourceArray = []
            for (var i = 0; i < this.in.source.frames; i++) {
                if (this.copyData) {
                    const original = this.in.source.v(i);
                    // make a copy of the original object
                    // and add the smoothed position to it
                    const copy = {...original, position: this.in.source.p(i)};
                    this.sourceArray.push(copy)
                } else {
                    this.sourceArray.push({position: this.in.source.p(i)})
                }
            }
        }

        if (this.method === "spline" && this.in.dataTrack) {
            // Spline: smooth chordal spline through the original sparse data points,
            // sampled per frame with time-based parameter mapping to preserve velocity.
            const dataTrack = this.in.dataTrack;
            const numPoints = dataTrack.misb.length;

            const startMS = GlobalDateTimeNode.getStartTimeValue();
            const msPerFrame = (Sit.simSpeed ?? 1) * 1000 / Sit.fps;

            // Account for time offsets that CNodeTrackFromMISB applies
            const manualOffset = dataTrack.timeOffset ?? 0;
            const startTimeOffset = (typeof dataTrack.getTrackStartTimeOffsetSeconds === 'function')
                ? dataTrack.getTrackStartTimeOffsetSeconds() : 0;
            const totalOffsetFrames = (manualOffset + startTimeOffset) * Sit.fps;

            // Collect valid sparse data point positions and their frame numbers
            const sparsePositions = [];
            const sparseFrames = [];
            for (let i = 0; i < numPoints; i++) {
                if (!dataTrack.isValid(i)) continue;
                sparsePositions.push(dataTrack.getPosition(i));
                const timeMS = dataTrack.getTime(i);
                sparseFrames.push((timeMS - startMS) / msPerFrame - totalOffsetFrames);
            }

            if (sparsePositions.length >= 2) {
                this.spline = new CatmullRomCurve3(sparsePositions);
                this.spline.curveType = 'chordal';

                // Sample per frame using time-based parameter mapping
                const n = sparsePositions.length;
                this.array = [];
                for (let f = 0; f < this.frames; f++) {
                    let t;
                    if (f <= sparseFrames[0]) {
                        t = 0;
                    } else if (f >= sparseFrames[n - 1]) {
                        t = 1;
                    } else {
                        // Find the bracketing sparse points for this frame
                        let idx = 0;
                        while (idx < n - 2 && sparseFrames[idx + 1] < f) {
                            idx++;
                        }
                        // Interpolate spline parameter proportional to time within this segment
                        const alpha = (f - sparseFrames[idx]) / (sparseFrames[idx + 1] - sparseFrames[idx]);
                        t = (idx + alpha) / (n - 1);
                    }
                    const pos = V3();
                    this.spline.getPoint(t, pos);
                    this.array.push({position: pos});
                }
            } else {
                // Not enough sparse points — fall back to copying the source positions
                this.array = [];
                for (let i = 0; i < this.frames; i++) {
                    this.array.push({position: this.in.source.p(i)});
                }
            }
            this.frames = this.array.length;

        } else if (this.method === "none") {
            this.array = []
            for (let i = 0; i < this.sourceArray.length; i++) {
                this.array.push({position: this.in.source.p(i)})
            }
            this.frames = this.array.length;
        } else if (this.method === "spline") {
            // Build a spline from SavGol-smoothed samples, then resample per-frame.
            const x = []
            const y = []
            const z = []
            for (let i = 0; i < this.sourceArray.length; i++) {
                const pos = this.in.source.p(i)
                x.push(pos.x)
                y.push(pos.y)
                z.push(pos.z)
            }

            var window = this.in.window ? this.in.window.v0 : 0
            var iterations = 1
            if (this.in.iterations)
                iterations = this.in.iterations.v0

            if (window > this.sourceArray.length - 3) {
                console.warn("Window size is larger tha 3 less than the number of frames, reducing.")
                window = this.sourceArray.length - 3;
            }

            const isConstant = x.every(v => v === x[0]) && y.every(v => v === y[0]) && z.every(v => v === z[0]);

            let sx = x
            let sy = y
            let sz = z
            if (window > 0 && !isConstant) {
                const polyOrder = this.in.polyOrder ? this.in.polyOrder.v0 : 3;
                const edgeOrder = this.in.edgeOrder ? this.in.edgeOrder.v0 : polyOrder;
                const fitWindow = this.in.fitWindow ? this.in.fitWindow.v0 : window;
                sx = SavitzkyGolay(x, window, polyOrder, iterations, edgeOrder, fitWindow)
                sy = SavitzkyGolay(y, window, polyOrder, iterations, edgeOrder, fitWindow)
                sz = SavitzkyGolay(z, window, polyOrder, iterations, edgeOrder, fitWindow)
            }

            const intervalCount = this.in.intervals ? this.in.intervals.v0 : 20
            const step = Math.max(1, Math.floor(this.frames / intervalCount))
            const controlPoints = []
            const controlFrames = []

            for (let i = 0; i < this.frames; i += step) {
                controlPoints.push(V3(sx[i], sy[i], sz[i]))
                controlFrames.push(i)
            }
            if (controlFrames[controlFrames.length - 1] !== this.frames - 1) {
                const i = this.frames - 1
                controlPoints.push(V3(sx[i], sy[i], sz[i]))
                controlFrames.push(i)
            }

            if (controlPoints.length < 2) {
                this.array = []
                for (let i = 0; i < this.frames; i++) {
                    this.array.push({position: V3(sx[i], sy[i], sz[i])})
                }
            } else {
                this.spline = new CatmullRomCurve3(controlPoints);
                this.spline.curveType = 'chordal';
                this.array = []
                const n = controlPoints.length

                for (let f = 0; f < this.frames; f++) {
                    let t;
                    if (f <= controlFrames[0]) {
                        t = 0;
                    } else if (f >= controlFrames[n - 1]) {
                        t = 1;
                    } else {
                        let idx = 0;
                        while (idx < n - 2 && controlFrames[idx + 1] < f) {
                            idx++;
                        }
                        const denom = controlFrames[idx + 1] - controlFrames[idx];
                        const alpha = denom > 0 ? (f - controlFrames[idx]) / denom : 0;
                        t = (idx + alpha) / (n - 1);
                    }
                    const pos = V3()
                    this.spline.getPoint(t, pos)
                    this.array.push({position: pos})
                }
            }
            this.frames = this.array.length;
        } else if (this.method === "moving" || this.method === "movingPolyEdge" || this.method === "sliding" || this.method === "savgol") {

            // create x,y,z arrays using getValueFrame, so we can smooth abstract data
            // (like catmullrom tracks, which don't create the sourceArray)

            const x = []
            const y = []
            const z = []
            for (let i = 0; i < this.sourceArray.length; i++) {
                const pos = this.in.source.p(i)
                x.push(pos.x)
                y.push(pos.y)
                z.push(pos.z)
            }

            var window = this.in.window ? this.in.window.v0 : 0
            var iterations = 1
            if (this.in.iterations)
                iterations = this.in.iterations.v0

            var xs, ys, zs;

            if (window > this.sourceArray.length-3) {
                console.warn("Window size is larger tha 3 less than the number of frames, reducing.")
                window = this.sourceArray.length - 3;
            }

            const isConstant = x.every(v => v === x[0]) && y.every(v => v === y[0]) && z.every(v => v === z[0]);

            if (window <= 0 || isConstant) {
                xs = x
                ys = y
                zs = z
            } else {
                if (this.method === "moving") {
                    xs = RollingAveragePolyEdge(x, window, iterations, 2, window)
                    ys = RollingAveragePolyEdge(y, window, iterations, 2, window)
                    zs = RollingAveragePolyEdge(z, window, iterations, 2, window)
                } else if (this.method === "movingPolyEdge") {
                    const edgeOrder = this.in.edgeOrder ? this.in.edgeOrder.v0 : 2;
                    const fitWindow = this.in.fitWindow ? this.in.fitWindow.v0 : window;
                    xs = RollingAveragePolyEdge(x, window, iterations, edgeOrder, fitWindow)
                    ys = RollingAveragePolyEdge(y, window, iterations, edgeOrder, fitWindow)
                    zs = RollingAveragePolyEdge(z, window, iterations, edgeOrder, fitWindow)
                } else if (this.method === "savgol") {
                    const polyOrder = this.in.polyOrder ? this.in.polyOrder.v0 : 2;
                    const edgeOrder = this.in.edgeOrder ? this.in.edgeOrder.v0 : polyOrder;
                    const fitWindow = this.in.fitWindow ? this.in.fitWindow.v0 : window;
                    xs = SavitzkyGolay(x, window, polyOrder, iterations, edgeOrder, fitWindow)
                    ys = SavitzkyGolay(y, window, polyOrder, iterations, edgeOrder, fitWindow)
                    zs = SavitzkyGolay(z, window, polyOrder, iterations, edgeOrder, fitWindow)
                } else {
                    xs = SlidingAverage(x, window, iterations)
                    ys = SlidingAverage(y, window, iterations)
                    zs = SlidingAverage(z, window, iterations)
                }
            }

            this.array = []
            for (var i = 0; i < x.length; i++) {
                this.array.push({position: V3(xs[i], ys[i], zs[i])})
            }
            this.frames = this.array.length;
        } else {
            // Catmull: spline through uniformly-sampled points from the per-frame data
            const intervalCount = this.in.intervals ? this.in.intervals.v0 : 10
            var interval = Math.max(1, Math.floor(this.frames / intervalCount))
            var data = []
            for (var i = 0; i < this.frames; i += interval) {
                var splinePoint = this.sourceArray[i].position.clone()
                data.push(splinePoint)
            }
            this.spline = new CatmullRomCurve3(data);
            this.spline.tension = this.in.tension ? this.in.tension.v0 : 0.5;  // only has effect for catmullrom

            // chordal keeps the velocity smooth across a segment
            this.spline.curveType = 'chordal';

            // pre-compute the array of positions
            this.array = []
            for (var i = 0; i < this.frames; i++) {
                var pos = V3()
                var t = i / this.frames
                this.spline.getPoint(t, pos)
                this.array.push({position: pos})
            }

        }

        // // if the source array has misbRows, then we need to copy them to the new array
        // // so that we can use them in the output
        // // this will be done in getValueFrame
        // assert(this.array !== undefined, "CNodeSmoothedPositionTrack: array is undefined, id=" + this.id)
        // for (let i = 0; i < this.sourceArray.length; i++) {
        //     if (this.sourceArray[i].misbRow !== undefined) {
        //         assert(this.array[i] !== undefined, "CNodeSmoothedPositionTrack: array[i] is undefined, i=" + i)
        //         this.array[i].misbRow = this.sourceArray[i].misbRow
        //     }
        // }

    }

    getValueFrame(frame) {
        if (this._needsRecalculate) {
            this._needsRecalculate = false;
            this.recalculate();
        } else if (this.array && this.array.length < this.in.source.frames) {
            // The source track grew (e.g. MISB frame data finished loading
            // after this smoothed track was first recalculated) and the
            // recalculate cascade did not mark us dirty. Self-heal by
            // rebuilding now that we've been asked for a frame past the end.
            this.recalculate();
        }
        if (this._passthrough) {
            return this.in.source.getValueFrame(frame);
        }
        let pos;
        if (this.method === "none" || this.method === "moving" || this.method === "movingPolyEdge" || this.method === "sliding" || this.method === "savgol" || this.method === "spline") {
            assert(this.array[frame] !== undefined, "CNodeSmoothedPositionTrack: array[frame] is undefined, frame=" + frame + " id=" + this.id)
            pos = this.array[frame].position
        } else {
            pos = V3()
            var t = frame / this.frames
            this.spline.getPoint(t, pos)
        }

        if (this.copyData) {
            return {
                ...this.sourceArray[frame], // might have other data, if copyData was set
                ...{position: pos}
            }
        } else {
            // just a bit quicker to not copy the data if we don't have to
            return {position: pos}
        }

    }

    getValue(frame) {
        if (this._needsRecalculate) {
            this._needsRecalculate = false;
            this.recalculate();
        }
        if (this._passthrough) {
            return this.in.source.getValue(frame);
        }
        return super.getValue(frame);
    }

    exportArray(inspect = false) {
        if (this._passthrough) {
            // No per-frame array to export; defer to the source if it can.
            if (typeof this.in.source.exportArray === 'function') {
                return this.in.source.exportArray(inspect);
            }
            return inspect ? null : undefined;
        }
        return super.exportArray(inspect);
    }


    dump() {

        if (this.spline !== undefined) {
            var out = ""

            out += "frame,t,x,y,z,v\n"
            var lastPos = V3()
            this.spline.getPoint(0, lastPos)
            for (var f = 1; f < this.frames; f++) {
                var pos = V3()
                var t = f / this.frames
                this.spline.getPoint(t, pos)

                var v = pos.clone().sub(lastPos).length()

                out += f + ",";
                out += t + ",";
                out += pos.x + ",";
                out += pos.y + ",";
                out += pos.z + ",";
                out += v + "\n";

                lastPos = pos


                // last line no comma, lf
                //out += data[8][f] + "\n"
            }

            saveAs(new Blob([out]), "gimbalSpline.csv")
        }
    }


}
