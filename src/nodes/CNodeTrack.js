import {CNodeEmptyArray} from "./CNodeArray";
import {GlobalDateTimeNode, NodeMan, Sit} from "../Globals";
import {EUSToLLA, LLAToEUS} from "../LLA-ECEF-ENU";
import {EventManager} from "../CEventManager";
import {getAzElFromPositionAndForward, getLocalUpVector, pointOnSphereBelow} from "../SphericalMath";
import {showError} from "../showError";
import {MISB} from "../MISBUtils";
import {saveAs} from "file-saver";
import {degrees} from "../utils";
import {meanSeaLevelOffset} from "../EGM96Geoid";

export class CNodeTrack extends CNodeEmptyArray {
    constructor(v) {
        super(v);

        // our mjor overhead is recalculating tracks
        // so we don't want to do it if not needed, so there's a check in the recalculateCascade logic
        // that will check the number of display outputs there are in the outputs and descendents of
        // a node with checkDisplayOutputs set to true
        // and skip the recalculation if there are no display outputs
        this.checkDisplayOutputs = true;
        this.elevationCache = null;
    }

    getPointBelowCached(terrainNode, pos, agl, frame) {
        if (!this.elevationCache) {
            this.elevationCache = new Array(this.frames).fill(null);
        }

        const cached = this.elevationCache[frame];
        if (cached) {
            if (cached.tileZ >= 0 && !terrainNode.elevationTileHasHigherZoom(cached.tileZ, cached.tileX, cached.tileY)) {
                return this._pointFromElevation(cached.lat, cached.lon, cached.elevation, agl);
            }
        }

        const LLA = EUSToLLA(pos);
        const info = terrainNode.getPointBelowWithTileInfo(pos, agl);
        this.elevationCache[frame] = {
            lat: LLA.x,
            lon: LLA.y,
            elevation: info.elevation,
            tileZ: info.tileZ,
            tileX: info.tileX,
            tileY: info.tileY,
        };
        return info.point;
    }

    refreshElevationCache(terrainNode, agl) {
        if (!this.elevationCache) return false;
        let changed = false;
        for (let f = 0; f < this.elevationCache.length; f++) {
            const entry = this.elevationCache[f];
            if (!entry) continue;
            let needsRefresh = false;
            if (entry.tileZ < 0) {
                needsRefresh = true;
            } else if (terrainNode.elevationTileHasHigherZoom(entry.tileZ, entry.tileX, entry.tileY)) {
                needsRefresh = true;
            }
            if (needsRefresh) {
                const pos = LLAToEUS(entry.lat, entry.lon, 0);
                const info = terrainNode.getPointBelowWithTileInfo(pos, agl);
                if (info.tileZ !== entry.tileZ || info.tileX !== entry.tileX || info.tileY !== entry.tileY) {
                    entry.elevation = info.elevation;
                    entry.tileZ = info.tileZ;
                    entry.tileX = info.tileX;
                    entry.tileY = info.tileY;
                    if (this.array && this.array[f]) {
                        this.array[f].position = info.point;
                    }
                    changed = true;
                }
            }
        }
        return changed;
    }

    _pointFromElevation(lat, lon, elevation, agl) {
        return LLAToEUS(lat, lon, Math.max(0, elevation) + agl);
    }

    serializeElevationCache() {
        if (!this.elevationCache) return null;
        const out = [];
        for (let f = 0; f < this.elevationCache.length; f++) {
            const e = this.elevationCache[f];
            if (e) {
                out.push([f, e.lat, e.lon, e.elevation, e.tileZ, e.tileX, e.tileY]);
            }
        }
        return out.length > 0 ? out : null;
    }

    deserializeElevationCache(data) {
        if (!data) return;
        this.elevationCache = new Array(this.frames).fill(null);
        for (const entry of data) {
            if (entry.length === 7) {
                const [f, lat, lon, elevation, tileZ, tileX, tileY] = entry;
                if (f < this.frames) {
                    this.elevationCache[f] = {lat, lon, elevation, tileZ, tileX, tileY};
                }
            } else if (entry.length === 6) {
                const [f, lat, lon, tileZ, tileX, tileY] = entry;
                if (f < this.frames) {
                    this.elevationCache[f] = {lat, lon, elevation: 0, tileZ, tileX, tileY};
                }
            }
        }
    }

    exportTrackCSV(inspect=false) {
        return this.exportArray(inspect);
    }

