// given an array of "positions" smooth the x,y,and z tracks by moving average
// or other techniques
// optionally copy any other data (like color, fov, etc) to the new array
import {GlobalDateTimeNode, NodeMan, setRenderOne, Sit} from "../Globals";
import {RollingAverage, SlidingAverage} from "../utils";
import {CatmullRomCurve3} from "three";
import {V3} from "../threeUtils";
import {assert} from "../assert";
import {CNodeTrack} from "./CNodeTrack";
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
            this.optionalInputs(["iterations", "dataTrack"])
            this.guiFolder = v.guiFolder
        } else {
            // Static mode: only register inputs needed for the current method
            if (this.method === "moving" || this.method === "sliding") {
                this.input("window")
                this.optionalInputs(["iterations"])
            }
            if (this.method === "catmull") {
                this.input("tension")
                this.input("intervals")
            }
        }

        this.frames = this.in.source.frames;
        this.useSitFrames = this.in.source.useSitFrames;

        this.copyData = v.copyData ?? false;

        this.recalculate()

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
        const methods = ["moving", "sliding", "catmull"];
        if (this.in.dataTrack) methods.push("spline");
        this.guiFolder.add(this, "method", methods)
            .name("Smoothing Method")
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
        this.in.window.show(!isCatmull && !isSpline);
        this.in.tension.show(isCatmull);
        this.in.intervals.show(isCatmull);
    }


    exportTrackCSV(inspect=false) {
        return this.exportArray(inspect);

    }

    recalculate() {

        assert(this.in.source !== undefined, "CNodeSmoothedPositionTrack: source input is undefined, id=" + this.id)
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

        } else if (this.method === "moving" || this.method === "sliding") {

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

            var window = this.in.window.v0
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
                    xs = RollingAverage(x, window, iterations)
                    ys = RollingAverage(y, window, iterations)
                    zs = RollingAverage(z, window, iterations)
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
            var interval = Math.floor(this.frames / this.in.intervals.v0)
            var data = []
            for (var i = 0; i < this.frames; i += interval) {
                var splinePoint = this.sourceArray[i].position.clone()
                data.push(splinePoint)
            }
            this.spline = new CatmullRomCurve3(data);
            this.spline.tension = this.in.tension.v0;  // only has effect for catmullrom

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
        let pos;
        if (this.method === "moving" || this.method === "sliding" || this.method === "spline") {
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