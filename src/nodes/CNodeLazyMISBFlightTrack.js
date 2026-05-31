import {CatmullRomCurve3} from "three";
import {GlobalDateTimeNode, Sit} from "../Globals";
import {V3} from "../threeUtils";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {roundIfClose} from "../utils";
import {saveAs} from "file-saver";
import {CNodeTrackFromMISB} from "./CNodeTrackFromMISB";

// A lazily-interpolated flight track, used only for the synthetic "Open in Sitrec"
// airplane flight (gated by FileManager info.isAppFlight). It keeps full
// CNodeTrackFromMISB semantics (MISB/KML export, time-offset wrapper) but never
// materializes a per-frame array. Instead it stores the sparse MISB samples
// (≤1200) as a chordal Catmull-Rom curve and evaluates it on demand at the
// (fractional) global frame the camera asks for.
//
// This mirrors the existing sparse-spline path in
// CNodeSmoothedPositionTrack.recalculate() (the method:"spline" + dataTrack
// branch), but evaluated lazily rather than baked into this.array.
export class CNodeLazyMISBFlightTrack extends CNodeTrackFromMISB {

    // Build the sparse curve instead of a per-frame array. The base
    // CNodeTrackFromMISB constructor calls this once, so _curve exists from
    // construction. recalculate() is re-run by the cascade on fps / Sit.frames /
    // start-time changes, which just remaps frame->t (curve geometry is
    // fps-independent).
    recalculate() {
        this.frames = Sit.frames;
        this.useSitFrames = true;
        this.array = undefined;
        // Flag checked by CNodeSmoothedPositionTrack to switch into passthrough.
        // Set here (rather than only the constructor) so it is defined before any
        // downstream smoother recalculates.
        this.lazyInterpolated = true;

        const misb = this.in.misb;
        misb.selectSourceColumns(this._columns);

        const startMS = this.in.startTime.getStartTimeValue();
        const msPerFrame = (Sit.simSpeed ?? 1) * 1000 / Sit.fps;

        // Gather valid sparse ECEF samples and their *raw* track-frame numbers
        // (no time offset here — applied once in getValue()).
        this._pts = [];
        this._frameOf = [];
        const len = misb.misb.length;
        for (let i = 0; i < len; i++) {
            if (!misb.isValid(i)) continue;
            this._pts.push(misb.getPosition(i));
            this._frameOf.push((misb.getTime(i) - startMS) / msPerFrame);
        }

        if (this._pts.length >= 2) {
            this._curve = new CatmullRomCurve3(this._pts);
            this._curve.curveType = 'chordal';
        } else {
            // Degenerate: 0 or 1 valid points — hold at the single point.
            this._curve = null;
        }
    }

    // Accepts a fractional frame. Maps frame -> curve parameter t proportional to
    // time within the bracketing segment, clamped to [0,1] outside the data, then
    // samples the curve. Never touches this.array (so it bypasses the
    // CNodeTrack.getValueFrame array.length>0 assert).
    getValueFrame(frame) {
        if (this._curve === undefined) {
            // Defensive: normally built in the constructor's recalculate().
            this.recalculate();
        }
        if (this._curve === null) {
            const pos = this._pts.length > 0 ? this._pts[0] : V3();
            return {position: pos.clone()};
        }

        const frameOf = this._frameOf;
        const n = frameOf.length;
        let t;
        if (frame <= frameOf[0]) {
            t = 0;
        } else if (frame >= frameOf[n - 1]) {
            t = 1;
        } else {
            let idx = 0;
            while (idx < n - 2 && frameOf[idx + 1] < frame) {
                idx++;
            }
            const denom = frameOf[idx + 1] - frameOf[idx];
            const alpha = denom > 0 ? (frame - frameOf[idx]) / denom : 0;
            t = (idx + alpha) / (n - 1);
        }

        const pos = V3();
        this._curve.getPoint(t, pos);
        return {position: pos};
    }

    // Apply the MISB time offset exactly once, then sample the curve directly at
    // the fractional frame (true Catmull-Rom smoothness, and cheaper than the base
    // class's two-sample linear blend). Bypasses CNode.getValue's
    // getValueFrame(0).position assert by not calling super.getValue().
    getValue(frameFloat) {
        const misb = this.in.misb;
        const manualOffset = misb.timeOffset ?? 0;
        const startTimeOffset = misb.getTrackStartTimeOffsetSeconds?.() ?? 0;
        const off = (manualOffset + startTimeOffset) * Sit.fps;
        return this.getValueFrame(frameFloat + off);
    }

    // The inherited CNodeArray.exportArray reads this.array[f] (undefined here),
    // so sample the curve per frame instead. Emits the same CSV as the base.
    // exportTrackKML / exportMISBCompliantCSV already loop this.v(f) and work as-is.
    exportArray(inspect = false) {
        let csv = "Frame,Time,Lat,Lon,Alt(m)\n";
        for (let f = 0; f < this.frames; f++) {
            const posECEF = this.getValue(f).position;
            const lla = ECEFToLLAVD_radii(posECEF);
            const alt = roundIfClose(lla.z, 1e-6);
            const time = GlobalDateTimeNode.frameToMS(f);
            csv += f + "," + time + "," + lla.x + "," + lla.y + "," + alt + "\n";
        }

        if (inspect) {
            return {
                desc: "Per-frame array with frame and time (ms)",
                csv: csv,
            };
        } else {
            saveAs(new Blob([csv]), "sitrecArray-" + this.id + ".csv");
        }
    }
}
