import {SplineEditor} from "../SplineEditor";
import {Globals, guiMenus, NodeMan, Sit, TrackManager} from "../Globals";
import {Vector3} from "three";
import {getCameraNode} from "./CNodeCamera";
import {assert} from "../assert.js";
import {CNodeTrack} from "./CNodeTrack";
import {EUSToLLA, LLAVToEUS} from "../LLA-ECEF-ENU";
import {adjustHeightAboveGround, adjustHeightMSL, pointAbove} from "../threeExt";
import {EventManager} from "../CEventManager";

// a node wrapper for varioius spline editors
export class CNodeSplineEditor extends CNodeTrack {
    constructor(v) {
        super(v);
        this.frames = v.frames ?? Sit.frames
        assert(this.frames >0, "CNodeSplineEditor has frames=0")

        // Default to time-based interpolation (not constant speed)
        this.constantSpeed = false;
        
        // Default to extrapolating beyond first/last control points
        this.extrapolateTrack = true;
        
        // Store the curve type
        this.curveType = v.type ? v.type.toLowerCase() : 'chordal';
        
        assert(v.view !== undefined, "CNodeSplineEditor needs a view");
        const view = NodeMan.get(v.view) // convert id to node, if needed
        const renderer = view.renderer;
        const controls = view.controls;

        const camera = getCameraNode(v.camera).camera;

        // Auto-detect legacy EUS: if initialPoints is provided without initialPointsLLA,
        // assume the points are in old EUS local tangent plane coordinates
        const legacyEUS = v.legacyEUS ?? (v.initialPoints !== undefined && v.initialPointsLLA === undefined);
        this.reprojectOnEarthModelChange =
            v.reprojectOnEarthModelChange ?? (v.initialPointsLLA !== undefined || legacyEUS);
        this._earthModelSignature = this.getEarthModelSignature();
        this._controlPointsLLA = null;

        if (v.initialPointsLLA === undefined) {
            this.splineEditor = new SplineEditor(v.scene, camera, renderer, controls, () => this.recalculateCascade(),
                v.initialPoints, false, v.type.toLowerCase(), legacyEUS)
        } else {
            this.splineEditor = new SplineEditor(v.scene, camera, renderer, controls, () => this.recalculateCascade(),
                v.initialPointsLLA, true, v.type.toLowerCase())
        }
        
        // Store reference to parent node so PointEditor can access extrapolateTrack setting
        this.splineEditor.parentNode = this;

        this.optionalInputs(["snapCamera","snapTarget"])
        if (this.in.snapCamera !== undefined) {
            this.splineEditor.snapCamera  = this.in.snapCamera;
            this.splineEditor.snapTarget  = this.in.snapTarget;
        }

        this.enable = false;

        // Only create GUI in physics menu if skipGUI is not set
        // This allows TrackManager to manage synthetic tracks without duplicate GUIs
        if (!v.skipGUI) {
            this.gui = guiMenus.physics.addFolder("Spline " + this.id).close()
            this.gui.add(this,"enable").onChange( v =>{
               this.splineEditor.setEnable(v)
            })
            this.gui.add(this,"exportSpline")
        }

        EventManager.addEventListener("elevationChanged", () => {
            if (this.altitudeLock !== undefined && this.altitudeLock >= 0) {
                const terrainNode = NodeMan.get("TerrainModel", false);
                if (terrainNode) {
                    this.refreshElevationCache(terrainNode, this.altitudeLock);
                }
                this.recalculateCascade();
            }
        });

        this.recalculate()
        this.splineEditor.updatePointEditorGraphics()
    }

    dispose() {
        const trackOb = TrackManager.get(this.id, false);
        
        if (trackOb && trackOb.objectID) {
            const objectNode = NodeMan.get(trackOb.objectID, false);
            if (objectNode) {
                // dispose the node and it's input (controller) nodes
                NodeMan.disposeRemove(objectNode, true);
            }
        }
        super.dispose();
    }

