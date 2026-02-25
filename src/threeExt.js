// threeExt.js - Mick's extensions to THREE.js
import {
    ArrowHelper,
    BoxGeometry,
    BufferGeometry,
    Color,
    Float32BufferAttribute,
    Group,
    LinearFilter,
    LineBasicMaterial,
    LineSegments,
    Material,
    Mesh,
    MeshBasicMaterial,
    NearestFilter,
    Ray,
    Sphere,
    SphereGeometry,
    TextureLoader,
    Vector3,
    WireframeGeometry
} from "three";

import {Globals, NodeMan, setRenderOne, Synth3DManager} from './Globals';
import {par} from "./par";


import {altitudeMSL, drop3, earthCenterEUS, pointOnSphereBelow, raisePoint, setAltitudeMSL} from "./SphericalMath"
import {GlobalScene} from "./LocalFrame";
import * as LAYER from "./LayerMasks";
import {ECEFToEUS, EUSToECEF, LLAToEUS} from "./LLA-ECEF-ENU";
import {LineMaterial} from "three/addons/lines/LineMaterial.js";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import {assert} from "./assert.js";
import {intersectSphere2, makeMatrix4PointYAt, V3} from "./threeUtils";

Material.prototype.getMap = function() {
    return this.uniforms?.map?.value ?? this.map;
};

Mesh.prototype.getMap = function() {
    return this.material?.getMap();
};

// Wrapper for calling dispose function on object, allowing undefined
export function dispose(a) { if (a!=undefined) a.dispose()}

// A grid helper that is a segment of a sphere (i.e. on the surface of the earth)
class GridHelperWorldComplex extends LineSegments {
    constructor (altitude, xStart, xEnd, xStep, yStart, yEnd, yStep, radius, color1=0x444444, color2 = 0x888888)
    {



        color1 = new Color( color1 );
        color2 = new Color( color2 );

        const vertices = [], colors = [];
        let j = 0
        for (let x = xStart; x < xEnd; x+= xStep) {
            for (let y = yStart; y< yEnd; y+= yStep) {
                const A = drop3(x,y)
                const B = drop3(x+xStep,y)
                const C = drop3(x,y+yStep)
                A.z += altitude
                B.z += altitude
                C.z += altitude
                vertices.push(A.x,A.z,A.y,B.x,B.z,B.y)
                vertices.push(A.x,A.z,A.y,C.x,C.z,C.y)
                const color = color1;

                color.toArray( colors, j ); j += 3;
                color.toArray( colors, j ); j += 3;
                color.toArray( colors, j ); j += 3;
                color.toArray( colors, j ); j += 3;
            }
        }

        const geometry = new BufferGeometry();
        geometry.setAttribute( 'position', new Float32BufferAttribute( vertices, 3 ) );
        geometry.setAttribute( 'color', new Float32BufferAttribute( colors, 3 ) );

        const material = new LineBasicMaterial( { vertexColors: true, toneMapped: false } );

        super( geometry, material );

        this.type = 'GridHelper';
    }
}

export class ColoredLine extends LineSegments {
    constructor(_positions, _colors) {

        const vertices = [];
        const colors = [];

        for (let i=0;i<_positions.length-1;i++) {
            const p = _positions[i]
            const c = _colors[i]
            vertices.push(_positions[i].x,_positions[i].y,_positions[i].z)
            vertices.push(_positions[i+1].x,_positions[i+1].y,_positions[i+1].z)
            _colors[i].toArray(colors,i*6)
            _colors[i].toArray(colors,i*6+3)
        }


        const geometry = new BufferGeometry();
        geometry.setAttribute( 'position', new Float32BufferAttribute( vertices, 3 ) );
        geometry.setAttribute( 'color', new Float32BufferAttribute( colors, 3 ) );

        const material = new LineBasicMaterial( { vertexColors: true, toneMapped: false } );

        super (geometry, material)
        this.type = 'ColoredLine';
    }

    dispose() {
        this.geometry.dispose()
        this.material.dispose()
    }

}



// Same as THREE.GridHelper, but creates a segment of a sphere.
// by taking the grid, and simply projecting it down to the sphere
// This requires we make individual line segments for each square
// so uses considerably more lines (n^2 vs 2n) than GridHelper
class GridHelperWorld extends GridHelperWorldComplex {

