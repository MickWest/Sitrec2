import {radians, tan, unitsToMeters} from "../utils";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import {CNode3DGroup} from "./CNode3DGroup";
import {DebugArrow, dispose, removeDebugArrow} from "../threeExt";
import {Globals, guiMenus, guiShowHide, NodeMan, setRenderOne, Units} from "../Globals";
import {disposeMatLine, makeMatLine} from "../MatLines";
import {LineSegmentsGeometry} from "three/addons/lines/LineSegmentsGeometry.js";
import {
    CanvasTexture,
    DoubleSide,
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    Ray,
    Raycaster,
    Sphere,
    Vector3
} from "three";
import {earthCenterEUS, getLocalUpVector} from "../SphericalMath";
import {EUSToLLA} from "../LLA-ECEF-ENU";
import {CNodeGroundOverlay} from "./CNodeGroundOverlay";
import * as LAYER from "../LayerMasks";
import {assert} from "../assert.js";
import {intersectSphere2} from "../threeUtils";
import {CNodeGUIValue} from "./CNodeGUIValue";

export class CNodeDisplayCameraFrustumATFLIR extends CNode3DGroup {
    constructor(v) {
        super(v);
        this.radius = v.radius ?? 100
        this.fov = v.fov

        this.color = v.color
        this.lineWeigh = v.lineWeight ?? 1;
        this.matLine = makeMatLine(this.color, this.lineWeigh)


        var s = this.radius * tan(radians(this.fov))
        var d = -(this.radius - 2)
        const line_points = [
            0, 0, 0, s, s, -d,
            0, 0, 0, s, -s, -d,
            0, 0, 0, -s, -s, -d,
            0, 0, 0, -s, s, -d,
            -s, -s, -d,
            s, -s, -d,
            s, s, -d,
            -s, s, -d,
            -s / 2, s, -d,
            0, s * 1.3, -d,
            s / 2, s, -d,
        ]


        this.FrustumGeometry = new LineGeometry();
        this.FrustumGeometry.setPositions(line_points);
        var line = new Line2(this.FrustumGeometry, this.matLine);
        line.computeLineDistances();
        line.scale.setScalar(1);
        this.group.add(line)
    }
}

export class CNodeDisplayCameraFrustum extends CNode3DGroup {
    constructor(v) {

        const cameraNode = NodeMan.get(v.camera ?? "lookCamera")
        if (v.id === undefined) {
            v.id = cameraNode.id+"_Frustum";
        }

        v.color ??= "white";
        v.layers ??= LAYER.MASK_HELPERS;
       // v.container = v.camera;
        super(v);
        this.radius = v.radius ?? 100
        this.input("targetTrack",true)
        this.cameraNode = cameraNode;
        this.camera = this.cameraNode.camera;

        //this.color = v.color.v();

        this.input("color")
        this.lastColor = {}
        this.lineWeigh = v.lineWeight ?? 1.5;

        this.units = v.units ?? "meters";
        this.step = v.step ?? 0;

        this.camera.visible = true;

        this.showQuad = v.showQuad ?? false;

        this.showFrustum = v.showFrustum ?? true;
        this.showHider("Camera View Frustum");
        this.guiToggle("showQuad", "Frustum Ground Quad")

        this.showVideoInFrustum = false;
        guiShowHide.add(this, "showVideoInFrustum").name("Video in Frustum").listen().onChange((v) => {
            this.updateVideoQuadVisibility();
            setRenderOne(true);
        })
        this.addSimpleSerial("showVideoInFrustum")

        this.showVideoOnGround = false;
        guiShowHide.add(this, "showVideoOnGround").name("Video on Ground").listen().onChange((v) => {
            this.updateGroundVideoQuadVisibility();
            setRenderOne(true);
        })
        this.addSimpleSerial("showVideoOnGround")

        this.showGroundVideoInLookView = false;
        guiShowHide.add(this, "showGroundVideoInLookView").name("Ground Video in Look View").listen().onChange((v) => {
            this.updateGroundVideoLayerMask();
            setRenderOne(true);
        })
        this.addSimpleSerial("showGroundVideoInLookView")


        const _dist = Number(Units.mToBig(2000))
        const _end = Number(Units.mToBig(10000))
        const _step = Number(Units.mToBig(100,5))

        this.videoDistanceNode = new CNodeGUIValue({
            id: this.id + "_videoDistance",
            value: _dist,
            start: 0,
            end: _end,
            step: _step,
            desc: "Video Distance",
            unitType: "big",
        }, guiMenus.showhide);

        this.videoOpacity = 1.0;
        guiShowHide.add(this, "videoOpacity", 0, 1, 0.01).name("Video Opacity").listen().onChange(() => {
            if (this.videoQuadMaterial) {
                this.videoQuadMaterial.opacity = this.videoOpacity;
            }
            setRenderOne(true);
        })
        this.addSimpleSerial("videoOpacity")

        this.videoQuad = null;
        this.videoQuadMaterial = null;
        this.videoTexture = null;
        this.videoCanvas = null;
        this.videoCtx = null;

        this.groundVideoOverlay = null;
        this.groundVideoCanvas = null;
        this.groundVideoCtx = null;
        this.groundVideoTexture = null;

        this.rebuild()
    }

