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
import {EUSToLLA, LLAToEUS} from "../LLA-ECEF-ENU";
import {makeMouseRay} from "../mouseMoveView";
import {ViewMan} from "../CViewManager";
import {CustomManager, Globals, guiMenus, setRenderOne, Synth3DManager, UndoManager} from "../Globals";
import {mouseInViewOnly} from "../ViewUtils";
import {getPointBelow, pointAbove} from "../threeExt";
import {EventManager} from "../CEventManager";
import {saveSettings} from "../SettingsManager";

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
                const lla = EUSToLLA(this.vertices[i].position);
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
            const localUp = getLocalUpVector(currentPos);
            
            // Lift point high above terrain, then drop to find ground
            const highPoint = currentPos.clone().add(localUp.clone().multiplyScalar(10000));
            const terrainPoint = getPointBelow(highPoint);
            
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
            const highPoint = LLAToEUS(lat, lon, 10000); // Start at high altitude
            const groundPoint = getPointBelow(highPoint);
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
        const roof1Up = getLocalUpVector(roof1Base);
        const roof1Pos = pointAbove(roof1Base, this.rooflineHeightAGL);
        
        this.vertices.push({
            position: roof1Pos,
            type: 'roofline',
            next: 9,
            prev: 9,
            linkedVertex: 9
        });
        
        // roof2: midpoint between top corners 6 and 7
        const roof2Base = roofCorners[2].clone().add(roofCorners[3]).multiplyScalar(0.5);
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
            const lla = EUSToLLA(footprint[i]);
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
            // From gable: vertices 4, 5, roof1 (8)
            this.faces.push({indices: [8, 5, 4], type: 'wall'});
            // Back gable: vertices 6, 7, roof2 (9)
            this.faces.push({indices: [9, 7, 6], type: 'wall'});
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
        
        // Create BufferGeometry from vertices and faces
        const geometry = new BufferGeometry();
        
        // Build position buffer first
        const positions = [];
        this.vertices.forEach(vertex => {
            const v = vertex.position;
            positions.push(v.x, v.y, v.z);
        });
        geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        
        // Triangulate faces and assign to material groups
        // Group 0: walls (bottom, sides, and gable ends)
        // Group 1: roof (only the sloped/flat top surfaces)
        const wallIndices = [];
        const roofIndices = [];
        
        this.faces.forEach(face => {
            const indices = face.indices;
            
            // Determine if this is a roof face based on face type
            const isRoofFace = face.type === 'roof';
            
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
        
        // Combine indices: walls first, then roof
        const combinedIndices = [...wallIndices, ...roofIndices];
        geometry.setIndex(combinedIndices);
        geometry.computeVertexNormals();
        
        // Add material groups
        if (wallIndices.length > 0) {
            geometry.addGroup(0, wallIndices.length, 0); // Group 0 for walls
        }
        if (roofIndices.length > 0) {
            geometry.addGroup(wallIndices.length, roofIndices.length, 1); // Group 1 for roof
        }
        
        // Create materials: [0] walls, [1] roof
        const wallMaterial = this.createMaterial(this.wallColor);
        const roofMaterial = this.createMaterial(this.roofColor);
        
        this.solidMesh = new Mesh(geometry, [wallMaterial, roofMaterial]);
        this.solidMesh.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        this.group.add(this.solidMesh);
        
        // Create wireframe from edges
        const edgeGeometry = new BufferGeometry();
        const edgePositions = [];
        this.edges.forEach(edge => {
            const v0 = this.vertices[edge.v0].position;
            const v1 = this.vertices[edge.v1].position;
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
        
        switch (this.materialType) {
            case 'basic':
                return new MeshBasicMaterial(materialConfig);
            case 'lambert':
                return new MeshLambertMaterial(materialConfig);
            case 'phong':
                return new MeshPhongMaterial(materialConfig);
            case 'physical':
                return new MeshStandardMaterial(materialConfig);
            default:
                return new MeshLambertMaterial(materialConfig);
        }
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
        this.editMode = enable;
        
        if (enable) {
            this.createControlPoints();
            Globals.editingBuilding = this;
            
            // Show GUI folder and expand it
            if (this.guiFolder) {
                this.guiFolder.show();
                this.guiFolder.open();
            }
            
            // Keep material folder visible but closed initially
            if (this.materialFolder) {
                this.materialFolder.close();
            }
            
            // Show the standalone edit menu at a default position (center-right of screen)
            const defaultX = window.innerWidth * 0.65;
            const defaultY = window.innerHeight * 0.3;
            CustomManager.showBuildingEditingMenu(defaultX, defaultY, null);
        } else {
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
            
            // Reset cursor and state
            this.hoveredHandle = null;
            this.isRotating = false;
            document.body.style.cursor = 'default';
            
            if (Globals.editingBuilding === this) {
                Globals.editingBuilding = null;
            }
            
            // Close the standalone edit menu if it exists
            if (CustomManager.buildingEditMenu) {
                CustomManager.buildingEditMenu.destroy();
                CustomManager.buildingEditMenu = null;
            }
            
            // Hide GUI folder
            if (this.guiFolder) {
                this.guiFolder.hide();
            }
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
            rooflineHeightAGL: this.rooflineHeightAGL
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
        
        // Recalculate all vertices from terrain
        this.recalculateVerticesFromTerrain();
        
        // Rebuild the mesh with new vertex positions
        this.buildMesh();
        
        // Update control points if in edit mode
        if (this.editMode) {
            this.createControlPoints();
        }
        
        setRenderOne(true);
    }
    
    /**
     * Set up event listeners for mouse interaction
     */
    setupEventListeners() {
        this.onPointerDownBound = (e) => this.onPointerDown(e);
        this.onPointerMoveBound = (e) => this.onPointerMove(e);
        this.onPointerUpBound = (e) => this.onPointerUp(e);
        
        document.addEventListener('pointerdown', this.onPointerDownBound);
        document.addEventListener('pointermove', this.onPointerMoveBound);
        document.addEventListener('pointerup', this.onPointerUpBound);
        
        // Listen for elevation changes (flat elevation toggle, resolution changes, etc.)
        EventManager.addEventListener("elevationChanged", () => {
            this.recalculateVerticesFromTerrain();
            this.buildMesh();
            setRenderOne();
        });
    }
    
    /**
     * Check if mouse is hovering over a handle and update cursor
     */
    checkHandleHover(event) {
        const view = ViewMan.get("mainView");
        if (!view || !mouseInViewOnly(view, event.clientX, event.clientY)) {
            // Not in view, reset cursor
            if (this.hoveredHandle) {
                document.body.style.cursor = 'default';
                this.hoveredHandle = null;
            }
            return;
        }
        
        const mouseYUp = view.heightPx - (event.clientY - view.topPx);
        const mouseRay = makeMouseRay(view, event.clientX, mouseYUp);
        
        this.raycaster.setFromCamera(mouseRay, view.camera);
        
        // Check intersection with actual handles (control points + roof center handle + roofline handle)
        const allHandles = [...this.controlPoints];
        if (this.roofCenterHandle) {
            allHandles.push(this.roofCenterHandle);
        }
        if (this.rooflineHandle) {
            allHandles.push(this.rooflineHandle);
        }
        
        const intersects = this.raycaster.intersectObjects(allHandles, false);
        
        // Check intersection with rotation handles
        const rotationIntersects = this.rotationHandles.length > 0 
            ? this.raycaster.intersectObjects(this.rotationHandles, false) 
            : [];
        
        // If both sphere handle and disk intersect, prioritize the closest one to camera
        if (intersects.length > 0 && rotationIntersects.length > 0) {
            // Compare distances - use the closest
            if (intersects[0].distance < rotationIntersects[0].distance) {
                // Handle is closer - use it
                if (!this.hoveredHandle || this.hoveredHandle !== intersects[0].object) {
                    if (intersects[0].object.userData.isRoofCenter || intersects[0].object.userData.isRoofline) {
                        document.body.style.cursor = 'row-resize';
                    } else {
                        document.body.style.cursor = 'move';
                    }
                    this.hoveredHandle = intersects[0].object;
                }
            } else {
                // Rotation handle is closer - use it
                const rotationHandle = rotationIntersects[0].object;
                const intersectionPoint = rotationIntersects[0].point;
                const cornerVertexIndex = rotationHandle.userData.cornerVertexIndex;
                
                if (this.isOutsideHandleInPlane(cornerVertexIndex, intersectionPoint)) {
                    if (!this.hoveredHandle || !this.hoveredHandle.userData || !this.hoveredHandle.userData.isRotationRing) {
                        document.body.style.cursor = 'grab';
                        this.hoveredHandle = {userData: {isRotationRing: true, cornerVertexIndex: cornerVertexIndex}};
                    }
                } else {
                    this.checkBuildingMeshHover();
                }
            }
        } else if (intersects.length > 0) {
            // Only handle intersect
            if (!this.hoveredHandle || this.hoveredHandle !== intersects[0].object) {
                if (intersects[0].object.userData.isRoofCenter || intersects[0].object.userData.isRoofline) {
                    document.body.style.cursor = 'row-resize';
                } else {
                    document.body.style.cursor = 'move';
                }
                this.hoveredHandle = intersects[0].object;
            }
        } else if (rotationIntersects.length > 0) {
            // Only rotation handle intersect
            const rotationHandle = rotationIntersects[0].object;
            const intersectionPoint = rotationIntersects[0].point;
            const cornerVertexIndex = rotationHandle.userData.cornerVertexIndex;
            
            if (this.isOutsideHandleInPlane(cornerVertexIndex, intersectionPoint)) {
                if (!this.hoveredHandle || !this.hoveredHandle.userData || !this.hoveredHandle.userData.isRotationRing) {
                    document.body.style.cursor = 'grab';
                    this.hoveredHandle = {userData: {isRotationRing: true, cornerVertexIndex: cornerVertexIndex}};
                }
            } else {
                this.checkBuildingMeshHover();
            }
        } else {
            // No intersections - check building mesh
            this.checkBuildingMeshHover();
        }
    }
    
    /**
     * Project intersection point onto the plane defined by corner and its neighbors,
     * then check if projected distance exceeds the visible handle radius
     * AND if the intersection is on the outward side (away from building center)
     */
    isOutsideHandleInPlane(cornerVertexIndex, intersectionPoint) {
        const cornerVertex = this.vertices[cornerVertexIndex];
        const cornerPosition = cornerVertex.position;
        
        // Get the two neighbor vertices (prev and next in the ring)
        const prevVertex = this.vertices[cornerVertex.prev];
        const nextVertex = this.vertices[cornerVertex.next];
        
        // Define a plane using corner and its two neighbors
        // Calculate two edge vectors
        const toPrev = prevVertex.position.clone().sub(cornerPosition);
        const toNext = nextVertex.position.clone().sub(cornerPosition);
        
        // Plane normal is the cross product of the two edges
        const planeNormal = new Vector3().crossVectors(toPrev, toNext).normalize();
        
        // Project intersection point onto this plane
        const toIntersection = intersectionPoint.clone().sub(cornerPosition);
        const distanceToPlane = toIntersection.dot(planeNormal);
        const projectedPoint = intersectionPoint.clone().sub(planeNormal.multiplyScalar(distanceToPlane));
        
        // Calculate distance from corner to projected point
        const projectedDistance = projectedPoint.distanceTo(cornerPosition);
        
        // Check if projected distance exceeds visible handle radius (20 pixels, scaled dynamically)
        // The visible sphere handle is 3m base radius, scaled to 20px screen size
        const view = ViewMan.get("mainView");
        if (view && view.pixelsToMeters) {
            const handlePixelSize = 20; // Must match updateHandleScales()
            const scaledHandleRadius = view.pixelsToMeters(cornerPosition, handlePixelSize);
            
            if (projectedDistance <= scaledHandleRadius) {
                return false;
            }
        } else {
            // Fallback to fixed 3m if view not available
            if (projectedDistance <= 3) {
                return false;
            }
        }
        
        // Additional check: only detect rotation if clicking on the "outward" side
        // X = projectedPoint (collision point on disk)
        // A = cornerPosition (center of disk)
        // F = buildingCentroid (center of floor)
        // Only allow rotation if F->A is within 45° of A->X
        if (this.buildingCentroid) {
            const fromCenterToCorner = cornerPosition.clone().sub(this.buildingCentroid).normalize(); // F->A
            const fromCornerToClick = projectedPoint.clone().sub(cornerPosition).normalize(); // A->X
            
            // Dot product > cos(45°) means angle < 45°
            // cos(45°) = √2/2 ≈ 0.707
            const dotProduct = fromCenterToCorner.dot(fromCornerToClick);
            if (dotProduct <= Math.SQRT1_2) { // Math.SQRT1_2 = 1/√2 = cos(45°)
                return false; // Click is not aligned enough with outward direction
            }
        }
        
        return true;
    }
    
    /**
     * Check if hovering over the building mesh for translation
     */
    checkBuildingMeshHover() {
        if (this.solidMesh) {
            // Temporarily change raycaster layer mask to include mesh layers
            const savedMask = this.raycaster.layers.mask;
            this.raycaster.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
            
            const intersects = this.raycaster.intersectObject(this.solidMesh, false);
            
            // Restore raycaster layer mask
            this.raycaster.layers.mask = savedMask;
            
            if (intersects.length > 0) {
                // Hovering over building mesh - show move cursor
                if (!this.hoveredHandle || !this.hoveredHandle.userData || !this.hoveredHandle.userData.isBuildingMesh) {
                    document.body.style.cursor = 'move';
                    this.hoveredHandle = {userData: {isBuildingMesh: true}};
                }
            } else {
                // Not hovering over anything
                if (this.hoveredHandle) {
                    document.body.style.cursor = 'default';
                    this.hoveredHandle = null;
                }
            }
        } else {
            // Not hovering over anything
            if (this.hoveredHandle) {
                document.body.style.cursor = 'default';
                this.hoveredHandle = null;
            }
        }
    }
    
    /**
     * Handle pointer down - start dragging a control point
     */
    onPointerDown(event) {
        if (!this.editMode) {
            return;
        }
        if (event.button !== 0) return; // Only left mouse button
        
        // Check if clicking on a GUI element - menus should have priority
        let target = event.target;
        while (target) {
            if (target.classList && target.classList.contains('lil-gui')) {
                return; // Click is on GUI, don't handle it
            }
            target = target.parentElement;
        }
        
        const view = ViewMan.get("mainView");
        if (!view || !mouseInViewOnly(view, event.clientX, event.clientY)) {
            return;
        }
        
        const mouseYUp = view.heightPx - (event.clientY - view.topPx);
        const mouseRay = makeMouseRay(view, event.clientX, mouseYUp);
        
        this.raycaster.setFromCamera(mouseRay, view.camera);
        
        // Capture state before any drag operation begins (for undo/redo)
        this.stateBeforeDrag = this.captureState();
        
        // Check for Alt/Option key - if pressed, duplicate the building and switch to editing the copy
        // Only duplicate if we haven't already done so for this event (prevent infinite recursion)
        if (event.altKey && !event._duplicatedBuilding) {
            const duplicate = this.duplicate();
            if (duplicate) {
                // Enter edit mode on the duplicate
                duplicate.setEditMode(true);
                
                // Mark the event as having triggered duplication to prevent recursion
                event._duplicatedBuilding = true;
                
                // Continue with the drag/rotate logic on the duplicate
                // by re-triggering the event handling on the duplicate
                duplicate.onPointerDown(event);
            }
            return;
        }
        
        // Check intersection with actual handles (control points + roof center handle + roofline handle)
        const allHandles = [...this.controlPoints];
        if (this.roofCenterHandle) {
            allHandles.push(this.roofCenterHandle);
        }
        if (this.rooflineHandle) {
            allHandles.push(this.rooflineHandle);
        }
        const intersects = this.raycaster.intersectObjects(allHandles, false);
        
        // Check for rotation ring intersections
        const rotationIntersects = this.rotationHandles.length > 0 
            ? this.raycaster.intersectObjects(this.rotationHandles, false)
            : [];

        // If both sphere handle and disk intersect, prioritize the closest one to camera
        let useHandle = false;
        let useRotation = false;
        
        if (intersects.length > 0 && rotationIntersects.length > 0) {
            // Compare distances - use the closest
            if (intersects[0].distance < rotationIntersects[0].distance) {
                useHandle = true;
            } else {
                useRotation = true;
            }
        } else if (intersects.length > 0) {
            useHandle = true;
        } else if (rotationIntersects.length > 0) {
            useRotation = true;
        }

        if (useHandle) {
            // Hit an actual handle
            this.draggingPoint = intersects[0].object;
            this.draggingVertexIndex = this.draggingPoint.userData.vertexIndex;
            this.isDragging = true;
            this.isRotating = false;
            

            // Store the initial position of the handle for relative dragging
            this.dragInitialHandlePosition = this.draggingPoint.position.clone();
            
            // Store the local up vector at this position
            this.dragLocalUp = getLocalUpVector(this.draggingPoint.position);
            
            // Calculate and store the initial intersection point on the appropriate plane
            const isRoofCenter = this.draggingPoint.userData.isRoofCenter;
            const isRoofline = this.draggingPoint.userData.isRoofline;
            const draggedVertex = (isRoofCenter || isRoofline) ? null : this.vertices[this.draggingVertexIndex];
            const isTopVertex = !isRoofCenter && !isRoofline && (draggedVertex && draggedVertex.type === 'top');
            
            let plane = new Plane();
            if (isRoofCenter || isTopVertex || isRoofline) {
                // Create a vertical plane facing the camera for height adjustment
                const cameraPos = view.camera.position;
                const toCamera = cameraPos.clone().sub(this.draggingPoint.position).normalize();
                const tangent = new Vector3().crossVectors(this.dragLocalUp, toCamera).normalize();
                const planeNormal = new Vector3().crossVectors(tangent, this.dragLocalUp).normalize();
                plane.setFromNormalAndCoplanarPoint(planeNormal, this.draggingPoint.position);
            } else {
                // Create a horizontal plane for bottom vertices
                plane.setFromNormalAndCoplanarPoint(this.dragLocalUp, this.draggingPoint.position);
            }
            
            // Store the initial intersection point
            this.dragInitialIntersection = new Vector3();
            this.raycaster.ray.intersectPlane(plane, this.dragInitialIntersection);
            
            // Disable camera controls while dragging
            if (view.controls) {
                view.controls.enabled = false;
            }
            
            event.stopPropagation();
            event.preventDefault();
            return; // Don't check rotation rings
        }
        
        // Check for rotation ring click
        if (useRotation) {
            
            if (rotationIntersects.length > 0) {
                // Get the closest rotation ring
                const rotationHandle = rotationIntersects[0].object;
                const intersectionPoint = rotationIntersects[0].point;
                
                if (rotationHandle.userData.cornerVertexIndex !== undefined && this.buildingCentroid) {
                    // Corner rotation ring (for building rotation)
                    const cornerVertexIndex = rotationHandle.userData.cornerVertexIndex;
                    
                    // Project intersection onto plane and check if outside handle radius
                    if (this.isOutsideHandleInPlane(cornerVertexIndex, intersectionPoint)) {
                        this.isRotating = true;
                        this.isDragging = false;
                        // Start from the previously saved rotation (absolute angle from initial orientation)
                        this.totalRotationThisSession = Globals.settings?.lastBuildingRotation || 0;
                        
                        // Calculate initial angle in ground plane around building centroid
                        const localUp = getLocalUpVector(this.buildingCentroid);
                        const toIntersection = intersectionPoint.clone().sub(this.buildingCentroid);
                        const verticalComponent = toIntersection.dot(localUp);
                        const groundPoint = intersectionPoint.clone().sub(localUp.clone().multiplyScalar(verticalComponent));
                        
                        const toPoint = groundPoint.clone().sub(this.buildingCentroid);
                        // Use a reference axis perpendicular to localUp for angle calculation
                        const referenceAxis = new Vector3(1, 0, 0);
                        if (Math.abs(localUp.dot(referenceAxis)) > 0.9) {
                            referenceAxis.set(0, 1, 0); // Use Y if X is parallel to up
                        }
                        const tangent = new Vector3().crossVectors(localUp, referenceAxis).normalize();
                        this.rotationStartAngle = Math.atan2(
                            toPoint.dot(new Vector3().crossVectors(localUp, tangent)),
                            toPoint.dot(tangent)
                        );
                        
                        document.body.style.cursor = 'grabbing';
                        
                        // Disable camera controls while rotating
                        if (view.controls) {
                            view.controls.enabled = false;
                        }
                        
                        event.stopPropagation();
                        event.preventDefault();
                        return; // Don't check building mesh
                    }
                }
            }
        }
        
        // THIRD: Check for click on building mesh (for building translation)
        if (this.solidMesh) {
            // Temporarily change raycaster layer mask to include mesh layers
            const savedMask = this.raycaster.layers.mask;
            this.raycaster.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
            
            const meshIntersects = this.raycaster.intersectObject(this.solidMesh, false);
            
            // Restore raycaster layer mask
            this.raycaster.layers.mask = savedMask;
            
            if (meshIntersects.length > 0) {
                this.isDragging = true;
                this.isRotating = false;
                this.draggingPoint = {userData: {isBuildingMesh: true}};
                this.draggingVertexIndex = -1;
                
                // Store the initial intersection point for translation
                this.dragStartPoint = meshIntersects[0].point.clone();
                
                document.body.style.cursor = 'move';
                
                // Disable camera controls while translating
                if (view.controls) {
                    view.controls.enabled = false;
                }
                
                event.stopPropagation();
                event.preventDefault();
            }
        }
    }
    
    /**
     * Handle rotation while dragging
     */
    handleRotation(event) {
        const view = ViewMan.get("mainView");
        if (!view || !this.buildingCentroid) return;
        
        const mouseYUp = view.heightPx - (event.clientY - view.topPx);
        const mouseRay = makeMouseRay(view, event.clientX, mouseYUp);
        
        this.raycaster.setFromCamera(mouseRay, view.camera);
        
        // Create a ground plane at the building centroid
        const localUp = getLocalUpVector(this.buildingCentroid);
        const groundPlane = new Plane();
        groundPlane.setFromNormalAndCoplanarPoint(localUp, this.buildingCentroid);
        
        // Intersect ray with ground plane
        const intersectionPoint = new Vector3();
        if (this.raycaster.ray.intersectPlane(groundPlane, intersectionPoint)) {
            // Calculate current angle
            const toPoint = intersectionPoint.clone().sub(this.buildingCentroid);
            
            // Use same reference axis as in onPointerDown
            const referenceAxis = new Vector3(1, 0, 0);
            if (Math.abs(localUp.dot(referenceAxis)) > 0.9) {
                referenceAxis.set(0, 1, 0);
            }
            const tangent = new Vector3().crossVectors(localUp, referenceAxis).normalize();
            const currentAngle = Math.atan2(
                toPoint.dot(new Vector3().crossVectors(localUp, tangent)),
                toPoint.dot(tangent)
            );
            
            // Calculate rotation delta
            const rotationDelta = currentAngle - this.rotationStartAngle;
            
            // Accumulate total rotation for this session
            this.totalRotationThisSession += rotationDelta;
            
            // Rotate all vertices around the centroid
            this.vertices.forEach(vertex => {
                // Get vector from centroid to vertex
                const toVertex = vertex.position.clone().sub(this.buildingCentroid);
                
                // Decompose into vertical and horizontal components
                const verticalComponent = toVertex.dot(localUp);
                const horizontalVector = toVertex.clone().sub(localUp.clone().multiplyScalar(verticalComponent));
                
                // Rotate horizontal component around localUp axis
                const rotatedHorizontal = horizontalVector.clone().applyAxisAngle(localUp, rotationDelta);
                
                // Reconstruct position
                vertex.position.copy(
                    this.buildingCentroid.clone()
                        .add(rotatedHorizontal)
                        .add(localUp.clone().multiplyScalar(verticalComponent))
                );
            });
            
            // Update the start angle for next frame (incremental rotation)
            this.rotationStartAngle = currentAngle;
            
            // Snap ground vertices to terrain after rotation
            this.snapGroundVerticesToTerrain();
            
            // Rebuild mesh
            this.buildMesh();
            
            // Sync parameters from the modified vertices
            this.syncParametersFromVertices();
            
            // Recreate control points
            this.createControlPoints();
            
            setRenderOne(true);
        }
        
        event.stopPropagation();
        event.preventDefault();
    }
    
    /**
     * Handle pointer move - drag the control point, rotate, or handle hover
     */
    onPointerMove(event) {
        if (!this.editMode) return;
        
        // Handle rotation
        if (this.isRotating) {
            this.handleRotation(event);
            return;
        }
        
        // Handle hover detection when not dragging
        if (!this.isDragging) {
            this.checkHandleHover(event);
            return;
        }
        
        if (!this.draggingPoint) return;
        
        const view = ViewMan.get("mainView");
        if (!view) return;
        
        const mouseYUp = view.heightPx - (event.clientY - view.topPx);
        const mouseRay = makeMouseRay(view, event.clientX, mouseYUp);
        
        this.raycaster.setFromCamera(mouseRay, view.camera);
        
        // Check if dragging the roof center handle, roofline handle, or building mesh
        const isRoofCenter = this.draggingPoint.userData.isRoofCenter;
        const isRoofline = this.draggingPoint.userData.isRoofline;
        const isBuildingMesh = this.draggingPoint.userData.isBuildingMesh;
        
        // Get the vertex being dragged (if not roof center, roofline, or building mesh)
        const draggedVertex = (isRoofCenter || isRoofline || isBuildingMesh) ? null : this.vertices[this.draggingVertexIndex];
        const isTopVertex = !isRoofCenter && !isRoofline && !isBuildingMesh && (draggedVertex && draggedVertex.type === 'top');
        
        let plane = new Plane();
        
        if (isBuildingMesh) {
            // For building mesh, create a horizontal plane for moving entire building
            const localUp = getLocalUpVector(this.buildingCentroid);
            plane.setFromNormalAndCoplanarPoint(localUp, this.dragStartPoint);
        } else if (isRoofCenter || isTopVertex || isRoofline) {
            // For roof center handle and top vertices, create a vertical plane facing the camera
            // This allows height adjustment while keeping horizontal position locked
            // Use the INITIAL handle position to create the plane for consistent relative dragging
            const cameraPos = view.camera.position;
            const toCamera = cameraPos.clone().sub(this.dragInitialHandlePosition).normalize();
            
            // Make plane perpendicular to camera view but parallel to localUp
            const tangent = new Vector3().crossVectors(this.dragLocalUp, toCamera).normalize();
            const planeNormal = new Vector3().crossVectors(tangent, this.dragLocalUp).normalize();
            
            plane.setFromNormalAndCoplanarPoint(planeNormal, this.dragInitialHandlePosition);
        } else {
            // For bottom vertices, create a horizontal plane (perpendicular to localUp)
            // Use the INITIAL handle position to create the plane for consistent relative dragging
            plane.setFromNormalAndCoplanarPoint(
                this.dragLocalUp,
                this.dragInitialHandlePosition
            );
        }
        
        // Intersect ray with plane to get current mouse position
        const currentIntersection = new Vector3();
        if (this.raycaster.ray.intersectPlane(plane, currentIntersection)) {
            let newPosition;
            
            if (isBuildingMesh) {
                // For building mesh: use incremental movement (already working correctly)
                // The plane is created at dragStartPoint and updated each frame
                newPosition = currentIntersection.clone();
                const displacement = newPosition.clone().sub(this.dragStartPoint);
                
                // Move all vertices by the same displacement
                this.vertices.forEach(vertex => {
                    vertex.position.add(displacement.clone());
                });
                
                // Update building centroid
                this.buildingCentroid.add(displacement);
                
                // Update drag start point for next frame (incremental translation)
                this.dragStartPoint.copy(newPosition);
                
                // Snap ground vertices to terrain after translation
                this.snapGroundVerticesToTerrain();
                
            } else {
                // For vertex/roof/roofline dragging: use relative displacement from initial click point
                const displacement = currentIntersection.clone().sub(this.dragInitialIntersection);
                newPosition = this.dragInitialHandlePosition.clone().add(displacement);
                
                if (isRoofline) {
                    // For roofline handle, calculate height ABOVE the roof edge (top vertices)
                    // Get the roof edge position (midpoint between top vertices 4 and 5)
                    const top4 = this.vertices[4];
                    const top5 = this.vertices[5];
                    const roofEdgePos = top4.position.clone().add(top5.position).multiplyScalar(0.5);
                    const localUp = getLocalUpVector(roofEdgePos);
                    
                    // Calculate what the new height ABOVE THE ROOF EDGE would be
                    const toRoofline = newPosition.clone().sub(roofEdgePos);
                    let newHeightAboveRoof = toRoofline.dot(localUp);
                    
                    // Don't let roofline go below the roof edge (minimum 0)
                    if (newHeightAboveRoof < 0) {
                        newHeightAboveRoof = 0;
                    }
                    
                    // Apply this HEIGHT ABOVE ROOF to both roofline vertices (roof1 and roof2)
                    const roof1 = this.vertices[8];
                    const roof2 = this.vertices[9];
                    
                    if (roof1 && roof1.type === 'roofline') {
                        // roof1 is at midpoint between top vertices 4 and 5
                        const roof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
                        const upVector1 = getLocalUpVector(roof1EdgePos);
                        roof1.position.copy(roof1EdgePos.clone().add(upVector1.multiplyScalar(newHeightAboveRoof)));
                    }
                    
                    if (roof2 && roof2.type === 'roofline') {
                        // roof2 is at midpoint between top vertices 6 and 7
                        const roof2EdgePos = this.vertices[6].position.clone().add(this.vertices[7].position).multiplyScalar(0.5);
                        const upVector2 = getLocalUpVector(roof2EdgePos);
                        roof2.position.copy(roof2EdgePos.clone().add(upVector2.multiplyScalar(newHeightAboveRoof)));
                    }
                    
                } else if (isRoofCenter) {
                // For roof center handle, calculate the HEIGHT CHANGE from initial drag position
                // This maintains the height difference between roofline and top vertices
                
                // Get a reference bottom vertex
                const referenceBottomVertex = this.vertices.find(v => v.type === 'bottom');
                const bottomPos = referenceBottomVertex.position;
                const localUp = getLocalUpVector(bottomPos);
                
                // Calculate the initial height (where drag started)
                const toInitial = this.dragInitialHandlePosition.clone().sub(bottomPos);
                const initialHeight = toInitial.dot(localUp);
                
                // Calculate the new height (where handle is now)
                const toNew = newPosition.clone().sub(bottomPos);
                const newHeight = toNew.dot(localUp);
                
                // Calculate the HEIGHT CHANGE (delta) - only the movement from initial position
                const heightDelta = newHeight - initialHeight;
                
                // Minimum height of 0.01 meter for top vertices
                const minHeight = 0.01;
                
                // Get all top vertices
                const topVertices = this.vertices.filter(v => v.type === 'top');
                
                // Apply this HEIGHT CHANGE to all top vertices
                topVertices.forEach(topVertex => {
                    const linkedBottom = this.vertices[topVertex.linkedVertex];
                    const upVector = getLocalUpVector(linkedBottom.position);
                    
                    // Get current height
                    const currentHeight = topVertex.position.clone().sub(linkedBottom.position).dot(upVector);
                    let adjustedHeight = currentHeight + heightDelta;
                    
                    // Don't go below minimum
                    if (adjustedHeight < minHeight) {
                        adjustedHeight = minHeight;
                    }
                    
                    // Position this top vertex directly above its bottom at adjusted height
                    topVertex.position.copy(linkedBottom.position.clone().add(upVector.multiplyScalar(adjustedHeight)));
                });
                
                // Apply the same HEIGHT CHANGE to roofline vertices (roof1 and roof2)
                // Roofline is relative to roof edge (top vertices), not ground
                const roof1 = this.vertices[8];
                const roof2 = this.vertices[9];
                
                if (roof1 && roof1.type === 'roofline') {
                    // roof1 is at midpoint between top vertices 4 and 5
                    const roof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
                    const upVector1 = getLocalUpVector(roof1EdgePos);
                    
                    // Get current roofline height ABOVE roof edge
                    const currentRoofHeightAboveEdge = roof1.position.clone().sub(roof1EdgePos).dot(upVector1);
                    const adjustedRoofHeight = currentRoofHeightAboveEdge + heightDelta;
                    
                    roof1.position.copy(roof1EdgePos.clone().add(upVector1.multiplyScalar(adjustedRoofHeight)));
                }
                
                if (roof2 && roof2.type === 'roofline') {
                    // roof2 is at midpoint between top vertices 6 and 7
                    const roof2EdgePos = this.vertices[6].position.clone().add(this.vertices[7].position).multiplyScalar(0.5);
                    const upVector2 = getLocalUpVector(roof2EdgePos);
                    
                    // Get current roofline height ABOVE roof edge
                    const currentRoofHeightAboveEdge = roof2.position.clone().sub(roof2EdgePos).dot(upVector2);
                    const adjustedRoofHeight = currentRoofHeightAboveEdge + heightDelta;
                    
                    roof2.position.copy(roof2EdgePos.clone().add(upVector2.multiplyScalar(adjustedRoofHeight)));
                }
                
            } else if (isTopVertex) {
                // For top vertices, calculate the new HEIGHT and apply to that top only
                // NOT USED?

                    assert(0, "Top vertex dragging is currently disabled in favor of roof center handle.");
                // Get the linked bottom vertex
                // const referenceBottomVertex = this.vertices[draggedVertex.linkedVertex];
                // const bottomPos = referenceBottomVertex.position;
                // const localUp = getLocalUpVector(bottomPos);
                //
                // // Calculate what the new height would be
                // const toTop = newPosition.clone().sub(bottomPos);
                // let newHeight = toTop.dot(localUp);
                //
                // // Minimum height of 0.01 meter
                // const minHeight = 0.01;
                // if (newHeight < minHeight) {
                //     newHeight = minHeight;
                // }
                //
                // // Apply this HEIGHT to this top vertex only
                // const upVector = getLocalUpVector(bottomPos);
                // draggedVertex.position.copy(bottomPos.clone().add(upVector.multiplyScalar(newHeight)));
                
            } else {
                // For bottom vertices, move the vertex and its two neighbors horizontally only
                // (no vertical movement), then snap to terrain
                
                // Store the original position before moving
                const oldPosition = draggedVertex.position.clone();
                
                // Calculate the horizontal displacement vector (project onto horizontal plane)
                // Remove any component parallel to localUp
                const localUp = getLocalUpVector(oldPosition);
                const rawDisplacement = newPosition.clone().sub(oldPosition);
                const verticalComponent = rawDisplacement.dot(localUp);
                const horizontalDisplacement = rawDisplacement.clone().sub(localUp.clone().multiplyScalar(verticalComponent));
                
                // Calculate new horizontal position
                const newHorizontalPos = oldPosition.clone().add(horizontalDisplacement);
                
                // Snap to terrain using getPointBelow()
                // First, lift the point high above terrain, then drop it to find ground
                const highPoint = newHorizontalPos.clone().add(localUp.clone().multiplyScalar(10000));
                const terrainPoint = getPointBelow(highPoint);
                
                // Move the dragged vertex to the terrain position
                draggedVertex.position.copy(terrainPoint);
                
                // Calculate the horizontal displacement (for neighbors)
                const displacement = terrainPoint.clone().sub(oldPosition);
                const horizontalDisp = displacement.clone().sub(localUp.clone().multiplyScalar(displacement.dot(localUp)));
                
                // Find the two neighbors using the ring structure
                const neighbor1Idx = draggedVertex.next;
                const neighbor2Idx = draggedVertex.prev;
                const neighbor1 = this.vertices[neighbor1Idx];
                const neighbor2 = this.vertices[neighbor2Idx];
                
                // Find the opposite corner (the vertex that's not this one or the neighbors)
                // For a rectangle, bottom vertices are indices 0-3
                let oppositeIdx = -1;
                for (let i = 0; i < 4; i++) {
                    if (i !== this.draggingVertexIndex && i !== neighbor1Idx && i !== neighbor2Idx) {
                        oppositeIdx = i;
                        break;
                    }
                }
                
                if (oppositeIdx !== -1) {
                    const opposite = this.vertices[oppositeIdx];
                    
                    // Move neighbor1: project A's displacement onto the HORIZONTAL edge connecting opposite to neighbor1
                    // First, project the 3D edge onto the horizontal plane
                    const edgeToNeighbor1_3D = neighbor1.position.clone().sub(opposite.position);
                    const verticalComp1 = edgeToNeighbor1_3D.dot(localUp);
                    const edgeToNeighbor1_Horizontal = edgeToNeighbor1_3D.clone().sub(localUp.clone().multiplyScalar(verticalComp1));
                    const edgeDir1 = edgeToNeighbor1_Horizontal.clone().normalize();
                    
                    // Now project the horizontal displacement onto the horizontal edge direction
                    const projectedMovement1 = horizontalDisp.dot(edgeDir1);
                    const neighbor1NewPos = neighbor1.position.clone().add(edgeDir1.multiplyScalar(projectedMovement1));
                    
                    // Snap neighbor1 to terrain
                    const neighbor1Up = getLocalUpVector(neighbor1.position);
                    const neighbor1High = neighbor1NewPos.clone().add(neighbor1Up.clone().multiplyScalar(10000));
                    neighbor1.position.copy(getPointBelow(neighbor1High));
                    
                    // Update the linked top vertex for neighbor1
                    const linkedTop1 = this.vertices[neighbor1.linkedVertex];
                    const localUp1 = getLocalUpVector(neighbor1.position);
                    const toTop1 = linkedTop1.position.clone().sub(neighbor1.position);
                    const currentHeight1 = toTop1.dot(localUp1);
                    linkedTop1.position.copy(neighbor1.position.clone().add(localUp1.multiplyScalar(currentHeight1)));
                    
                    // Move neighbor2: project A's displacement onto the HORIZONTAL edge connecting opposite to neighbor2
                    // First, project the 3D edge onto the horizontal plane
                    const edgeToNeighbor2_3D = neighbor2.position.clone().sub(opposite.position);
                    const verticalComp2 = edgeToNeighbor2_3D.dot(localUp);
                    const edgeToNeighbor2_Horizontal = edgeToNeighbor2_3D.clone().sub(localUp.clone().multiplyScalar(verticalComp2));
                    const edgeDir2 = edgeToNeighbor2_Horizontal.clone().normalize();
                    
                    // Now project the horizontal displacement onto the horizontal edge direction
                    const projectedMovement2 = horizontalDisp.dot(edgeDir2);
                    const neighbor2NewPos = neighbor2.position.clone().add(edgeDir2.multiplyScalar(projectedMovement2));
                    
                    // Snap neighbor2 to terrain
                    const neighbor2Up = getLocalUpVector(neighbor2.position);
                    const neighbor2High = neighbor2NewPos.clone().add(neighbor2Up.clone().multiplyScalar(10000));
                    neighbor2.position.copy(getPointBelow(neighbor2High));
                    
                    // Update the linked top vertex for neighbor2
                    const linkedTop2 = this.vertices[neighbor2.linkedVertex];
                    const localUp2 = getLocalUpVector(neighbor2.position);
                    const toTop2 = linkedTop2.position.clone().sub(neighbor2.position);
                    const currentHeight2 = toTop2.dot(localUp2);
                    linkedTop2.position.copy(neighbor2.position.clone().add(localUp2.multiplyScalar(currentHeight2)));
                }
                
                // Move the linked top vertex for the dragged vertex to stay directly above
                const linkedTop = this.vertices[draggedVertex.linkedVertex];
                const dragLocalUp = getLocalUpVector(draggedVertex.position);
                
                // Calculate current height of the linked top
                const toTop = linkedTop.position.clone().sub(draggedVertex.position);
                const currentHeight = toTop.dot(dragLocalUp);
                
                // Reposition top to maintain its height above the new bottom position
                linkedTop.position.copy(draggedVertex.position.clone().add(dragLocalUp.multiplyScalar(currentHeight)));
                
                // Update roofline vertices to stay at midpoint between TOP vertices (roof edge)
                const roof1 = this.vertices[8];
                const roof2 = this.vertices[9];
                
                if (roof1 && roof1.type === 'roofline' && roof2 && roof2.type === 'roofline') {
                    // Get current roofline height ABOVE the roof edge (top vertices)
                    const currentRoof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
                    const currentRoof1HeightAboveRoof = roof1.position.clone().sub(currentRoof1EdgePos).dot(getLocalUpVector(currentRoof1EdgePos));
                    
                    // Update roof1 position (at midpoint between top vertices 4 and 5)
                    const newRoof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
                    const upVector1 = getLocalUpVector(newRoof1EdgePos);
                    roof1.position.copy(newRoof1EdgePos.clone().add(upVector1.multiplyScalar(currentRoof1HeightAboveRoof)));
                    
                    // Update roof2 position (at midpoint between top vertices 6 and 7)
                    const newRoof2EdgePos = this.vertices[6].position.clone().add(this.vertices[7].position).multiplyScalar(0.5);
                    const upVector2 = getLocalUpVector(newRoof2EdgePos);
                    roof2.position.copy(newRoof2EdgePos.clone().add(upVector2.multiplyScalar(currentRoof1HeightAboveRoof)));
                }
                }
            }
            
            // Rebuild mesh (for all drag types)
            this.buildMesh();
            
            // Sync parameters from the modified vertices
            this.syncParametersFromVertices();
            
            // Recreate control points to update their positions
            this.createControlPoints();
            
            // Re-identify the dragging point and update initial positions for next frame
            if (isBuildingMesh) {
                // Keep the fake dragging point for building mesh
                this.draggingPoint = {userData: {isBuildingMesh: true}};
            } else if (isRoofCenter) {
                this.draggingPoint = this.roofCenterHandle;
                // Update the initial position and intersection for next frame (incremental dragging)
                this.dragInitialHandlePosition.copy(this.roofCenterHandle.position);
                this.dragInitialIntersection.copy(currentIntersection);
            } else if (isRoofline) {
                this.draggingPoint = this.rooflineHandle;
                // Update the initial position and intersection for next frame (incremental dragging)
                this.dragInitialHandlePosition.copy(this.rooflineHandle.position);
                this.dragInitialIntersection.copy(currentIntersection);
            } else {
                this.draggingPoint = this.controlPoints[this.draggingVertexIndex];
                // Update the initial position and intersection for next frame (incremental dragging)
                this.dragInitialHandlePosition.copy(this.draggingPoint.position);
                this.dragInitialIntersection.copy(currentIntersection);
            }
            
            setRenderOne(true);
        }
        
        event.stopPropagation();
        event.preventDefault();
    }
    
    /**
     * Handle pointer up - stop dragging or rotating
     */
    onPointerUp(event) {
        if (this.isDragging || this.isRotating) {
            const view = ViewMan.get("mainView");
            if (view && view.controls) {
                view.controls.enabled = true;
            }
            
            // Create undo action if we have a state before drag and UndoManager is available
            if (this.stateBeforeDrag && UndoManager) {
                const stateAfterDrag = this.captureState();
                const stateBefore = this.stateBeforeDrag;
                
                // Only create undo if state actually changed
                const stateChanged = JSON.stringify(stateBefore) !== JSON.stringify(stateAfterDrag);
                
                if (stateChanged) {
                    const actionDescription = this.isRotating 
                        ? `Rotate building "${this.name}"` 
                        : `Edit building "${this.name}"`;
                    
                    UndoManager.add({
                        undo: () => {
                            this.restoreState(stateBefore);
                        },
                        redo: () => {
                            this.restoreState(stateAfterDrag);
                        },
                        description: actionDescription
                    });
                }
            }
            
            // Clear the stored state
            this.stateBeforeDrag = null;
        }
        
        // If rotation just ended, save the absolute rotation angle to settings
        if (this.isRotating) {
            // Normalize rotation to 0-2π range
            let normalizedRotation = this.totalRotationThisSession % (2 * Math.PI);
            if (normalizedRotation < 0) {
                normalizedRotation += 2 * Math.PI;
            }
            
            // Update settings with the absolute rotation angle (invisibly persisted)
            Globals.settings.lastBuildingRotation = normalizedRotation;
            
            // Save settings asynchronously (don't await to avoid blocking UI)
            saveSettings(Globals.settings).catch(err => {
                console.warn("Failed to save building rotation to settings:", err);
            });
            
            console.log(`Saved absolute building rotation: ${(normalizedRotation * 180 / Math.PI).toFixed(1)}°`);
        }
        
        this.isDragging = false;
        this.isRotating = false;
        this.draggingPoint = null;
        this.draggingVertexIndex = -1;
        this.dragLocalUp = null;
        
        // Check hover after releasing to update cursor appropriately
        if (this.editMode) {
            this.checkHandleHover(event);
        }
    }
    
    /**
     * Create GUI folder for this building
     */
    createGUIFolder() {
        if (!guiMenus.contents) return;
        
        const folderID = `folder_${this.buildingID}`;
        this.guiFolder = guiMenus.contents.addFolder(this.name);
        this.guiFolder.domElement.id = folderID;
        
        // Name editor
        this.guiFolder.add(this, 'name').name('Name').onChange(() => {
            // Update folder title
            this.guiFolder.title = this.name;
            setRenderOne(true);
        });
        
        // Edit mode checkbox
        const editModeData = {editMode: this.editMode};
        this.guiFolder.add(editModeData, 'editMode').name('Edit Mode').onChange((value) => {
            // If enabling edit mode, first exit edit mode on any other building
            if (value && Globals.editingBuilding && Globals.editingBuilding !== this) {
                Globals.editingBuilding.setEditMode(false);
            }
            this.setEditMode(value);
        });
        
        // Material folder
        this.materialFolder = this.guiFolder.addFolder('Material').close();
        
        this.materialFolder.add(this, 'materialType', ['basic', 'lambert', 'phong', 'physical'])
            .name('Type')
            .onChange(() => this.rebuildMaterial());
        
        this.materialFolder.addColor(this, 'wallColor')
            .name('Wall Color')
            .onChange(() => this.rebuildMaterial());
        
        this.materialFolder.addColor(this, 'roofColor')
            .name('Roof Color')
            .onChange(() => this.rebuildMaterial());
        
        this.materialFolder.add(this, 'materialOpacity', 0, 1, 0.01)
            .name('Opacity')
            .onChange(() => this.rebuildMaterial());
        
        this.materialFolder.add(this, 'materialTransparent')
            .name('Transparent')
            .onChange(() => this.rebuildMaterial());
        
        this.materialFolder.add(this, 'materialWireframe')
            .name('Wireframe')
            .onChange(() => this.rebuildMaterial());
        
        this.materialFolder.add(this, 'materialDepthTest')
            .name('Depth Test')
            .onChange(() => this.rebuildMaterial());
        
        // Delete button
        const actions = {
            delete: () => {
                if (confirm(`Delete building "${this.name}"?`)) {
                    // Capture state before deletion for undo
                    if (UndoManager) {
                        const buildingState = this.serialize();
                        const buildingID = this.buildingID;
                        
                        UndoManager.add({
                            undo: () => {
                                // Recreate the building
                                Synth3DManager.addBuilding(buildingState);
                            },
                            redo: () => {
                                // Delete the building again
                                Synth3DManager.removeBuilding(buildingID);
                            },
                            description: `Delete building "${this.name}"`
                        });
                    }
                    
                    // Manager will handle deletion
                    Synth3DManager.removeBuilding(this.buildingID);
                }
            }
        };
        this.guiFolder.add(actions, 'delete').name('Delete Building');
        
        // Initially hide the folder
        this.guiFolder.hide();
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
     * Serialize to save data
     */
    serialize() {
        return {
            id: this.buildingID,
            name: this.name,
            cornerLatLons: this.cornerLatLons.map(c => ({lat: c.lat, lon: c.lon})),
            roofAGL: this.roofAGL,
            rooflineHeightAGL: this.rooflineHeightAGL,
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
                cornerLatLons: data.cornerLatLons.map(c => ({lat: c.lat, lon: c.lon})),
                roofAGL: data.roofAGL !== undefined ? data.roofAGL : 4,
                rooflineHeightAGL: data.rooflineHeightAGL !== undefined ? data.rooflineHeightAGL : 0,
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
            const verticesEUS = data.vertices.map(v => {
                if (v.position) {
                    return {
                        position: LLAToEUS(v.position[0], v.position[1], v.position[2]),
                        type: v.type || 'free'
                    };
                } else {
                    return {
                        position: LLAToEUS(v.lat, v.lon, v.alt),
                        type: 'free'
                    };
                }
            });
            
            // Find bottom and top vertices
            const bottomVerts = verticesEUS.filter(v => v.type === 'bottom').slice(0, 4);
            const topVerts = verticesEUS.filter(v => v.type === 'top').slice(0, 4);
            
            if (bottomVerts.length === 4 && topVerts.length === 4) {
                // Extract cornerLatLons from bottom vertices
                const cornerLatLons = bottomVerts.map(v => {
                    const lla = EUSToLLA(v.position);
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
                    vertices: verticesEUS,
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