    constructor( altitude = 0, size = 10, divisions = 10, radius = 1000,color1 = 0x444444, color2 = 0x888888 ) {



        const center = divisions / 2;
        const step = size / divisions;
        const halfSize = size / 2;

        super(altitude, -halfSize,halfSize,step,-halfSize,halfSize,step,radius,color1,color2)

    }

}




export {GridHelperWorld, GridHelperWorldComplex}

function sphereAt(x, y, z, radius = 5, color = 0xffffff, parent) {
    const geometry = new SphereGeometry(radius, 10, 10);
    const material = new MeshBasicMaterial({color: color});
    const sphere = new Mesh(geometry, material);
    sphere.position.x = x;
    sphere.position.y = y;
    sphere.position.z = z;
    if (parent !== undefined) parent.add(sphere);
//    sphere.layers.mask = LAYER.MASK_MAIN;
    sphere.layers.mask = LAYER.MASK_HELPERS;
    return sphere;
}

export function sphereMark(point, r = 5, color = 0xffffff, parent=null) {
    return sphereAt(point.x, point.y, point.z, r, color, parent)
}

function boxAt(x, y, z, xs = 1, ys=1, zs=1, color = 0xffffff, parent) {
    const geometry = new BoxGeometry(xs,ys,zs);
    const material = new MeshBasicMaterial({color: color});
    const sphere = new Mesh(geometry, material);
    sphere.position.x = x;
    sphere.position.y = y;
    sphere.position.z = z;
    sphere.layers.mask = LAYER.MASK_MAIN;
    if (parent !== undefined) parent.add(sphere);
    return sphere;
}

export function boxMark(point,  xs = 1, ys=1, zs=1, color = 0xffffff, parent=null) {
    return boxAt(point.x, point.y, point.z, xs,ys,zs, color, parent)
}



// Create anywhere debug sphere
let DebugSpheres = {}
export function DebugSphere(name, origin, radius = 100, color = 0xffffff, parent = GlobalScene, layers = LAYER.MASK_HELPERS, wireframe = false) {

    color = new Color(color)  // convert from whatever format, like "green" or "#00ff00" to a THREE.Color(r,g,b)

    if (DebugSpheres[name] === undefined) {
        let material, geometry, sphere;
        if (wireframe) {
            // create a wireframe sphere
            material = new LineBasicMaterial({color: color})
            geometry = new SphereGeometry(1, 10, 10);
            geometry = new WireframeGeometry(geometry);
            sphere = new LineSegments(geometry, material);
        } else {
            material = new MeshBasicMaterial({color: color});
            geometry = new SphereGeometry(1, 10, 10);
            sphere = new Mesh(geometry, material);
        }
        DebugSpheres[name] = sphere
        sphere.layers.mask = layers;
        parent.add(sphere);
    }
    DebugSpheres[name].position.copy(origin)
    DebugSpheres[name].scale.set(radius,radius,radius)

    return DebugSpheres[name]

}

export function DebugWireframeSphere(name, origin, radius = 100, color = 0xffffff, segments=20, parent) {

    color = new Color(color)  // convert from whatever format, like "green" or "#00ff00" to a THREE.Color(r,g,b)

    if (parent === undefined)
        parent = GlobalScene

    if (DebugSpheres[name] === undefined) {

        // we make a sphere of radius 0.5 so it has a 1 METER diameter
        // so scale passed in must be in meters.
        const geometry = new SphereGeometry(0.5, segments, segments);
        const wireframe = new WireframeGeometry(geometry);
        const sphere = new LineSegments(wireframe);
        sphere.material.color = new Color(color)
        sphere.material.depthTest = true;
        sphere.material.opacity = 0.75;
        sphere.material.transparent = true;
        sphere.layers.mask = LAYER.MASK_HELPERS;

        DebugSpheres[name] = sphere
        parent.add(sphere);
    }
    DebugSpheres[name].position.copy(origin)
    DebugSpheres[name].scale.set(radius,radius,radius)

    return DebugSpheres[name]

}

export let DebugArrows = {}

export function disposeDebugArrows() {
    console.log("Disposing all debug arrows")

    for (const key in DebugArrows) {
       // DebugArrows[key].dispose();
    }
    DebugArrows = {}
}

