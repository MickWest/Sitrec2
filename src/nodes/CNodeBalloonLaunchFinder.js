// CNodeBalloonLaunchFinder.js
//
// The Reverse Balloon Launch Finder (Traverse menu): the reverse of Add Balloon.
// An object is taken to be a balloon that rises at its buoyancy while the wind
// moves it. The finder follows that flight back in time, down to the ground,
// and draws where the balloon can have been launched.
//
// The start is the line of sight of Traverse > LOS Source at the current frame,
// with a range of balloon sizes for the distance. Or it is the position of the
// target or of a track at the current frame. The buoyancy and the wind direction
// each have a range, so the result is an area on the ground.
//
// The math is in the pure BalloonLaunchFinder.js. The parts that this finder has
// in common with the Kite Anchor Finder are in CNodeGroundFinder.

import {
    BAND_COLOR, CENTER_COLOR, CNodeGroundFinder, lowHigh, metres, OUTLINE_COLOR, RADIANS, SIGHT_COLOR, trimmed, windText,
} from "./CNodeGroundFinder";
import {CNodeConstant} from "./CNode";
import {CNodeTrackSwitch} from "./CNodeTrackSwitch";
import {NodeMan, TrackManager} from "../Globals";
import {EventManager} from "../CEventManager";
import {elevationAtLL} from "../threeExt";
import {raycastGroundElevationFast} from "../raycastGround";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {midpointRangeFromAngularSize} from "../AngularSizeMath";
import {balloonLaunchSitesOfObject, balloonLaunchSitesOnSight} from "../BalloonLaunchFinder";
import {t} from "../i18n";

// The settings that are saved with the sitch, and the values of a new finder.
const DEFAULTS = {
    enabled: false,
    objectPixels: 10,       // pixels of the video frame
    sizeMin: 0.3,           // m
    sizeMax: 2,             // m
    buoyancyMin: 1,         // m/s
    buoyancyMax: 5,         // m/s
    windError: 10,          // degrees to each side
    // The steps of each flight, from the balloon down to the ground. Measured in a sitch with
    // weather profiles, against 4096 steps: the farthest launch site is off by 0.2% to 0.6% of
    // its distance at 32 steps, and by 0.2% at most at 128. The cost goes with the steps.
    heightSteps: 128,
};

// The longest flight. A balloon that needs more time than this to get to its height is not
// in the result (see flightsOf in BalloonLaunchFinder.js). It is not a setting.
const MAX_FLIGHT_HOURS = 10;

// The two fixed choices of Start From. They are saved with the sitch as the choice
// of the selector, so they do not change with the language. Every other choice is
// the short name of a track.
const FROM_SIGHT = "lineOfSight";
const FROM_TARGET = "target";

const duration = seconds => seconds < 90 ? `${Math.round(seconds)} s`
    : seconds < 5940 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;

