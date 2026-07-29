// Calculating what the horizon should look like in the ATFLIR
import {degrees, radians} from "./utils";
import {EAJP2PR, extractRollFromMatrix, PRJ2XYZ} from "./SphericalMath";
import {par} from "./par";
import {Sit} from "./Globals";
import {Object3D} from "three";
import {
    Frame2Az,
    Frame2El,
    get_real_horizon_angle_for_frame,
    getGlareAngleFromFrame,
    jetPitchFromFrame,
    jetRollFromFrame,
    pitchAndGlobalRollFromFrame,
    podRollFromFrame
} from "./JetUtils";
import {vizRadius} from "./JetStuffVars";

// keeping these as globals speeds up getPodHorizonFromJetAndPod
// as creating objects is expensive
export const localBall = new Object3D()
export const localEOSU = new Object3D()
export const localPodFrame = new Object3D()
localPodFrame.add(localEOSU)
localEOSU.add(localBall)

// ---------------------------------------------------------------------------
// THE ATFLIR GIMBAL CHAIN — notes for future readers, established by
// reverse-engineering and verified numerically. Please keep these accurate.
//
// ATFLIR is a ROLL-NOD gimbal: its FIRST axis is the aircraft's LONGITUDINAL
// (nose-tail) axis, and the second is a pitch/nod axis. The camera is mounted on
// the aircraft, so the rotations COMPOUND — hence the parent/child Object3Ds
// above (localPodFrame > localEOSU > localBall), which mirror the real
// PodFrame > Pod > HEAD(EOSU) > BALL graph in JetStuff.js/CNodeDisplayATFLIR.js.
//
// EULER ORDER. Three.js's default is 'XYZ', which composes M = Rx . Ry . Rz. So
// localPodFrame, setting both .z and .x, is Rx(jetPitch) . Rz(-jetRoll) — NOT
// Rz then Rx. The order the two lines are written in is irrelevant; they are
// components of one Euler and only `order` decides. Read intrinsically that is
// "pitch the nose up, THEN bank about the already-pitched longitudinal axis",
// which is the standard aircraft order.
//
// THE COMPOSED MATRIX (verified to 1e-10):
//     M_ball = Rx(jetPitch) . Rz(-jetRoll) . Rz(-podRoll) . Rx(-podPitch)
//            = Rx(jetPitch) . Rz(-(jetRoll + podRoll)) . Rx(-podPitch)
//
// *** THE SINGLE MOST IMPORTANT STRUCTURAL FACT ***
// The airframe roll and the pod roll are about the SAME axis and are ADJACENT in
// the chain, so they collapse into one rotation and simply ADD. That is the only
// reason `podRoll = totalRoll - jetRoll` (line ~69 below) is valid, and why
// EAJP2PR takes no jetRoll argument — it cannot, because the required TOTAL roll
// is independent of how the airframe is banked.
//
// THIS DOES NOT GENERALISE TO OTHER GIMBAL TYPES. An azimuth-elevation mount
// (as on a WESCAM-style ball turret) has its first axis on the aircraft's VERTICAL, so its Ry
// neither commutes with nor merges into the airframe's Rz; there is no
// subtraction trick and the inverse must transform the LOS into the body frame
// first. See src/TurretRoll.js, which also documents why an az-el turret's image
// roll turns out to equal the plain "human horizon" angle.
//
// Note the pod roll axis is the NOSE axis, which is elevated by jetPitch (default
// 3.6 deg, further scaled by 1/cos(roll) when par.scaleJetPitch is on) — it is
// NOT world-horizontal, though it is independent of bank.
//
// The updateMatrixWorld() calls below are redundant after the first: it recurses
// into children. The quaternion.identity() calls are what clear rotation.y.
// ---------------------------------------------------------------------------
export function getPodHorizonFromJetAndPod(jetRoll, jetPitch, podRollPhysical, podPitchPhysical) {

    localBall.quaternion.identity()
    localEOSU.quaternion.identity()
    localPodFrame.quaternion.identity()

    localPodFrame.rotation.z = radians(-jetRoll)
    localPodFrame.rotation.x = radians(jetPitch)
    localBall.rotation.x = radians(-podPitchPhysical)
    localEOSU.rotation.z = radians(-podRollPhysical)
    localPodFrame.updateMatrixWorld()
    localEOSU.updateMatrixWorld()
    localBall.updateMatrixWorld()

    const podHorizonAngle = degrees(extractRollFromMatrix(localBall.matrixWorld))

    return podHorizonAngle;
}