export function disposeDebugSpheres() {
    console.log("Disposing all debug spheres")
    for (const key in DebugSpheres) {
     //   DebugSpheres[key].dispose();
    }
    DebugSpheres = {}
}


// creat a debug arrow if it does not exist, otherwise update the existing one
// uses an array to record all the debug arrows.
export function DebugArrow(name, direction, origin, _length = 100, color="#FFFFFF", visible=true, parent, _headLength=20, layerMask=LAYER.MASK_HELPERS) {
    const dir = direction.clone()
    dir.normalize();


    if (parent === undefined)
        parent = GlobalScene;


    // if a fraction, then treat that as a fraction of the total length, else an absolute value
    if (_headLength < 1) {
//        _headLength = _length * _headLength;

        // sinc
        assert(0, "Head length as a fraction is deprecated")
    }


    if (DebugArrows[name] === undefined) {
        color = new Color(color)  // convert from whatever format, like "green" or "#00ff00" to a THREE.Color(r,g,b)
//        DebugArrows[name] = new ArrowHelper(dir, origin, _length, color, _headLength);
        DebugArrows[name] = new ArrowHelper(dir, origin, _length, color);
        DebugArrows[name].visible = visible
        DebugArrows[name].length = _length;
        DebugArrows[name].headLength = _headLength;
        DebugArrows[name].direction = dir;

        if (layerMask !== undefined) {
            setLayerMaskRecursive(DebugArrows[name], layerMask)
        }
        parent.add(DebugArrows[name]);
    } else {
        assert(parent === DebugArrows[name].parent, "Parent changed on debug arrow: was "+DebugArrows[name].parent.debugTimeStamp+" now "+parent.debugTimeStamp)
        DebugArrows[name].setDirection(dir)
        DebugArrows[name].position.copy(origin)
        DebugArrows[name].setLength(_length, _headLength)
        DebugArrows[name].visible = visible
        DebugArrows[name].length = _length;
        DebugArrows[name].originalLength = _length;
        DebugArrows[name].headLength = _headLength;
        DebugArrows[name].direction = dir;

        // Update color if it has changed
        const newColor = new Color(color);
        if (DebugArrows[name].line && DebugArrows[name].line.material) {
            DebugArrows[name].line.material.color.copy(newColor);
        }
        if (DebugArrows[name].cone && DebugArrows[name].cone.material) {
            DebugArrows[name].cone.material.color.copy(newColor);
        }

        // Update layer mask if it has changed
        if (layerMask !== undefined) {
            setLayerMaskRecursive(DebugArrows[name], layerMask)
        }
    }
    return DebugArrows[name]
}

export function scaleArrows(view) {

    // being called with overlay views, which have a camera, but no pixelsToMeters
    // the arrows are only rendered in 3D views, so we can ignore this
    if (view.pixelsToMeters === undefined) return;

    for (const key in DebugArrows) {
        const arrow = DebugArrows[key]
        // arrow.position is the start of the arrow, we need to scale the arrow head
        // based on the end of the arrow
        const arrowEnd = arrow.position.clone().add(arrow.direction.clone().multiplyScalar(arrow.length));

        let headLength = view.pixelsToMeters(arrowEnd, arrow.headLength);

        // don't let it get bigger than half the arrow length
        headLength = Math.min(arrow.length/2, headLength);

        if (arrow.originalLength < 0) {
            assert(0,"DEPRECATED: originalLength < 0")
            let length = view.pixelsToMeters(arrowEnd, -arrow.originalLength);
            arrow.setLength(length, headLength);
        } else {
            arrow.setLength(arrow.length, headLength);
        }
    }

}

/**
 * Update the position indicator cone for the currently editing track
 * This should be called from the render loop to keep the cone at the current frame position
 * and maintain constant screen size
 */