    exportTrackKML(inspect=false) {
        const trackName = Sit.name + "-" + this.id;
        let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Folder>
<name>${trackName}</name>
<Placemark>
<name>${trackName}</name>
<Style>
<LineStyle><color>ff0000ff</color><width>4</width></LineStyle>
<IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/airports.png</href></Icon></IconStyle>
</Style>
<gx:Track>
<altitudeMode>absolute</altitudeMode>
<extrude>1</extrude>
`;
        const whenLines = [];
        const coordLines = [];

        for (let f = 0; f < this.frames; f++) {
            const timeMS = GlobalDateTimeNode.frameToMS(f);
            const dateStr = new Date(timeMS).toISOString();
            whenLines.push(`<when>${dateStr}</when>`);

            const frameData = this.v(f);
            let lat, lon, alt;
            if (frameData.lla) {
                [lat, lon, alt] = frameData.lla;
            } else if (frameData.position) {
                const llaVec = EUSToLLA(frameData.position);
                lat = llaVec.x;
                lon = llaVec.y;
                alt = llaVec.z;
            } else {
                lat = 0;
                lon = 0;
                alt = 0;
            }
            coordLines.push(`<gx:coord>${lon} ${lat} ${alt}</gx:coord>`);
        }

        kml += whenLines.join("\n") + "\n";
        kml += coordLines.join("\n") + "\n";
        kml += `</gx:Track>
</Placemark>
</Folder>
</kml>`;

        if (inspect) {
            return {
                desc: "KML Track Export",
                kml: kml,
            };
        } else {
            saveAs(new Blob([kml], {type: "application/vnd.google-earth.kml+xml"}), trackName + ".kml");
        }
    }

    exportMISBCompliantCSV(inspect=false) {
        const headers = [
            "UnixTimeStamp",
            "SensorLatitude",
            "SensorLongitude",
            "SensorTrueAltitude",
            "SensorHorizontalFieldofView",
            "SensorVerticalFieldofView",
            "PlatformHeadingAngle",
            "PlatformPitchAngle",
            "PlatformRollAngle",
            "SensorRelativeAzimuthAngle",
            "SensorRelativeElevationAngle",
            "SensorRelativeRollAngle",
        ];
        let csv = headers.join(",") + "\n";

        const lookCamera = NodeMan.get("lookCamera", false);

        for (let f = 0; f < this.frames; f++) {
            const frameData = this.v(f);
            const timeMS = GlobalDateTimeNode.frameToMS(f);

            let lla;
            if (frameData.lla) {
                lla = frameData.lla;
            } else if (frameData.position) {
                const llaVec = EUSToLLA(frameData.position);
                lla = [llaVec.x, llaVec.y, llaVec.z];
            } else {
                lla = ["", "", ""];
            }

            const misbRow = frameData.misbRow;
            let vFOV = frameData.vFOV ?? (misbRow ? misbRow[MISB.SensorVerticalFieldofView] : null) ?? "";
            let hFOV = misbRow ? (misbRow[MISB.SensorHorizontalFieldofView] ?? "") : "";

            if (vFOV === "" && lookCamera && lookCamera.camera) {
                vFOV = lookCamera.camera.fov;
                const aspect = lookCamera.camera.aspect;
                const vFovRad = vFOV * Math.PI / 180;
                const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
                hFOV = hFovRad * 180 / Math.PI;
            }

            let platformHeading = misbRow ? (misbRow[MISB.PlatformHeadingAngle] ?? "") : "";
            let platformPitch = misbRow ? (misbRow[MISB.PlatformPitchAngle] ?? "") : "";
            let platformRoll = misbRow ? (misbRow[MISB.PlatformRollAngle] ?? "") : "";

            let sensorAz = misbRow ? (misbRow[MISB.SensorRelativeAzimuthAngle] ?? "") : "";
            let sensorEl = misbRow ? (misbRow[MISB.SensorRelativeElevationAngle] ?? "") : "";
            let sensorRoll = misbRow ? (misbRow[MISB.SensorRelativeRollAngle] ?? "") : "";

            if (frameData.heading && frameData.position) {
                const [az, el] = getAzElFromPositionAndForward(frameData.position, frameData.heading);
                 sensorAz = az;
                sensorEl = el;
                sensorRoll = 0; // default to 0 if the frame has no up vector (i.e. no orientation)

                if (frameData.up && frameData.right) {
                    const localUp = getLocalUpVector(frameData.position);
                    const rightProjection = localUp.clone().cross(frameData.heading).normalize();
                    const cosRoll = frameData.up.dot(localUp);
                    const sinRoll = frameData.up.dot(rightProjection);
                    sensorRoll = degrees(Math.atan2(sinRoll, cosRoll));

                    // clamp to 0 if very close
                    sensorRoll = Math.abs(sensorRoll) < 1e-6 ? 0 : sensorRoll;
                }


                platformHeading = 0;
                platformPitch = 0;
                platformRoll = 0;
            }

            csv += [
                timeMS,
                lla[0],
                lla[1],
                lla[2],
                hFOV,
                vFOV,
                platformHeading,
                platformPitch,
                platformRoll,
                sensorAz,
                sensorEl,
                sensorRoll,
            ].join(",") + "\n";
        }

        if (inspect) {
            return {
                desc: "MISB Compliant CSV",
                csv: csv,
            }
        } else {
            saveAs(new Blob([csv]), "MISB-" + this.id + ".csv")
        }
    }

    // calculate min and max LLA extents of the track
    // from the EUS positions
    getLLAExtents() {
        let pos = this.v(0)
        if (pos === undefined || pos.position === undefined) {
            showError("No position data to find extents of track");
            return
        }
        let minLat = 90
        let maxLat = -90
        let minLon = 180
        let maxLon = -180
        let minAlt = 1000000
        let maxAlt = -1000000
        for (let f=0;f<this.frames;f++) {
            pos=this.v(f)
            const LLA = EUSToLLA(pos.position)
            minLat = Math.min(minLat, LLA.x)
            maxLat = Math.max(maxLat, LLA.x)
            minLon = Math.min(minLon, LLA.y)
            maxLon = Math.max(maxLon, LLA.y)
            minAlt = Math.min(minAlt, LLA.z)
            maxAlt = Math.max(maxAlt, LLA.z)
        }
        return {minLat, maxLat, minLon, maxLon, minAlt, maxAlt}
    }


}



export function trackLength(node) {
    const frames= node.frames;
    var len = 0
    var A = node.p(0)
    for (var i=1;i<frames;i++) {
        var B = node.p(i)
        len += B.clone().sub(A).length()
        A = B;
    }
    return len;
}


export class CNodeTrackFromLLAArray extends CNodeTrack {
    constructor(v) {
        super(v);
        this.altitudeMode = v.altitudeMode ?? "absolute";
        this.showCap = v.showCap ?? false;
        // altitudeReference: "HAE" (default) or "MSL"
        // KML "absolute" is HAE per spec; custom data may provide MSL
        this.altitudeReference = v.altitudeReference ?? "HAE";


        // using events to recalculate the track when the terrain is loaded
        // which is more lightweight than recalculating all nodes
        // we just do this for nodes that are relative to the ground .0
        if (this.altitudeMode === "relativeToGround") {
            // Currently there's no facility for removing event listeners
            // they are just added and never removed
            // but are all cleared when a new sitch is loaded
            // possibly should have object responsible for removing their own listeners
            EventManager.addEventListener("elevationChanged", () => this.recalculateCascade());
        }
        this.recalculate();
    }


    setArray(array) {
        this.array = array;
        this.frames = this.array.length;
    }

    recalculate() {
        super.recalculate();
        // assume the elevation might have changed
        // so we recalculate the elevation of the center of the track
        // which we might need for Google Earth-style KML polygons with "Extend sides to Ground"

        this.centerElevation = 0; // default elevation in case we can't find the ground

        if (this.altitudeMode === "relativeToGround" && this.showCap && this.frames > 0) {
            // need the altitude to be relative to the ground
            // get the terrain
            const terrainNode = NodeMan.get("TerrainModel", false);
            if (terrainNode !== undefined) {
               // average all the LLA frames to get the center
                let lat = 0;
                let lon = 0;
                let alt = 0;
                for (let f = 0; f < this.frames; f++) {
                    const v = this.array[f];
                    lat += v[0];
                    lon += v[1];
                    alt += v[2];
                }
                lat /= this.frames;
                lon /= this.frames;
                alt /= this.frames;

                // get the center of the track
                const center = LLAToEUS(lat, lon, alt);

                // get the ground point below the center (best avaialble from the terrain elevation
                this.centerGroundPoint = terrainNode.getPointBelow(center, 0, true);

                // get MSL point below the center (i.e. point on WGS84 sphere
                this.centerMSLPoint = pointOnSphereBelow(center);
                this.centerElevation = this.centerGroundPoint.distanceTo(this.centerMSLPoint);

            }
        }

    }

    getValueFrame(frame) {
        const v = this.array[Math.floor(frame)];
        const lat = v[0]
        const lon = v[1];
        let alt = v[2];
        // Convert MSL altitude to HAE if needed (h = H + N)
        if (this.altitudeReference === "MSL") {
            alt += meanSeaLevelOffset(lat, lon);
        }
        let eus = LLAToEUS(lat, lon, alt);

        // while this is sub optimal, it should not be done constantly.
        // it mostly for KML polygons and paths, which have no inputs, so are essentially static
        if (this.altitudeMode === "relativeToGround") {
            // need the altitude to be relative to the ground
            // get the terrain

            if (this.showCap) {
                // use the center elevation for ground level, plus the point's altitude
                eus = LLAToEUS(lat, lon, this.centerElevation + alt);


            } else {

                const terrainNode = NodeMan.get("TerrainModel", false);
                if (terrainNode !== undefined) {
                    eus = terrainNode.getPointBelow(eus, alt, true)
                }

            }

        }

        return {position: eus}
    }

    // p(frame) {
    //     const v = this.array[frame];
    //     const lat = v[0]
    //     const lon = v[1];
    //     const alt = v[2];
    //     const eus = LLAToEUS(lat, lon, alt);
    //     return {position: eus}
    // }
}




