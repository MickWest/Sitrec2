import {CNode3DGroup} from "./CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {dispose, propagateLayerMaskObject} from "../threeExt";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import {makeMatLine} from "../MatLines";
import {perpendicularVector, V3} from "../threeUtils";
import {Globals, guiShowHide, setRenderOne} from "../Globals";
import {BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial} from "three";

/**
 * CNodeDisplayEarthShadow - Displays Earth's shadow cone in the night sky
 * 
 * Renders two circles representing Earth's shadow:
 * - Red circle: Umbra (complete shadow, Sun completely blocked)
 * - Green circle: Penumbra (partial shadow, Sun partially blocked)
 * 
 * The shadow is positioned at the antisolar point and sized based on the altitude
 * parameter and Sun-Earth geometry.
 */
export class CNodeDisplayEarthShadow extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_LOOKRENDER;
        super(v);

        this.gui = v.gui ?? guiShowHide;
        
        // Configuration

        this.altitude = 42164000; // Default to geostationary altitude (~42,164 km above Earth's center)

        // Shadow colors
        this.umbraColor = 0x87CEFF;      // Light blue (umbra)
        this.penumbraColor = 0x4169E1;   // Darker blue (penumbra)

        this.fromSun = v.fromSun ?? V3(0, -1, 0); // Direction away from Sun (antisolar)
        
        // Sun parameters (all in meters)
        this.sunRadius = 696000000; // ~696,000 km
        this.earthRadius = Globals.equatorRadius;
        this.sunEarthDistance = 149597870700; // ~149.6 million km (1 AU)
        
        // Geometry and line objects
        this.umbraGeometry = null;
        this.umbraLine = null;
        this.penumbraGeometry = null;
        this.penumbraLine = null;
        this.umbraConeMesh = null;
        this.umbraConeGeometry = null;
        this.penumbraConeMesh = null;
        this.penumbraConeGeometry = null;
        
        // Materials
        this.umbraMaterial = makeMatLine(this.umbraColor, 2); // Light blue
        this.penumbraMaterial = makeMatLine(this.penumbraColor, 2); // Darker blue
        this.umbraConeMaterial = new MeshBasicMaterial({
            color: this.umbraColor,
            wireframe: false,
            transparent: true,
            opacity: 0.2,
            depthTest: false,
            depthWrite: false,
            side: 0 // THREE.FrontSide
        });
        this.penumbraConeMaterial = new MeshBasicMaterial({
            color: this.penumbraColor,
            wireframe: false,
            transparent: true,
            opacity: 0.2,
            depthTest: false,
            depthWrite: false,
            side: 0 // THREE.FrontSide
        });


        this.gui.add(this, "visible").name("Show Earth's Shadow").onChange(() => {
            this.show(this.visible);
            this.rebuild();
            setRenderOne(true);
        }).listen()
            .tooltip("Toggle the display of Earth's shadow cone in the night sky.");

        this.gui.add(this, 'altitude', 0, 80000000, 1000).listen()
            .onChange(() => {
                setRenderOne(true);
                this.rebuild();
            })
            .name("Earth's Shadow Altitude")
            .tooltip("Distance from Earth's center to the plane at which to render Earth's shadow cone (in meters).");

        this.addSimpleSerial("altitude")

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


    // Function to calculate the umbra and penumbra diameters at a given geocentric altitude
