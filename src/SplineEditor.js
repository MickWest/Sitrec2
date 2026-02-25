// e.g. in SitAguadilla.js:

import {PointEditor} from "./PointEditor";
import {BufferAttribute, BufferGeometry, CatmullRomCurve3, Line, LineBasicMaterial, Vector3} from "three";
import * as LAYER from "./LayerMasks";

export class   SplineEditor extends PointEditor{

    constructor(_scene, _camera, _renderer, controls, onChange, initialPoints, isLLA, curveType, legacyEUS) {

        super(_scene, _camera, _renderer, controls, onChange, initialPoints, isLLA, legacyEUS)


        // segments per arc (between control points) for rendering
        this.ARC_SEGMENTS = 200;
        // CatmullRomCurve3 needs 4+ points; linear mode works with 2
        this.minimumPoints = (curveType === 'linear') ? 2 : 4;

        // Note: positions are already loaded by the parent PointEditor constructor
        // (which handles LLA→EUS conversion when isLLA=true).
        // Do NOT re-load here — that would overwrite correct EUS coords with raw LLA values.

        // Local origin for precision: use the first point as the origin
        // This prevents floating-point precision issues when coordinates are far from world origin
        this.splineLocalOrigin = new Vector3();
        if (this.positions.length > 0) {
            this.splineLocalOrigin.copy(this.positions[0]);
        }

        // Create local positions relative to splineLocalOrigin for use with CatmullRomCurve3
        this.localPositions = this.positions.map(p => p.clone().sub(this.splineLocalOrigin));

        // create a geometry for the curve, we clone this later
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.ARC_SEGMENTS * 3), 3));

        // Use localPositions for the spline to avoid precision issues
        this.spline = new CatmullRomCurve3(this.localPositions);
        // Store curve type for linear mode support
        this.curveType = curveType;
        // 'chordal' gives a smooth velocity across the segment.
        // For 'linear' mode we handle interpolation ourselves, so set a valid CatmullRom type as fallback
        this.spline.curveType = curveType === 'catmull' ? 'catmullrom' : (curveType === 'linear' ? 'chordal' : curveType);
        this.spline.mesh = new Line(geometry.clone(), new LineBasicMaterial({
            color: 0xFF0FF,
            opacity: 0.35
        }));
        this.spline.mesh.castShadow = true;

        this.spline.mesh.layers.mask = LAYER.MASK_HELPERS;

        this.scene.add(this.spline.mesh);

        this.updatePointEditorGraphics()

    }

    // Override load to update local positions after loading new points
    load(new_positions, LLA = false) {
        super.load(new_positions, LLA);
        // Update local positions if they exist (they won't during initial construction)
        if (this.splineLocalOrigin && this.localPositions) {
            this.syncLocalPositions();
        }
    }

    // Sync localPositions with world positions relative to the local origin
    // Called after positions change to keep the CatmullRomCurve3 in sync
    syncLocalPositions() {
        // Guard: nothing to sync if arrays don't exist
        if (!this.splineLocalOrigin || !this.localPositions) {
            return;
        }

        // Update local origin from first point
        if (this.positions.length > 0) {
            this.splineLocalOrigin.copy(this.positions[0]);
        }

        // Ensure localPositions array length matches positions array
        while (this.localPositions.length < this.positions.length) {
            this.localPositions.push(new Vector3());
        }
        while (this.localPositions.length > this.positions.length) {
            this.localPositions.pop();
        }

        // Update each local position to be relative to the origin
        for (let i = 0; i < this.positions.length; i++) {
            this.localPositions[i].copy(this.positions[i]).sub(this.splineLocalOrigin);
        }
    }

    getLength(steps) {
        // Guard: need at least 2 points for CatmullRomCurve3 to work
        if (!this.localPositions || this.localPositions.length < 2) {
            return 0;
        }

        let len = 0;
        const lastPos = new Vector3()
        const pos = new Vector3()
        this.getPoint(0,lastPos)

        for (let i=1;i<steps;i++){
            const t = i/(steps-1) // go from 0 to 1, so we need steps-1 for the last one
            this.getPoint(t,pos)
            len += pos.clone().sub(lastPos).length()
            lastPos.copy(pos)
        }

        return len;
    }

    // get value at t (parametric input, 0..1) into the vector point
    getPoint(t,point) {
        // Fall back to linear interpolation if not enough points for spline
        if (this.curveType === 'linear' || this.numPoints < 2 || !this.localPositions || this.localPositions.length < 2) {
            return super.getPoint(t, point);
        }
        // Get point in local coordinates, then add the offset to get world coordinates
        this.spline.getPoint(t, point);
        point.add(this.splineLocalOrigin);
        return point;
    }


    updatePointEditorGraphics() {
        super.updatePointEditorGraphics()

        // Guard: spline may not exist yet during parent constructor call
        if (!this.spline || !this.spline.mesh || !this.localPositions) {
            return;
        }

        // Sync local positions with world positions
        this.syncLocalPositions();

        // Guard: need at least 2 points for CatmullRomCurve3 to work
        if (this.localPositions.length < 2) {
            return;
        }

        const point = new Vector3();
        const splineMesh = this.spline.mesh;
        const position = splineMesh.geometry.attributes.position;

        // Set mesh vertices in local coordinates (relative to splineLocalOrigin)
        // This avoids GPU precision issues with large world coordinates
        for (let i = 0; i < this.ARC_SEGMENTS; i++) {
            const t = i / (this.ARC_SEGMENTS - 1);
            if (this.curveType === 'linear') {
                // Linear interpolation in local coords (PointEditor-style)
                const np = this.localPositions.length;
                let a = Math.floor(t * (np - 1));
                if (t >= 1.0) a = np - 2;
                const b = a + 1;
                const f = t * (np - 1) - a;
                point.copy(this.localPositions[b]).sub(this.localPositions[a]).multiplyScalar(f).add(this.localPositions[a]);
            } else {
                this.spline.getPoint(t, point); // Get in local coords (don't add offset)
            }
            position.setXYZ(i, point.x, point.y, point.z);
        }
        position.needsUpdate = true;

        // Position the mesh at the local origin to place it correctly in world space
        splineMesh.position.copy(this.splineLocalOrigin);
    }

    setCurveType(type) {
        this.curveType = type;
        this.minimumPoints = (type === 'linear') ? 2 : 4;
        if (type !== 'linear') {
            this.spline.curveType = type === 'catmull' ? 'catmullrom' : type;
        }
        this.updatePointEditorGraphics();
    }

    /**
     * Clean up resources when the spline editor is disposed
     * Extends the base PointEditor dispose to also clean up the spline mesh
     */
    dispose() {
        // Clean up the spline mesh
        if (this.spline && this.spline.mesh) {
            this.scene.remove(this.spline.mesh);
            this.spline.mesh.geometry.dispose();
            this.spline.mesh.material.dispose();
        }

        // Call parent dispose to clean up position indicator and other resources
        super.dispose();
    }

}