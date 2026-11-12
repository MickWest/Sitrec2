// CNodeGroundFinder.js
//
// The common part of the finders of the Traverse menu that go from an object in
// the video back to a place on the ground: the Kite Anchor Finder
// (CNodeKiteAnchorFinder) and the Reverse Balloon Launch Finder
// (CNodeBalloonLaunchFinder).
//
// A finder is one node that is always there, made in the custom sitch setup. It
// does no work until its title checkbox is on. Then, on each frame, it reads
// what its result depends on. When that changed, it calculates the result and
// draws it in the main view as line segments and labels.
//
// A subclass gives:
//   finderInputs(f)        what the result depends on at a frame, with a `key` that
//                          changes when the result must be calculated again. With a
//                          `problem` text when the finder cannot work
//   showResult(inputs, f)  calculate, call draw(), and set the read-only texts
//   showProblem(problem)   set the read-only texts for a finder that cannot work

import {BufferGeometry, Float32BufferAttribute, Vector3} from "three";
import {CNode3DGroup} from "./CNode3DGroup";
import {guiMenus, markSitchDirty, NodeMan, setRenderOne} from "../Globals";
import {par} from "../par";
import * as LAYER from "../LayerMasks";
import {SceneLineSegments} from "../SceneLines";
import {SceneLineMaterial} from "../SceneLineMaterial";
import {setAlwaysVisibleOverlay} from "../AlwaysVisibleOverlay";
import {registerLabel3D, unregisterLabel3D} from "./CNodeDisplaySkyOverlay";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {sampleSceneWind, sceneWindFingerprint} from "../SceneWind";
import {focalLengthPixels} from "../AngularSizeMath";
import {pixelsToAngle} from "../KiteAnchorFinder";
import {t} from "../i18n";

export const SIGHT_COLOR = [1, 1, 1];              // the part of the line of sight, and the lines through the air
export const BAND_COLOR = [1, 0.6, 0.1];           // the sides of the band
export const OUTLINE_COLOR = [1, 0.85, 0.2];       // the outline for one size
export const CENTER_COLOR = [1, 0.95, 0.3];        // the middle of the band
const LABEL_COLOR = "#FFE680";

export const RADIANS = Math.PI / 180;
const KNOT = 0.514444;      // m/s

export const metres = value => value < 1000 ? `${Math.round(value)} m` : `${(value / 1000).toFixed(2)} km`;
export const trimmed = value => String(+value.toFixed(2));
export const lowHigh = (first, second) => [Math.min(first, second), Math.max(first, second)];
// A wind as text: the direction that it comes from, and its speed.
export const windText = (windToward, windSpeed) => windToward === null ? "Calm"
    : `From ${Math.round((windToward / RADIANS + 180 + 360) % 360)}° at ${(windSpeed / KNOT).toFixed(1)} kt`;

export class CNodeGroundFinder extends CNode3DGroup {
    // `defaults` holds the settings that are saved with the sitch, and their values in a
    // new finder. It has `enabled: false` and `objectPixels`.
    constructor(v, defaults) {
        v.layers ??= LAYER.MASK_HELPERS;
        super(v);
        this.defaults = defaults;
        Object.assign(this, defaults);

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
        // when the last result was shown, and how long it took to calculate (milliseconds)
        this._shownAt = 0;
        this._cost = 0;
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
        const inputs = this.finderInputs(f);
        if (inputs.key === this._key) return;
        // While the sitch plays, the line of sight can change on each frame. A result that
        // is slow to calculate then takes at most one fifth of the time: the frames between
        // keep the last result. The frame that the sitch stops on is always calculated.
        const started = performance.now();
        if (!par.paused && started - this._shownAt < 4 * this._cost) return;
        this._key = inputs.key;
        if (inputs.problem) {
            this.draw({});
            this.showProblem(inputs.problem);
        } else {
            this.showResult(inputs, f);
        }
        this._shownAt = performance.now();
        this._cost = this._shownAt - started;
    }

