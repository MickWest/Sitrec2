// CNodeKiteAnchorFinder.js
//
// The Kite Anchor Finder (Traverse menu): the reverse of Add Kite. The object
// in the video is taken to be a kite on the line of sight, and the finder
// draws where on the ground its line can be held.
//
// The line of sight is that of Traverse > LOS Source at the current frame. The
// size of the object in the video and a range of real kite sizes give a part
// of that line. For each kite position on it, the anchor is upwind, where a
// line that goes down at the flight angle meets the ground. The flight angle
// and the wind direction each have a range, so the result is a band.
//
// The math is in the pure KiteAnchorFinder.js. The parts that this finder has
// in common with the Reverse Balloon Launch Finder are in CNodeGroundFinder.

import {
    BAND_COLOR, CENTER_COLOR, CNodeGroundFinder, lowHigh, metres, OUTLINE_COLOR, RADIANS, SIGHT_COLOR, trimmed, windText,
} from "./CNodeGroundFinder";
import {elevationAtLL} from "../threeExt";
import {raycastGroundElevationFast} from "../raycastGround";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {midpointRangeFromAngularSize} from "../AngularSizeMath";
import {kiteAnchorBand} from "../KiteAnchorFinder";

// The settings that are saved with the sitch, and the values of a new finder.
const DEFAULTS = {
    enabled: false,
    objectPixels: 10,       // pixels of the video frame
    sizeMin: 1,             // m
    sizeMax: 5,             // m
    flightAngleMin: 30,     // degrees
    flightAngleMax: 60,     // degrees
    windError: 20,          // degrees to each side
    maxLineLength: 300,     // m
};

export class CNodeKiteAnchorFinder extends CNodeGroundFinder {
    constructor(v) {
        super(v, DEFAULTS);
        if (!this.makeFolder("Kite Anchor Finder", "kiteAnchorFinder")) return;
        this.addSlider("objectPixels", 0.5, 500, 0.5);
        this.addSlider("sizeMin", 0.1, 30, 0.1);
        this.addSlider("sizeMax", 0.1, 30, 0.1);
        this.addSlider("flightAngleMin", 5, 85, 1);
        this.addSlider("flightAngleMax", 5, 85, 1);
        this.addSlider("windError", 0, 90, 1);
        this.addSlider("maxLineLength", 10, 2000, 10);
        this.addReadouts(["angularText", "windText", "distanceText", "heightText", "lineText"]);
    }

    // The line of sight and the size of the object at a frame.
    finderInputs(f) {
        const sight = this.sightAt(f);
        if (sight.problem) return {problem: sight.problem, key: sight.problem};
        const {origin, direction, angularSize} = sight;
        const [sizeMin, sizeMax] = lowHigh(this.sizeMin, this.sizeMax);
        // the wind at the middle of the kite positions
        const middle = ECEFToLLAVD_radii(origin.clone().addScaledVector(direction,
            midpointRangeFromAngularSize(angularSize, (sizeMin + sizeMax) / 2)));
        const key = this.stateKey([
            origin.x.toFixed(2), origin.y.toFixed(2), origin.z.toFixed(2),
            direction.x.toFixed(8), direction.y.toFixed(8), direction.z.toFixed(8),
            angularSize.toPrecision(8),
        ], this.windAt(f)(middle.x, middle.y, middle.z));
        return {origin, direction, angularSize, sizeMin, sizeMax, key};
    }

    showProblem(problem) {
        this.angularText = problem;
        this.windText = this.distanceText = this.heightText = this.lineText = "—";
    }

    // Calculate the band, and show it and its numbers.
    showResult(inputs, f) {
        const [flightAngleMin, flightAngleMax] = lowHigh(this.flightAngleMin, this.flightAngleMax);
        const band = kiteAnchorBand({
            origin: inputs.origin,
            direction: inputs.direction,
            angularSize: inputs.angularSize,
            sizeMin: inputs.sizeMin,
            sizeMax: inputs.sizeMax,
            flightAngleMin: flightAngleMin * RADIANS,
            flightAngleMax: flightAngleMax * RADIANS,
            windError: this.windError * RADIANS,
            maxLineLength: this.maxLineLength,
            windAt: this.windAt(f),
            groundHAE: (lat, lon) => elevationAtLL(lat, lon),
            // The terrain ray of Sitrec: its steps are set by the slope of the elevation
            // data, so a line cannot go over a narrow ridge and meet the ground beyond it.
            groundHit: raycastGroundElevationFast,
        });
        this._drawBand(band);
        this._showNumbers(band, inputs.angularSize);
    }

    // The read-only rows of the menu.
    _showNumbers(band, angularSize) {
        const {samples} = band;
        const first = samples[0], last = samples[samples.length - 1], middle = samples[samples.length >> 1];

        this.angularText = `${(angularSize / RADIANS).toFixed(3)}° (${(angularSize * 1000).toFixed(2)} mrad)`;
        this.windText = windText(middle.windToward, middle.windSpeed);
        this.distanceText = `${metres(first.range)} to ${metres(last.range)}`;

        // Over hills, the height above the ground does not go up steadily with the distance,
        // and the kite positions that are in the ground can be at either end.
        const aboveGround = samples.filter(sample => sample.height > 0);
        const heights = aboveGround.map(sample => sample.height);
        this.heightText = aboveGround.length === 0 ? "Below the ground"
            : `${metres(Math.min(...heights))} to ${metres(Math.max(...heights))}`
                + (aboveGround.length < samples.length ? ", part below the ground" : "");

        const found = samples.filter(sample => sample.center);
        if (found.length === 0) {
            this.lineText = middle.windToward === null ? "No wind to fly a kite"
                : aboveGround.length === 0 ? "The kite is below the ground"
                : "Longer than the limit";
        } else {
            const lengths = found.map(sample => sample.center.lineLength);
            this.lineText = `${metres(Math.min(...lengths))} to ${metres(Math.max(...lengths))}`
                // not every size has an anchor: give the sizes that have one
                + (found.length < samples.length
                    ? `, for ${trimmed(found[0].size)} m to ${trimmed(found[found.length - 1].size)} m` : "");
        }
    }

    _drawBand({samples, outlines}) {
        const thin = [], center = [], labels = [];
        // the part of the line of sight where the kite can be
        thin.push([samples[0].kite, samples[samples.length - 1].kite, SIGHT_COLOR]);
        for (let index = 1; index < samples.length; index++) {
            const before = samples[index - 1], after = samples[index];
            if (before.center && after.center) center.push([before.center.position, after.center.position, CENTER_COLOR]);
            before.corners.forEach((corner, which) => {
                if (corner && after.corners[which]) thin.push([corner.position, after.corners[which].position, BAND_COLOR]);
            });
        }
        for (const outline of outlines) {
            outline.loop?.forEach((point, index) =>
                thin.push([point, outline.loop[(index + 1) % outline.loop.length], OUTLINE_COLOR]));
            if (!outline.center) continue;
            // the flying line of this kite, as a straight line
            thin.push([outline.kite, outline.center.position, SIGHT_COLOR]);
            labels.push({
                position: outline.center.position,
                text: `${trimmed(outline.size)} m kite\n${Math.round(outline.center.lineLength)} m line`,
            });
        }
        this.draw({thin, center, labels});
    }
}