// given a jet pitch and roll, and the el and az (the ideal, i.e. the white dod)
// find the pod pitch and roll
// THEN modify roll until the dero for that pitch and roll matches the needed dero for the ideal
// this new roll will give us the green dot (i.e. where the pod head is physically pointing)
export function getPodRollFromGlareAngleFrame(frame) {

    //   return getGlareAngleFromFrame(frame);

    // This is what we want the horizon to be
    const humanHorizon = get_real_horizon_angle_for_frame(frame)

    // actual Jet orientation
    const jetPitch = jetPitchFromFrame(frame) // this will get scaled pitch
    const jetRoll = jetRollFromFrame(frame)

    // ideal az and el (white dot)
    const az = Frame2Az(frame)
    const el = Frame2El(frame);

    // start pod Pitch and Roll for ideal az and el
    let podPitch, totalRoll;
    [podPitch, totalRoll] = EAJP2PR(el, az, jetPitch);

    // Valid ONLY because the airframe roll and the pod roll are about the same axis
    // and adjacent in the chain, so they add — see the long note on
    // getPodHorizonFromJetAndPod above. The airframe already supplies jetRoll of the
    // total, so the pod ring provides the remainder: bank right 30 deg and the pod,
    // carried along by the airframe, needs 30 deg less of its own roll.
    // Do NOT copy this line for a different gimbal type (e.g. an az-el ball turret) —
    // it is a property of coaxial rotations, not a general pod/airframe relationship.
    // Note also this subtraction is NOT wrapped to +/-180 here, while
    // podRollFromFrame() in JetUtils.js DOES wrap. Only matters at large jetRoll.
    const podRoll = totalRoll - jetRoll

    // what we want the dero to be
    const targetDero = getGlareAngleFromFrame(frame)

    // and hence what we want the pod horizon angle to be
    const horizonTarget = targetDero + humanHorizon

    // binary search here modifying podRoll until the dero calculates from jetRoll, jetPitch, podRoll and podPitch
    // is close to targetDero

    let rollA = podRoll - 90;
    let rollB = podRoll + 90;
    let horizonA = getPodHorizonFromJetAndPod(jetRoll, jetPitch, rollA, podPitch)
    let horizonB = getPodHorizonFromJetAndPod(jetRoll, jetPitch, rollB, podPitch)
    let maxIterations = 1000
    while (rollB - rollA > 0.01 && maxIterations-- > 0) {
        const rollMid = (rollA + rollB) / 2;
        const horizonMid = getPodHorizonFromJetAndPod(jetRoll, jetPitch, rollMid, podPitch)
        // is the horiozn from A to B increasing or decreasing, that will affect which way we compare
        if (horizonB > horizonA) {
            // horizon is increasing from A to B
            if (horizonTarget < horizonMid) {
                // target is in the lower part, so Mid is the new B
                rollB = rollMid;
                horizonB = horizonMid;
            } else {
                // target is in the upper part, so Mid is the new A
                rollA = rollMid;
                horizonA = horizonMid;
            }
        } else {
            // horizon is decreasing from A to B
            // KNOWN BUG (flagged, not fixed — this is load-bearing legacy glare code):
            // the condition below is duplicated, so the inner `else` is unreachable
            // and this whole decreasing-horizon branch has no fallback. When the
            // horizon decreases from A to B and horizonTarget >= horizonMid, neither
            // rollA nor rollB is narrowed and the bisection stalls until it runs out
            // of iterations, returning rollA unchanged. Verify against real glare
            // data before touching it.
            if (horizonTarget < horizonMid) {
                if (horizonTarget < horizonMid) {
                    // target is in the smaller upper part, so Mid is the new A
                    rollA = rollMid;
                    horizonA = horizonMid;
                } else {
                    // target is in the larger lowere part, so Mid is the new B
                    rollB = rollMid;
                    horizonB = horizonMid;
                }
            }
        }
    }
    return rollA;
}

