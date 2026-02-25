import {CNode3DGroup} from "./CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {clampAboveGround, dispose, intersectEllipsoid, propagateLayerMaskObject} from "../threeExt";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import {makeMatLine} from "../MatLines";
import {perpendicularVector} from "../threeUtils";
import {Globals, guiShowHide, setRenderOne} from "../Globals";
import {BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Vector3} from "three";


export class CNodeDisplayMoonShadow extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_LOOKRENDER;
        super(v);

        this.gui = v.gui ?? guiShowHide;
        
        this.numSegments = 20;

        this.umbraColor = 0xFFD700;      // Gold (umbra)
        this.penumbraColor = 0xFFA500;   // Orange (penumbra)
        
        this.sunRadius = 696000000;
        this.moonRadius = 1737400;
        this.sunMoonDistance = 149597870700;
        
        this.umbraGeometry = null;
        this.umbraLine = null;
        this.penumbraGeometry = null;
        this.penumbraLine = null;
        this.umbraConeMesh = null;
        this.umbraConeGeometry = null;
        this.penumbraConeMesh = null;
        this.penumbraConeGeometry = null;
        
        this.umbraMaterial = makeMatLine(this.umbraColor, 2);
        this.penumbraMaterial = makeMatLine(this.penumbraColor, 2);
        this.umbraConeMaterial = new MeshBasicMaterial({
            color: this.umbraColor,
            wireframe: false,
            transparent: true,
            opacity: 0.15,
            depthTest: false,
            depthWrite: false,
            side: 2
        });
        this.penumbraConeMaterial = new MeshBasicMaterial({
            color: this.penumbraColor,
            wireframe: false,
            transparent: true,
            opacity: 0.1,
            depthTest: false,
            depthWrite: false,
            side: 2
        });

        this.gui.add(this, "visible").name("Show Moon's Shadow").onChange(() => {
            this.show(this.visible);
            this.rebuild();
            setRenderOne(true);
        }).listen()
            .tooltip("Toggle the display of Moon's shadow cone for eclipse visualization.");

        this.gui.add(this, 'numSegments', 5, 50, 1).listen()
            .onChange(() => {
                setRenderOne(true);
                this.rebuild();
            })
            .name("Shadow Segments")
            .tooltip("Number of segments in the shadow cone (more = smoother but slower)");

        this.addSimpleSerial("numSegments")

        this.rebuild();
    }

    dispose() {
        this.removeCircles();
        super.dispose();
    }

    removeCircles() {
        if (this.umbraLine) {
            this.group.remove(this.umbraLine);
            dispose(this.umbraGeometry);
        }
        if (this.penumbraLine) {
            this.group.remove(this.penumbraLine);
            dispose(this.penumbraGeometry);
        }
        if (this.umbraConeMesh) {
            this.group.remove(this.umbraConeMesh);
            dispose(this.umbraConeGeometry);
        }
        if (this.penumbraConeMesh) {
            this.group.remove(this.penumbraConeMesh);
            dispose(this.penumbraConeGeometry);
        }
    }

    calculateShadowRadii(altitude, sunMoonDistance) {
        const MOON_RADIUS = 1737400;
        const SUN_RADIUS = 696000000;

        if (altitude < 0) {
            throw new Error("Altitude must be non-negative");
        }

        const sunAngularRadius = Math.atan(SUN_RADIUS / sunMoonDistance);
        
        const umbraTipDistance = MOON_RADIUS / Math.tan(sunAngularRadius);
        
        let umbraDiameter;
        if (altitude >= umbraTipDistance) {
            umbraDiameter = 0;
        } else {
            umbraDiameter = 2 * MOON_RADIUS * (umbraTipDistance - altitude) / umbraTipDistance;
        }
        
        const penumbraTipDistance = -MOON_RADIUS / Math.tan(sunAngularRadius);
        const penumbraDiameter = Math.abs(2 * MOON_RADIUS * (penumbraTipDistance - altitude) / penumbraTipDistance);
        
        return {
            umbraDiameter: Math.max(umbraDiameter, 0),
            penumbraDiameter: penumbraDiameter,
            altitude: altitude,
            units: 'meters'
        };
    }

    buildSegmentedCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, isUmbra, material, geometryProp, meshProp, renderOrder, sunMoonDistance, coneReferenceDistance) {
        const circleSegments = 32;
        const geometry = new BufferGeometry();
        const vertices = [];
        const indices = [];
        
        const extensionDistance = coneReferenceDistance + 100000000;
        
        const refShadowData = this.calculateShadowRadii(coneReferenceDistance, sunMoonDistance);
        const refRadius = isUmbra ? refShadowData.umbraDiameter / 2 : refShadowData.penumbraDiameter / 2;
        const refCenter = moonCenter.clone().add(shadowDir.clone().multiplyScalar(coneReferenceDistance));
        
        const rayDirs = [];
        const mslDistances = [];
        for (let i = 0; i < circleSegments; i++) {
            const theta = (i / circleSegments) * 2 * Math.PI;
            const refPoint = refCenter.clone();
            refPoint.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * refRadius));
            refPoint.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * refRadius));
            
            const rayDir = refPoint.clone().sub(moonCenter).normalize();
            rayDirs.push(rayDir);
            
            const mslPoint = intersectEllipsoid(moonCenter, rayDir);
            mslDistances.push(mslPoint ? moonCenter.distanceTo(mslPoint) : Infinity);
        }
        
        for (let seg = 0; seg <= this.numSegments; seg++) {
            const t = seg / this.numSegments;
            const distanceFromMoon = extensionDistance * t;
            
            for (let i = 0; i < circleSegments; i++) {
                const rayDir = rayDirs[i];
                const mslDist = mslDistances[i];
                
                let point;
                if (mslDist < distanceFromMoon) {
                    const mslPoint = moonCenter.clone().add(rayDir.clone().multiplyScalar(mslDist));
                    point = clampAboveGround(mslPoint, 100);
                } else {
                    point = moonCenter.clone().add(rayDir.clone().multiplyScalar(distanceFromMoon));
                }
                
                vertices.push(point.x, point.y, point.z);
            }
        }
        
        for (let seg = 0; seg < this.numSegments; seg++) {
            for (let i = 0; i < circleSegments; i++) {
                const next = (i + 1) % circleSegments;
                const current = seg * circleSegments + i;
                const currentNext = seg * circleSegments + next;
                const nextRing = (seg + 1) * circleSegments + i;
                const nextRingNext = (seg + 1) * circleSegments + next;
                
                indices.push(current, nextRing, currentNext);
                indices.push(currentNext, nextRing, nextRingNext);
            }
        }
        
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3));
        geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
        geometry.computeVertexNormals();
        
        this[geometryProp] = geometry;
        this[meshProp] = new Mesh(geometry, material);
        this[meshProp].renderOrder = renderOrder;
        this.group.add(this[meshProp]);
    }

    buildUmbraCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, sunMoonDistance, coneReferenceDistance) {
        this.buildSegmentedCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, true,
                       this.umbraConeMaterial, 'umbraConeGeometry', 'umbraConeMesh', 2, sunMoonDistance, coneReferenceDistance);
    }

    buildPenumbraCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, sunMoonDistance, coneReferenceDistance) {
        this.buildSegmentedCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, false,
                       this.penumbraConeMaterial, 'penumbraConeGeometry', 'penumbraConeMesh', 1, sunMoonDistance, coneReferenceDistance);
    }

    rebuild() {
        this.removeCircles();
        if (!this.visible) {
            return;
        }

        if (!Globals.moonPos || !Globals.fromSun) {
            return;
        }

        const moonCenter = Globals.moonPos.clone();
        
        if (moonCenter.length() < 100000) {
            return;
        }
        
        const shadowDir = Globals.fromSun.clone().normalize();
        
        let coneReferenceDistance;
        // Ellipsoid-correct intersection for the shadow axis with Earth.
        const axisHit = intersectEllipsoid(moonCenter, shadowDir);
        if (axisHit) {
            coneReferenceDistance = moonCenter.distanceTo(axisHit);
        } else {
            // Fallback: spherical approximation using equatorial radius.
            // This should rarely be needed, but keeps rendering robust.
            const oc = moonCenter.clone();
            const b = -oc.dot(shadowDir);
            const c = oc.dot(oc) - Globals.equatorRadius * Globals.equatorRadius;
            const discriminant = b * b - c;
            if (discriminant >= 0) {
                coneReferenceDistance = b - Math.sqrt(discriminant);
            } else {
                const t = -oc.dot(shadowDir);
                coneReferenceDistance = t > 0 ? t : moonCenter.length();
            }
        }
        
        const coneEndPoint = moonCenter.clone().add(shadowDir.clone().multiplyScalar(coneReferenceDistance));
        
        // Use the actual geocentric Sun position at this frame (not fixed 1 AU),
        // because umbra size is sensitive to the Sun's apparent angular radius.
        const sunMoonDistance = Globals.sunPos
            ? Globals.sunPos.distanceTo(moonCenter)
            : Globals.toSun.clone().normalize().multiplyScalar(this.sunMoonDistance).distanceTo(moonCenter);
        
        const perpendicular = perpendicularVector(shadowDir).normalize();
        const otherPerpendicular = shadowDir.clone().cross(perpendicular);
        
        this.buildPenumbraCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, sunMoonDistance, coneReferenceDistance);
        this.buildUmbraCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, sunMoonDistance, coneReferenceDistance);
        const shadowData = this.calculateShadowRadii(coneReferenceDistance, sunMoonDistance);
        const umbraRadius = shadowData.umbraDiameter / 2;
        const penumbraRadius = shadowData.penumbraDiameter / 2;

        const segments = 100;
        
        {
            const line_points = [];
            
            for (let i = 0; i < segments; i++) {
                const theta = i / (segments - 1) * 2 * Math.PI;
                let point = coneEndPoint.clone();
                point.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * umbraRadius));
                point.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * umbraRadius));
                
                const rayDir = point.clone().sub(moonCenter).normalize();
                const mslPoint = intersectEllipsoid(moonCenter, rayDir);
                
                if (mslPoint) {
                    point = clampAboveGround(mslPoint, 100);
                    line_points.push(point.x, point.y, point.z);
                }
            }

            if (line_points.length > 0) {
                const umbraGeometry = new LineGeometry();
                umbraGeometry.setPositions(line_points);
                this.umbraGeometry = umbraGeometry;
                this.umbraLine = new Line2(this.umbraGeometry, this.umbraMaterial);
                this.umbraLine.computeLineDistances();
                this.umbraLine.scale.setScalar(1);
                this.group.add(this.umbraLine);
            }
        }

        {
            const line_points = [];
            
            for (let i = 0; i < segments; i++) {
                const theta = i / (segments - 1) * 2 * Math.PI;
                let point = coneEndPoint.clone();
                point.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * penumbraRadius));
                point.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * penumbraRadius));
                
                const rayDir = point.clone().sub(moonCenter).normalize();
                const mslPoint = intersectEllipsoid(moonCenter, rayDir);
                
                if (mslPoint) {
                    point = clampAboveGround(mslPoint, 100);
                    line_points.push(point.x, point.y, point.z);
                }
            }

            if (line_points.length > 0) {
                const penumbraGeometry = new LineGeometry();
                penumbraGeometry.setPositions(line_points);
                this.penumbraGeometry = penumbraGeometry;
                this.penumbraLine = new Line2(this.penumbraGeometry, this.penumbraMaterial);
                this.penumbraLine.computeLineDistances();
                this.penumbraLine.scale.setScalar(1);
                this.group.add(this.penumbraLine);
            }
        }

        propagateLayerMaskObject(this.group);
    }

    update(f) {
        if (this.visible && Globals.fromSun !== undefined && Globals.moonPos !== undefined) {
            this.rebuild();
        }
    }
}
