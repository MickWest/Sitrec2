// Synthetic 3D Building/Object Node
// Uses a mesh-based data structure (vertices, edges, faces) for extensibility
// to arbitrary 3D geometry editing (like SketchUp/Blender)

import {CNode3DGroup} from "./CNode3DGroup";
import {
    BufferGeometry,
    CircleGeometry,
    Color,
    DoubleSide,
    Float32BufferAttribute,
    LineBasicMaterial,
    LineSegments,
    Mesh,
    MeshBasicMaterial,
    MeshLambertMaterial,
    MeshPhongMaterial,
    MeshStandardMaterial,
    Plane,
    Raycaster,
    SphereGeometry,
    Vector3
} from "three";
import * as LAYER from "../LayerMasks";
import {getLocalUpVector} from "../SphericalMath";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {screenToNDC} from "../mouseMoveView";
import {ViewMan} from "../CViewManager";
import {CustomManager, Globals, guiMenus, setRenderOne, Synth3DManager, UndoManager} from "../Globals";
import {mouseInViewOnly} from "../ViewUtils";
import {getPointBelow, patchMaterialForLinearOutput, pointAbove} from "../threeExt";
import {EventManager} from "../CEventManager";
import {isInLeftSidebar, isInRightSidebar} from "../PageStructure";
import {t} from "../i18n";
import {eventMethods} from "./CNodeSynthBuildingEvents";

export class CNodeSynthBuilding extends CNode3DGroup {
    constructor(v) {

        v.rawColor = v.color;
        super(v);
        
        // Mesh data structure (what we save/load)
        // Each vertex is now an object with position and metadata:
        // {
        //   position: Vector3,
        //   type: 'top' | 'bottom' | 'free',
        //   next: vertexIndex (for ring navigation),
        //   prev: vertexIndex (for ring navigation),
        //   linkedVertex: vertexIndex (top <-> bottom pairing)
        // }
        this.vertices = [];  // Array of vertex objects
        this.faces = [];     // Array of face objects: {indices: [v0, v1, v2, ...]}
        
        // Optional: Store edges explicitly for wireframe rendering
        // Edges are derived from faces, but we can cache them
        this.edges = [];     // Array of {v0: idx, v1: idx}
        
        // Metadata
        this.buildingID = v.id;
        this.name = v.name || v.id;
        
        // Material properties
        this.materialType = v.material || 'lambert';
        
        // Convert colors to hex string format for GUI (#RRGGBB)
        const wallColorValue = v.wallColor || v.color || v.rawColor || 0xc0c0c0;
        const roofColorValue = v.roofColor || 0x404040;
        this.wallColor = "#" + new Color(wallColorValue).getHexString();
        this.roofColor = "#" + new Color(roofColorValue).getHexString();
        
        this.materialOpacity = v.opacity !== undefined ? v.opacity : 1.0;
        this.materialTransparent = v.transparent !== undefined ? v.transparent : true;
        this.materialDepthTest = v.depthTest !== undefined ? v.depthTest : true;
        this.materialWireframe = v.wireframe || false;
        
        // Building height parameters (terrain-relative)
        // Store corner positions as lat/lon only, heights calculated from highPoint
        this.cornerLatLons = v.cornerLatLons || [];  // Array of {lat, lon} for 4 corners
        this.roofAGL = v.roofAGL !== undefined ? v.roofAGL : 4;  // Roof height above highest ground point
        this.rooflineHeightAGL = v.rooflineHeightAGL !== undefined ? v.rooflineHeightAGL : 0;  // Additional height of roofline above roof corners
        this.ridgelineInset = v.ridgelineInset !== undefined ? v.ridgelineInset : 0;  // Distance to move ridgeline ends inward
        this.roofEaves = v.roofEaves !== undefined ? v.roofEaves : 0;  // Distance to extend roof beyond walls laterally
        this.highPoint = null;  // Cached highest ground point (recalculated as needed)
        
        // THREE.js rendering objects
        this.solidMesh = null;      // The rendered building mesh
        this.wireframe = null;      // Wireframe edges
        this.controlPoints = [];    // Editable vertex control points
        this.roofCenterHandle = null; // Single grey handle for roof height adjustment
        this.rooflineHandle = null;   // Handle for roofline height adjustment
        this.rotationHandles = [];    // Invisible larger handles around each corner for rotation detection
        
        // Edit mode state
        this.editMode = false;
        this.isDragging = false;
        this.isRotating = false;
        this.draggingPoint = null;
        this.draggingVertexIndex = -1;
        this.dragLocalUp = null;
        this.hoveredHandle = null;  // Track which handle is being hovered
        this.rotationStartAngle = 0; // Initial angle when rotation starts
        this.totalRotationThisSession = 0; // Accumulated rotation in radians during this rotation session
        this.buildingCentroid = null; // Center point for rotation
        
        // Raycaster for picking
        this.raycaster = new Raycaster();
        this.raycaster.layers.mask = LAYER.MASK_HELPERS;
        
        // If we're given initial geometry, create it
        if (v.cornerLatLons && v.cornerLatLons.length === 4) {
            // New format: recalculate from terrain
            this.recalculateVerticesFromTerrain();
        } else if (v.vertices && v.faces) {
            // Old format: load vertices directly
            this.loadGeometry(v.vertices, v.faces);
        } else if (v.footprint && v.height !== undefined) {
            // Create a cuboid from a footprint rectangle and height
            this.createCuboidFromFootprint(v.footprint, v.height);
        }
        
        // Build the THREE.js meshes
        this.buildMesh();
        
        // Set up event listeners for dragging
        this.setupEventListeners();
        
        // Create GUI folder (hidden until edit mode)
        this.createGUIFolder();
    }
    
    /**
     * Load geometry from vertices and faces arrays
     */
    loadGeometry(vertices, faces) {
        // Handle both old format (just positions) and new format (vertex objects)
        this.vertices = vertices.map(v => {
            if (v.position) {
                // New format with metadata
                return {
                    position: new Vector3(v.position.x, v.position.y, v.position.z),
                    type: v.type || 'free',
                    next: v.next !== undefined ? v.next : -1,
                    prev: v.prev !== undefined ? v.prev : -1,
                    linkedVertex: v.linkedVertex !== undefined ? v.linkedVertex : -1
                };
            } else {
                // Old format - just a position, treat as free vertex
                return {
                    position: new Vector3(v.x, v.y, v.z),
                    type: 'free',
                    next: -1,
                    prev: -1,
                    linkedVertex: -1
                };
            }
        });
        this.faces = faces.map(f => ({
            indices: [...f.indices],
            type: f.type || 'wall'  // Default to 'wall' for backward compatibility
        }));
        
        // If we have roofline vertices, rebuild roof faces
        const hasRoofline = this.vertices.some(v => v.type === 'roofline');
        if (hasRoofline) {
            this.buildRoofFaces();
        }
        
        this.computeEdges();
    }
    