    updateVideoQuadVisibility() {
        if (this.videoQuad) {
            this.videoQuad.visible = this.showVideoInFrustum;
        }
    }

    updateGroundVideoQuadVisibility() {
        if (this.groundVideoOverlay) {
            this.groundVideoOverlay.group.visible = this.showVideoOnGround;
        }
    }

    updateGroundVideoLayerMask() {
        if (this.groundVideoOverlay) {
            let mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
            if (!this.showGroundVideoInLookView) {
                mask = LAYER.MASK_MAIN;
            }
            this.groundVideoOverlay.group.layers.mask = mask;
            this.groundVideoOverlay.group.traverse((child) => {
                child.layers.mask = mask;
            });
        }
    }

    createGroundVideoOverlay() {
        if (this.groundVideoOverlay) return;

        this.groundVideoCanvas = document.createElement('canvas');
        this.groundVideoCanvas.width = 256;
        this.groundVideoCanvas.height = 256;
        this.groundVideoCtx = this.groundVideoCanvas.getContext('2d');
        this.groundVideoTexture = new CanvasTexture(this.groundVideoCanvas);
        this.groundVideoTexture.flipY = false;

        this.groundVideoOverlay = new CNodeGroundOverlay({
            id: this.id + "_groundVideoOverlay",
            noGUI: true,
            freeTransform: true,
            corners: [
                {lat: 0, lon: 0},
                {lat: 0, lon: 0.001},
                {lat: -0.001, lon: 0.001},
                {lat: -0.001, lon: 0},
            ],
            opacity: this.videoOpacity,
            layers: this.group.layers.mask,
        });
        this.groundVideoOverlay.setTexture(this.groundVideoTexture);
        this.groundVideoOverlay.group.visible = this.showVideoOnGround;
        this.updateGroundVideoLayerMask();
    }

    updateGroundVideoOverlay(f, worldCorners) {
        if (!this.showVideoOnGround) {
            if (this.groundVideoOverlay) {
                this.groundVideoOverlay.group.visible = false;
            }
            return;
        }

        if (!worldCorners || worldCorners.some(c => c === null)) {
            if (this.groundVideoOverlay) {
                this.groundVideoOverlay.group.visible = false;
            }
            return;
        }

        const videoNode = NodeMan.get("video", false);
        if (!videoNode || !videoNode.videoData) {
            if (this.groundVideoOverlay) {
                this.groundVideoOverlay.group.visible = false;
            }
            return;
        }

        const image = videoNode.videoData.getImage(f);
        if (!image || !image.width) {
            if (this.groundVideoOverlay) {
                this.groundVideoOverlay.group.visible = false;
            }
            return;
        }

        if (!this.groundVideoOverlay) {
            this.createGroundVideoOverlay();
        }

        if (this.groundVideoCanvas.width !== image.width || this.groundVideoCanvas.height !== image.height) {
            this.groundVideoCanvas.width = image.width;
            this.groundVideoCanvas.height = image.height;
        }

        this.groundVideoCtx.save();
        this.groundVideoCtx.translate(0, image.height);
        this.groundVideoCtx.scale(1, -1);
        this.groundVideoCtx.drawImage(image, 0, 0);
        this.groundVideoCtx.restore();
        this.groundVideoTexture.needsUpdate = true;

        if (this.groundVideoOverlay.overlayMaterial) {
            this.groundVideoOverlay.overlayMaterial.uniforms.opacity.value = this.videoOpacity;
        }

        const llaCorners = worldCorners.map(corner => {
            const lla = EUSToLLA(corner);
            return {lat: lla.x, lon: lla.y};
        });

        this.groundVideoOverlay.setFreeTransformCorners(llaCorners);
        this.updateGroundVideoLayerMask();
        this.groundVideoOverlay.group.visible = true;
    }

