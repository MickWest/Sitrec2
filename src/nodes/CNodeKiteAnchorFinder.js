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
// The math is in the pure KiteAnchorFinder.js. This node reads the line of
// sight, the wind and the ground, and draws the result in the main view.

import {BufferGeometry, Float32BufferAttribute, Vector3} from "three";
import {CNode3DGroup} from "./CNode3DGroup";
import {guiMenus, markSitchDirty, NodeMan, setRenderOne} from "../Globals";
import * as LAYER from "../LayerMasks";
import {SceneLineSegments} from "../SceneLines";
import {SceneLineMaterial} from "../SceneLineMaterial";
import {setAlwaysVisibleOverlay} from "../AlwaysVisibleOverlay";
import {registerLabel3D, unregisterLabel3D} from "./CNodeDisplaySkyOverlay";
import {elevationAtLL} from "../threeExt";
import {raycastGroundElevationFast} from "../raycastGround";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {sampleSceneWind, sceneWindFingerprint} from "../SceneWind";
import {focalLengthPixels, midpointRangeFromAngularSize} from "../AngularSizeMath";
import {kiteAnchorBand, pixelsToAngle} from "../KiteAnchorFinder";
import {t} from "../i18n";

const RADIANS = Math.PI / 180;
const KNOT = 0.514444;      // m/s

const SIGHT_COLOR = [1, 1, 1];              // the part of the line of sight, and the flying lines
const BAND_COLOR = [1, 0.6, 0.1];           // the sides of the band
const OUTLINE_COLOR = [1, 0.85, 0.2];       // the outline for one kite size
const CENTER_COLOR = [1, 0.95, 0.3];        // the middle of the band
const LABEL_COLOR = "#FFE680";

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
const SETTINGS = Object.keys(DEFAULTS);

const metres = value => value < 1000 ? `${Math.round(value)} m` : `${(value / 1000).toFixed(2)} km`;
const trimmed = value => String(+value.toFixed(2));
const lowHigh = (first, second) => [Math.min(first, second), Math.max(first, second)];

