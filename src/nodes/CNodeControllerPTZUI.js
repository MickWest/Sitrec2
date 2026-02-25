import {ExpandKeyframes, radians, RollingAverage} from "../utils";
import {getLocalDownVector, getLocalUpVector, getNorthPole} from "../SphericalMath";
import {NodeMan, Sit} from "../Globals";

import {CNodeController} from "./CNodeController";
import {V3} from "../threeUtils";
import {assert} from "../assert";
import {Vector3} from "three";
import {extractFOV} from "./CNodeControllerVarious";

const pszUIColor = "#C0C0FF";

// Generic controller that has azimuth, elevation, and zoom
export class CNodeControllerAzElZoom extends CNodeController {
    _az = 0;
    _el = 0;

    get az() { return this._az; }
    set az(value) {
        assert(!isNaN(value), "CNodeControllerAzElZoom: setting az to NaN, id=" + this.id);
        this._az = value;
    }

    get el() { return this._el; }
    set el(value) {
        assert(!isNaN(value), "CNodeControllerAzElZoom: setting el to NaN, id=" + this.id);
        this._el = value;
    }

    constructor(v) {
        super(v);
    }


    apply(f, objectNode ) {

        // Since we are in EUS, and the origin is at some arbritary point
        // we need to get the LOCAL up

        const camera = objectNode.camera

        //  since the user controls roll here, we don't want to use north for up
        var up = getLocalUpVector(camera.position)

        // to get a northish direction we get the vector from here to the north pole.
        var northPoleEUS = getNorthPole()
        var toNorth = northPoleEUS.clone().sub(camera.position).normalize()
        // take only the component perpendicular
        let dot = toNorth.dot(up)
        let north = toNorth.clone().sub(up.clone().multiplyScalar(dot))
        assert(north.lengthSq() >= 1e-10, "CNodeControllerAzElZoom: north vector is zero (at pole?), camera.position=" + camera.position.toArray());
        north.normalize()
        let south = north.clone().negate()
        let east = V3().crossVectors(up, south)

        length = 100000;
        // DebugArrow("local East",east,camera.position,length,"#FF8080")
        // DebugArrow("local Up",up,camera.position,length,"#80FF90")
        // DebugArrow("local South",south,camera.position,length,"#8080FF")

        var right = east;
        var fwd = north;

        let el = this.el
        let az = this.az
        if (this.relative) {
            // if we are in relative mode, then we just rotate the camera's fwd vector

            const xAxis = new Vector3()
            const yAxis = new Vector3()
            const zAxis = new Vector3()
            camera.updateMatrix();
            camera.updateMatrixWorld()
            camera.matrix.extractBasis(xAxis,yAxis,zAxis)
            fwd = zAxis.clone().negate()

            // project fwd onto the horizontal plane define by up
            // it's only relative to the heading, not the tilt
            let dot = fwd.dot(up)
            fwd = fwd.sub(up.clone().multiplyScalar(dot)).normalize()

            right = fwd.clone().cross(up)



        }


        fwd.applyAxisAngle(right,radians(el))
        fwd.applyAxisAngle(up,-radians(az))
        camera.fov = extractFOV(this.fov);
        assert(!Number.isNaN(camera.fov), "CNodeControllerPTZUI: camera.fov is NaN");
        assert(camera.fov !== undefined && camera.fov>0 && camera.fov <= 180, `bad fov ${camera.fov}` )
        fwd.add(camera.position);
        camera.up = up;
        camera.lookAt(fwd)
        if (this.roll !== undefined ) {
            camera.rotateZ(radians(this.roll))
        }

    }


}