export class CNodeBalloonLaunchFinder extends CNodeGroundFinder {
    constructor(v) {
        super(v, DEFAULTS);
        if (!this.makeFolder("Reverse Balloon Launch Finder", "balloonLaunchFinder")) return;

        // Start From: the line of sight, the target, or a track. A switch hides the menus of
        // the inputs that are not selected, so the two fixed choices are plain placeholders,
        // and not the LOS source and the target track themselves. TrackManager adds the tracks.
        const placeholder = name => {
            const node = new CNodeConstant({id: `${this.id}_${name}`, value: 0});
            node.skipModSerialize = true;
            return node;
        };
        this.source = new CNodeTrackSwitch({
            id: `${this.id}_source`,
            inputs: {[FROM_SIGHT]: placeholder(FROM_SIGHT), [FROM_TARGET]: placeholder(FROM_TARGET)},
            labels: {
                [FROM_SIGHT]: t("balloonLaunchFinder.source.lineOfSight"),
                [FROM_TARGET]: t("balloonLaunchFinder.source.target"),
            },
            default: FROM_SIGHT,
            desc: t("balloonLaunchFinder.source.label"),
            gui: this.gui,
            tooltip: t("balloonLaunchFinder.source.tooltip"),
        });
        // A track that the user loads must not take the finder: the user selects it.
        this.source.noAutoSelect = true;
        TrackManager.addTracksToSwitch(this.source);

        // The size of the object gives the distance on a line of sight. A track has a position.
        this.sightRows = [
            this.addSlider("objectPixels", 0.5, 500, 0.5),
            this.addSlider("sizeMin", 0.05, 30, 0.05),
            this.addSlider("sizeMax", 0.05, 30, 0.05),
        ];
        this.addSlider("buoyancyMin", 0.1, 10, 0.1);
        this.addSlider("buoyancyMax", 0.1, 10, 0.1);
        this.addSlider("windError", 0, 90, 1);
        this.addSlider("heightSteps", 8, 1024, 8);
        this.addReadouts(["angularText", "windText", "distanceText", "heightText", "timeText"]);

        const showSightRows = () => {
            const onSight = this.source.choice === FROM_SIGHT;
            for (const row of this.sightRows) onSight ? row.show() : row.hide();
        };
        this._onSource = () => {
            showSightRows();
            this.changed();
        };
        this._sourceEvent = "Switch.choiceChanged." + this.source.id;
        EventManager.addEventListener(this._sourceEvent, this._onSource);
        showSightRows();
    }

    dispose() {
        if (this._sourceEvent) EventManager.removeEventListener(this._sourceEvent, this._onSource);
        super.dispose();
    }

    // The start of the flights at a frame: the line of sight and the size of the object, or
    // the position of the target or of a track.
    finderInputs(f) {
        const choice = this.source.choice;
        if (choice === FROM_SIGHT) {
            const sight = this.sightAt(f);
            if (sight.problem) return {problem: sight.problem, key: sight.problem};
            const {origin, direction, angularSize} = sight;
            const [sizeMin, sizeMax] = lowHigh(this.sizeMin, this.sizeMax);
            // the wind at the middle of the balloon positions
            const middle = ECEFToLLAVD_radii(origin.clone().addScaledVector(direction,
                midpointRangeFromAngularSize(angularSize, (sizeMin + sizeMax) / 2)));
            const key = this.stateKey([
                choice, origin.x.toFixed(2), origin.y.toFixed(2), origin.z.toFixed(2),
                direction.x.toFixed(8), direction.y.toFixed(8), direction.z.toFixed(8),
                angularSize.toPrecision(8),
            ], this.windAt(f)(middle.x, middle.y, middle.z));
            return {origin, direction, angularSize, sizeMin, sizeMax, key};
        }

        // A track gives {position}, and the fixed target gives the point itself.
        const track = choice === FROM_TARGET ? NodeMan.get("targetTrackSwitch", false) : this.source;
        const value = track?.getValue(f);
        const position = value?.position ?? value;
        if (!Number.isFinite(position?.x)) return {problem: "No position", key: `no position|${choice}`};
        const lla = ECEFToLLAVD_radii(position);
        const key = this.stateKey([choice, position.x.toFixed(1), position.y.toFixed(1), position.z.toFixed(1)],
            this.windAt(f)(lla.x, lla.y, lla.z));
        return {position, key};
    }

    showProblem(problem) {
        this.angularText = this.windText = this.distanceText = this.heightText = "—";
        this.timeText = problem;
    }

    // Calculate the launch sites, and show them and their numbers.
    showResult(inputs, f) {
        const [buoyancyMin, buoyancyMax] = lowHigh(this.buoyancyMin, this.buoyancyMax);
        const options = {
            buoyancyMin, buoyancyMax,
            windError: this.windError * RADIANS,
            maxSeconds: MAX_FLIGHT_HOURS * 3600,
            heightSteps: this.heightSteps,
            windAt: this.windAt(f),
            groundHAE: (lat, lon) => elevationAtLL(lat, lon),
            // The terrain ray of Sitrec: its steps are set by the slope of the elevation
            // data, so a flight cannot go over a narrow ridge and meet the ground beyond it.
            groundHit: raycastGroundElevationFast,
        };
        const sites = inputs.position
            ? balloonLaunchSitesOfObject({position: inputs.position, ...options})
            : balloonLaunchSitesOnSight({origin: inputs.origin, direction: inputs.direction, angularSize: inputs.angularSize,
                sizeMin: inputs.sizeMin, sizeMax: inputs.sizeMax, ...options});
        this._drawSites(sites);
        this._showNumbers(sites, inputs.angularSize);
    }