    createVideoQuad() {
        if (this.videoQuad) return;

        this.videoCanvas = document.createElement('canvas');
        this.videoCanvas.width = 256;
        this.videoCanvas.height = 256;
        this.videoCtx = this.videoCanvas.getContext('2d');

        this.videoTexture = new CanvasTexture(this.videoCanvas);

        this.videoQuadMaterial = new MeshBasicMaterial({
            map: this.videoTexture,
            side: DoubleSide,
            transparent: true,
            opacity: this.videoOpacity,
            depthWrite: false,
        });

        const geometry = new PlaneGeometry(1, 1);
        this.videoQuad = new Mesh(geometry, this.videoQuadMaterial);
        this.videoQuad.visible = this.showVideoInFrustum;
        this.videoQuad.layers.mask = this.group.layers.mask;
        this.group.add(this.videoQuad);
    }

    updateVideoQuad(f) {
        if (!this.showVideoInFrustum) return;

        const videoNode = NodeMan.get("video", false);
        if (!videoNode || !videoNode.videoData) return;

        const image = videoNode.videoData.getImage(f);
        if (!image || !image.width) return;

        if (!this.videoQuad) {
            this.createVideoQuad();
        }

        if (this.videoCanvas.width !== image.width || this.videoCanvas.height !== image.height) {
            this.videoCanvas.width = image.width;
            this.videoCanvas.height = image.height;
        }

        this.videoCtx.drawImage(image, 0, 0);
        this.videoTexture.needsUpdate = true;

        const videoDistance = this.videoDistanceNode.getValueFrame(f);
        const h = videoDistance * tan(radians(this.camera.fov / 2));
        const w = h * this.camera.aspect;

        this.videoQuad.scale.set(w * 2, h * 2, 1);
        this.videoQuad.position.set(0, 0, -videoDistance);
        this.videoQuad.visible = true;
    }