export function updateTrackPositionIndicator(view) {

    // Check if there's a track being edited
    if (!Globals.editingTrack || !Globals.editingTrack.splineEditor) {
        return;
    }
    
    const trackOb = Globals.editingTrack;
    const splineEditor = trackOb.splineEditor;
    
    // Check if the editor is enabled and has the position indicator
    if (!splineEditor.enable || !splineEditor.positionIndicatorCone) {
        return;
    }
    
    // Get the track node (CNodeSplineEditor)
    const trackNode = trackOb.splineEditorNode;
    if (!trackNode || !trackNode.array || trackNode.array.length === 0) {
        return;
    }
    
    // Get the current frame position
    const currentFrame = Math.floor(par.frame);
    if (currentFrame < 0 || currentFrame >= trackNode.array.length) {
        return;
    }
    
    const position = trackNode.array[currentFrame].position;
    if (!position) {
        return;
    }
    
    // Update the position indicator
    splineEditor.updatePositionIndicator(position, view);
    
    // Update the widget handle scales to maintain constant screen size
    if (splineEditor.transformControl && splineEditor.transformControl.updateHandleScales) {
        splineEditor.transformControl.updateHandleScales(view);
    }
    
    // Update control point cube scales to maintain constant screen size
    if (splineEditor.updateCubeScales) {
        splineEditor.updateCubeScales(view);
    }
}

/**
 * Update building handle scales to maintain constant screen size
 * This should be called from the render loop to keep handles at a fixed pixel size
 * regardless of camera distance
 * @param {CNodeView3D} view - The view to use for screen-space scaling
 */
export function scaleBuildingHandles(view) {
    // Only apply to views with pixelsToMeters support (3D views)
    if (!view || !view.pixelsToMeters) {
        return;
    }

    const s = Synth3DManager;

    // Iterate over all synthetic buildings and update their handle scales
    if (Synth3DManager && Synth3DManager.list) {
        for (const buildingId in Synth3DManager.list) {
            const building = Synth3DManager.list[buildingId].data;

            if (building && building.updateHandleScales) {
                building.updateHandleScales(view);
            }
        }
    }
    
    // Iterate over all synthetic clouds and update their handle scales
    if (Synth3DManager && Synth3DManager.cloudsList) {
        for (const cloudsId in Synth3DManager.cloudsList) {
            const clouds = Synth3DManager.cloudsList[cloudsId];

            if (clouds && clouds.updateHandleScales) {
                clouds.updateHandleScales(view);
            }
        }
    }
    
    // Iterate over all ground overlays and update their handle scales
    if (Synth3DManager && Synth3DManager.overlaysList) {
        for (const overlayId in Synth3DManager.overlaysList) {
            const overlay = Synth3DManager.overlaysList[overlayId];

            if (overlay && overlay.updateHandleScales) {
                overlay.updateHandleScales(view);
            }
        }
    }
}

export function removeDebugArrow(name) {
    if (DebugArrows[name]) {
        if (DebugArrows[name].parent) {
            DebugArrows[name].parent.remove(DebugArrows[name]);
        }
        DebugArrows[name].dispose();
        delete DebugArrows[name]
    }
}

export function removeDebugSphere(name) {
    if (DebugSpheres[name]) {
        if (DebugSpheres[name].parent) {
            DebugSpheres[name].parent.remove(DebugSpheres[name]);
        }
        DebugSpheres[name].geometry.dispose();
        delete DebugSpheres[name]
    }
}

// XYZ axes colored RGB
export function DebugAxes(name, position, length) {
    DebugArrow(name+"Xaxis",V3(1,0,0), position.clone().sub(V3(length/2,0,0)),length,"#FF8080")
    DebugArrow(name+"Yaxis",V3(0,1,0), position.clone().sub(V3(0,length/2,0)),length,"#80FF80")
    DebugArrow(name+"Zaxis",V3(0,0,1), position.clone().sub(V3(0,0,length/2)),length,"#8080FF")
}

export function DebugMatrixAxes(name, position, matrix, length) {
    // extract the axes from the matrix
    const x = new Vector3().setFromMatrixColumn(matrix, 0);
    const y = new Vector3().setFromMatrixColumn(matrix, 1);
    const z = new Vector3().setFromMatrixColumn(matrix, 2);
    // draw the debug arrows
    DebugArrow(name+"Xaxis",x, position.clone().sub(x.clone().multiplyScalar(length)),length*2,"#FF8080")
    DebugArrow(name+"Yaxis",y, position.clone().sub(y.clone().multiplyScalar(length)),length*2,"#80FF80")
    DebugArrow(name+"Zaxis",z, position.clone().sub(z.clone().multiplyScalar(length)),length*2,"#8080FF")

}