// the glare start angle is caculated under the assumption that since the
// pod is not rotating during the first 650 frames, then it is in the middle
// so we just adjust glareStartAngle so the AVERAGE DIFFERENCE between
// getGlareAngleFromFrame(f) and podRollFromFrame(f) is 0
export function calculateGlareStartAngle() {

    const n = 650;
    let errSum = 0
    let glareSum = 0;
    for (let f = 0; f < n; f++) {
        errSum += getGlareAngleFromFrame(f) - podRollFromFrame(f)
        glareSum += getGlareAngleFromFrame(f)
    }
    const avg = errSum / n // the average difference is the adjustment needed to make it zero
    const glareAvg = glareSum / n

    // this is a bit ad-hoc and does not really work
    par.glareStartAngle -= avg - (getGlareAngleFromFrame(0) - glareAvg)

    // use that as a start, and now refine it to minimize the maximum error
    // this is a somewhat expensive (slow) operation

    let bestError = 100000
    let bestStartAngle = par.glareStartAngle

    const start = par.glareStartAngle - 5
    const end = par.glareStartAngle + 5
    for (let angle = start; angle < end; angle += 0.2) {
        par.glareStartAngle = angle; // set it temporarily to see if it's any good
        let biggestError = 0
        for (let frame = 0; frame < Sit.frames; frame += 5) {
            const podRoll = podRollFromFrame(frame); // this is JUST the roll not from
            let pitch, globalRoll;
            [pitch, globalRoll] = pitchAndGlobalRollFromFrame(frame)

            const glarePos = PRJ2XYZ(pitch, getPodRollFromGlareAngleFrame(frame) + jetRollFromFrame(frame), jetPitchFromFrame(frame), vizRadius)

            const v = PRJ2XYZ(pitch, globalRoll, jetPitchFromFrame(frame), vizRadius)
            const errorAngle = degrees(v.angleTo(glarePos))
            if (errorAngle > biggestError)
                biggestError = errorAngle
        }
        if (biggestError < bestError) {
            bestError = biggestError;
            bestStartAngle = angle
        }
    }
    par.glareStartAngle = bestStartAngle
}

///////////////////////////////////////////////////////
// Side angle correction stuff from gimbal
export function getIdealDeroFromFrame(frame) {
    const horizonAngle = get_real_horizon_angle_for_frame(frame)
    const podHorizonAngle = getPodHorizonAngleFrame(frame)
    const deroNeeded = podHorizonAngle - horizonAngle
    return deroNeeded
}

export function getDeroFromFrame(frame) {
    if (par.deroFromGlare) {
        return getGlareAngleFromFrame(frame)
    } else {
        return getIdealDeroFromFrame(frame)
    }
}

// to get the frame of reference of the pod camera, we can just extract it from the ball's matrixWorld
// We duplicate that object hierarchy here so we can extract the code, ensuring it's the same
// this gets the horizon angle given the IDEAL tracking
function getPodHorizonAngleFrame(frame) {
// similar to UpdatePRFromEA, but on locals, not par values

    const jetPitch = jetPitchFromFrame(frame)
    const jetRoll = jetRollFromFrame(frame)
    const az = Frame2Az(frame)
    const el = Frame2El(frame);

    let pitch, totalRoll;
    [pitch, totalRoll] = EAJP2PR(el, az, jetPitch);
    const podPitchPhysical = pitch;
    const podRollPhysical = totalRoll - jetRoll;
//    if (par.deroFromGlare) {
//        podRollPhysical = getGlareAngleFromFrame(frame)
//    }
    return getPodHorizonFromJetAndPod(jetRoll, jetPitch, podRollPhysical, podPitchPhysical)
}