export class CNodeKiteAnchorFinder extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_HELPERS;
        super(v);

        Object.assign(this, DEFAULTS);

        this.angularText = "—";
        this.windText = "—";
        this.distanceText = "—";
        this.heightText = "—";
        this.lineText = "—";

        // Two sets of line segments: the middle of the band is wider than the rest.
        const makeLines = linewidth => {
            const lines = new SceneLineSegments(new BufferGeometry(),
                new SceneLineMaterial({vertexColors: true, linewidth, toneMapped: false}));
            // The ground under the band can be 3D tiles, which are not at the height of the
            // elevation map. So the lines are drawn over the ground and the buildings.
            setAlwaysVisibleOverlay(lines);
            this.group.add(lines);
            return lines;
        };
        this.thinLines = makeLines(1.5);
        this.centerLines = makeLines(3);
        this.propagateLayerMask();
        this.labels = [];

        this.group.visible = false;
        this._key = null;
        this._setupGUI();
    }

    dispose() {
        this._setLabels([]);
        for (const lines of [this.thinLines, this.centerLines]) {
            this.group.remove(lines);
            lines.geometry.dispose();
            lines.sourceGeometry.dispose();
            lines.material.dispose();
        }
        this.gui?.destroy();
        super.dispose();
    }

    // A setting changed: show or hide the result, and calculate it again on the next frame.
    changed() {
        this.group.visible = this.enabled;
        this._key = null;
        // the settings are saved with the sitch (this does nothing while a sitch loads)
        markSitchDirty();
        setRenderOne(true);
    }

    update(f) {
        super.update(f);
        if (!this.enabled) return;
        const inputs = this._inputs(f);
        const key = inputs?.key ?? "none";
        if (key === this._key) return;
        this._key = key;
        this._show(inputs, f);
    }

    // The line of sight and the size of the object at a frame, and a key that
    // changes when the result must be calculated again. `problem` is set, and
    // there is no line of sight, when the finder cannot work.
    _inputs(f) {
        const los = NodeMan.get("JetLOS", false)?.getValueFrame(f);
        // The axes and the field of view of the camera are on the line of sight through the
        // middle of the picture. When the LOS Source is that line, it has them already, and
        // the camera is not worked out a second time (which costs about 0.2 ms).
        const camera = los?.up && los.right ? los : NodeMan.get("JetLOSCameraCenter", false)?.getValueFrame(f);
        if (!los?.position || !los.heading || !camera?.up || !camera.right) return {problem: "No line of sight", key: "no line of sight"};

        // The Object Size is in pixels of the video frame as shown, and the
        // camera's vertical field of view is the height of that frame.
        const video = NodeMan.get("video", false);
        const turned = [90, 270].includes(video?.videoData?.effectiveRotation ?? 0);
        const frameHeight = turned ? video?.originalVideoWidth : video?.originalVideoHeight;
        if (!(frameHeight > 0) || !(camera.vFOV > 0)) return {problem: "Needs a video", key: "no video"};

        const origin = los.position, direction = los.heading;
        // where the line of sight is in the picture, in pixels from the middle
        const focal = focalLengthPixels(camera.vFOV, frameHeight);
        const forward = direction.dot(camera.heading);
        const angularSize = pixelsToAngle(this.objectPixels, focal,
            focal * direction.dot(camera.right) / forward, -focal * direction.dot(camera.up) / forward);

        // The wind can change with the frame, and sceneWindFingerprint does not show that.
        // So the key has the wind at the middle of the kite positions.
        const [sizeMin, sizeMax] = lowHigh(this.sizeMin, this.sizeMax);
        const middle = ECEFToLLAVD_radii(origin.clone().addScaledVector(direction,
            midpointRangeFromAngularSize(angularSize, (sizeMin + sizeMax) / 2)));
        const wind = this._windAt(f)(middle.x, middle.y, middle.z);

        const key = [
            origin.x.toFixed(2), origin.y.toFixed(2), origin.z.toFixed(2),
            direction.x.toFixed(8), direction.y.toFixed(8), direction.z.toFixed(8),
            angularSize.toPrecision(8), wind.u.toFixed(2), wind.v.toFixed(2),
            ...SETTINGS.map(name => this[name]),
            sceneWindFingerprint(),
            // the ground changes as its elevation tiles arrive
            NodeMan.get("TerrainModel", false)?.elevationMap?._tileEpoch ?? 0,
        ].join("|");
        return {origin, direction, angularSize, sizeMin, sizeMax, key};
    }

    // The wind of the scene at a frame, at a height above the ellipsoid.
    _windAt(f) {
        return (lat, lon, hae) => sampleSceneWind(lat, lon, hae - meanSeaLevelOffset(lat, lon), f);
    }

    // Calculate the band, and show it and its numbers.
    _show(inputs, f) {
        if (inputs.problem) {
            this._drawBand(null);
            this.angularText = inputs.problem;
            this.windText = this.distanceText = this.heightText = this.lineText = "—";
            return;
        }
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
            windAt: this._windAt(f),
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
        this.windText = middle.windToward === null ? "Calm"
            : `From ${Math.round((middle.windToward / RADIANS + 180 + 360) % 360)}° at ${(middle.windSpeed / KNOT).toFixed(1)} kt`;
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

    // Draw the band, or nothing for a null band.
    _drawBand(band) {
        const thin = {points: [], colors: []}, center = {points: [], colors: []};
        const segment = (set, from, to, color) => {
            set.points.push(from, to);
            set.colors.push(color, color);
        };
        const labels = [];

        if (band) {
            const {samples, outlines} = band;
            // the part of the line of sight where the kite can be
            segment(thin, samples[0].kite, samples[samples.length - 1].kite, SIGHT_COLOR);
            for (let index = 1; index < samples.length; index++) {
                const before = samples[index - 1], after = samples[index];
                if (before.center && after.center) segment(center, before.center.position, after.center.position, CENTER_COLOR);
                before.corners.forEach((corner, which) => {
                    if (corner && after.corners[which]) segment(thin, corner.position, after.corners[which].position, BAND_COLOR);
                });
            }
            for (const outline of outlines) {
                outline.loop?.forEach((point, index) =>
                    segment(thin, point, outline.loop[(index + 1) % outline.loop.length], OUTLINE_COLOR));
                if (!outline.center) continue;
                // the flying line of this kite, as a straight line
                segment(thin, outline.kite, outline.center.position, SIGHT_COLOR);
                labels.push({
                    position: outline.center.position,
                    text: `${trimmed(outline.size)} m kite\n${Math.round(outline.center.lineLength)} m line`,
                });
            }
        }

        // The points are drawn relative to one of them, so they stay in float32 range:
        // ECEF coordinates are about 6,378 km from the origin.
        const base = thin.points[0] ?? new Vector3();
        this._setSegments(this.thinLines, base, thin);
        this._setSegments(this.centerLines, base, center);
        this._setLabels(labels);
    }

    _setSegments(lines, base, {points, colors}) {
        const positions = new Float32Array(points.length * 3), tints = new Float32Array(points.length * 3);
        points.forEach((point, index) => {
            positions.set([point.x - base.x, point.y - base.y, point.z - base.z], index * 3);
            tints.set(colors[index], index * 3);
        });
        lines.sourceGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
        lines.sourceGeometry.setAttribute("color", new Float32BufferAttribute(tints, 3));
        lines.position.copy(base);
        lines.syncGeometry();
    }

    // The text labels, one for each entry {position, text}. They are drawn by the
    // label overlay of each view (CNodeDisplaySkyOverlay.renderLabels3D), which
    // reads these fields. The labels show only while the group of this node shows.
    _setLabels(entries) {
        while (this.labels.length > entries.length) unregisterLabel3D(this.labels.pop());
        entries.forEach((entry, index) => {
            if (!this.labels[index]) {
                this.labels[index] = {
                    group: this.group, groupNode: this, layerMask: this.group.layers.mask,
                    shouldRender: () => true,
                    textPosition: new Vector3(), text: "",
                    size: 13, color: LABEL_COLOR, useHUDColor: false,
                    strokeWidth: 3, strokeColor: "#000000",
                    offset: {x: 20, y: 0}, textAlign: "left",
                };
                registerLabel3D(this.labels[index]);
            }
            this.labels[index].textPosition.copy(entry.position);
            this.labels[index].text = entry.text;
        });
    }

    _setupGUI() {
        if (!guiMenus.traverse) return;
        const text = name => t(`kiteAnchorFinder.${name}.label`), tip = name => t(`kiteAnchorFinder.${name}.tooltip`);
        this.gui = guiMenus.traverse.addFolder("Kite Anchor Finder").close();
        this.gui.tooltip(t("kiteAnchorFinder.folderTooltip"));

        this.gui.add(this, "enabled").name(text("enabled")).listen()
            .onChange(() => this.changed()).tooltip(tip("enabled")).asFolderToggle();
        const slider = (name, low, high, step) => this.gui.add(this, name, low, high, step).name(text(name)).listen()
            .onChange(() => this.changed()).tooltip(tip(name));
        slider("objectPixels", 0.5, 500, 0.5);
        slider("sizeMin", 0.1, 30, 0.1);
        slider("sizeMax", 0.1, 30, 0.1);
        slider("flightAngleMin", 5, 85, 1);
        slider("flightAngleMax", 5, 85, 1);
        slider("windError", 0, 90, 1);
        slider("maxLineLength", 10, 2000, 10);
        for (const name of ["angularText", "windText", "distanceText", "heightText", "lineText"]) {
            this.gui.add(this, name).name(text(name)).listen().disable().tooltip(tip(name));
        }
    }

    // A finder that is on saves all its settings, so that a later change of a default
    // does not move its band. A finder that is off saves only what the user changed,
    // so that a sitch which never uses it carries nothing for it.
    modSerialize() {
        const settings = {};
        for (const name of SETTINGS) {
            if (this.enabled || this[name] !== DEFAULTS[name]) settings[name] = this[name];
        }
        return {...super.modSerialize(), ...settings};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        for (const name of SETTINGS) if (v[name] !== undefined) this[name] = v[name];
        this.changed();
    }
}