function DebugArrowOrigin(name, direction, length = 100, color, visible=true, parent, headLength=20, layerMask) {
    const origin = new Vector3(0, 0, 0);
    return DebugArrow(name, direction, origin, length, color, visible, parent, headLength)
}

export function DebugArrowAB(name, A, B, color, visible, parent, headLength=20, layerMask) {
    const direction = B.clone()
    direction.sub(A)
    const length = direction.length()
    direction.normalize()
    return DebugArrow(name, direction, A, length, color, visible, parent, headLength, layerMask)
}


// Layer masks are on a per-object level, and don't affect child objects
// so we need to propagate it if there's any chenge
export function propagateLayerMaskObject(parent) {
    assert(parent !== undefined, "propagateLayerMaskObject called on undefined parent")
    // copy group layers bitmask into all children
    const layersMask = parent.layers.mask;
    parent.traverse( function( child ) { child.layers.mask = layersMask } )
    setRenderOne(true);
}

export function setLayerMaskRecursive(object, mask) {
    object.layers.mask = mask;
    object.traverse( function( child ) { child.layers.mask = mask } )
    setRenderOne(true);

}


export function pointObject3DAt(object, _normal) {
    const m = makeMatrix4PointYAt(_normal)
    object.quaternion.setFromRotationMatrix( m );
}

export function isVisible(ob) {
    if (ob.visible === false) return false; // if not visible, then that can't be overridden
    if (ob.parent !== null) return isVisible(ob.parent) // visible, but parents can override
    return true; // visible all the way up to the root
}


// Recursive function to dispose of materials and geometries
export function disposeObject(object) {

    if (!object) return;

    // if (object.type === 'Mesh' || object.type === 'Line' || object.type === 'Points') {
    // Dispose geometry
    if (object.geometry) {
        object.geometry.dispose();
    }

    if (object.material) {
        // Dispose materials
        if (Array.isArray(object.material)) {
            // In case of an array of materials, dispose each one
            object.material.forEach(material => disposeMaterial(material));
        } else {
            // Single material
            disposeMaterial(object.material);
        }
    }
    //}

    // Recurse into children
    while (object.children.length > 0) {
        disposeObject(object.children[0]);
        object.remove(object.children[0]);
    }
}

// Helper function to dispose materials and textures
export function disposeMaterial(material) {
    Object.keys(material).forEach(prop => {
        if (material[prop] !== null && material[prop] !== undefined && typeof material[prop].dispose === 'function') {
            // This includes disposing textures, render targets, etc.
            material[prop].dispose();
        }
    });
    material.dispose(); // Dispose the material itself
}


// given a three.js scene, we can dispose of all the objects in it
// this is used when we want to change scenes/sitches
// we can't just delete the scene, as it's a THREE.Object3D, and we need to dispose of all the objects in it
// and all the materials, etc.
export function disposeScene(scene) {
    console.log("Disposing scene");

    if (scene === undefined) return;





    // Start the disposal process from the scene's children
    if (scene.children!== undefined) {
        while (scene.children.length > 0) {

            //  if (scene.children[0].type === 'GridHelper')
            //      debugger;

            disposeObject(scene.children[0]);


            scene.remove(scene.children[0]);
        }
    }
}

// A debug group so we can see specifically what's being disposed or not
export class DEBUGGroup extends Group {
    constructor() {
        super();
    }
}

// get intersection of a point/heading ray with the Mean Sea Level surface.
// In ellipsoid mode, delegates to intersectEllipsoid for accuracy.
// In sphere mode (equatorRadius === polarRadius), uses fast sphere intersection.
export function intersectMSL(point, headingVector) {
    if (Globals.equatorRadius !== Globals.polarRadius) {
        return intersectEllipsoid(point, headingVector);
    }
    const globe = new Sphere(earthCenterEUS(), Globals.equatorRadius);
    const ray = new Ray(point, headingVector.clone().normalize());
    const sphereCollision = new Vector3();
    if (intersectSphere2(ray, globe, sphereCollision))
        return sphereCollision;
    return null;
}

