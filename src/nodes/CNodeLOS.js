// Base class for the various sources of LOS information.
// LOS = Lines of Sight, which is a track with heading vectors
// getValueFrame(f) will return
// {position: position, // ECEF position in meters (EUS=ECEF),
// heading: fwd,        // unit vector pointing along the LOS (ECEF)
// up: up,              // (optional) up unit vector for LOS, e.g. camera orientation
// right:               // (optional) right unit vector
// }


import {CNodeTrack} from "./CNodeTrack";
import {GlobalDateTimeNode, NodeMan, Sit} from "../Globals";
import {saveAs} from "file-saver";
import {Matrix3, Vector3} from "three";
import {ECEF2ENU_radii, ECEFToEUS, ENU2ECEF_radii, EUSToECEF, EUSToLLA} from "../LLA-ECEF-ENU";
import {extractFOV} from "./CNodeControllerVarious";
import {elevationAtLL} from "../threeExt";
import {roundIfClose} from "../utils";

export class CNodeLOS extends CNodeTrack {
    constructor(v) {
        super(v);
    }

    update(f) {
        super.update(f);
        if (!this.addedExportButton) {
            this.addedExportButton = true;
            NodeMan.addExportButton(this, "exportLOSCSV")
        }
    }

    exportLOSCSV(inspect = false) {
        // Get the first point to establish the ENU origin
        const firstData = this.getValueFrame(0);
        if (!firstData || !firstData.position) {
            console.error("No position data available for export");
            return;
        }

        // Get the LLA of the first position to establish the new ENU origin
        const firstPosEUS = firstData.position;
        const firstLLA = EUSToLLA(firstPosEUS);

        // The new ENU origin is on the ground (altitude = 0) below the first point
        const originLat = firstLLA.x * Math.PI / 180;  // Convert to radians
        const originLon = firstLLA.y * Math.PI / 180;  // Convert to radians

        // EUS is now identical to ECEF, so data.heading is already an ECEF vector.
        // We just need the ECEF→ENU rotation at the export origin.
        const mECEF2ENU_Origin = new Matrix3().set(
            -Math.sin(originLon), Math.cos(originLon), 0,
            -Math.sin(originLat) * Math.cos(originLon), -Math.sin(originLat) * Math.sin(originLon), Math.cos(originLat),
            Math.cos(originLat) * Math.cos(originLon), Math.cos(originLat) * Math.sin(originLon), Math.sin(originLat)
        );
        const mENU2ECEF_Origin = new Matrix3().copy(mECEF2ENU_Origin).invert();

        // Build CSV
        let csv = "Time, SensorPositionX, SensorPositionY, SensorPositionZ, LOSUnitVectorX, LOSUnitVectorY, LOSUnitVectorZ, maxRange, LOSUncertaintyVertical, LOSUncertaintyHorizontal, OriginLat, OriginLon, BaseAltitude\n";

        const fovSwitch = NodeMan.get("fovSwitch", false);
        const lookCamera = NodeMan.get("lookCamera", false);
        
        // Convert origin coordinates to degrees for CSV output
        const originLatDeg = originLat * 180 / Math.PI;
        const originLonDeg = originLon * 180 / Math.PI;
        
        // Get the base altitude (ground elevation at the origin)
        const baseAltitude = elevationAtLL(originLatDeg, originLonDeg);

        // Use Sit.aFrame and Sit.bFrame to limit the export range
        const startFrame = Sit.aFrame ?? 0;
        const endFrame = Sit.bFrame ?? (this.frames - 1);

        for (let f = startFrame; f <= endFrame; f++) {
            const data = this.getValueFrame(f);
            if (!data || !data.position || !data.heading) {
                continue;
            }

            const posEUS = data.position;
            const posECEF = EUSToECEF(posEUS);
            const posENU = ECEF2ENU_radii(posECEF, originLat, originLon, false);

            // Round ENU position components if very close to whole numbers
            const px = roundIfClose(posENU.x, 1e-6);
            const py = roundIfClose(posENU.y, 1e-6);
            const pz = roundIfClose(posENU.z, 1e-6);

            // data.heading is ECEF (EUS=ECEF). Convert directly to ENU at origin.
            const headingENU = data.heading.clone().applyMatrix3(mECEF2ENU_Origin);
            
            // Normalize to ensure it's a unit vector
            headingENU.normalize();

            // Calculate time for this frame in milliseconds since epoch
            const startMS = GlobalDateTimeNode.dateStart.valueOf();
            const timestamp = Math.round(startMS + f * 1000 * (Sit.simSpeed ?? 1) / Sit.fps);
            
            // Calculate maxRange based on ground plane collision
            // Ground plane is at z=0 in ENU coordinates
            // Ray equation: P = posENU + t * headingENU
            // For ground intersection: posENU.z + t * headingENU.z = 0
            // Solve for t: t = -posENU.z / headingENU.z
            let maxRange;
            if (headingENU.z < 0 && posENU.z > 0) {
                // Ray is pointing downward and position is above ground
                const t = -posENU.z / headingENU.z;
                maxRange = t; // Distance to ground intersection
            } else {
                // Ray doesn't intersect ground (pointing up or parallel, or already below ground)
                maxRange = -1; // Indicates infinity
            }
            
            // Get FOV for uncertainty values
            // Try to get fovSwitch node first (for custom sitches with per-frame FOV)
            let verticalFOV;
            if (fovSwitch) {
                // Get vertical FOV for this frame from fovSwitch
                // note there's different ways to store FOV info in a track
                // so we use the extractFOV function that works for all cases
                verticalFOV = extractFOV(fovSwitch.getValue(f));
            } else {
                // Fall back to lookCamera's FOV
                if (lookCamera && lookCamera.camera) {
                    // fov in Three.js is vertical field of view in degrees
                    verticalFOV = lookCamera.camera.fov;
                } else {
                    // Default fallback if no camera found
                    verticalFOV = 5.0;
                }
            }
            
            // Calculate horizontal FOV from vertical FOV and aspect ratio
            let horizontalFOV;
            if (lookCamera && lookCamera.camera) {
                const aspect = lookCamera.camera.aspect;
                // Convert vertical FOV to horizontal FOV using aspect ratio
                // hFOV = 2 * atan(tan(vFOV/2) * aspect)
                const vFovRad = verticalFOV * Math.PI / 180;
                const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
                horizontalFOV = hFovRad * 180 / Math.PI;
            } else {
                // If no camera, assume square aspect ratio
                horizontalFOV = verticalFOV;
            }
            
            // Use FOV for uncertainty (values in degrees)
            const uncertaintyVertical = verticalFOV/2;
            const uncertaintyHorizontal = horizontalFOV/2;
            
            // Format maxRange and baseAltitude to 3 decimal places
            const maxRangeFormatted = maxRange === -1 ? -1 : maxRange.toFixed(3);
            const baseAltitudeFormatted = baseAltitude.toFixed(3);
            
            csv += `${timestamp},${px},${py},${pz},${headingENU.x},${headingENU.y},${headingENU.z},${maxRangeFormatted},${uncertaintyVertical},${uncertaintyHorizontal},${originLatDeg},${originLonDeg},${baseAltitudeFormatted}\n`;
        }

        // Save the file
        if (inspect) {
            return {
                desc: "Lines of Sight CSV",
                csv: csv,
            }
        }
        else {
            saveAs(new Blob([csv]), `LOS-${this.id}.csv`);
        }
        // Test the reverse transformation
        this.testReverseExport(csv, originLat, originLon);
    }