// UI based version of this, PTZ = Az, El, Zoom, and have constants defined by the gui
export class CNodeControllerPTZUI extends CNodeControllerAzElZoom {
    constructor(v) {
        super(v);
        assert(v.az !== undefined, "CNodeControllerPTZUI: initial az is undefined")
        assert(v.el !== undefined, "CNodeControllerPTZUI: initial el is undefined")
        this.az = v.az;
        this.el = v.el
        this.fov = v.fov
        this.roll = v.roll
        this.xOffset = v.xOffset ?? 0;
        this.yOffset = v.yOffset ?? 0;
        this.nearPlane = v.nearPlane ?? 0.1;
        this.relative = false;

        assert(v.fov !== undefined, "CNodeControllerPTZUI: initial fov is undefined")

        if (v.showGUI) {

            this.setGUI(v,"camera");
            const guiPTZ = this.gui;

            guiPTZ.add(this, "az", -180, 180, 0.01, false).listen().name("Pan (Az)").onChange(v => this.refresh()).setLabelColor(pszUIColor).wrap()
            guiPTZ.add(this, "el", -89, 89, 0.01, false).listen().name("Tilt (El)").onChange(v => this.refresh()).setLabelColor(pszUIColor)
            if (this.fov !== undefined) {
                guiPTZ.add(this, "fov", 0.0001, 170, 0.01, false).listen().name("Zoom (fov)").onChange(v => {
                    this.refresh()
                }).setLabelColor(pszUIColor) // .elastic(0.0001, 170)
            }
            if (this.roll !== undefined ) {
                guiPTZ.add(this, "roll", -180, 180, 0.005).listen().name("Roll").onChange(v => this.refresh()).setLabelColor(pszUIColor)
            }
            guiPTZ.add(this, "xOffset", -10, 10, 0.001).listen().name("xOffset").onChange(v => this.refresh()).setLabelColor(pszUIColor)
            guiPTZ.add(this, "yOffset", -10, 10, 0.001).listen().name("yOffset").onChange(v => this.refresh()).setLabelColor(pszUIColor)
            guiPTZ.add(this, "nearPlane", 0.001, 1, 0.001).listen().name("Near Plane (m)").onChange(v => this.refresh()).setLabelColor(pszUIColor)
            guiPTZ.add(this, "relative").listen().name("Relative").onChange(v => this.refresh())
        }
       // this.refresh()
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            az: this.az,
            el: this.el,
            fov: this.fov,
            roll: this.roll,
            xOffset: this.xOffset,
            yOffset: this.yOffset,
            nearPlane: this.nearPlane,
            relative: this.relative
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        assert(v.az !== undefined, "CNodeControllerPTZUI.modDeserialize: az is undefined");
        assert(v.el !== undefined, "CNodeControllerPTZUI.modDeserialize: el is undefined");
        this.az = v.az;
        this.el = v.el;
        this.fov = v.fov;
        this.roll = v.roll;
        this.xOffset = v.xOffset ?? 0;
        this.yOffset = v.yOffset ?? 0;
        this.nearPlane = v.nearPlane ?? 0.1;
        this.relative = v.relative ?? false;
    }

    // Note this has to be in apply, not update, as there are update orders issues
    apply(f, objectNode ) {

        // check if the switch node fovSwitch is present
        // and if set to somthing other than userFOV
        // if so, we use that

        const fovSwitch = NodeMan.get("fovSwitch",false)
        if (fovSwitch) {
            this.fov = extractFOV(fovSwitch.getValue(f));
        }

        super.apply(f, objectNode);

        const camera = objectNode.camera;
        camera.near = this.nearPlane;
        camera.updateProjectionMatrix();
    }

    refresh(v) {
        // legacy check
        assert(v === undefined, "CNodeControllerPTZUI: refresh called with v, should be undefined");


        // the FOV UI node is also updated, It's a hidden UI element that remains for backwards compatibility.
        const fovUINode = NodeMan.get("fovUI", false)
        if (fovUINode) {
            fovUINode.setValue(this.fov);
        }

        // don't think this is needed
        this.recalculateCascade();
    }

}

export class CNodeControllerCustomAzEl extends CNodeControllerAzElZoom {
    constructor(v) {
        super(v);
        this.input("azSmooth",true);
        this.input("elSmooth", true);
        this.fallback = NodeMan.get(v.fallback);
        this.frames = Sit.frames;
        this.useSitFrames = true;

        this.relative = this.fallback.relative

    }



