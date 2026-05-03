// CNodeDisplaySondeWind.js — Display wind arrows along a sonde track.
// Each arrow shows wind direction and speed at a sounding level.
// Arrow points in the direction the wind is blowing TO (balloon drift direction).
// Arrow length is proportional to wind speed.
// Uses Line2/LineMaterial for thick, visible lines (same as CNodeDisplayTrack).

import {CNode} from "./CNode";
import {getEffectiveMSAASamples, getEffectiveRenderScale} from "../Globals";
import {Group, Vector3, Color} from "three";
import {Line2} from "three/addons/lines/Line2.js";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {LineMaterial} from "three/addons/lines/LineMaterial.js";
import {MISB} from "../MISBFields";
import {getLocalNorthVector, getLocalEastVector} from "../SphericalMath";
import * as LAYER from "../LayerMasks";
import {GlobalScene} from "../LocalFrame";
import {setLayerMaskRecursive} from "../threeExt";

export class CNodeDisplaySondeWind extends CNode {
    constructor(v) {
        super(v);
        this.input("dataTrack"); // CNodeMISBDataTrack with wind data

        this.arrowScale = v.arrowScale ?? 200; // meters per m/s of wind speed
        this.arrowColor = new Color(v.arrowColor ?? 0xffff00); // yellow
        this.lineWidth = v.lineWidth ?? 3; // screen-space line width

        this.group = new Group();
        this.group.visible = v.visible ?? true;
        GlobalScene.add(this.group);
        this.lines = [];
        // Arrows built in recalculate() after track data is ready
    }

    buildArrows() {
        // Remove old lines
        for (var i = 0; i < this.lines.length; i++) {
            this.group.remove(this.lines[i]);
            if (this.lines[i].geometry) this.lines[i].geometry.dispose();
            if (this.lines[i].material) this.lines[i].material.dispose();
        }
        this.lines = [];

        var dataTrack = this.in.dataTrack;
        var misb = dataTrack.misb;
        if (!misb || misb.length === 0) return;

        // Collect all arrow line segments into one geometry for efficiency
        var positions = [];
        var colors = [];

        for (var i = 0; i < misb.length; i++) {
            var windDir = misb[i][MISB.WindDirection];
            var windSpeed = misb[i][MISB.WindSpeed];
            if (windDir == null || windSpeed == null || windSpeed <= 0) continue;

            // Use the actual data track position for each sounding level
            var pos = dataTrack.getPosition(i);
            if (!pos || isNaN(pos.x)) continue;

            // Wind blows FROM windDir; balloon drifts TO (windDir + 180)
            var bearingDeg = (windDir + 180) % 360;
            var bearingRad = bearingDeg * Math.PI / 180;

            var north = getLocalNorthVector(pos);
            var east = getLocalEastVector(pos);

            var dir = new Vector3()
                .addScaledVector(north, Math.cos(bearingRad))
                .addScaledVector(east, Math.sin(bearingRad));
            dir.normalize();

            var arrowLength = windSpeed * this.arrowScale;
            var endpoint = pos.clone().addScaledVector(dir, arrowLength);

            // Line segment from pos to endpoint
            positions.push(pos.x, pos.y, pos.z);
            positions.push(endpoint.x, endpoint.y, endpoint.z);
            colors.push(this.arrowColor.r, this.arrowColor.g, this.arrowColor.b);
            colors.push(this.arrowColor.r, this.arrowColor.g, this.arrowColor.b);
        }

        if (positions.length === 0) return;

        // Center the geometry to avoid float32 precision issues (same pattern as CNodeDisplayTrack)
        var cx = 0, cy = 0, cz = 0;
        var nPts = positions.length / 3;
        for (var i = 0; i < positions.length; i += 3) {
            cx += positions[i];
            cy += positions[i + 1];
            cz += positions[i + 2];
        }
        cx /= nPts; cy /= nPts; cz /= nPts;

        for (var i = 0; i < positions.length; i += 3) {
            positions[i] -= cx;
            positions[i + 1] -= cy;
            positions[i + 2] -= cz;
        }

        var geometry = new LineGeometry();
        geometry.setPositions(positions);
        geometry.setColors(colors);

        var dpr = (window.devicePixelRatio || 1) * getEffectiveRenderScale();
        var material = new LineMaterial({
            vertexColors: true,
            linewidth: this.lineWidth,
            depthWrite: false,
            // See CNodeDisplayTrack note: this is needed so the analytic-AA
            // branch in LineMaterial fills sub-pixel coverage at low render
            // scale. Toggled live from applyPerformanceSettings.
            alphaToCoverage: getEffectiveMSAASamples() > 0,
        });
        material.resolution.set(window.innerWidth * dpr, window.innerHeight * dpr);

        var line = new Line2(geometry, material);
        line.computeLineDistances();

        // Offset the group to match the centering
        this.group.position.set(cx, cy, cz);

        setLayerMaskRecursive(line, LAYER.MASK_HELPERS);
        this.group.add(line);
        this.lines.push(line);
    }

    recalculate() {
        this.buildArrows();
    }

    dispose() {
        for (var i = 0; i < this.lines.length; i++) {
            this.group.remove(this.lines[i]);
            if (this.lines[i].geometry) this.lines[i].geometry.dispose();
            if (this.lines[i].material) this.lines[i].material.dispose();
        }
        GlobalScene.remove(this.group);
        super.dispose();
    }
}