    // The line of sight of Traverse > LOS Source at a frame, and the angle that the Object
    // Size makes at the camera: {origin, direction, angularSize}. Or {problem} when there
    // is no line of sight, or no video to give the pixels a size.
    sightAt(f) {
        // The playhead can be between two frames, and a line of sight is made for a whole
        // frame: the tracked lines of sight have one point for each frame, and no more.
        const frame = Math.floor(f);
        const los = NodeMan.get("JetLOS", false)?.getValueFrame(frame);
        // The axes and the field of view of the camera are on the line of sight through the
        // middle of the picture. When the LOS Source is that line, it has them already, and
        // the camera is not worked out a second time (which costs about 0.2 ms).
        const camera = los?.up && los.right ? los : NodeMan.get("JetLOSCameraCenter", false)?.getValueFrame(frame);
        if (!los?.position || !los.heading || !camera?.up || !camera.right) return {problem: "No line of sight"};

        // The Object Size is in pixels of the video frame as shown, and the
        // camera's vertical field of view is the height of that frame.
        const video = NodeMan.get("video", false);
        const turned = [90, 270].includes(video?.videoData?.effectiveRotation ?? 0);
        const frameHeight = turned ? video?.originalVideoWidth : video?.originalVideoHeight;
        if (!(frameHeight > 0) || !(camera.vFOV > 0)) return {problem: "Needs a video"};

        const origin = los.position, direction = los.heading;
        // where the line of sight is in the picture, in pixels from the middle
        const focal = focalLengthPixels(camera.vFOV, frameHeight);
        const forward = direction.dot(camera.heading);
        const angularSize = pixelsToAngle(this.objectPixels, focal,
            focal * direction.dot(camera.right) / forward, -focal * direction.dot(camera.up) / forward);
        return {origin, direction, angularSize};
    }

    // The wind of the scene at a frame: (lat, lon, height above the ellipsoid) → {u, v} in m/s.
    windAt(f) {
        return (lat, lon, hae) => sampleSceneWind(lat, lon, hae - meanSeaLevelOffset(lat, lon), f);
    }

    // A key for finderInputs: the given values, the settings, and the state of the wind and
    // the terrain. `wind` is the wind at a point of the result: the wind can change with the
    // frame, and sceneWindFingerprint does not show that.
    stateKey(values, wind) {
        return [
            ...values, wind.u.toFixed(2), wind.v.toFixed(2),
            ...Object.keys(this.defaults).map(name => this[name]),
            sceneWindFingerprint(),
            // the ground changes as its elevation tiles arrive
            NodeMan.get("TerrainModel", false)?.elevationMap?._tileEpoch ?? 0,
        ].join("|");
    }

    // Draw line segments and labels. `thin` and `center` are lists of [from, to, color]
    // (ECEF points; the center lines are wider), and `labels` is a list of {position, text}.
    draw({thin = [], center = [], labels = []}) {
        // The points are drawn relative to one of them, so they stay in float32 range:
        // ECEF coordinates are about 6,378 km from the origin.
        const base = thin[0]?.[0] ?? center[0]?.[0] ?? new Vector3();
        this._setSegments(this.thinLines, base, thin);
        this._setSegments(this.centerLines, base, center);
        this._setLabels(labels);
    }

    _setSegments(lines, base, segments) {
        const positions = new Float32Array(segments.length * 6), tints = new Float32Array(segments.length * 6);
        segments.forEach(([from, to, color], index) => {
            positions.set([from.x - base.x, from.y - base.y, from.z - base.z, to.x - base.x, to.y - base.y, to.z - base.z], index * 6);
            tints.set([...color, ...color], index * 6);
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

    // The folder in the Traverse menu, with the title checkbox. `textKey` is the group of
    // the labels and tooltips in the language files. False when there is no Traverse menu.
    makeFolder(title, textKey) {
        if (!guiMenus.traverse) return false;
        this.textKey = textKey;
        this.gui = guiMenus.traverse.addFolder(title).close();
        this.gui.tooltip(t(`${textKey}.folderTooltip`));
        this.gui.add(this, "enabled").name(t(`${textKey}.enabled.label`)).listen()
            .onChange(() => this.changed()).tooltip(t(`${textKey}.enabled.tooltip`)).asFolderToggle();
        return true;
    }

    addSlider(name, low, high, step) {
        return this.gui.add(this, name, low, high, step).name(t(`${this.textKey}.${name}.label`)).listen()
            .onChange(() => this.changed()).tooltip(t(`${this.textKey}.${name}.tooltip`));
    }

    // Read-only text rows. Each name is a field of this node, which starts as a dash.
    addReadouts(names) {
        for (const name of names) {
            this[name] = "—";
            this.gui.add(this, name).name(t(`${this.textKey}.${name}.label`)).listen().disable()
                .tooltip(t(`${this.textKey}.${name}.tooltip`));
        }
    }

    // A finder that is on saves all its settings, so that a later change of a default
    // does not move its result. A finder that is off saves only what the user changed,
    // so that a sitch which never uses it carries nothing for it.
    modSerialize() {
        const settings = {};
        for (const name of Object.keys(this.defaults)) {
            if (this.enabled || this[name] !== this.defaults[name]) settings[name] = this[name];
        }
        return {...super.modSerialize(), ...settings};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        for (const name of Object.keys(this.defaults)) if (v[name] !== undefined) this[name] = v[name];
        this.changed();
    }
}
