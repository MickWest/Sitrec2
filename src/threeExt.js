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
    Raycaster,
    Sphere,
    SphereGeometry,
    SRGBColorSpace,
    TextureLoader,
    Vector3,
    WireframeGeometry
} from "three";

import {getEffectiveRenderScale, Globals, NodeMan, setRenderOne, Synth3DManager} from './Globals';
import {par} from "./par";
import {showError} from "./showError";


import {altitudeHAE, drop3, earthCenterECEF, pointOnSphereBelow, raisePoint, setAltitudeHAE} from "./SphericalMath"
import {GlobalScene} from "./LocalFrame";
import * as LAYER from "./LayerMasks";
import {LLAToECEF} from "./LLA-ECEF-ENU";
import {getDebugMatrixAxisSegments} from "./DebugMatrixAxesUtils";
import {LineMaterial} from "three/addons/lines/LineMaterial.js";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import {assert} from "./assert";
import {intersectSphere2, makeMatrix4PointYAt, V3} from "./threeUtils";

// When ColorManagement is disabled, standard materials operate in sRGB space.
// Since the copy-to-screen shader applies sRGB encoding, we inject
// sRGBTransferEOTF at the end of the fragment shader so the round-trip
// (sRGB output → linearize here → copy shader encodes) preserves the original colors.
export function patchMaterialForLinearOutput(material) {
    const origOBC = material.onBeforeCompile;
    material.onBeforeCompile = function(shader, renderer) {
        if (origOBC) origOBC.call(this, shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>
gl_FragColor = sRGBTransferEOTF(gl_FragColor);`
        );
    };
    return material;
}

Material.prototype.getMap = function() {
    return this.uniforms?.map?.value ?? this.map;
};

// Sitrec's orthographic view mode (CNodeCamera._installOrthographicOverride)
// swaps an orthographic projection matrix onto a camera that still reports
// isPerspectiveCamera === true (so .fov/.aspect readers keep working).
// Raycaster.setFromCamera branches on that flag, so it would unproject cursor
// coordinates through the ortho inverse as if perspective — collapsing every
// screen ray toward the view-centre ray, which breaks all mouse picking
// (orbit pivot, cursor, drag, context menus) while ortho is on. The override
// stamps __sitrecOrthoMatrixActive on the camera whenever the installed
// matrix is orthographic; only then do we build the correct parallel rays.
// The m[15] check (1 only for an orthographic projection, 0 for perspective)
// is a belt-and-braces guard so a stale flag can never divert a camera whose
// matrix is actually perspective. NDC z = -1 puts the ray origin on the ortho
// near plane; direction is the camera forward axis (all ortho rays are
// parallel).
const _perspSetFromCamera = Raycaster.prototype.setFromCamera;
Raycaster.prototype.setFromCamera = function(coords, camera) {
    if (camera.isPerspectiveCamera && camera.__sitrecOrthoMatrixActive
        && camera.projectionMatrix.elements[15] === 1) {
        this.ray.origin.set(coords.x, coords.y, -1).unproject(camera);
        this.ray.direction.set(0, 0, -1).transformDirection(camera.matrixWorld);
        this.camera = camera;
        return;
    }
    return _perspSetFromCamera.call(this, coords, camera);
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
    for (const key in DebugArrows) {
        const arrow = DebugArrows[key];
        if (arrow.parent) arrow.parent.remove(arrow);
        arrow.dispose();
    }
    DebugArrows = {}
}

export function disposeDebugSpheres() {
    for (const key in DebugSpheres) {
        const sphere = DebugSpheres[key];
        if (sphere.parent) sphere.parent.remove(sphere);
        if (sphere.geometry) sphere.geometry.dispose();
        if (sphere.material) sphere.material.dispose();
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

        // Update layer mask ONLY if it has changed. setLayerMaskRecursive() calls
        // setRenderOne(true), so calling it unconditionally on every per-frame
        // arrow redraw (e.g. the camera frustum / flow indicator) re-armed the
        // render flag every frame — a self-sustaining render loop that never let
        // the paused scene settle (~600% CPU). Only re-apply on a real change.
        if (layerMask !== undefined && DebugArrows[name].layers.mask !== layerMask) {
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

    // Update Globals.editingTrack (TrackManager-managed synthetic tracks)
    if (Globals.editingTrack && Globals.editingTrack.splineEditor) {
        const trackOb = Globals.editingTrack;
        const splineEditor = trackOb.splineEditor;

        if (splineEditor.enable && splineEditor.positionIndicatorCone) {
            const trackNode = trackOb.splineEditorNode;
            assert(!trackNode?._needsRecalculate, "call ensureRecalculated() before direct array access on " + trackNode?.id);
            if (trackNode && trackNode.array && trackNode.array.length > 0) {
                const currentFrame = Math.floor(par.frame);
                if (currentFrame >= 0 && currentFrame < trackNode.array.length) {
                    const position = trackNode.array[currentFrame].position;
                    if (position) {
                        splineEditor.updatePositionIndicator(position, view);
                    }
                }
            }
        }
    }

    // Scale handles for ALL enabled spline editors (including sitch-defined ones
    // like agua's lanternSplineEditor that don't go through Globals.editingTrack)
    NodeMan.iterate((id, node) => {
        if (node.splineEditor && node.splineEditor.enable) {
            const se = node.splineEditor;
            if (se.updateCubeScales) {
                se.updateCubeScales(view);
            }
            if (se.transformControl && se.transformControl.updateHandleScales) {
                se.transformControl.updateHandleScales(view);
            }
        }
    });
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
    const [xAxis, yAxis, zAxis] = getDebugMatrixAxisSegments(position, matrix, length);
    // draw the debug arrows
    DebugArrow(name+"Xaxis",xAxis.direction, xAxis.origin, xAxis.length,"#FF8080")
    DebugArrow(name+"Yaxis",yAxis.direction, yAxis.origin, yAxis.length,"#80FF80")
    DebugArrow(name+"Zaxis",zAxis.direction, zAxis.origin, zAxis.length,"#8080FF")

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
    // copy group layers bitmask into all children, only requesting a render if
    // a mask actually changed. These helpers are invoked from per-frame redraw
    // paths (e.g. the camera frustum rebuild), so an unconditional setRenderOne
    // re-armed the render loop every frame and pegged CPU on a static scene.
    const layersMask = parent.layers.mask;
    let changed = false;
    parent.traverse( function( child ) {
        if (child.layers.mask !== layersMask) { child.layers.mask = layersMask; changed = true; }
    } )
    if (changed) setRenderOne(true);
}

export function setLayerMaskRecursive(object, mask) {
    let changed = (object.layers.mask !== mask);
    object.layers.mask = mask;
    object.traverse( function( child ) {
        if (child.layers.mask !== mask) { child.layers.mask = mask; changed = true; }
    } )
    if (changed) setRenderOne(true);
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

// get intersection of a point/heading ray with the reference surface (ellipsoid or sphere at HAE=0).
// In ellipsoid mode, delegates to intersectEllipsoid for accuracy.
// In sphere mode (equatorRadius === polarRadius), uses fast sphere intersection.
export function intersectSurface(point, headingVector) {
    if (Globals.equatorRadius !== Globals.polarRadius) {
        return intersectEllipsoid(point, headingVector);
    }
    const globe = new Sphere(earthCenterECEF(), Globals.equatorRadius);
    const ray = new Ray(point, headingVector.clone().normalize());
    const sphereCollision = new Vector3();
    if (intersectSphere2(ray, globe, sphereCollision))
        return sphereCollision;
    return null;
}

// get intersection of a point/heading ray with the WGS84 ellipsoid
// More accurate than sphere intersection for high-latitude locations
export function intersectEllipsoid(point, headingVector) {
    const a = Globals.equatorRadius;
    const b = Globals.polarRadius;

    const dir = headingVector.clone().normalize();

    const ox = point.x, oy = point.y, oz = point.z;
    const dx = dir.x, dy = dir.y, dz = dir.z;
    
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
    
    return point.clone().add(dir.clone().multiplyScalar(t));
}

// Boolean-only ray-ellipsoid intersection test (no hit point allocation).
// Returns true if the ray from origin in the given direction intersects the WGS84 ellipsoid.
// Direction does not need to be normalized.
export function rayIntersectsEllipsoid(origin, direction) {
    const a = Globals.equatorRadius;
    const b = Globals.polarRadius;

    let ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = direction.x, dy = direction.y, dz = direction.z;

    const a2 = a * a, b2 = b * b;

    // If the origin is ON or INSIDE the ellipsoid, project it back out to just above the
    // surface before testing. A ground observer's altitude is geoid/terrain-relative, and
    // at sea level the geoid sits BELOW the WGS84 ellipsoid — so an observer "50 ft up"
    // can land a few metres inside it. With the origin inside (C <= 0) the two roots
    // straddle zero, so the exit root t2 is ALWAYS > 0 and EVERY direction (even straight
    // up) reports an intersection — which made every satellite read as below the horizon
    // and silently killed ALL flares for sea-level observers. Projecting to the surface
    // makes the entry/exit roots behave correctly (zenith → no hit, nadir → hit).
    const norm = (ox * ox + oy * oy) / a2 + (oz * oz) / b2;   // <1 inside, =1 on surface, >1 outside
    if (norm <= 1) {
        const s = (1 + 1e-9) / Math.sqrt(norm);   // scale out to fractionally above the surface
        ox *= s; oy *= s; oz *= s;
    }

    const A = (dx * dx + dy * dy) / a2 + (dz * dz) / b2;
    const B = 2 * ((ox * dx + oy * dy) / a2 + (oz * dz) / b2);
    const C = (ox * ox + oy * oy) / a2 + (oz * oz) / b2 - 1;

    const discriminant = B * B - 4 * A * C;
    if (discriminant < 0) return false;

    const sqrtDisc = Math.sqrt(discriminant);
    const t1 = (-B - sqrtDisc) / (2 * A);
    const t2 = (-B + sqrtDisc) / (2 * A);

    const EPS = 1e-6;
    return t1 > EPS || t2 > EPS;
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

        const lineDPR = (window.devicePixelRatio || 1) * getEffectiveRenderScale();
        this.material.resolution.set(window.innerWidth * lineDPR, window.innerHeight * lineDPR)
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

// get the point on the ground below a point in ECEF
// if the terrain model is loaded, use that, otherwise use the sphere
// `out` (optional) receives {altitudeHAE} of A when the terrain path runs —
// a byproduct of the conversion getPointBelow already does, letting callers
// skip an identical ECEFToLLA conversion of their own.
export function getPointBelow(A, raycast = false, out = undefined) {
    if (NodeMan.exists("TerrainModel")) {
        let terrainNode = NodeMan.get("TerrainModel")
        return terrainNode.getPointBelow(A, 0, raycast, out)
    } else {
        return pointOnSphereBelow(A);
    }
}

export function getPointBelowLL(lat, lon) {
    const A = LLAToECEF(lat, lon, 100000);
    return getPointBelow(A)
}

// Ground directly below an ECEF point taken from the actual loaded 3D building
// tiles (the rendered Google Photorealistic / OSM geometry), or null if there are
// no 3D tiles, none loaded directly below yet, or only implausible (coarse-stream)
// geometry there. Unlike getPointBelow() — which uses the smooth elevation map
// and ignores buildings — this raycasts the real tile polygons and returns the hit
// nearest the elevation-map ground. That is the walkable street surface in the open,
// but over a building footprint it is the ROOF: the tiles are a single draped mesh
// with no street beneath, so the roof is the only hit and any structure under 40 m
// is accepted. NOTE: query from
// NEAR the surface, not 100 km up — a high query point's local-up differs from the
// surface normal and biases the column sideways. See CNodeBuildings3DTiles.groundBelow.
export function getTilesPointBelow(A) {
    if (NodeMan.exists("buildings3DTiles")) {
        return NodeMan.get("buildings3DTiles").groundBelow(A);
    }
    return null;
}

// get the above ground altitude a point in ECEF
export function aboveGroundLevelAt(A) {
    const B = getPointBelow(A);
    const altitude = A.clone().sub(B).length();
    return altitude;
}

// True when the terrain basemap is not being rendered because Google
// Photorealistic 3D tiles are the visible ground (CNodeTerrainUI's
// updateTerrainAndOceanVisibility hides the terrain group in that mode).
function terrainBasemapHidden() {
    if (!NodeMan.exists("TerrainModel")) return false;
    return NodeMan.get("TerrainModel").group?.visible === false;
}

// How far above the elevation map a point can still be under a tile ground that
// groundBelow() would accept. Zero when there are no tiles, so callers fall
// straight through to the elevation map.
function tilesGroundTolerance() {
    if (!NodeMan.exists("buildings3DTiles")) return 0;
    return NodeMan.get("buildings3DTiles").groundTolerance ?? 0;
}

// THE ground the user can actually SEE under `point`, or null when that is just
// the elevation map and the caller should use getPointBelow() as usual.
//
// Only the Google 3D tiles can disagree with the elevation map about where the
// ground is, and they only ARE the ground while the terrain basemap is hidden.
// groundBelow() is the authority for the tile surface; null means "nothing
// better than the elevation map is available".
//
// Be precise about what that surface IS: Google photogrammetry is a single
// DRAPED mesh, so a building is a bump in it with no street surface underneath
// (measured over Torrance: a downward ray returns exactly ONE hit at all 144
// points sampled). groundBelow() therefore cannot tell roof from street — its
// "nearest the elevation map" arbitration degenerates to "the only hit", and its
// 40 m tolerance accepts any structure shorter than that. It is really
// "visible surface below", not "ground below".
//
// That is the RIGHT answer for the caller this exists for — someone pointing at
// a pixel wants the surface they pointed at, roof included — but it is why this
// must not be wired into a query that promises buildings-free terrain.
//
// Deliberately the single encoding of that rule: clampAboveGround() and
// adjustHeightAboveGround() both need it and differ only in what they do with
// the answer — clamp toward it, or set from it.
function visibleGroundBelow(point) {
    if (!terrainBasemapHidden()) return null;
    return getTilesPointBelow(point);
}

// given a point in ECEF, ensure it is at least "height" meters above the ground
// accounting for terrain.
// useVisibleGround opts in to clamping against the Google 3D-tile surface (see
// below). It costs a tile intersection — 0.196 ms measured, vs ~0 for the
// elevation-map lookup — so it is OFF by default: bulk callers like the
// Moon-shadow overlay clamp ~1,500 points per frame, which at that price is
// ~294 ms a frame against a 16.7 ms budget. Those callers sit on the ground by
// construction and don't need the precision. Pass true where something the user
// positions or flies is being placed (cameras, tracked objects).
export function clampAboveGround(point, height, useVisibleGround = false) {
    // getPointBelow already converts `point` to LLA internally; reuse that
    // altitude instead of a second identical conversion (this runs per frame
    // in the camera track-position sweep). Falls back to computing it when
    // there's no terrain model (out left unset).
    const out = {};
    const ground = getPointBelow(point, false, out);
    const pointAlt = out.altitudeHAE !== undefined ? out.altitudeHAE : calculateAltitude(point);
    const groundAlt = calculateAltitude(ground);

    // While Google Photorealistic 3D tiles are the rendered ground the terrain
    // basemap is hidden, and the elevation map is NOT the surface the user sees.
    // It lands on either side of the tile ground (measured in one Athens block:
    // ~12 m above it in most columns, up to ~6 m below it in a fifth of them), so
    // clamping to it either parks the object in mid-air over the visible street —
    // its height stops responding while the AGL readout bottoms out well above
    // zero — or buries it under one. Clamp to the tile surface in BOTH directions
    // instead; groundBelow() is the authority there and rejects coarse-LOD tiles by
    // returning null, in which case the elevation map is still the best ground
    // available. It does NOT reject roofs — over a building footprint the roof is the
    // only hit — but clamping something the user placed to the visible surface it
    // stands on is the intended behaviour here.
    if (useVisibleGround && terrainBasemapHidden()) {
        // Skipping the raycast is only sound while the point sits too high for any
        // ACCEPTED tile ground to reach it — groundBelow() takes tile hits within
        // its own tolerance of the elevation map, so that band is the safe margin.
        if (pointAlt - groundAlt > height + tilesGroundTolerance()) {
            return point;
        }
        const tileGround = visibleGroundBelow(point);
        if (tileGround !== null) {
            const tileAlt = calculateAltitude(tileGround);
            return (pointAlt - tileAlt > height) ? point : pointAbove(tileGround, height);
        }
    }

    if (pointAlt - groundAlt > height) {
        return point;
    }
    return pointAbove(ground, height);
}

// get the AGL altitude at a point speciifed by lat/lon
export function aboveGroundLevelAtLL(lat, lon) {
    const A = LLAToECEF(lat, lon, 100000);
    return aboveGroundLevelAt(A)
}

// given a point in ECEF, return a point above (or below) it by a given additional height
export function pointAbove(point, height) {
    return raisePoint(point, height);
}

// Put `point` AT `height` above the ground. A SET, not a clamp — contrast
// clampAboveGround(), which leaves a point that is already high enough alone.
//
// `options` is {raycast, useVisibleGround}. A bare boolean is still accepted and
// means {raycast}, which is how every pre-existing call reads.
//
// useVisibleGround matters only while Google Photorealistic 3D tiles are the
// rendered ground, because there the elevation map is NOT the surface on screen:
// measured in one Athens block it sits ~12 m above the tile ground in most
// columns and up to ~6 m below it in a fifth of them. Anything the user places by
// pointing AT the screen wants the surface they pointed at. It is off by default
// because it costs a tile raycast (~0.2 ms) that bulk callers — which sit on the
// ground by construction — do not need.
//
// When asked for, the tile ground is resolved FIRST: on success the terrain is
// never consulted, so `raycast` cannot spend a millisecond raycasting a basemap
// that is hidden anyway. It remains the fallback for when no tile ground there
// is acceptable.
export function adjustHeightAboveGround (point, height, options = false) {
    const {raycast = false, useVisibleGround = false} =
        (typeof options === "boolean") ? {raycast: options} : (options ?? {});

    if (useVisibleGround) {
        const visible = visibleGroundBelow(point);
        if (visible !== null) return pointAbove(visible, height);
    }

    return pointAbove(getPointBelow(point, raycast), height);
}

export function adjustHeightHAE(point, height) {
    return setAltitudeHAE(point, height);
}

export function calculateAltitude(point) {
    return altitudeHAE(point);
}

// given a lat/lon, calculate the terrain elevation of the ground above the WGS84 ellipsoid
// (i.e. the HAE altitude of the ground below that point)
// uses the terrain model if available, otherwise uses the WGS84 ellipsoid
export function elevationAtLL(lat, lon, raycast = false) {
    // get the point in ECEF
    const point = LLAToECEF(lat, lon, 100000);
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
    texture.colorSpace = SRGBColorSpace;

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