    /**
     * Extract cornerLatLons and heights from current vertex positions
     * This syncs the stored parameters with the actual geometry
     */
    syncParametersFromVertices() {
        if (this.vertices.length < 10) {
            console.warn("Cannot sync parameters: need at least 10 vertices");
            return;
        }
        
        // Extract corner lat/lons from bottom vertices (0-3)
        this.cornerLatLons = [];
        for (let i = 0; i < 4; i++) {
            if (this.vertices[i] && this.vertices[i].type === 'bottom') {
                const lla = ECEFToLLAVD_radii(this.vertices[i].position);
                this.cornerLatLons.push({lat: lla.x, lon: lla.y});
            }
        }
        
        // Calculate roofAGL from the top vertices
        // CRITICAL: roofAGL is the height of the roof above the HIGHEST ground point
        // NOT the average of roof heights above each ground point
        
        // Step 1: Find the highest ground point
        let maxGroundHeight = -Infinity;
        let highestGroundIndex = 0;
        const refGround = this.vertices[0].position;
        const refUp = getLocalUpVector(refGround);
        
        for (let i = 0; i < 4; i++) {
            if (this.vertices[i] && this.vertices[i].type === 'bottom') {
                const height = this.vertices[i].position.clone().sub(refGround).dot(refUp);
                if (height > maxGroundHeight) {
                    maxGroundHeight = height;
                    highestGroundIndex = i;
                    this.highPoint = this.vertices[i].position.clone();
                }
            }
        }
        
        // Step 2: Calculate roofAGL as height of roof above the HIGHEST ground
        // Use the roof vertex linked to the highest ground vertex
        const highestGround = this.vertices[highestGroundIndex];
        const linkedRoofIndex = highestGround.linkedVertex;
        
        if (this.vertices[linkedRoofIndex] && this.vertices[linkedRoofIndex].type === 'top') {
            const roofVertex = this.vertices[linkedRoofIndex];
            const upVector = getLocalUpVector(highestGround.position);
            this.roofAGL = roofVertex.position.clone().sub(highestGround.position).dot(upVector);
        } else {
            // Fallback: use any roof vertex's height above highest ground
            if (this.vertices[4] && this.vertices[4].type === 'top') {
                const upVector = getLocalUpVector(this.highPoint);
                this.roofAGL = this.vertices[4].position.clone().sub(this.highPoint).dot(upVector);
            } else {
                this.roofAGL = 4; // default
            }
        }
        
        // Calculate rooflineHeightAGL from roofline vertices
        // This is the height ABOVE the roof edge (midpoint of top vertices)
        if (this.vertices[8] && this.vertices[8].type === 'roofline') {
            const roof1 = this.vertices[8];
            
            // Calculate roof edge position (midpoint between top vertices 4 and 5)
            const top4 = this.vertices[4];
            const top5 = this.vertices[5];
            const roofEdgePos = top4.position.clone().add(top5.position).multiplyScalar(0.5);
            const upVector = getLocalUpVector(roofEdgePos);
            
            // Height of roofline above roof edge
            const heightAboveRoof = roof1.position.clone().sub(roofEdgePos).dot(upVector);
            
            this.rooflineHeightAGL = Math.max(0, heightAboveRoof);
        } else {
            this.rooflineHeightAGL = 0;
        }
    }
    
    /**
     * Update roof edge height from GUI slider
     * This adjusts all roof vertices to be at the new height above the highest ground point
     */
    updateRoofEdgeHeight(newHeight) {
        this.roofAGL = newHeight;
        
        // Find highest ground point
        if (this.vertices.length < 8) return;
        
        const groundPositions = [];
        for (let i = 0; i < 4; i++) {
            if (this.vertices[i] && this.vertices[i].type === 'bottom') {
                groundPositions.push(this.vertices[i].position);
            }
        }
        
        if (groundPositions.length !== 4) return;
        
        const refGround = groundPositions[0];
        const refUp = getLocalUpVector(refGround);
        
        let maxHeight = 0;
        let highPointIndex = 0;
        for (let i = 0; i < 4; i++) {
            const height = groundPositions[i].clone().sub(refGround).dot(refUp);
            if (height > maxHeight) {
                maxHeight = height;
                highPointIndex = i;
            }
        }
        const highestGround = groundPositions[highPointIndex].clone();
        
        // Update all roof vertices to be at roofAGL above highest ground
        for (let i = 0; i < 4; i++) {
            const groundPos = groundPositions[i];
            const roofVertex = this.vertices[i + 4];
            
            if (roofVertex && roofVertex.type === 'top') {
                const localUp = getLocalUpVector(groundPos);
                const groundToHigh = highestGround.clone().sub(groundPos).dot(localUp);
                roofVertex.position.copy(pointAbove(groundPos, groundToHigh + this.roofAGL));
            }
        }
        
        // Update roofline vertices (they are relative to roof edge)
        this.updateRooflineVertices();
        
        // Rebuild mesh and controls
        this.buildMesh();
        if (this.editMode) {
            this.createControlPoints();
        }
        
        // Update GUI controllers
        this.updateGUIControllers();
        
        setRenderOne(true);
    }
    
    /**
     * Update roofline height from GUI slider
     * This adjusts the roofline vertices to be at the new height above the roof edge
     */
    updateRooflineHeight(newHeight) {
        this.rooflineHeightAGL = newHeight;
        
        // Update roofline vertices
        this.updateRooflineVertices();
        
        // Rebuild mesh and controls
        this.buildMesh();
        if (this.editMode) {
            this.createControlPoints();
        }
        
        // Update GUI controllers
        this.updateGUIControllers();
        
        setRenderOne(true);
    }
    
    /**
     * Update ridgeline inset from GUI slider
     * This moves the ridgeline endpoints inward along the ridgeline
     */
    updateRidgelineInset(newInset) {
        this.ridgelineInset = newInset;
        
        // Update roofline vertices (which now applies the inset)
        this.updateRooflineVertices();
        
        // Rebuild mesh and controls
        this.buildMesh();
        if (this.editMode) {
            this.createControlPoints();
        }
        
        // Update GUI controllers
        this.updateGUIControllers();
        
        setRenderOne(true);
    }
    
    /**
     * Update roof eaves from GUI slider
     * This extends the roof beyond the walls laterally
     */
    updateRoofEaves(newEaves) {
        this.roofEaves = newEaves;
        
        // Rebuild mesh and controls
        this.buildMesh();
        if (this.editMode) {
            this.createControlPoints();
        }
        
        // Update GUI controllers
        this.updateGUIControllers();
        
        setRenderOne(true);
    }
    
    /**
     * Calculate the inset ridgeline position by moving endpoints inward
     * @param {Vector3} basePos - The midpoint of the roof edge (without inset)
     * @param {Vector3} otherBasePos - The other ridgeline endpoint (for calculating inset direction)
     * @returns {Vector3} The inset position
     */
    calculateInsetRidgelinePosition(basePos, otherBasePos) {
        if (this.ridgelineInset === 0) {
            return basePos.clone();
        }
        
        // Direction from basePos towards otherBasePos (along the ridgeline)
        const direction = otherBasePos.clone().sub(basePos);
        const ridgelineLength = direction.length();
        
        if (ridgelineLength === 0) {
            return basePos.clone();
        }
        
        // Normalize and move inward
        const normalizedDir = direction.normalize();
        return basePos.clone().add(normalizedDir.multiplyScalar(this.ridgelineInset));
    }
    
    /**
     * Update roofline vertex positions based on current rooflineHeightAGL
     */
    updateRooflineVertices() {
        const roof1 = this.vertices[8];
        const roof2 = this.vertices[9];
        
        if (roof1 && roof1.type === 'roofline' && this.vertices[4] && this.vertices[5]) {
            const roof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
            const upVector1 = getLocalUpVector(roof1EdgePos);
            roof1.position.copy(roof1EdgePos.clone().add(upVector1.multiplyScalar(this.rooflineHeightAGL)));
        }
        
        if (roof2 && roof2.type === 'roofline' && this.vertices[6] && this.vertices[7]) {
            const roof2EdgePos = this.vertices[6].position.clone().add(this.vertices[7].position).multiplyScalar(0.5);
            const upVector2 = getLocalUpVector(roof2EdgePos);
            roof2.position.copy(roof2EdgePos.clone().add(upVector2.multiplyScalar(this.rooflineHeightAGL)));
        }
    }
    
    /**
     * Update GUI controllers to reflect current values
     * Controllers store display units, so we use setSIValue to convert from building's SI values
     */
    updateGUIControllers() {
        if (this.roofEdgeHeightController) {
            // Update proxy display value from building's SI value
            this.roofEdgeHeightController.setSIValue(this.roofAGL);
        }
        if (this.ridgelineHeightController) {
            // Update proxy display value from building's SI values
            const totalHeight = this.roofAGL + this.rooflineHeightAGL;
            this.ridgelineHeightController.setSIValue(totalHeight);
        }
        if (this.ridgelineInsetController) {
            // Update proxy display value from building's SI value
            this.ridgelineInsetController.setSIValue(this.ridgelineInset);
        }
        if (this.roofEavesController) {
            // Update proxy display value from building's SI value
            this.roofEavesController.setSIValue(this.roofEaves);
        }
    }
    