    rebuild() {

        // TODO: This is rather messy in the way it handles colors and line materials
        // a CNodeGUIColor is returning a hex string, as that's what lil-gui uses
        // but would a CNodeConstant do the same?
        // generally color handling is a bit of a mess, and needs to be cleaned up
        // specifically the converting between various format. Can we settle on just one type for colors?
        // what about HDR later?

        // rebuild the matLine if the color or lineWeight has changed
        // (only color for now, but if lightWeight becomes a node, add that here)
        const color = this.in.color.v0;
        // we assume that the color is a THREE.Color
        // but we need a hex string for lil-gui
        // so we convert it to a hex string
        const hexColor = "#"+color.getHexString();

        if (this.matLine === undefined || hexColor !== this.lastColor) {
            disposeMatLine(this.matLine);
            this.matLine = makeMatLine(hexColor, this.lineWeigh);
            this.lastColor = hexColor;
        }


        this.group.remove(this.line)
        dispose(this.FrustumGeometry)

        const fov = this.camera.renderedFOV || this.camera.fov;
        var h = this.radius * tan(radians(fov/2))
        assert(!isNaN(h), "h is NaN, fov="+fov+" radius="+this.radius+" aspect="+this.camera.aspect+" units="+this.units+" step="+this.step);
        // aspect is w/h so w = h * aspect
        var w = h * this.camera.aspect;
        var d = (this.radius - 2)
//        console.log("REBUILDING FRUSTUM h="+h+" w="+w+" d="+d);
        const line_points = [
            0, 0, 0, w, h, -d,
            0, 0, 0, w, -h, -d,
            0, 0, 0, -w, -h, -d,
            0, 0, 0, -w, h, -d,
            -w, -h, -d, w, -h, -d,
            w, -h, -d,  w, h, -d,
            w, h, -d, -w, h, -d,
            -w, h, -d, -w, -h, -d,
            // -w / 2, h, -d,
            // 0, h * 1.3, -d,
            // w / 2, h, -d,
        ]

        if (this.step > 0) {

            const step = unitsToMeters(this.units,this.step);

            for (let r = step; r < this.radius; r += step) {
                h = r * tan(radians(fov / 2))
                w = h * this.camera.aspect;
                d = r;
                line_points.push(
                    -w, -h, -d, w, -h, -d,
                    w, -h, -d, w, h, -d,
                    w, h, -d, -w, h, -d,
                    -w, h, -d, -w, -h, -d,
                )
            }

        }


// WORK IN PROGRESS.  calculating the ground quadrilateral intersecting the frustum with the ground

        this.groundWorldCorners = null;
        if (this.showQuad || this.showVideoOnGround) {
            this.camera.updateMatrixWorld();
            let frustumH = this.radius * tan(radians(fov / 2));
            let frustumW = frustumH * this.camera.aspect;
            const frustumD = this.radius - 2;

            if (this.showVideoOnGround) {
                const videoNode = NodeMan.get("video", false);
                if (videoNode && videoNode.videoData) {
                    const videoWidth = videoNode.videoData.videoWidth;
                    const videoHeight = videoNode.videoData.videoHeight;
                    if (videoWidth && videoHeight) {
                        const videoAspect = videoWidth / videoHeight;
                        const cameraAspect = this.camera.aspect;
                        if (videoAspect > cameraAspect) {
                            frustumH *= cameraAspect / videoAspect;
                        } else {
                            frustumW *= videoAspect / cameraAspect;
                        }
                    }
                }
            }

            let corner = new Array(4)

            if (NodeMan.exists("TerrainModel")) {
                let terrainNode = NodeMan.get("TerrainModel")
                corner[0] = terrainCollideCameraRelative(terrainNode, this.camera, new Vector3(-frustumW, -frustumH, -frustumD))
                corner[1] = terrainCollideCameraRelative(terrainNode, this.camera, new Vector3(frustumW, -frustumH, -frustumD))
                corner[2] = terrainCollideCameraRelative(terrainNode, this.camera, new Vector3(frustumW, frustumH, -frustumD))
                corner[3] = terrainCollideCameraRelative(terrainNode, this.camera, new Vector3(-frustumW, frustumH, -frustumD))
            } else {
                corner[0] = null;
                corner[1] = null;
                corner[2] = null;
                corner[3] = null;
            }

            // if any corner is null, then we don't have a complete quadrilateral
            // so we try the collisions again, but this time against a globe, a sphere
            // if all corners are nell then radius of the globle is wgs84.radius
            // otherwise it's the average.
            // note the results are in world space
            const sphereCenter = earthCenterEUS();
            // first calculate the radius of the sphere
            let sphereRadius = Globals.equatorRadius;
            // let n = 0;
            // let rSum = 0;
            // for (let i = 0; i < 4; i++) {
            //     if (corner[i] !== null) {
            //         n++;
            //         rSum += corner[i].clone().sub(sphereCenter).length();
            //     }
            // }
            // if (n > 0) {
            //     sphereRadius = rSum / n;
            // }

            // now make a sphere with that radius
            const globe = new Sphere(sphereCenter, sphereRadius);

            // now we can try the sphere collisions for any that missed the terrain
            if (corner[0] === null) {
                corner[0] = sphereCollideCameraRelative(globe, this.camera, new Vector3(-frustumW, -frustumH, -frustumD))
            }
            if (corner[1] === null) {
                corner[1] = sphereCollideCameraRelative(globe, this.camera, new Vector3(frustumW, -frustumH, -frustumD))
            }
            if (corner[2] === null) {
                corner[2] = sphereCollideCameraRelative(globe, this.camera, new Vector3(frustumW, frustumH, -frustumD))
            }
            if (corner[3] === null) {
                corner[3] = sphereCollideCameraRelative(globe, this.camera, new Vector3(-frustumW, frustumH, -frustumD))
            }

            // if we have all 4 corners, then we can draw the quadrilateral
            // Construct the quadrilateral from the corners
            // converting them back to local space, as they are attached to the camera
            if (corner[0] !== null && corner[1] !== null && corner[2] !== null && corner[3] !== null) {
                const localUp = getLocalUpVector(corner[0])
                this.groundWorldCorners = [
                    corner[0].clone(),
                    corner[1].clone(),
                    corner[2].clone(),
                    corner[3].clone(),
                ];
                corner[0] = this.camera.worldToLocal(corner[0]).add(localUp);
                corner[1] = this.camera.worldToLocal(corner[1]).add(localUp);
                corner[2] = this.camera.worldToLocal(corner[2]).add(localUp);
                corner[3] = this.camera.worldToLocal(corner[3]).add(localUp);
                if (this.showQuad) {
                    line_points.push(
                        corner[0].x, corner[0].y, corner[0].z,
                        corner[1].x, corner[1].y, corner[1].z,
                        corner[1].x, corner[1].y, corner[1].z,
                        corner[2].x, corner[2].y, corner[2].z,
                        corner[2].x, corner[2].y, corner[2].z,
                        corner[3].x, corner[3].y, corner[3].z,
                        corner[3].x, corner[3].y, corner[3].z,
                        corner[0].x, corner[0].y, corner[0].z,
                    )
                }
            }

        }

        if (this.showFrustum) {
            this.FrustumGeometry = new LineSegmentsGeometry();
            this.FrustumGeometry.setPositions(line_points);
            this.line = new Line2(this.FrustumGeometry, this.matLine);
            this.line.computeLineDistances();
            this.line.scale.setScalar(1);
            this.group.add(this.line)
        }
        this.propagateLayerMask();
        this.lastFOV = this.camera.fov;



    }

