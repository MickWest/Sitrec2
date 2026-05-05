import {NodeMan} from "./Globals";
import {par} from "./par";
import {abs, cos, degrees, radians} from "./utils";
import {CueAz, EA2XYZ, EAJP2PR, XYZ2EA} from "./SphericalMath";
import {V3} from "./threeUtils";

export function jetRollFromFrame(f) {
    return NodeMan.get("bank").v(f)
}

export function jetPitchFromFrame(f = -1) {
    if (f === -1) f = par.frame;
    let jetPitch = par.jetPitch;
    if (par.scaleJetPitch) {
        const roll = jetRollFromFrame(f)
        jetPitch *= 1 / cos(radians(abs(roll)))
    }
    return jetPitch;
}

export function horizonAngle(jetPitch, jetRoll, az) {
    const d2r = Math.PI / 180;
    const P = jetPitch * d2r;
    const R = jetRoll  * d2r;
    const A = az       * d2r;
    const y = Math.sin(R) * Math.cos(A) + Math.sin(A) * Math.tan(P);
    const x = Math.cos(R);
    return Math.atan2(y, x) / d2r;
}

export function getHumanHorizonFromPitchRollAzEl(jetPitch, jetRoll, az, el) {


//     if (type == 1) {
//         return jetRoll * cos(radians(az)) + jetPitch * sin(radians(az));
//     } else {
//         // rotate the absolute 3D coordinates of (el, az) into the frame of reference of the jet
//         vec3d relative_AzElHeading = EA2XYZ(el, az, 1)
//             .rotate(vec3d { 1, 0, 0 }, -radians(jetPitch)) // reverse both the order and sign of these rotations
//              .rotate(vec3d { 0, 0, 1 }, radians(jetRoll));

    const AzElHeading = EA2XYZ(el, az, 1)
    const relative_AzElHeading = AzElHeading
        .applyAxisAngle(V3(1, 0, 0), -radians(jetPitch))
        .applyAxisAngle(V3(0, 0, 1), radians(jetRoll))

    let relative_el, relative_az;
    [relative_el, relative_az] = XYZ2EA(relative_AzElHeading)

    const jetUp = V3(0, 1, 0)
        .applyAxisAngle(V3(0, 0, 1), -radians(jetRoll))
        .applyAxisAngle(V3(1, 0, 0), radians(jetPitch))

    const jetRight = V3(1, 0, 0)
        .applyAxisAngle(V3(0, 0, 1), -radians(jetRoll))
        .applyAxisAngle(V3(1, 0, 0), radians(jetPitch))

    const camera_horizon = jetRight.applyAxisAngle(jetUp, -radians(relative_az));

    const real_horizon = V3(1, 0, 0).applyAxisAngle(V3(0, 1, 0), -radians(az))
//    DebugArrowV("real_horizon",real_horizon,100,0x00ff00) // green

//
//         // it can be shown that the real horizon vector is already in the camera plane
//         // so return the angle between the camera horizon and the real horizon
//         return -degrees(camera_horizon.angleTo(real_horizon));

    const horizon_angle = -degrees(camera_horizon.angleTo(real_horizon))

    const cross = camera_horizon.clone().cross(real_horizon)
    const dot = cross.dot(AzElHeading)
    if (dot < 0)
        return -horizon_angle

    return horizon_angle
//     }
// }
}

// Render-loop wake-ups (setRenderOne / par.frame setter) can tick the loop
// during sitch setup, before SetupGimbal creates azSources/el. Treat the
// nodes as not-yet-ready and return the current par.az/par.el so the early
// updateFrame() pass is a no-op until the real nodes exist — matches the
// pattern in getGlareAngleFromFrame below.
export function Frame2Az(frame) {
    if (!NodeMan.exists("azSources")) return par.az ?? 0;
    return NodeMan.get("azSources").v(frame)
}

export function Frame2El(frame) {
    if (!NodeMan.exists("el")) return par.el ?? 0;
    return NodeMan.get("el").v(frame)
}


// https://www.metabunk.org/threads/gimbal-derotated-video-using-clouds-as-the-horizon.12552/page-2#post-276183
//double get_real_horizon_angle_for_frame(int frame, int type = 2) {
export function get_real_horizon_angle_for_frame(frame) {
    const jetPitch = jetPitchFromFrame(frame) // this will get scaled pitch
    const jetRoll = jetRollFromFrame(frame)
    const az = Frame2Az(frame)
    const el = Frame2El(frame);

    if (par.horizonMethod === "Horizon Angle") {
        return horizonAngle(jetPitch, jetRoll, az);
    }
    return getHumanHorizonFromPitchRollAzEl(jetPitch, jetRoll, az, el)
}

export function getGlareAngleFromFrame(f) {
    if (!NodeMan.exists("glareAngle")) {
        if (f === 0)
            console.warn("GlareAngleFromFrame being called BUT missing glareAngle node")
        return 0;
    }

    // this is different to GimbalSim, as that was negative
    if (f < 698) {
        const old = parseFloat(NodeMan.get("glareAngle").getValueFrame(0)) // old flat line
        // so here we need to SUBTRACT the fraction of par.initialGlareRotation
        const modified = old - par.initialGlareRotation * (697 - f) / 697 // go from +6 to +0
        return par.glareStartAngle + modified
    }

    return par.glareStartAngle + NodeMan.get("glareAngle").getValue(f)

} // calculate just the pod roll, ie global roll less the jet roll
// Take a frame number in the video (i.e. a time in 1/30ths)
// and return the angle formed by projecting the camera's Az/El vector
// onto the plane of the wings
export function Frame2CueAz(frame) {
    // get az for this frame (el is constant, in par.el)
    // this comes from video data, shown on the graph as yellow
    const az = Frame2Az(frame)
    const el = Frame2El(frame)
    const jetRoll = jetRollFromFrame(frame) // get jet roll angle from either video data or constant
    const jetPitch = jetPitchFromFrame(frame)
    return CueAz(el, az, jetRoll, jetPitch)
}

// calculate the "ideal" roll angle (pod roll plus jet roll) to point at target
export function pitchAndGlobalRollFromFrame(frame) {
    const az = Frame2Az(frame)
    const el = Frame2El(frame)
    return EAJP2PR(el, az, jetPitchFromFrame(frame))
}

function globalRollFromFrame(frame) {
    let pitch, globalRoll
    [pitch, globalRoll] = pitchAndGlobalRollFromFrame(frame)
    return globalRoll;
}

export function podRollFromFrame(frame) {
    const globalRoll = globalRollFromFrame(frame)
    let podRoll = globalRoll - jetRollFromFrame(frame);
    if (podRoll < -180) podRoll += 360;
    if (podRoll >= 180) podRoll -= 360;
    return podRoll
}