// Input: altitude (distance from Earth's center in meters)
// Output: Object containing umbra and penumbra diameters in meters
    calculateShadowRadii(altitude) {
        // Constants (all in meters)
        // Earth's radius, used as the size of the object casting the shadow
        const EARTH_RADIUS = Globals.equatorRadius;
        // Sun's radius, used to calculate its angular size
        const SUN_RADIUS = 696000000; // meters
        // Average Earth-Sun distance (1 AU), used to compute the Sun's angular size
        const EARTH_SUN_DISTANCE = 149600000000; // meters

        // Input validation: Ensure altitude is non-negative
        // Negative altitudes are physically invalid (below Earth's center)
        if (altitude < 0) {
            throw new Error("Altitude must be non-negative");
        }

        // Calculate the Sun's angular radius (half of angular diameter)
        // This is the angle subtended by the Sun's radius at Earth's distance
        // Formula: angular radius = arctan(Sun radius / Earth-Sun distance)
        // This determines how much the Sun's rays converge or diverge
        const sunAngularRadius = Math.atan(SUN_RADIUS / EARTH_SUN_DISTANCE);

        // Calculate the distance to the umbra's tip (where umbra diameter becomes zero)
        // The umbra is a converging cone, ending where Earth's shadow fully blocks the Sun
        // Using similar triangles: distance = Earth's radius / tan(angular radius)
        const umbraTipDistance = EARTH_RADIUS / Math.tan(sunAngularRadius);

        // Umbra diameter calculation
        // The umbra is a conical shadow that narrows with distance
        // At Earth's surface (altitude = EARTH_RADIUS), the umbra diameter equals Earth's diameter
        // At the umbra tip, the diameter is zero
        // For a given altitude, use similar triangles to find the diameter
        let umbraDiameter;
        if (altitude >= umbraTipDistance) {
            // Beyond the umbra tip, the shadow enters the antumbra (no total shadow)
            // Set umbra diameter to 0 as no complete shadow exists
            umbraDiameter = 0;
        } else {
            // Within the umbra, the diameter scales linearly with the remaining distance to the tip
            // Formula: D_umbra = 2 * R_earth * (L_umbra - altitude) / L_umbra
            umbraDiameter = 2 * EARTH_RADIUS * (umbraTipDistance - altitude) / umbraTipDistance;
        }

        // Penumbra calculation
        // The penumbra is the region where any part of the Sun is obscured, forming a diverging cone
        // At Earth's surface, the penumbra diameter is approximately Earth's diameter
        // The penumbra's "tip" is a virtual point behind the Sun where the cone would converge
        // Calculate the penumbra tip distance (negative, indicating divergence)
        const penumbraTipDistance = -EARTH_RADIUS / Math.tan(sunAngularRadius);
        // Penumbra diameter at the given altitude
        // Formula: D_penumbra = 2 * R_earth * (L_penumbra - altitude) / L_penumbra
        // Use absolute value to ensure a positive diameter, as the penumbra grows with distance
        const penumbraDiameter = Math.abs(2 * EARTH_RADIUS * (penumbraTipDistance - altitude) / penumbraTipDistance);

        // Return results as an object
        // Ensure umbra diameter is non-negative for physical accuracy
        // Include altitude and units for clarity
        return {
            umbraDiameter: Math.max(umbraDiameter, 0), // Prevent negative values
            penumbraDiameter: penumbraDiameter, // Always positive due to absolute value
            altitude: altitude,
            units: 'meters'
        };
    }


    buildCone(radius, circleCenter, perpendicular, otherPerpendicular, material, geometryProp, meshProp, renderOrder) {
        // Build a truncated cone (frustum) showing a shadow volume
        // From Earth's center to the shadow plane at the specified radius
        
        const segments = 50;
        const geometry = new BufferGeometry();
        const vertices = [];
        const indices = [];
        
        // ECEF/EUS are identical in this mode, so Earth's center is at origin.
        const globeCenter = V3(0, 0, 0);
        
        // Bottom circle (at Earth)
        for (let i = 0; i < segments; i++) {
            const theta = (i / segments) * 2 * Math.PI;
            const point = globeCenter.clone();
            point.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * this.earthRadius));
            point.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * this.earthRadius));
            vertices.push(point.x, point.y, point.z);
        }
        
        // Top circle (at shadow plane)
        for (let i = 0; i < segments; i++) {
            const theta = (i / segments) * 2 * Math.PI;
            const point = circleCenter.clone();
            point.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * radius));
            point.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * radius));
            vertices.push(point.x, point.y, point.z);
        }
        
        // Create side faces (no caps)
        for (let i = 0; i < segments; i++) {
            const next = (i + 1) % segments;
            const bottom_i = i;
            const bottom_next = next;
            const top_i = segments + i;
            const top_next = segments + next;
            
            // Two triangles per segment
            // indices.push(bottom_i, top_i, bottom_next);
            // indices.push(bottom_next, top_i, top_next);
            indices.push(bottom_next, top_i, bottom_i);
            indices.push(top_next, top_i, bottom_next);
        }
        
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3));
        geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
        geometry.computeVertexNormals();
        
        // Store geometry and mesh in the specified properties
        this[geometryProp] = geometry;
        this[meshProp] = new Mesh(geometry, material);
        this[meshProp].renderOrder = renderOrder;
        this.group.add(this[meshProp]);
    }

    buildUmbraCone(umbraRadius, circleCenter, perpendicular, otherPerpendicular) {
        // Build umbra cone - from Earth to umbra plane (bright blue, more opaque)
        // renderOrder = 2: renders on top
        this.buildCone(umbraRadius, circleCenter, perpendicular, otherPerpendicular,
                       this.umbraConeMaterial, 'umbraConeGeometry', 'umbraConeMesh', 2);
    }

    buildPenumbraCone(penumbraRadius, circleCenter, perpendicular, otherPerpendicular) {
        // Build penumbra cone - from Earth to penumbra plane (darker blue, more transparent)
        // renderOrder = 1: renders first (in background)
        this.buildCone(penumbraRadius, circleCenter, perpendicular, otherPerpendicular,
                       this.penumbraConeMaterial, 'penumbraConeGeometry', 'penumbraConeMesh', 1);
    }

    rebuild() {
        this.removeCircles();
        if (!this.visible) {
            return;
        }

        const shadowData = this.calculateShadowRadii(this.altitude);
        const umbraRadius = shadowData.umbraDiameter / 2;
        const penumbraRadius = shadowData.penumbraDiameter / 2;
        
        // ECEF/EUS are identical in this mode, so Earth's center is at origin.
        const globeCenter = V3(0, 0, 0);
        
        // Circle center is at altitude along antisolar direction (fromSun)
        const circleCenter = globeCenter.clone().add(this.fromSun.clone().multiplyScalar(this.altitude));
        
        // Create perpendicular vectors for the circle plane
        const perpendicular = perpendicularVector(this.fromSun).normalize();
        const otherPerpendicular = this.fromSun.clone().cross(perpendicular);
        
        const segments = 100;
        
        // Build the umbra and penumbra cones
        this.buildPenumbraCone(penumbraRadius, circleCenter, perpendicular, otherPerpendicular);
        this.buildUmbraCone(umbraRadius, circleCenter, perpendicular, otherPerpendicular);

        // Create umbra circle
        {
            const line_points = [];
            for (let i = 0; i < segments; i++) {
                const theta = i / (segments - 1) * 2 * Math.PI;
                const point = circleCenter.clone();
                point.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * umbraRadius));
                point.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * umbraRadius));
                line_points.push(point.x, point.y, point.z);
            }

            const umbraGeometry = new LineGeometry();
            umbraGeometry.setPositions(line_points);
            this.umbraGeometry = umbraGeometry;
            this.umbraLine = new Line2(this.umbraGeometry, this.umbraMaterial);
            this.umbraLine.computeLineDistances();
            this.umbraLine.scale.setScalar(1);
            this.group.add(this.umbraLine);
        }

        // Create penumbra circle
        {
            const line_points = [];
            for (let i = 0; i < segments; i++) {
                const theta = i / (segments - 1) * 2 * Math.PI;
                const point = circleCenter.clone();
                point.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * penumbraRadius));
                point.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * penumbraRadius));
                line_points.push(point.x, point.y, point.z);
            }

            const penumbraGeometry = new LineGeometry();
            penumbraGeometry.setPositions(line_points);
            this.penumbraGeometry = penumbraGeometry;
            this.penumbraLine = new Line2(this.penumbraGeometry, this.penumbraMaterial);
            this.penumbraLine.computeLineDistances();
            this.penumbraLine.scale.setScalar(1);
            this.group.add(this.penumbraLine);
        }

        propagateLayerMaskObject(this.group);
    }

    /**
     * Update shadow position based on current Sun direction
     */
    update(f) {
        if (this.visible && Globals.fromSun !== undefined) {

            this.fromSun = Globals.fromSun.clone().normalize();
            this.rebuild();
        }
    }


    dispose() {
        this.removeCircles();
        super.dispose();
    }
}