    /**
     * Snap all ground vertices (0-3) to terrain and update linked top vertices
     * This is called after moving or rotating the building to ensure ground vertices
     * stay on the terrain surface.
     * 
     * CRITICAL: All roof vertices (4-7) MUST be at the same altitude, which is
     * roofAGL above the HIGHEST ground vertex. This ensures the roof edges form
     * a horizontal plane, and all triangles are coplanar.
     */
    snapGroundVerticesToTerrain() {
        // Step 1: Snap all ground vertices (0-3) to terrain
        const groundPositions = [];
        for (let i = 0; i < 4; i++) {
            const groundVertex = this.vertices[i];
            if (!groundVertex || groundVertex.type !== 'bottom') continue;
            
            const currentPos = groundVertex.position.clone();

            // Snap to terrain — no need to lift first for the non-raycast path;
            // lifting along the geodetic normal shifts lat/lon on an ellipsoid,
            // causing systematic drift.
            const terrainPoint = getPointBelow(currentPos);
            
            // Update ground vertex position
            groundVertex.position.copy(terrainPoint);
            groundPositions.push(terrainPoint);
        }
        
        // Step 2: Find the HIGHEST ground vertex
        // All roof vertices must be at the same altitude: roofAGL above this highest point
        const refGround = groundPositions[0];
        const refUp = getLocalUpVector(refGround);
        
        let maxHeight = 0;
        let highPointIndex = 0;
        for (let i = 0; i < 4; i++) {
            const height = groundPositions[i].clone().sub(refGround).dot(refUp);
            if (height > maxHeight) {
                maxHeight = height;
                highPointIndex = i;
            }
        }
        const highestGround = groundPositions[highPointIndex].clone();
        
        // Step 3: Position all roof vertices at the SAME altitude
        // Each roof vertex is positioned above its corresponding ground vertex,
        // but at an altitude that equals: highestGround + roofAGL
        for (let i = 0; i < 4; i++) {
            const groundPos = groundPositions[i];
            const roofVertex = this.vertices[i + 4]; // roof vertices are at indices 4-7
            
            if (roofVertex && roofVertex.type === 'top') {
                const localUp = getLocalUpVector(groundPos);
                
                // Calculate height from this ground to the highest ground
                const groundToHigh = highestGround.clone().sub(groundPos).dot(localUp);
                
                // Position roof vertex at: groundToHigh + roofAGL above this ground point
                // This ensures all roof vertices are at the same absolute altitude
                roofVertex.position.copy(pointAbove(groundPos, groundToHigh + this.roofAGL));
            }
        }
        
        // Step 4: Update roofline vertices
        // Both roofline vertices must be at the SAME altitude as each other
        const roof1 = this.vertices[8];
        const roof2 = this.vertices[9];
        
        if (roof1 && roof1.type === 'roofline' && roof2 && roof2.type === 'roofline') {
            // roof1 is at midpoint between top vertices 4 and 5
            const roof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
            const upVector1 = getLocalUpVector(roof1EdgePos);
            roof1.position.copy(roof1EdgePos.clone().add(upVector1.multiplyScalar(this.rooflineHeightAGL)));
            
            // roof2 is at midpoint between top vertices 6 and 7
            const roof2EdgePos = this.vertices[6].position.clone().add(this.vertices[7].position).multiplyScalar(0.5);
            const upVector2 = getLocalUpVector(roof2EdgePos);
            roof2.position.copy(roof2EdgePos.clone().add(upVector2.multiplyScalar(this.rooflineHeightAGL)));
        }
    }
    
    /**
     * Recalculate all vertex positions from cornerLatLons and height parameters
     * This method uses getPointBelow() to find ground positions and then calculates
     * all vertices relative to the highest ground point.
     */
    recalculateVerticesFromTerrain() {
        if (this.cornerLatLons.length !== 4) {
            console.warn("Cannot recalculate vertices: need exactly 4 corners");
            return;
        }
        
        // Step 1: Find ground positions under each corner
        const groundCorners = [];
        for (let i = 0; i < 4; i++) {
            const {lat, lon} = this.cornerLatLons[i];
            const surfacePoint = LLAToECEF(lat, lon, 0);
            const groundPoint = getPointBelow(surfacePoint);
            groundCorners.push(groundPoint);
        }
        
        // Step 2: Find the highest ground point
        // Use the first corner as reference for calculating relative heights
        const refGround = groundCorners[0];
        const refUp = getLocalUpVector(refGround);
        
        let maxHeight = 0;
        let highPointIndex = 0;
        for (let i = 0; i < 4; i++) {
            const height = groundCorners[i].clone().sub(refGround).dot(refUp);
            if (height > maxHeight) {
                maxHeight = height;
                highPointIndex = i;
            }
        }
        this.highPoint = groundCorners[highPointIndex].clone();
        
        // Step 3: Calculate roof corner positions
        // Each roof corner is at its lat/lon position, at altitude = highPoint + roofAGL
        const roofCorners = [];
        for (let i = 0; i < 4; i++) {
            const groundPos = groundCorners[i];
            const localUp = getLocalUpVector(groundPos);
            
            // Height from this ground to the highest ground
            const groundToHigh = this.highPoint.clone().sub(groundPos).dot(localUp);
            
            // Roof position is groundToHigh + roofAGL above this ground point
            const roofPos = pointAbove(groundPos, groundToHigh + this.roofAGL);
            roofCorners.push(roofPos);
        }
        
        // Step 4: Clear vertices and rebuild
        this.vertices = [];
        
        // Create bottom ring (vertices 0-3) - ground vertices
        for (let i = 0; i < 4; i++) {
            this.vertices.push({
                position: groundCorners[i].clone(),
                type: 'bottom',
                next: (i + 1) % 4,
                prev: (i + 3) % 4,
                linkedVertex: i + 4
            });
        }
        
        // Create top ring (vertices 4-7) - roof corner vertices
        for (let i = 0; i < 4; i++) {
            this.vertices.push({
                position: roofCorners[i].clone(),
                type: 'top',
                next: 4 + ((i + 1) % 4),
                prev: 4 + ((i + 3) % 4),
                linkedVertex: i
            });
        }
        
        // Step 5: Create roofline vertices (vertices 8-9)
        // roof1 is at midpoint between TOP vertices 4 and 5 (above ground corners 0 and 1)
        // roof2 is at midpoint between TOP vertices 6 and 7 (above ground corners 2 and 3)
        // Height is rooflineHeightAGL ABOVE the roof edge
        
        // roof1: midpoint between top corners 4 and 5
        const roof1Base = roofCorners[0].clone().add(roofCorners[1]).multiplyScalar(0.5);
        // roof2: midpoint between top corners 6 and 7
        const roof2Base = roofCorners[2].clone().add(roofCorners[3]).multiplyScalar(0.5);
        
        const roof1Up = getLocalUpVector(roof1Base);
        const roof1Pos = pointAbove(roof1Base, this.rooflineHeightAGL);
        
        this.vertices.push({
            position: roof1Pos,
            type: 'roofline',
            next: 9,
            prev: 9,
            linkedVertex: 9
        });
        
        const roof2Up = getLocalUpVector(roof2Base);
        const roof2Pos = pointAbove(roof2Base, this.rooflineHeightAGL);
        
        this.vertices.push({
            position: roof2Pos,
            type: 'roofline',
            next: 8,
            prev: 8,
            linkedVertex: 8
        });
        
        // Step 6: Define faces
        this.faces = [
            {indices: [3, 2, 1, 0], type: 'wall'},  // Bottom face
            {indices: [4, 5, 1, 0], type: 'wall'},  // Side faces
            {indices: [5, 6, 2, 1], type: 'wall'},
            {indices: [6, 7, 3, 2], type: 'wall'},
            {indices: [7, 4, 0, 3], type: 'wall'},
        ];
        
        // Add roof faces
        this.buildRoofFaces();
        this.computeEdges();
    }
    
    /**
     * Create a cuboid (rectangular prism) from a footprint and height
     * @param {Array} footprint - Array of 4 corner positions [Vector3] forming rectangle on ground
     * @param {number} height - Height of the building in meters (now stored as roofAGL)
     */
    createCuboidFromFootprint(footprint, height) {
        if (footprint.length !== 4) {
            console.error("Footprint must have exactly 4 corners");
            return;
        }
        
        // Convert footprint positions to lat/lon
        this.cornerLatLons = [];
        for (let i = 0; i < 4; i++) {
            const lla = ECEFToLLAVD_radii(footprint[i]);
            this.cornerLatLons.push({
                lat: lla.x,
                lon: lla.y
            });
        }
        
        // Store the height as roofAGL
        this.roofAGL = height;
        this.rooflineHeightAGL = 0; // Start with flat roof
        
        // Recalculate all vertices from terrain
        this.recalculateVerticesFromTerrain();
    }
    