    // The read-only rows of the menu.
    _showNumbers({samples, outlines}, angularSize) {
        // every balloon position, and every flight that has a launch site
        const balloons = samples.length ? samples : outlines;
        const middle = balloons[balloons.length >> 1];
        const flights = [...samples.flatMap(sample => [sample.center, ...sample.corners]), ...outlines.flatMap(outline => outline.spine)];
        const found = flights.filter(Boolean);
        // the longest flight cut the slow end of the buoyancy range, for a part of the balloons or for all
        const limited = [...samples, ...outlines].some(balloon => balloon.limited);
        const limit = `${MAX_FLIGHT_HOURS} h`;

        this.angularText = angularSize === undefined ? "—"
            : `${(angularSize / RADIANS).toFixed(3)}° (${(angularSize * 1000).toFixed(2)} mrad)`;
        this.windText = windText(middle.windToward, middle.windSpeed);
        this.distanceText = samples.length ? `${metres(samples[0].range)} to ${metres(samples[samples.length - 1].range)}` : "—";

        const heights = balloons.filter(balloon => balloon.height > 0).map(balloon => balloon.height);
        this.heightText = heights.length === 0 ? "Below the ground"
            : heights.length === 1 ? metres(heights[0])
            : `${metres(Math.min(...heights))} to ${metres(Math.max(...heights))}`
                + (heights.length < balloons.length ? ", part below the ground" : "");

        if (found.length === 0) {
            this.timeText = heights.length === 0 ? "The balloon is below the ground"
                : limited ? `Longer than ${limit}` : "No launch site";
        } else {
            const seconds = found.map(flight => flight.seconds);
            this.timeText = `${duration(Math.min(...seconds))} to ${duration(Math.max(...seconds))}`
                + (limited ? `, part longer than ${limit}` : "");
        }
    }

    _drawSites({samples, outlines}) {
        const thin = [], center = [], labels = [];
        const polyline = (set, points, color) => {
            for (let index = 1; index < points.length; index++) {
                if (points[index - 1] && points[index]) set.push([points[index - 1], points[index], color]);
            }
        };
        const place = site => site?.position ?? null;

        if (samples.length) {
            // the part of the line of sight where the balloon can be
            thin.push([samples[0].balloon, samples[samples.length - 1].balloon, SIGHT_COLOR]);
            polyline(center, samples.map(sample => place(sample.center)), CENTER_COLOR);
            for (let which = 0; which < 4; which++) polyline(thin, samples.map(sample => place(sample.corners[which])), BAND_COLOR);
        }
        for (const outline of outlines) {
            if (outline.loop) polyline(thin, [...outline.loop, outline.loop[0]], OUTLINE_COLOR);
            // The launch sites for the wind as given, from the highest buoyancy to the lowest.
            // With no line of sight, this line is the middle of the area.
            polyline(samples.length ? thin : center, outline.spine.map(place), samples.length ? OUTLINE_COLOR : CENTER_COLOR);
            // the flight for the middle buoyancy, from the launch site up to the balloon
            if (outline.center) polyline(thin, outline.center.path, SIGHT_COLOR);

            // A label at each end of that line: the buoyancy and the flight time.
            const size = outline.size === undefined ? "" : `${trimmed(outline.size)} m balloon\n`;
            const ends = [0, outline.spine.length - 1].filter(index => outline.spine[index]);
            ends.forEach((index, order) => labels.push({
                position: outline.spine[index].position,
                text: `${order === 0 ? size : ""}${trimmed(outline.buoyancies[index])} m/s: ${duration(outline.spine[index].seconds)}`,
            }));
        }
        this.draw({thin, center, labels});
    }
}