    setAzFile(azFile, azCol) {
        this.azFile = azFile;
        this.azCol = azCol;
        this.recalculate();
    }

    setElFile(elFile, elCol) {
        this.elFile = elFile;
        this.elCol = elCol;
    }



    recalculate() {

        const azSmooth = this.in.azSmooth ? this.in.azSmooth.v0 : 200;
        const elSmooth = this.in.elSmooth ? this.in.elSmooth.v0 : 200;

        if (this.azFile !== undefined) {
            assert(this.frames = Sit.frames, "CNodeControllerCustomAzEl: frames not set right");
            this.azArrayRaw = ExpandKeyframes(this.azFile, this.frames, 0, this.azCol);
            this.azArray = RollingAverage(this.azArrayRaw, azSmooth);
        }

        if (this.elFile !== undefined) {
            assert(this.frames = Sit.frames, "CNodeControllerCustomAzEl: frames not set right");
            this.elArrayRaw = ExpandKeyframes(this.elFile, this.frames, 0, this.elCol);
            this.elArray = RollingAverage(this.elArrayRaw, elSmooth);
        }



    }



    apply(f, objectNode ) {
        if (this.relative !== this.fallback.relative) {
            this.relative = this.fallback.relative;
            this.recalculateCascade();
        }

        if (this.fallback) {
            this.az = this.fallback.az;
            this.el = this.fallback.el;
            this.fov = this.fallback.fov;
        }

        if (this.azArray) {
            this.az = this.azArray[f];
        }

        if (this.elArray) {
            this.el = this.elArray[f];
        }



        super.apply(f, objectNode);

    }




}

export class CNodeControllerCustomHeading extends CNodeController {
    constructor(v) {
        super(v);
        this.input("headingSmooth", true);
        this.fallback = NodeMan.get(v.fallback);
        this.frames = Sit.frames;
        this.useSitFrames = true;
        this.heading = 0; // default heading
        this.forceHeadingPerFrame = true;
    }

    setHeadingFile(headingFile, headingCol) {
        this.headingFile = headingFile;
        this.headingCol = headingCol;
        this.recalculate();
    }

    recalculate() {
        const headingSmooth = this.in.headingSmooth ? this.in.headingSmooth.v0 : 200;

        if (this.headingFile !== undefined) {
            assert(this.frames = Sit.frames, "CNodeControllerCustomHeading: frames not set right");
            this.headingArrayRaw = ExpandKeyframes(this.headingFile, this.frames, 0, this.headingCol);
            this.headingArray = RollingAverage(this.headingArrayRaw, headingSmooth);
        }
    }


    getValueFrame(f) {
        return this.headingArray[f]
    }

    apply(f, objectNode) {
        // // default to the fallback heading if available
        // if (this.fallback && this.fallback.heading !== undefined) {
        //     this.heading = this.fallback.heading;
        // }
        //
        // // override with file data if available
        // if (this.headingArray) {
        //     this.heading = this.headingArray[f];
        // }
        //
        // // apply heading rotation to the object node
        // if (objectNode) {
        //     // DON'T rotate around the Y axis (up direction) for heading
        //     // need to set the heading on on the objectNode to the current cser
        //
        //
        // }
    }
}


// simlar, but move an object based on the inputs vertical speed feet per second
export class CNodeControllerVerticalSpeed extends CNodeController {
    constructor(v) {
        super(v);
        this.input("verticalSpeed", true);
        this.speed = 0;
        this.frames = Sit.frames;
        this.useSitFrames = true;
    }

    apply(f, objectNode) {
        if (!objectNode) {
            return;
        }
        const ob = objectNode._object;
        const feetPerSecond = this.in.verticalSpeed.v(f);
        if (feetPerSecond !== undefined) {
            const metersPerSecond = feetPerSecond * 0.3048;
            const distance = metersPerSecond / Sit.fps;


            const down = getLocalDownVector(ob.position)
            ob.position.add(down.multiplyScalar(distance))

            console.log(`moving ${distance}m`)

        }


    }
}