    testReverseExport(csv, originLat, originLon) {
        console.log("=== Testing Reverse Export Transformation ===");
        
        // Parse CSV
        const lines = csv.split('\n');
        const dataLines = lines.slice(1).filter(line => line.trim().length > 0);
        
        // ENU→ECEF matrix at origin (inverse of ECEF→ENU)
        const mENU2ECEF_Origin = new Matrix3().set(
            -Math.sin(originLon), Math.cos(originLon), 0,
            -Math.sin(originLat) * Math.cos(originLon), -Math.sin(originLat) * Math.sin(originLon), Math.cos(originLat),
            Math.cos(originLat) * Math.cos(originLon), Math.cos(originLat) * Math.sin(originLon), Math.sin(originLat)
        ).invert();
        
        let maxPosError = 0;
        let maxHeadingError = 0;
        let totalPosError = 0;
        let totalHeadingError = 0;
        let count = 0;
        
        for (let i = 0; i < dataLines.length; i++) {
            const parts = dataLines[i].split(',').map(parseFloat);
            if (parts.length !== 13) continue;
            
            const [timestamp, x, y, z, dx, dy, dz, maxRange, uncertaintyV, uncertaintyH, originLatDeg, originLonDeg, baseAltitude] = parts;
            
            // Get original data
            const originalData = this.getValueFrame(i);
            if (!originalData || !originalData.position || !originalData.heading) {
                continue;
            }
            
            // Convert position from ENU back to EUS (EUS=ECEF)
            const posENU = new Vector3(x, y, z);
            const posECEF = ENU2ECEF_radii(posENU, originLat, originLon, false);
            const posEUS = ECEFToEUS(posECEF);

            // Convert heading from ENU back to ECEF (=EUS)
            const headingENU = new Vector3(dx, dy, dz);
            const headingEUS = headingENU.clone().applyMatrix3(mENU2ECEF_Origin);
            headingEUS.normalize();
            
            // Compare with original
            const posError = posEUS.distanceTo(originalData.position);
            const headingError = Math.acos(Math.min(1, Math.max(-1, headingEUS.dot(originalData.heading)))) * 180 / Math.PI;
            
            maxPosError = Math.max(maxPosError, posError);
            maxHeadingError = Math.max(maxHeadingError, headingError);
            totalPosError += posError;
            totalHeadingError += headingError;
            count++;
            
            // Log first few and any large errors
            if (i < 3 || posError > 0.01 || headingError > 0.1) {
                console.log(`Frame ${i}:`);
                console.log(`  Position error: ${posError.toFixed(6)} meters`);
                console.log(`  Heading error: ${headingError.toFixed(6)} degrees`);
                console.log(`  Original pos: (${originalData.position.x.toFixed(3)}, ${originalData.position.y.toFixed(3)}, ${originalData.position.z.toFixed(3)})`);
                console.log(`  Recovered pos: (${posEUS.x.toFixed(3)}, ${posEUS.y.toFixed(3)}, ${posEUS.z.toFixed(3)})`);
                console.log(`  Original heading: (${originalData.heading.x.toFixed(6)}, ${originalData.heading.y.toFixed(6)}, ${originalData.heading.z.toFixed(6)})`);
                console.log(`  Recovered heading: (${headingEUS.x.toFixed(6)}, ${headingEUS.y.toFixed(6)}, ${headingEUS.z.toFixed(6)})`);
            }
        }
        
        console.log(`\n=== Summary (${count} frames tested) ===`);
        console.log(`Position errors:`);
        console.log(`  Max: ${maxPosError.toFixed(6)} meters`);
        console.log(`  Average: ${(totalPosError / count).toFixed(6)} meters`);
        console.log(`Heading errors:`);
        console.log(`  Max: ${maxHeadingError.toFixed(6)} degrees`);
        console.log(`  Average: ${(totalHeadingError / count).toFixed(6)} degrees`);
        
        if (maxPosError < 0.001 && maxHeadingError < 0.01) {
            console.log("✓ Transformation test PASSED - errors within acceptable tolerance");
        } else {
            console.warn("⚠ Transformation test shows significant errors");
        }
    }

}