    update(f) {

        const fov = this.camera.fov

        assert(fov !== undefined,"FOV is undefined for camera controlled by "+this.id)
        assert(!isNaN(fov),"FOV is NaN for "+this.id)

        // if we have a target track, then we can use that to set the radius (distance to the end of the frustum)
        if (this.in.targetTrack !== undefined) {
            const targetPos = this.in.targetTrack.p(f)
            this.radius = targetPos.clone().sub(this.camera.position).length()
        }

      //  this.label.changePosition(this.camera.position)

        // const A = this.camera.position;
        // let B;
        // if (NodeMan.exists("TerrainModel")) {
        //     let terrainNode = NodeMan.get("TerrainModel")
        //     B = terrainNode.getPointBelow(A)
        // } else {
        //     B = pointOnSphereBelow(A);
        // }
     //   this.measureAltitude.changeAB(A,B)

        this.group.position.copy(this.camera.position)
        this.group.quaternion.copy(this.camera.quaternion)
        this.group.updateMatrix();
        this.group.updateMatrixWorld();
    //    if (this.lastFOV !== this.camera.fov || this.lastAspect !== this.camera.aspect || (this.in.targetTrack !== undefined)) {
            this.lastAspect = this.camera.aspect;
            this.lastFOV = this.camera.fov;
            this.rebuild();
    //    }

        this.updateVideoQuad(f);
        this.updateGroundVideoOverlay(f, this.groundWorldCorners);
    }
}


export class CNodeDisplayGroundMovement extends CNode3DGroup {
    constructor(v) {
        const cameraNode = NodeMan.get(v.camera ?? "lookCamera")
        if (v.id === undefined) {
            v.id = cameraNode.id+"_Frustum";
        }

        v.color ??= "white";
        v.layers ??= LAYER.MASK_LOOKRENDER;

        super(v);
        this.cameraNode = cameraNode;
        this.camera = this.cameraNode.camera;

        this.p1 = new Vector3(0, 0, 0);
        this.p2 = new Vector3(0, 0, 0);

        this.rebuild();



    }

    update(f) {
        this.rebuild();

    }


    rebuild() {

        this.p1.copy(this.p2);
        let center = null
        if (NodeMan.exists("TerrainModel")) {
            let terrainNode = NodeMan.get("TerrainModel")
            center = terrainCollideCameraRelative(terrainNode, this.camera, new Vector3(0, 0, -1000));
        }
        if (center === null) {
            // if we don't have a terrain model, then we can use the globe
            center = sphereCollideCameraRelative(new Sphere(earthCenterEUS(), Globals.equatorRadius), this.camera, new Vector3(0, 0, -1000));
        }
        if (center === null) {
//            console.warn("CNodeDisplayGroundMovement: No ground found for camera at "+this.camera.position);
            removeDebugArrow(this.id+"_Arrow");
            return;
        }
        const localUp = getLocalUpVector(center);
        center.add(localUp); // add a little bit to the center to avoid z-fighting with the ground


        this.p2.copy(center);

        let dir = this.p2.clone().sub(this.p1);
        const length = this.p1.distanceTo(this.p2) * 30;

        if (length >0.1) {
            // export function DebugArrow(name, direction, origin, _length = 100, color="#FFFFFF", visible=true, parent, _headLength=20, layerMask=LAYER.MASK_HELPERS) {
            DebugArrow(this.id + "_Arrow", dir, this.p2, length, '#FFFF00', true, this.container, 10, LAYER.MASK_LOOKRENDER);
        }

    }
}



function terrainCollideCameraRelative(terrain, camera, localPos) {
    const pos = camera.localToWorld(localPos);
    const rayCaster = new Raycaster(camera.position, pos.sub(camera.position).normalize());
    rayCaster.layers.mask  |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;
    const ground = terrain.getClosestIntersect(rayCaster);
    if (ground !== null) {
        return ground.point;
    }
    return null;
}

function sphereCollideCameraRelative(sphere, camera, localPos) {
    const pos = camera.localToWorld(localPos);
    const ray = new Ray(camera.position, pos.sub(camera.position).normalize());
    const sphereCollision = new Vector3();
    if (intersectSphere2(ray, sphere, sphereCollision))
        return sphereCollision;
    return null;

}