// get intersection of a point/heading ray with the WGS84 ellipsoid
// More accurate than intersectMSL for high-latitude locations
export function intersectEllipsoid(pointEUS, headingVectorEUS) {
    const a = Globals.equatorRadius;
    const b = Globals.polarRadius;
    
    const originECEF = EUSToECEF(pointEUS);
    const dirEUS = headingVectorEUS.clone().normalize();
    const endEUS = pointEUS.clone().add(dirEUS);
    const endECEF = EUSToECEF(endEUS);
    const dirECEF = endECEF.clone().sub(originECEF).normalize();
    
    const ox = originECEF.x, oy = originECEF.y, oz = originECEF.z;
    const dx = dirECEF.x, dy = dirECEF.y, dz = dirECEF.z;
    
    const a2 = a * a, b2 = b * b;
    
    const A = (dx * dx + dy * dy) / a2 + (dz * dz) / b2;
    const B = 2 * ((ox * dx + oy * dy) / a2 + (oz * dz) / b2);
    const C = (ox * ox + oy * oy) / a2 + (oz * oz) / b2 - 1;
    
    const discriminant = B * B - 4 * A * C;
    
    if (discriminant < 0) {
        return null;
    }
    
    const sqrtDisc = Math.sqrt(discriminant);
    const t1 = (-B - sqrtDisc) / (2 * A);
    const t2 = (-B + sqrtDisc) / (2 * A);
    
    let t;
    if (t1 > 0) {
        t = t1;
    } else if (t2 > 0) {
        t = t2;
    } else {
        return null;
    }
    
    const intersectionECEF = originECEF.clone().add(dirECEF.clone().multiplyScalar(t));
    return ECEFToEUS(intersectionECEF);
}

export class CDisplayLine {
    constructor(v) {
        this.color = v.color ?? [1, 0, 1];
        this.width = v.width ?? 1;
        this.A = v.A;
        this.B = v.B;
        this.group = v.group;
        this.layers = v.layers ?? LAYER.MASK_HELPERS;

        this.material = new LineMaterial({

            // the color here is white, as
            color: [1.0, 1.0, 1.0], // this.color,
            linewidth: this.width, // in world units with size attenuation, pixels otherwise
            vertexColors: true,
            dashed: false,
            alphaToCoverage: true,
        });

        this.geometry = null;

        const line_points = [];
        const line_colors = [];

        line_points.push(this.A.x, this.A.y, this.A.z);
        line_points.push(this.B.x, this.B.y, this.B.z);
        line_colors.push(this.color.r, this.color.g, this.color.b)
        line_colors.push(this.color.r, this.color.g, this.color.b)

        this.geometry = new LineGeometry();
        this.geometry.setPositions(line_points);
        this.geometry.setColors(line_colors);

        this.material.resolution.set(window.innerWidth, window.innerHeight)
        this.line = new Line2(this.geometry, this.material);
        this.line.computeLineDistances();
        this.line.scale.set(1, 1, 1);
        this.line.layers.mask = this.layers;
        this.group.add(this.line);

    }

    dispose() {
        this.group.remove(this.line)
        this.material.dispose();
        this.geometry.dispose();
    }
}

// get the point on the ground below a point in EUS
// if the terrain model is loaded, use that, otherwise use the sphere
export function getPointBelow(A, raycast = false) {
    if (NodeMan.exists("TerrainModel")) {
        let terrainNode = NodeMan.get("TerrainModel")
        return terrainNode.getPointBelow(A, 0, raycast)
    } else {
        return pointOnSphereBelow(A);
    }
}

export function getPointBelowLL(lat, lon) {
    const A = LLAToEUS(lat, lon, 100000);
    return getPointBelow(A)
}

// get the above ground altitude a point in EUS
export function aboveGroundLevelAt(A) {
    const B = getPointBelow(A);
    const altitude = A.clone().sub(B).length();
    return altitude;
}

// given a point in EUS, ensure it is at least "height" meters above the ground
// accounting for terrain.
export function clampAboveGround(point, height) {
    const ground = getPointBelow(point);
    const aboveGround = calculateAltitude(point) - calculateAltitude(ground);
    if (aboveGround <= height) {
        return pointAbove(ground, height);
    }
    return point;
}

// get the AGL altitude at a point speciifed by lat/lon
export function aboveGroundLevelAtLL(lat, lon) {
    const A = LLAToEUS(lat, lon, 100000);
    return aboveGroundLevelAt(A)
}