    /**
     * Build roof faces based on roofline height
     * If roofline is close to top vertices altitude, use 1 quad
     * If higher, use 2 triangular faces for a peaked roof
     */
    buildRoofFaces() {
        // Find roof vertices
        const roof1 = this.vertices.find(v => v.type === 'roofline' && this.vertices.indexOf(v) === 8);
        const roof2 = this.vertices.find(v => v.type === 'roofline' && this.vertices.indexOf(v) === 9);
        
        if (!roof1 || !roof2) {
            // No roofline vertices, create flat top
            this.faces.push({indices: [7, 6, 5, 4]});  // Top face (reversed - normal points up/out)
            return;
        }
        
        // Get reference bottom position and calculate heights
        const refBottom = this.vertices[0].position;
        const localUp = getLocalUpVector(refBottom);
        
        // Calculate heights for top corners
        const top4Height = this.vertices[4].position.clone().sub(refBottom).dot(localUp);
        const top5Height = this.vertices[5].position.clone().sub(refBottom).dot(localUp);
        const avgTopHeight = (top4Height + top5Height) / 2;
        
        // Calculate roofline heights
        const roof1BasePos = this.vertices[0].position.clone().add(this.vertices[1].position).multiplyScalar(0.5);
        const roof1Height = roof1.position.clone().sub(roof1BasePos).dot(getLocalUpVector(roof1BasePos));
        
        // Threshold for considering roofline as flat (within 10cm of top)
        const flatThreshold = 0.1;
        const heightDiff = roof1Height - avgTopHeight;
        
        // Remove any existing top/roof faces from this.faces
        this.faces = this.faces.filter(f => {
            const indices = f.indices;
            // Remove if it contains vertices 4,5,6,7,8,9 only (roof-related faces)
            return !indices.every(idx => idx >= 4);
        });
        
        if (heightDiff < flatThreshold) {
            // Flat roof: single quad
            this.faces.push({indices: [7, 6, 5, 4], type: 'roof'});  // Top face (reversed - normal points up/out)
        } else {
            // Determine if gable triangles should be roof color (when ridgelineInset is applied)
            const gableType = this.ridgelineInset !== 0 ? 'roof' : 'wall';
            
            // From gable: vertices 4, 5, roof1 (8)
            this.faces.push({indices: [8, 5, 4], type: gableType});
            // Back gable: vertices 6, 7, roof2 (9)
            this.faces.push({indices: [9, 7, 6], type: gableType});
            // Roof 1: vertices 5, 6, roof2 (9), roof1 (8)
            this.faces.push({indices: [8, 9, 6, 5], type: 'roof'});
            // Roof 2: vertices 7, 4, roof1 (8), roof2 (9)
            this.faces.push({indices: [9, 8, 4, 7], type: 'roof'});
        }
    }
    