    modSerialize() {


        assert(this.splineEditor.frameNumbers !== undefined, "CNodeSplineEditor has no frameNumbers")
        // check same length
        assert(this.splineEditor.frameNumbers.length === this.splineEditor.positions.length, "CNodeSplineEditor frameNumbers and positions length mismatch")


        let positions = [];
        for (let i=0;i<this.splineEditor.positions.length;i++) {
            const p = this.splineEditor.positions[i];
            // Convert EUS coordinates to LLA (lat, lon, alt) for storage
            const lla = EUSToLLA(p);
            positions.push([this.splineEditor.frameNumbers[i], lla.x, lla.y, lla.z])
        }
        const result = {
            ...super.modSerialize(),
            positions: positions,
            constantSpeed: this.constantSpeed,
            extrapolateTrack: this.extrapolateTrack,
            altitudeLock: this.altitudeLock,
            altitudeLockAGL: this.altitudeLockAGL,
            curveType: this.curveType,
        };
        const elevCache = this.serializeElevationCache();
        if (elevCache) result.elevationCache = elevCache;
        return result;
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.positions !== undefined) {
            // Convert LLA coordinates back to EUS before loading into spline editor
            let eusPositions = [];
            for (let i = 0; i < v.positions.length; i++) {
                const posData = v.positions[i];
                const frameNumber = posData[0];
                const lla = new Vector3(posData[1], posData[2], posData[3]);
                const eus = LLAVToEUS(lla);
                eusPositions.push([frameNumber, eus.x, eus.y, eus.z]);
            }
            this.splineEditor.load(eusPositions)
        }
        if (v.constantSpeed !== undefined) {
            this.constantSpeed = v.constantSpeed
        }
        if (v.extrapolateTrack !== undefined) {
            this.extrapolateTrack = v.extrapolateTrack
        }
        if (v.altitudeLock !== undefined) {
            this.altitudeLock = v.altitudeLock
            this.altitudeLockAGL = v.altitudeLockAGL ?? true
            this.updateAltitudeLock()
        }
        if (v.curveType !== undefined) {
            this.setCurveType(v.curveType)
        }
        if (v.elevationCache !== undefined) {
            this.deserializeElevationCache(v.elevationCache);
        }
        if (this.reprojectOnEarthModelChange) {
            this._earthModelSignature = this.getEarthModelSignature();
            this._controlPointsLLA = this.captureControlPointsLLA();
        }
    }

    getEarthModelSignature() {
        return `${Globals.equatorRadius}:${Globals.polarRadius}:${Sit.lat}:${Sit.lon}`;
    }

    captureControlPointsLLA() {
        const frameNumbers = this.splineEditor?.frameNumbers ?? [];
        const positions = this.splineEditor?.positions ?? [];
        const points = [];
        for (let i = 0; i < positions.length; i++) {
            const lla = EUSToLLA(positions[i]);
            points.push([frameNumbers[i], lla.x, lla.y, lla.z]);
        }
        return points;
    }

    reprojectControlPointsFromLLA() {
        if (!this._controlPointsLLA || this._controlPointsLLA.length === 0) return;

        const eusPositions = [];
        for (let i = 0; i < this._controlPointsLLA.length; i++) {
            const [frameNumber, lat, lon, alt] = this._controlPointsLLA[i];
            const eus = LLAVToEUS(new Vector3(lat, lon, alt));
            eusPositions.push([frameNumber, eus.x, eus.y, eus.z]);
        }
        this.splineEditor.load(eusPositions);
        this.splineEditor.updatePointEditorGraphics();
    }

    reprojectControlPointsIfNeeded() {
        if (!this.reprojectOnEarthModelChange) return;

        const signature = this.getEarthModelSignature();
        if (signature === this._earthModelSignature) return;

        if (!this._controlPointsLLA || this._controlPointsLLA.length === 0) {
            this._controlPointsLLA = this.captureControlPointsLLA();
        }

        this.reprojectControlPointsFromLLA();
        this._earthModelSignature = signature;
    }
    
    setAltitudeLock(value) {
        this.altitudeLock = value;
        if (value < 0) this.elevationCache = null;
        this.updateAltitudeLock();
        this.recalculateCascade();
    }
    
    updateAltitudeLock() {
        if (this.splineEditor && this.splineEditor.transformControl) {
            this.splineEditor.transformControl.setAltitudeLocked(this.altitudeLock >= 0, this.altitudeLock);
        }
    }
    
    applyAltitudeLock(position, frame) {
        if (this.altitudeLock !== undefined && this.altitudeLock >= 0) {
            if (this.altitudeLockAGL === false) {
                return adjustHeightMSL(position, this.altitudeLock);
            }
            if (frame !== undefined) {
                const terrainNode = NodeMan.get("TerrainModel", false);
                if (terrainNode) {
                    const ground = this.getPointBelowCached(terrainNode, position, 0, frame);
                    return pointAbove(ground, this.altitudeLock);
                }
            }
            return adjustHeightAboveGround(position, this.altitudeLock);
        }
        return position;
    }

    setCurveType(type) {
        this.curveType = type;
        if (this.splineEditor && typeof this.splineEditor.setCurveType === 'function') {
            this.splineEditor.setCurveType(type);
            this.recalculateCascade();
        }
    }

    exportSpline() {
        this.splineEditor.exportSpline()
    }

    update(f) {
        if (this.splineEditor.dirty) {
            this.splineEditor.dirty = false;
            this.recalculateCascade(f)
        }
    }

    // a spline is parametric and we step along it as a function of t
    recalculate() {
//        console.log("+++++Start Recalculate Spline")
 //       const spline = this.splineEditor.spline;
        this.reprojectControlPointsIfNeeded();
        this.array = []
        var pos = new Vector3()


        /*
        this.length = this.splineEditor.getLength(this.frames) // get length, based on the frames

        //console.log ("Spline length = " + len)

        // First get an array of the length at each value of t
        // with this.resolution steps

        var len = 0;
        var lastPos = new THREE.Vector3()
        var pos = new THREE.Vector3()
//        this.splineEditor.getPoint(0,lastPos)
        lastPos = this.splineEditor.getPointFrame(0)

        this.lengths = []
        this.tPositions = []
        // array is essentially indexed by t
        // where t = i/(frames-1)
        // so i = t*(fframes-1)
        this.tPositions.push(lastPos.clone())
        this.lengths.push(0)
        for (var i=1;i<this.frames;i++){

            var t = i/(this.frames-1) // go from 0 to 1, so we need frames-1 for the last one
            this.splineEditor.getPoint(t,pos)


            len += pos.clone().sub(lastPos).length()
            lastPos.copy(pos)
            this.lengths.push(len)
            this.tPositions.push(pos.clone())
        }

        // we now want an array of positions indexed by length (ie points are equidistant)
        // so step t along the length array until the length at that point
        var tIndex = 0;  // index into the above array

        var lengthStep = this.length/this.frames

        // the first one (lenght of 0) is always the same as t=0
        this.array.push({position:this.tPositions[0].clone()})
        for (var l=lengthStep;l<this.length;l+=lengthStep) {
            // advance tIndex until the length at that point is >= the needed length
            while (this.lengths[tIndex] < l) {
                tIndex++
            }

            if (tIndex >= this.lengths.length) {
                break;
            }
            // we now have the first tIndex that is GREATER OR EQUAL TO the length needed
            // we also know that tIndex > 0, so we can use tIndex-1 safely
            assert(tIndex > 0, "tIndex is "+tIndex )
            var aLen = this.lengths[tIndex-1]
            var bLen = this.lengths[tIndex]
            var fraction = (bLen-l)/(bLen-aLen)
            // fraction is how far from a to b we are for position L
            var aPos = this.tPositions[tIndex-1]
            var bPos = this.tPositions[tIndex]
            var a2b = bPos.clone().sub(aPos)
            var fractionPos = aPos.clone().add(a2b.multiplyScalar(fraction))

            this.array.push({position:fractionPos})



        }
    */

        // update snapping, if needed
        this.splineEditor.updateSnapping();

        if (this.constantSpeed) {
            // CONSTANT SPEED MODE: Traverse the path at constant speed, ignoring frame times
            // Calculate total path length by sampling the curve
            const SAMPLES = 1000; // Number of samples for length calculation
            var totalLength = 0;
            var lastPos = new Vector3()
            var currentPos = new Vector3()
            
            // Get the first point
            this.splineEditor.getPoint(0, lastPos)
            
            // Calculate total length by sampling the curve
            for (var i = 1; i <= SAMPLES; i++) {
                var t = i / SAMPLES;
                this.splineEditor.getPoint(t, currentPos)
                totalLength += currentPos.clone().sub(lastPos).length()
                lastPos.copy(currentPos)
            }
            
            // Now create an array mapping distance along path to t value
            const lengthToT = [{length: 0, t: 0}];
            var accumulatedLength = 0;
            this.splineEditor.getPoint(0, lastPos)
            
            for (var i = 1; i <= SAMPLES; i++) {
                var t = i / SAMPLES;
                this.splineEditor.getPoint(t, currentPos)
                accumulatedLength += currentPos.clone().sub(lastPos).length()
                lengthToT.push({length: accumulatedLength, t: t})
                lastPos.copy(currentPos)
            }
            
            // Now for each frame, find the position at constant speed
            for (var frame = 0; frame < this.frames; frame++) {
                // Calculate target distance for this frame
                var targetDistance = (frame / (this.frames - 1)) * totalLength;
                
                // Find the two samples that bracket this distance
                var sampleIndex = 0;
                while (sampleIndex < lengthToT.length - 1 && lengthToT[sampleIndex + 1].length < targetDistance) {
                    sampleIndex++;
                }
                
                var t;
                if (sampleIndex >= lengthToT.length - 1) {
                    t = 1.0;
                } else {
                    // Interpolate between the two samples to find exact t
                    var sample1 = lengthToT[sampleIndex];
                    var sample2 = lengthToT[sampleIndex + 1];
                    var lengthFraction = (targetDistance - sample1.length) / (sample2.length - sample1.length);
                    t = sample1.t + lengthFraction * (sample2.t - sample1.t);
                }
                
                // Get position at this t value
                var framePos = new Vector3();
                this.splineEditor.getPoint(t, framePos);
                this.array.push({position: this.applyAltitudeLock(framePos, frame)});
            }
        } else {
            // TIME-BASED MODE: Use frame numbers to determine position (original behavior)
            // Get it based on the frame number, as the spline now has a per-node frame number stored
            // and will work out the t value for you
          for (var i=0;i<this.frames;i++) {
              var pos = this.splineEditor.getPointFrame(i)
              this.array.push({position: this.applyAltitudeLock(pos, i)})
          }
        }

        if (this.reprojectOnEarthModelChange) {
            this._controlPointsLLA = this.captureControlPointsLLA();
            this._earthModelSignature = this.getEarthModelSignature();
        }
    }

    insertPoint(frame, point) {
        this.splineEditor.insertPoint(frame, point)
        this.recalculateCascade()
    }



//     // heirachical search for the closest point
// NOT TESTED
//     findClosestPointToRay(ray) {
//
//         var A = 0;
//         var B = 1;
//         var steps = 10;
//         var accuracyDistance = 0.001 // to 1 mm
//
//         var point;
//         while (Math.abs(A-B)<0.000000001) {
//
//             // Find the segment that has the closest center point to the ray
//             // and then repeat with that until accurate enough
//             var bestSegment = A;
//             var bestSegmentDistance = 10000000000
//             var stepSize = (A-B)/steps
//             for (var t=A; t<=B; t+=stepSize) {
//                 var mid = t+stepSize / 2
//                 point = this.v(mid)
//                 var distance = ray.distanceToPoint(point)
//                 if (distance < accuracyDistance) {
//                     return point
//                 }
//                 if (distance < bestSegmentDistance) {
//                     bestSegmentDistance = distance;
//                     bestSegment = t
//                 }
//             }
//
//             A = bestSegment;
//             B = bestSegment+stepSize;
//
//         }
//
//         // This will be the B point, but essentially the same as A
//         return point;
//     }

    adjustUp(height, cameraTrack) {
        this.splineEditor.adjustUp(height,cameraTrack)

    }

 }