// given a point in EUS, return a point above (or below) it by a given additional height
export function pointAbove(point, height) {
    return raisePoint(point, height);
}

export function adjustHeightAboveGround (point, height, raycast = false) {
    const ground = getPointBelow(point, raycast);
    return pointAbove(ground, height);
}

export function adjustHeightMSL(point, height) {
    return setAltitudeMSL(point, height);
}

export function calculateAltitude(point) {
    return altitudeMSL(point);
}

// given a lat/lon, calculate the terrainelevation of the ground above the WGS84 sphere
// (i.e. the MSL altitude of the ground below that point)
// uses the terrain model if available, otherwise uses the WGS84 sphere
export function elevationAtLL(lat, lon, raycast = false) {
    // get the point in EUS
    const point = LLAToEUS(lat, lon, 100000);
    // get the ground point below it
    const groundPoint = getPointBelow(point, raycast);
    // calculate the elevation
    return calculateAltitude(groundPoint);
}

export function forceFilterChange(texture, filter, renderer) {
    // Check if the filter is already set
    if (texture.minFilter === filter && texture.magFilter === filter) {
        return; // No need to update
    }

    // Update texture filter properties
    texture.minFilter = filter;
    texture.magFilter = filter;

    // Retrieve WebGL properties and texture
    const textureProperties = renderer.properties.get(texture);
    const webglTexture = textureProperties.__webglTexture;

    if (webglTexture) {
        // Get the WebGL context from the renderer
        const gl = renderer.getContext();

        // Map Three.js filters to WebGL filters
        let glFilter;
        switch (filter) {
            case LinearFilter:
                glFilter = gl.LINEAR;
                break;
            case NearestFilter:
                glFilter = gl.NEAREST;
                break;
            // Add additional cases here for other filters if necessary
            default:
                console.warn('Unsupported filter type:', filter);
                glFilter = gl.NEAREST; // Default to nearest
                break;
        }

        // Bind the texture to update it
        gl.bindTexture(gl.TEXTURE_2D, webglTexture);

        // Update the minFilter and magFilter
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, glFilter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, glFilter);

        // Unbind the texture
        gl.bindTexture(gl.TEXTURE_2D, null);

        // Ensure Three.js is aware of the state change
        texture.needsUpdate = false;
    } else {
        showError('No WebGL texture handle found for the texture.');
    }
}

// given a url to a texture, create a cube that has that texture on all sides
// at a given position and size.
export function testTextureCube(url, position, size, scene) {

    console.log("Creating texture cube at "+position.x+","+position.y+","+position.z+" with size "+size+" and texture "+url)

    // first load the texture
    const loader = new TextureLoader();
    const texture = loader.load(url);
//    texture.encoding = sRGBEncoding;

    // create a basic material with that texture
    const material = new MeshBasicMaterial({map: texture});

    // create a cube geometry
    const geometry = new BoxGeometry(size, size, size);

    // create the mesh
    const mesh = new Mesh(geometry, material);

    // set the position
    mesh.position.copy(position);

    // add it to the scene
    scene.add(mesh);

}

// as above but a solid color
export function testColorCube(color, position, size, scene) {
    let materials = [];

    if (Array.isArray(color)) {
        color.forEach(c => {
            c = new Color(c)
            materials.push(new MeshBasicMaterial({color: c}));
            materials.push(new MeshBasicMaterial({color: c}));
        });
    } else {

        // convert to three.js color
        color = new Color(color)

        // create a cube that has the color on each face
        // top and bottom at 100%
        // front and back at 50%
        // left and right at 25%
        const halfColor = color.clone().multiplyScalar(0.5);
        const quarterColor = color.clone().multiplyScalar(0.25);

        const leftRightMaterial = new MeshBasicMaterial({color: color});
        const frontBackMaterial = new MeshBasicMaterial({color: halfColor});
        const topBotMaterial = new MeshBasicMaterial({color: quarterColor});

        materials = [leftRightMaterial, leftRightMaterial, frontBackMaterial, frontBackMaterial, topBotMaterial, topBotMaterial]
    }

    // create a cube geometry
    const geometry = new BoxGeometry(size, size, size);

    // create the mesh with a different material for each face
    const mesh = new Mesh(geometry, materials);

    // add to scene
    mesh.position.copy(position);
    scene.add(mesh);


}