    /**
     * Compute edges from faces
     */
    computeEdges() {
        const edgeSet = new Set();
        this.edges = [];
        
        this.faces.forEach(face => {
            const indices = face.indices;
            for (let i = 0; i < indices.length; i++) {
                const v0 = indices[i];
                const v1 = indices[(i + 1) % indices.length];
                // Create a canonical edge key (smaller index first)
                const key = v0 < v1 ? `${v0},${v1}` : `${v1},${v0}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    this.edges.push({v0: Math.min(v0, v1), v1: Math.max(v0, v1)});
                }
            }
        });
    }
    
    /**
     * Build THREE.js mesh from vertices and faces
     */
    buildMesh() {
        // Remove old mesh if it exists
        if (this.solidMesh) {
            this.group.remove(this.solidMesh);
            this.solidMesh.geometry.dispose();
            if (Array.isArray(this.solidMesh.material)) {
                this.solidMesh.material.forEach(m => m.dispose());
            } else {
                this.solidMesh.material.dispose();
            }
        }
        if (this.wireframe) {
            this.group.remove(this.wireframe);
            this.wireframe.geometry.dispose();
            this.wireframe.material.dispose();
        }

        // Rebuild roof faces based on current roofline height
        this.buildRoofFaces();

        // Recompute edges to include roof faces
        this.computeEdges();

        // Calculate local origin (centroid of all vertices) for precision
        // This prevents floating-point precision issues when coordinates are far from world origin
        this.meshLocalOrigin = new Vector3();
        if (this.vertices.length > 0) {
            for (const vertex of this.vertices) {
                this.meshLocalOrigin.add(vertex.position);
            }
            this.meshLocalOrigin.divideScalar(this.vertices.length);
        }
        
        // Helper function to get position with inset and eaves applied
        const getPositionWithModifiers = (idx) => {
            const vertex = this.vertices[idx];
            let pos = vertex.position.clone();
            
            // Apply ridgeline inset for roofline vertices
            if ((idx === 8 || idx === 9) && vertex.type === 'roofline' && this.ridgelineInset !== 0) {
                const roof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
                const roof2EdgePos = this.vertices[6].position.clone().add(this.vertices[7].position).multiplyScalar(0.5);
                
                if (idx === 8) {
                    pos = this.calculateInsetRidgelinePosition(roof1EdgePos, roof2EdgePos)
                        .add(getLocalUpVector(this.calculateInsetRidgelinePosition(roof1EdgePos, roof2EdgePos))
                            .multiplyScalar(this.rooflineHeightAGL));
                } else {
                    pos = this.calculateInsetRidgelinePosition(roof2EdgePos, roof1EdgePos)
                        .add(getLocalUpVector(this.calculateInsetRidgelinePosition(roof2EdgePos, roof1EdgePos))
                            .multiplyScalar(this.rooflineHeightAGL));
                }
            }
            
            // Apply roof eaves for top vertices (4-7) and roofline vertices (8-9)
            if (this.roofEaves !== 0 && (vertex.type === 'top' || vertex.type === 'roofline')) {
                // Calculate building centroid from bottom vertices for lateral direction
                const centroid = new Vector3();
                for (let i = 0; i < 4; i++) {
                    centroid.add(this.vertices[i].position);
                }
                centroid.multiplyScalar(0.25);
                
                const localUp = getLocalUpVector(pos);
                
                // Get the lateral direction (from centroid to this vertex, projected to horizontal plane)
                const toVertex = pos.clone().sub(centroid);
                const verticalComponent = toVertex.dot(localUp);
                const lateralDir = toVertex.clone().sub(localUp.clone().multiplyScalar(verticalComponent));
                
                if (lateralDir.length() > 0.001) {
                    lateralDir.normalize();
                    // Extend position laterally by eaves amount
                    pos.add(lateralDir.multiplyScalar(this.roofEaves));
                }
            }
            
            return pos;
        };
        
        // Create BufferGeometry from vertices and faces
        const geometry = new BufferGeometry();
        
        // Build position buffer
        const positions = [];
        let vertexOffset = this.vertices.length; // Offset for extended roof vertices when eaves != 0
        
        // Add original vertices (without eaves for walls)
        // Use local coordinates (relative to meshLocalOrigin) for GPU precision
        this.vertices.forEach((vertex, idx) => {
            let pos = vertex.position.clone();

            // Apply ridgeline inset for roofline vertices
            if ((idx === 8 || idx === 9) && vertex.type === 'roofline' && this.ridgelineInset !== 0) {
                const roof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
                const roof2EdgePos = this.vertices[6].position.clone().add(this.vertices[7].position).multiplyScalar(0.5);

                if (idx === 8) {
                    pos = this.calculateInsetRidgelinePosition(roof1EdgePos, roof2EdgePos)
                        .add(getLocalUpVector(this.calculateInsetRidgelinePosition(roof1EdgePos, roof2EdgePos))
                            .multiplyScalar(this.rooflineHeightAGL));
                } else {
                    pos = this.calculateInsetRidgelinePosition(roof2EdgePos, roof1EdgePos)
                        .add(getLocalUpVector(this.calculateInsetRidgelinePosition(roof2EdgePos, roof1EdgePos))
                            .multiplyScalar(this.rooflineHeightAGL));
                }
            }

            // Convert to local coordinates
            pos.sub(this.meshLocalOrigin);
            positions.push(pos.x, pos.y, pos.z);
        });

        // If eaves are enabled, add extended roof vertices
        if (this.roofEaves !== 0) {
            // Add extended versions of vertices 4-7 and 8-9
            for (let idx = 4; idx <= 9; idx++) {
                const pos = getPositionWithModifiers(idx);
                // Convert to local coordinates
                pos.sub(this.meshLocalOrigin);
                positions.push(pos.x, pos.y, pos.z);
            }
        }
        
        geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        
        // Triangulate faces and assign to material groups
        // Group 0: walls (bottom, sides, and gable ends)
        // Group 1: roof (only the sloped/flat top surfaces)
        // Group 2: soffit (underside of eaves, roof color at 50%)
        const wallIndices = [];
        const roofIndices = [];
        const soffitIndices = [];
        
        this.faces.forEach(face => {
            let indices = face.indices;
            
            // Determine if this is a roof face based on face type
            const isRoofFace = face.type === 'roof';
            
            // If eaves are enabled and this is a roof face, remap indices to use extended vertices
            if (this.roofEaves !== 0 && isRoofFace) {
                indices = indices.map(idx => {
                    if (idx >= 4 && idx <= 9) {
                        return vertexOffset + (idx - 4);
                    }
                    return idx;
                });
            }
            
            // Simple fan triangulation for convex polygons
            const triangles = [];
            for (let i = 1; i < indices.length - 1; i++) {
                triangles.push(indices[0], indices[i], indices[i + 1]);
            }
            
            if (isRoofFace) {
                roofIndices.push(...triangles);
            } else {
                wallIndices.push(...triangles);
            }
        });
        
        // Add soffit (underside) when eaves are enabled
        if (this.roofEaves !== 0) {
            // Add one horizontal quad covering the four extended roof base corners
            // Winding for visibility from below (upside down poly)
            // Triangulate the quad into two triangles
            soffitIndices.push(vertexOffset + 0, vertexOffset + 1, vertexOffset + 2);
            soffitIndices.push(vertexOffset + 0, vertexOffset + 2, vertexOffset + 3);
        }
        
        // Combine indices: walls first, then roof, then soffit
        const combinedIndices = [...wallIndices, ...roofIndices, ...soffitIndices];
        geometry.setIndex(combinedIndices);
        geometry.computeVertexNormals();
        
        // Add material groups
        let indexOffset = 0;
        if (wallIndices.length > 0) {
            geometry.addGroup(indexOffset, wallIndices.length, 0); // Group 0 for walls
            indexOffset += wallIndices.length;
        }
        if (roofIndices.length > 0) {
            geometry.addGroup(indexOffset, roofIndices.length, 1); // Group 1 for roof
            indexOffset += roofIndices.length;
        }
        if (soffitIndices.length > 0) {
            geometry.addGroup(indexOffset, soffitIndices.length, 2); // Group 2 for soffit
        }
        
        // Create materials: [0] walls, [1] roof, [2] soffit (roof color at 50%)
        const wallMaterial = this.createMaterial(this.wallColor);
        const roofMaterial = this.createMaterial(this.roofColor);
        roofMaterial.side = DoubleSide;
        
        // Create soffit material with roof color darkened by 50%
        const roofColorObj = new Color(this.roofColor);
        const soffitColor = roofColorObj.clone().multiplyScalar(0.5);
        const soffitMaterial = this.createMaterial('#' + soffitColor.getHexString());
        
        this.solidMesh = new Mesh(geometry, [wallMaterial, roofMaterial, soffitMaterial]);
        this.solidMesh.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        // Position mesh at local origin to place it correctly in world space
        this.solidMesh.position.copy(this.meshLocalOrigin);
        this.group.add(this.solidMesh);

        // Create wireframe from edges
        const edgeGeometry = new BufferGeometry();
        const edgePositions = [];
        this.edges.forEach(edge => {
            let v0Idx = edge.v0;
            let v1Idx = edge.v1;
            
            // If eaves are enabled and edge involves roof vertices, use extended positions
            if (this.roofEaves !== 0) {
                // Check if both vertices are roof vertices (4-9)
                const v0IsRoof = v0Idx >= 4 && v0Idx <= 9;
                const v1IsRoof = v1Idx >= 4 && v1Idx <= 9;
                
                if (v0IsRoof && v1IsRoof) {
                    // Both are roof vertices, use extended positions
                    v0Idx = vertexOffset + (v0Idx - 4);
                    v1Idx = vertexOffset + (v1Idx - 4);
                }
            }
            
            // Get positions from the geometry's position attribute
            const v0 = new Vector3(
                positions[v0Idx * 3],
                positions[v0Idx * 3 + 1],
                positions[v0Idx * 3 + 2]
            );
            const v1 = new Vector3(
                positions[v1Idx * 3],
                positions[v1Idx * 3 + 1],
                positions[v1Idx * 3 + 2]
            );
            
            edgePositions.push(v0.x, v0.y, v0.z);
            edgePositions.push(v1.x, v1.y, v1.z);
        });
        
        edgeGeometry.setAttribute('position', new Float32BufferAttribute(edgePositions, 3));
        
        const edgeMaterial = new LineBasicMaterial({
            color: 0x000000,
            linewidth: 2,
            depthTest: true
        });
        
        this.wireframe = new LineSegments(edgeGeometry, edgeMaterial);
        this.wireframe.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        // Position wireframe at local origin to match solidMesh
        this.wireframe.position.copy(this.meshLocalOrigin);
        this.group.add(this.wireframe);
    }
    
    /**
     * Create a material based on current material properties
     * @param {number} color - The color for this material
     */
    createMaterial(color) {
        const materialConfig = {
            color: color,
            transparent: this.materialTransparent,
            opacity: this.materialOpacity,
            depthTest: this.materialDepthTest,
            wireframe: this.materialWireframe,
            depthWrite: true,
            flatShading: true  // Use face normals for flat surfaces
        };
        
        let mat;
        switch (this.materialType) {
            case 'basic':
                mat = new MeshBasicMaterial(materialConfig); break;
            case 'lambert':
                mat = new MeshLambertMaterial(materialConfig); break;
            case 'phong':
                mat = new MeshPhongMaterial(materialConfig); break;
            case 'physical':
                mat = new MeshStandardMaterial(materialConfig); break;
            default:
                mat = new MeshLambertMaterial(materialConfig); break;
        }
        return patchMaterialForLinearOutput(mat);
    }
    
    /**
     * Rebuild the material when properties change
     */
    rebuildMaterial() {
        if (this.solidMesh) {
            const oldMaterial = this.solidMesh.material;
            
            // Create new materials
            const wallMaterial = this.createMaterial(this.wallColor);
            const roofMaterial = this.createMaterial(this.roofColor);
            roofMaterial.side = DoubleSide;
            this.solidMesh.material = [wallMaterial, roofMaterial];
            
            // Dispose old materials
            if (Array.isArray(oldMaterial)) {
                oldMaterial.forEach(m => m.dispose());
            } else {
                oldMaterial.dispose();
            }
            
            setRenderOne(true);
        }
    }
    
    /**
     * Create control points for editing vertices
     */
    createControlPoints() {
        // Remove old control points
        this.controlPoints.forEach(cp => {
            this.group.remove(cp);
            cp.geometry.dispose();
            cp.material.dispose();
        });
        this.controlPoints = [];
        
        // Remove old roof center handle if it exists
        if (this.roofCenterHandle) {
            this.group.remove(this.roofCenterHandle);
            this.roofCenterHandle.geometry.dispose();
            this.roofCenterHandle.material.dispose();
            this.roofCenterHandle = null;
        }
        
        // Remove old roofline handle if it exists
        if (this.rooflineHandle) {
            this.group.remove(this.rooflineHandle);
            this.rooflineHandle.geometry.dispose();
            this.rooflineHandle.material.dispose();
            this.rooflineHandle = null;
        }
        
        // Remove old rotation handles if they exist
        this.rotationHandles.forEach(handle => {
            this.group.remove(handle);
            handle.geometry.dispose();
            handle.material.dispose();
        });
        this.rotationHandles = [];
        
        const geometry = new SphereGeometry(3, 16, 16);  // 3m radius
        const rotationDiscGeometry = new CircleGeometry(6, 32);  // 6m radius flat disc
        
        // Create yellow handles for bottom vertices + invisible rotation discs
        this.vertices.forEach((vertex, idx) => {
            if (vertex.type === 'bottom') {
                // Visible yellow handle
                const material = new MeshLambertMaterial({
                    color: 0xffff00,
                    transparent: true,
                    opacity: 0.9,
                    depthTest: true
                });
                
                const sphere = new Mesh(geometry, material);
                sphere.position.copy(vertex.position);
                sphere.layers.mask = LAYER.MASK_HELPERS;
                sphere.userData.vertexIndex = idx;
                sphere.userData.isBottomHandle = true;
                
                this.group.add(sphere);
                this.controlPoints.push(sphere);
                
                // Get the two neighbor vertices to define the disc plane
                const prevVertex = this.vertices[vertex.prev];
                const nextVertex = this.vertices[vertex.next];
                
                // Calculate plane normal from corner and its two neighbors
                const toPrev = prevVertex.position.clone().sub(vertex.position);
                const toNext = nextVertex.position.clone().sub(vertex.position);
                const planeNormal = new Vector3().crossVectors(toPrev, toNext).normalize();
                
                // Invisible rotation disc around this corner
                const rotationMaterial = new MeshBasicMaterial({
                    color: 0xff0000,
                    transparent: true,
                    opacity: 0.0,  // Completely invisible
                    depthTest: true,
                    side: DoubleSide  // Detect from both sides of the disc
                });
                
                const rotationDisc = new Mesh(rotationDiscGeometry, rotationMaterial);
                rotationDisc.position.copy(vertex.position);
                
                // Orient the disc to align with the plane normal
                rotationDisc.lookAt(vertex.position.clone().add(planeNormal));
                
                rotationDisc.layers.mask = LAYER.MASK_HELPERS;
                rotationDisc.userData.isRotationHandle = true;
                rotationDisc.userData.cornerVertexIndex = idx;  // Link to corner vertex
                
                this.group.add(rotationDisc);
                this.rotationHandles.push(rotationDisc);
            }
        });
        
        // Create one grey handle at the center of the roofline
        const rooflineVertices = this.vertices.filter(v => v.type === 'roofline');
        if (rooflineVertices.length >= 2) {
            // Calculate the center of the roofline (midpoint between roof1 and roof2)
            const roof1 = this.vertices[8];
            const roof2 = this.vertices[9];
            
            if (roof1 && roof2 && roof1.type === 'roofline' && roof2.type === 'roofline') {
                const roofCenter = roof1.position.clone().add(roof2.position).multiplyScalar(0.5);
                
                const roofMaterial = new MeshLambertMaterial({
                    color: 0x888888,  // Grey
                    transparent: true,
                    opacity: 0.9,
                    depthTest: true
                });
                
                this.roofCenterHandle = new Mesh(geometry, roofMaterial);
                this.roofCenterHandle.position.copy(roofCenter);
                this.roofCenterHandle.layers.mask = LAYER.MASK_HELPERS;
                this.roofCenterHandle.userData.isRoofCenter = true;
                
                this.group.add(this.roofCenterHandle);
                this.controlPoints.push(this.roofCenterHandle);
            }
        }
        
        // Create cyan handle for roofline (roof1)
        // rooflineVertices already declared above, reuse it
        if (rooflineVertices.length > 0) {
            // Use roof1 position (vertex 8)
            const roof1 = this.vertices[8];
            if (roof1 && roof1.type === 'roofline') {
                const rooflineMaterial = new MeshLambertMaterial({
                    color: 0x00ffff,  // Cyan
                    transparent: true,
                    opacity: 0.9,
                    depthTest: true
                });
                
                this.rooflineHandle = new Mesh(geometry, rooflineMaterial);
                this.rooflineHandle.position.copy(roof1.position);
                this.rooflineHandle.layers.mask = LAYER.MASK_HELPERS;
                this.rooflineHandle.userData.isRoofline = true;
                this.rooflineHandle.userData.vertexIndex = 8;
                
                this.group.add(this.rooflineHandle);
                this.controlPoints.push(this.rooflineHandle);
            }
        }
        
        // Calculate and store the building centroid at ground level (for rotation)
        const bottomVertices = this.vertices.filter(v => v.type === 'bottom');
        if (bottomVertices.length > 0) {
            this.buildingCentroid = new Vector3();
            bottomVertices.forEach(v => this.buildingCentroid.add(v.position));
            this.buildingCentroid.divideScalar(bottomVertices.length);
        }
    }
    
    /**
     * Update handle scales to maintain constant screen size (size-invariant)
     * Should be called from the render loop to keep handles at 40px regardless of camera distance
     * @param {CNodeView3D} view - The view to use for screen-space scaling
     */
    updateHandleScales(view) {
        if (!this.editMode || !view || !view.pixelsToMeters) {
            return;
        }
        
        const handlePixelSize = 20; // Target size in screen pixels for visible handles
        const rotationDiscPixelSize = 60; // Larger size for invisible rotation discs (easier to hit)
        
        // Update sphere handles (bottom corner handles and roof handles)
        this.controlPoints.forEach(handle => {
            if (handle && handle.geometry && handle.geometry.type === 'SphereGeometry') {
                const scale = view.pixelsToMeters(handle.position, handlePixelSize);
                // SphereGeometry with radius 3m, so scale to get handlePixelSize on screen
                handle.scale.set(scale / 3, scale / 3, scale / 3);
            }
        });
        
        // Update roof center handle (also a sphere)
        if (this.roofCenterHandle) {
            const scale = view.pixelsToMeters(this.roofCenterHandle.position, handlePixelSize);
            this.roofCenterHandle.scale.set(scale / 3, scale / 3, scale / 3);
        }
        
        // Update roofline handle (also a sphere)
        if (this.rooflineHandle) {
            const scale = view.pixelsToMeters(this.rooflineHandle.position, handlePixelSize);
            this.rooflineHandle.scale.set(scale / 3, scale / 3, scale / 3);
        }
        
        // Update rotation disc handles with LARGER size since they're invisible
        // The larger size makes them much easier to interact with for rotation
        this.rotationHandles.forEach(handle => {
            if (handle && handle.geometry && handle.geometry.type === 'CircleGeometry') {
                const scale = view.pixelsToMeters(handle.position, rotationDiscPixelSize);
                // CircleGeometry with radius 6m, so scale to get rotationDiscPixelSize on screen
                handle.scale.set(scale / 6, scale / 6, scale / 6);
            }
        });
    }
    
    /**
     * Set edit mode on/off
     */
    setEditMode(enable) {
        if (this.editMode === enable) return;

        this.editMode = enable;
        
        if (enable) {
            this.createControlPoints();
            Globals.editingBuilding = this;
            CustomManager.showBuildingEditingMenu(100, 100);
        } else {
            this.controlPoints.forEach(cp => {
                this.group.remove(cp);
                cp.geometry.dispose();
                cp.material.dispose();
            });
            this.controlPoints = [];
            
            if (this.roofCenterHandle) {
                this.group.remove(this.roofCenterHandle);
                this.roofCenterHandle.geometry.dispose();
                this.roofCenterHandle.material.dispose();
                this.roofCenterHandle = null;
            }
            
            if (this.rooflineHandle) {
                this.group.remove(this.rooflineHandle);
                this.rooflineHandle.geometry.dispose();
                this.rooflineHandle.material.dispose();
                this.rooflineHandle = null;
            }
            
            this.rotationHandles.forEach(handle => {
                this.group.remove(handle);
                handle.geometry.dispose();
                handle.material.dispose();
            });
            this.rotationHandles = [];
            
            this.hoveredHandle = null;
            this.isRotating = false;
            document.body.style.cursor = 'default';
            
            if (Globals.editingBuilding === this) {
                Globals.editingBuilding = null;
            }
            
            // Only destroy menu if not already being destroyed (prevents recursion)
            if (!window._menuBeingDestroyed && CustomManager.buildingEditMenu) {
                // Save sidebar state before destroying so new menu can use same position
                if (isInLeftSidebar(CustomManager.buildingEditMenu)) {
                    CustomManager.lastBuildingEditMenuSidebar = 'left';
                } else if (isInRightSidebar(CustomManager.buildingEditMenu)) {
                    CustomManager.lastBuildingEditMenuSidebar = 'right';
                } else {
                    CustomManager.lastBuildingEditMenuSidebar = null;
                }
                CustomManager.buildingEditMenu.destroy();
                CustomManager.buildingEditMenu = null;
            }
        }
        
        if (this.editModeController) {
            this.editModeController.setValue(enable);
        }
        
        setRenderOne(true);
    }
    
    /**
     * Capture current building state for undo/redo
     * Returns a deep copy of cornerLatLons and heights
     */
    captureState() {
        return {
            cornerLatLons: this.cornerLatLons.map(c => ({lat: c.lat, lon: c.lon})),
            roofAGL: this.roofAGL,
            rooflineHeightAGL: this.rooflineHeightAGL,
            ridgelineInset: this.ridgelineInset,
            roofEaves: this.roofEaves
        };
    }
    
    /**
     * Restore building state from a snapshot
     * @param {Object} state - State object from captureState()
     */
    restoreState(state) {
        // Restore cornerLatLons and heights
        this.cornerLatLons = state.cornerLatLons.map(c => ({lat: c.lat, lon: c.lon}));
        this.roofAGL = state.roofAGL;
        this.rooflineHeightAGL = state.rooflineHeightAGL;
        this.ridgelineInset = state.ridgelineInset !== undefined ? state.ridgelineInset : 0;
        this.roofEaves = state.roofEaves !== undefined ? state.roofEaves : 0;
        
        // Recalculate all vertices from terrain
        this.recalculateVerticesFromTerrain();
        
        // Rebuild the mesh with new vertex positions
        this.buildMesh();
        
        // Update GUI controllers to reflect restored values
        this.updateGUIControllers();
        
        // Update control points if in edit mode
        if (this.editMode) {
            this.createControlPoints();
        }
        
        setRenderOne(true);
    }
    
    /**
     * Set up event listeners for mouse interaction
     */
    
    /**
     * Create GUI folder for this building
     */
    createGUIFolder() {
        if (!guiMenus.objects) return;
        
        this.guiFolder = guiMenus.objects.addFolder(`Building: ${this.name}`);
        
        this.guiFolder.add(this, 'name').name(t("synthBuilding.name.label")).onChange(() => {
            this.guiFolder.title = `Building: ${this.name}`;
            setRenderOne(true);
        }).onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        const editModeData = {editMode: this.editMode};
        this.guiFolder.add(this, 'visible').name(t("synthBuilding.visible.label")).onChange((value) => {
            this.show(value);
            setRenderOne(true);
        }).onFinishChange(() => { CustomManager.saveGlobalSettings(true); });

        this.editModeController = this.guiFolder.add(editModeData, 'editMode').name(t("synthBuilding.editMode.label")).onChange((value) => {

            if (value && Globals.editingBuilding && Globals.editingBuilding !== this) {
                Globals.editingBuilding.setEditMode(false);
            }
            this.setEditMode(value);
        });
        
        const heightFolder = this.guiFolder.addFolder('Height').close();
        
        const roofEdgeProxy = {
            _displayValue: this.roofAGL,
            get height() { return this._displayValue; },
            set height(v) { this._displayValue = v; }
        };
        this.roofEdgeProxy = roofEdgeProxy;
        this.roofEdgeHeightController = heightFolder.add(roofEdgeProxy, 'height', 0.1, 100, 0.01)
            .name(t("synthBuilding.roofEdgeHeight.label"))
            .setUnitType('small')
            .onChange(() => {
                const siValue = this.roofEdgeHeightController.getSIValue();
                this.updateRoofEdgeHeight(siValue);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); })
            .listen();
        
        const ridgelineHeightProxy = {
            _displayValue: this.roofAGL + this.rooflineHeightAGL,
            get height() { return this._displayValue; },
            set height(v) { this._displayValue = v; }
        };
        this.ridgelineProxy = ridgelineHeightProxy;
        this.ridgelineHeightController = heightFolder.add(ridgelineHeightProxy, 'height', 0.1, 100, 0.01)
            .name(t("synthBuilding.ridgelineHeight.label"))
            .setUnitType('small')
            .onChange(() => {
                const siValue = this.ridgelineHeightController.getSIValue();
                const newRooflineHeight = Math.max(0, siValue - this.roofAGL);
                this.updateRooflineHeight(newRooflineHeight);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); })
            .listen();
        
        const ridgelineInsetProxy = {
            _displayValue: this.ridgelineInset,
            get inset() { return this._displayValue; },
            set inset(v) { this._displayValue = v; }
        };
        this.ridgelineInsetProxy = ridgelineInsetProxy;
        this.ridgelineInsetController = heightFolder.add(ridgelineInsetProxy, 'inset', 0, 20, 0.01)
            .name(t("synthBuilding.ridgelineInset.label"))
            .setUnitType('small')
            .onChange(() => {
                const siValue = this.ridgelineInsetController.getSIValue();
                this.updateRidgelineInset(siValue);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); })
            .listen();
        
        const roofEavesProxy = {
            _displayValue: this.roofEaves,
            get eaves() { return this._displayValue; },
            set eaves(v) { this._displayValue = v; }
        };
        this.roofEavesProxy = roofEavesProxy;
        this.roofEavesController = heightFolder.add(roofEavesProxy, 'eaves', 0, 3, 0.01)
            .name(t("synthBuilding.roofEaves.label"))
            .setUnitType('small')
            .onChange(() => {
                const siValue = this.roofEavesController.getSIValue();
                this.updateRoofEaves(siValue);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); })
            .listen();
        
        this.materialFolder = this.guiFolder.addFolder('Material').close();
        
        this.materialFolder.add(this, 'materialType', ['basic', 'lambert', 'phong', 'physical'])
            .name(t("synthBuilding.type.label"))
            .onChange(() => this.rebuildMaterial())
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        this.materialFolder.addColor(this, 'wallColor')
            .name(t("synthBuilding.wallColor.label"))
            .onChange(() => this.rebuildMaterial())
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        this.materialFolder.addColor(this, 'roofColor')
            .name(t("synthBuilding.roofColor.label"))
            .onChange(() => this.rebuildMaterial())
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        this.materialFolder.add(this, 'materialOpacity', 0, 1, 0.01)
            .name(t("synthBuilding.opacity.label"))
            .onChange(() => this.rebuildMaterial())
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        this.materialFolder.add(this, 'materialTransparent')
            .name(t("synthBuilding.transparent.label"))
            .onChange(() => this.rebuildMaterial())
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        this.materialFolder.add(this, 'materialWireframe')
            .name(t("synthBuilding.wireframe.label"))
            .onChange(() => this.rebuildMaterial());
        
        this.materialFolder.add(this, 'materialDepthTest')
            .name(t("synthBuilding.depthTest.label"))
            .onChange(() => this.rebuildMaterial());
        
        const actions = {
            delete: () => this.deleteBuilding()
        };
        this.guiFolder.add(actions, 'delete').name(t("synthBuilding.deleteBuilding.label"));
        
        this.guiFolder.close();
    }
    
    /**
     * Generate a unique name for a duplicate by adding or incrementing a numeric suffix
     * @returns {string} A unique name that doesn't conflict with existing buildings
     */
    generateUniqueName() {
        // Check if current name ends with "-N" where N is a number
        const match = this.name.match(/^(.+?)-(\d+)$/);
        let baseName, startNumber;
        
        if (match) {
            // Name already has a number suffix, extract base and increment
            baseName = match[1];
            startNumber = parseInt(match[2], 10);
        } else {
            // No number suffix, use full name as base
            baseName = this.name;
            startNumber = 1;
        }
        
        // Collect all existing building names
        const existingNames = new Set();
        Synth3DManager.iterate((id, building) => {
            existingNames.add(building.name);
        });
        
        // Find the first available number
        let counter = startNumber;
        let candidateName;
        do {
            candidateName = `${baseName}-${counter}`;
            counter++;
        } while (existingNames.has(candidateName));
        
        return candidateName;
    }
    
    /**
     * Duplicate this building and return the copy
     * @returns {CNodeSynthBuilding} The duplicated building
     */
    duplicate() {
        // Serialize the current building
        const serialized = this.serialize();
        
        // Exit edit mode on the original
        this.setEditMode(false);
        
        // Generate a unique name with incremental numbering
        const newName = this.generateUniqueName();
        
        // Create building data for the manager (without ID so it gets auto-assigned)
        const buildingData = {
            name: newName,
            cornerLatLons: serialized.cornerLatLons,
            roofAGL: serialized.roofAGL,
            rooflineHeightAGL: serialized.rooflineHeightAGL,
            ridgelineInset: serialized.ridgelineInset,
            roofEaves: serialized.roofEaves,
            material: serialized.material,
            wallColor: serialized.wallColor,
            roofColor: serialized.roofColor,
            opacity: serialized.opacity,
            transparent: serialized.transparent,
            depthTest: serialized.depthTest,
            wireframe: serialized.wireframe
        };
        
        // Use the manager's addBuilding to properly create and register the duplicate
        const duplicate = Synth3DManager.addBuilding(buildingData);
        
        // Add undo action for duplication
        if (UndoManager && duplicate) {
            const duplicateID = duplicate.buildingID;
            
            UndoManager.add({
                undo: () => {
                    // Delete the duplicated building
                    Synth3DManager.removeBuilding(duplicateID);
                },
                redo: () => {
                    // Recreate the duplicated building
                    Synth3DManager.addBuilding(buildingData);
                },
                description: `Duplicate building "${this.name}"`
            });
        }
        
        return duplicate;
    }

    /**
     * Delete this building with confirmation and undo support
     */
    deleteBuilding() {
        if (confirm(`Delete building "${this.name}"?`)) {
            if (UndoManager) {
                const buildingState = this.serialize();
                const buildingID = this.buildingID;

                UndoManager.add({
                    undo: () => {
                        Synth3DManager.addBuilding(buildingState);
                    },
                    redo: () => {
                        Synth3DManager.removeBuilding(buildingID);
                    },
                    description: `Delete building "${this.name}"`
                });
            }

            Synth3DManager.removeBuilding(this.buildingID);
        }
    }

    /**
     * Serialize to save data
     */
    serialize() {
        return {
            id: this.buildingID,
            name: this.name,
            visible: this.visible,
            cornerLatLons: this.cornerLatLons.map(c => ({lat: c.lat, lon: c.lon})),
            roofAGL: this.roofAGL,
            rooflineHeightAGL: this.rooflineHeightAGL,
            ridgelineInset: this.ridgelineInset,
            roofEaves: this.roofEaves,
            material: this.materialType,
            wallColor: this.wallColor,
            roofColor: this.roofColor,
            opacity: this.materialOpacity,
            transparent: this.materialTransparent,
            depthTest: this.materialDepthTest,
            wireframe: this.materialWireframe
        };
    }
    
    /**
     * Deserialize from saved data
     */
    static deserialize(data) {
        // Check if this is the new format (with cornerLatLons) or old format (with vertices)
        if (data.cornerLatLons) {
            // New format - use terrain-relative heights
            return new CNodeSynthBuilding({
                id: data.id,
                name: data.name,
                visible: data.visible,
                cornerLatLons: data.cornerLatLons.map(c => ({lat: c.lat, lon: c.lon})),
                roofAGL: data.roofAGL !== undefined ? data.roofAGL : 4,
                rooflineHeightAGL: data.rooflineHeightAGL !== undefined ? data.rooflineHeightAGL : 0,
                ridgelineInset: data.ridgelineInset !== undefined ? data.ridgelineInset : 0,
                material: data.material,
                wallColor: data.wallColor,
                roofColor: data.roofColor,
                color: data.color,
                opacity: data.opacity,
                transparent: data.transparent,
                depthTest: data.depthTest,
                wireframe: data.wireframe
            });
        } else if (data.vertices) {
            // Old format - convert to new format
            // Extract the 4 bottom corners and calculate roofAGL
            const verticesECEF = data.vertices.map(v => {
                if (v.position) {
                    return {
                        position: LLAToECEF(v.position[0], v.position[1], v.position[2]),
                        type: v.type || 'free'
                    };
                } else {
                    return {
                        position: LLAToECEF(v.lat, v.lon, v.alt),
                        type: 'free'
                    };
                }
            });
            
            // Find bottom and top vertices
            const bottomVerts = verticesECEF.filter(v => v.type === 'bottom').slice(0, 4);
            const topVerts = verticesECEF.filter(v => v.type === 'top').slice(0, 4);
            
            if (bottomVerts.length === 4 && topVerts.length === 4) {
                // Extract cornerLatLons from bottom vertices
                const cornerLatLons = bottomVerts.map(v => {
                    const lla = ECEFToLLAVD_radii(v.position);
                    return {lat: lla.x, lon: lla.y};
                });
                
                // Calculate average height
                let totalHeight = 0;
                for (let i = 0; i < 4; i++) {
                    const diff = topVerts[i].position.clone().sub(bottomVerts[i].position);
                    totalHeight += diff.length();
                }
                const roofAGL = totalHeight / 4;
                
                return new CNodeSynthBuilding({
                    id: data.id,
                    name: data.name,
                    cornerLatLons: cornerLatLons,
                    roofAGL: roofAGL,
                    rooflineHeightAGL: 0,
                    material: data.material,
                    wallColor: data.wallColor,
                    roofColor: data.roofColor,
                    color: data.color,
                    opacity: data.opacity,
                    transparent: data.transparent,
                    depthTest: data.depthTest,
                    wireframe: data.wireframe
                });
            } else {
                // Fallback: use old method if we can't determine structure
                return new CNodeSynthBuilding({
                    id: data.id,
                    name: data.name,
                    vertices: verticesECEF,
                    faces: data.faces,
                    material: data.material,
                    wallColor: data.wallColor,
                    roofColor: data.roofColor,
                    color: data.color,
                    opacity: data.opacity,
                    transparent: data.transparent,
                    depthTest: data.depthTest,
                    wireframe: data.wireframe
                });
            }
        } else {
            console.error("Invalid building data format");
            return null;
        }
    }
    
    /**
     * Dispose of resources
     */
    dispose() {
        // Remove event listeners
        document.removeEventListener('pointerdown', this.onPointerDownBound);
        document.removeEventListener('pointermove', this.onPointerMoveBound);
        document.removeEventListener('pointerup', this.onPointerUpBound);
        
        // Remove control points
        this.controlPoints.forEach(cp => {
            this.group.remove(cp);
            cp.geometry.dispose();
            cp.material.dispose();
        });
        this.controlPoints = [];
        
        // Remove roof center handle
        if (this.roofCenterHandle) {
            this.group.remove(this.roofCenterHandle);
            this.roofCenterHandle.geometry.dispose();
            this.roofCenterHandle.material.dispose();
            this.roofCenterHandle = null;
        }
        
        // Remove roofline handle
        if (this.rooflineHandle) {
            this.group.remove(this.rooflineHandle);
            this.rooflineHandle.geometry.dispose();
            this.rooflineHandle.material.dispose();
            this.rooflineHandle = null;
        }
        
        // Remove rotation handles
        this.rotationHandles.forEach(handle => {
            this.group.remove(handle);
            handle.geometry.dispose();
            handle.material.dispose();
        });
        this.rotationHandles = [];
        
        // Remove meshes
        if (this.solidMesh) {
            this.group.remove(this.solidMesh);
            this.solidMesh.geometry.dispose();
            // Handle both single material and material array
            if (Array.isArray(this.solidMesh.material)) {
                this.solidMesh.material.forEach(m => m.dispose());
            } else {
                this.solidMesh.material.dispose();
            }
            this.solidMesh = null;
        }
        if (this.wireframe) {
            this.group.remove(this.wireframe);
            this.wireframe.geometry.dispose();
            this.wireframe.material.dispose();
            this.wireframe = null;
        }
        
        // Remove GUI folder
        if (this.guiFolder) {
            this.guiFolder.destroy();
            this.guiFolder = null;
        }

        super.dispose();
    }
}

// Install pointer event / handle-interaction prototype methods.
Object.assign(CNodeSynthBuilding.prototype, eventMethods);