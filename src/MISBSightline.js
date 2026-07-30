/**
 * MISBSightline.js — MISB ST 0601 platform + sensor angles -> an ECEF sightline.
 *
 * The rotation order (heading about local up, then pitch about the rotated
 * right, then roll about the rotated forward; then the same three for the
 * gimbal, relative to the platform) is the one CNodeLOSTrackMISB has always
 * used. It lives here so a caller that only has MISB ROWS — no node graph, no
 * loaded sitch — computes the identical sightline. The alternative was a second
 * copy of the rotation order, which is precisely the kind of thing that drifts
 * silently and tilts every bearing by a degree nobody can account for.
 */

import {Matrix4, Vector3} from "three";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {radians} from "./utils";

/**
 * Sensor orientation at an ECEF position, as a Matrix4 whose third column is
 * the boresight.
 *
 * @param posECEF  Vector3, the platform/sensor position in ECEF metres
 * @param angles   degrees: {platformHeading, platformPitch, platformRoll,
 *                 sensorAz, sensorEl, sensorRoll}. Missing values are 0 — a
 *                 level, north-aligned platform — which is what a source that
 *                 reports only gimbal angles is asserting.
 * @returns Matrix4
 */
export function misbSensorMatrix(posECEF, {
    platformHeading = 0, platformPitch = 0, platformRoll = 0,
    sensorAz = 0, sensorEl = 0, sensorRoll = 0,
} = {}) {
    // Basis vectors for the platform at this position.
    let right = getLocalEastVector(posECEF);
    let fwd = getLocalNorthVector(posECEF);
    const up = getLocalUpVector(posECEF);

    const m = new Matrix4();
    m.makeBasis(right, up, fwd);

    const rot = new Matrix4();
    // Heading: negative, because it is clockwise about DOWN, not up.
    rot.makeRotationAxis(up.normalize(), -radians(platformHeading));
    m.premultiply(rot);

    right = new Vector3().setFromMatrixColumn(m, 0);
    rot.makeRotationAxis(right.normalize(), radians(platformPitch));
    m.premultiply(rot);

    fwd = new Vector3().setFromMatrixColumn(m, 2);
    rot.makeRotationAxis(fwd.normalize(), radians(platformRoll));
    m.premultiply(rot);

    // The gimbal, relative to the platform frame just built.
    const sensor = m.clone();

    let sUp = new Vector3().setFromMatrixColumn(sensor, 1);
    rot.makeRotationAxis(sUp.normalize(), -radians(sensorAz));
    sensor.premultiply(rot);

    let sRight = new Vector3().setFromMatrixColumn(sensor, 0);
    rot.makeRotationAxis(sRight.normalize(), radians(sensorEl));
    sensor.premultiply(rot);

    const sFwd = new Vector3().setFromMatrixColumn(sensor, 2);
    rot.makeRotationAxis(sFwd.normalize(), radians(sensorRoll));
    sensor.premultiply(rot);

    return sensor;
}

/**
 * The sightline direction alone: the sensor matrix's forward (third) column,
 * normalized. This is what an LOS dataset needs.
 */
export function misbSightlineHeading(posECEF, angles) {
    const heading = new Vector3().setFromMatrixColumn(misbSensorMatrix(posECEF, angles), 2);
    return heading.normalize();
}
