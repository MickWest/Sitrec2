import {CNodeTrack} from "./CNodeTrack";
import {NodeMan, Sit} from "../Globals";
import {LLAToEUS} from "../LLA-ECEF-ENU";
import {toPoint as mgrsToPoint} from "mgrs";
import {parseSingleCoordinate} from "../CoordinateParser";
import {EventManager} from "../CEventManager";
import {f2m} from "../utils";
import {adjustHeightAboveGround, adjustHeightMSL} from "../threeExt";
import {meanSeaLevelOffset} from "../EGM96Geoid";

export class CNodeOSDDataSeriesTrack extends CNodeTrack {
    constructor(v) {
        super(v);
        this.input("controller");
        this.seriesMap = v.seriesMap;
        this.frames = Sit.frames;
        this.useSitFrames = true;
        this.isGroundRelative = false;
        // OSD altitudes are typically MSL (barometric); convert to HAE for LLAToEUS
        this.altitudeReference = v.altitudeReference ?? "MSL";
        EventManager.addEventListener("elevationChanged", () => this.onElevationChanged());
        this.recalculate();
    }

    onElevationChanged() {
        if (!this.isGroundRelative) return;
        const terrainNode = NodeMan.get("TerrainModel", false);
        if (terrainNode && this.refreshElevationCache(terrainNode, 1)) {
            this.recalculateCascade();
        }
    }

    getKeyframeDigitLength(track) {
        for (let f = 0; f < this.frames; f++) {
            if (track.isKeyframe(f)) {
                const val = track.frameData[f];
                if (val && val !== "?????") return val.replace(/\s+/g, "").length;
            }
        }
        return 5;
    }

    expandStepped(track) {
        const arr = new Array(this.frames).fill(null);
        let last = null;
        for (let f = 0; f < this.frames; f++) {
            if (track.isKeyframe(f)) last = track.frameData[f];
            arr[f] = last;
        }
        if (arr[0] === null) {
            const first = arr.find(v => v !== null);
            if (first !== null && first !== undefined) {
                for (let f = 0; f < this.frames; f++) {
                    if (arr[f] !== null) break;
                    arr[f] = first;
                }
            }
        }
        return arr;
    }

    expandLerp(track) {
        const kfs = [];
        for (let f = 0; f < this.frames; f++) {
            if (track.isKeyframe(f)) {
                const num = parseFloat(track.frameData[f]);
                if (!isNaN(num)) kfs.push({frame: f, value: num});
            }
        }
        const n = kfs.length;
        if (n === 0) return new Array(this.frames).fill(null);
        if (n === 1) return new Array(this.frames).fill(kfs[0].value);

        const first = kfs[0], second = kfs[1];
        const last = kfs[n - 1], prevLast = kfs[n - 2];
        const slopeStart = (second.value - first.value) / (second.frame - first.frame);
        const slopeEnd = (last.value - prevLast.value) / (last.frame - prevLast.frame);

        const arr = new Array(this.frames);
        for (let f = 0; f < this.frames; f++) {
            if (f <= first.frame) {
                arr[f] = first.value + slopeStart * (f - first.frame);
            } else if (f >= last.frame) {
                arr[f] = last.value + slopeEnd * (f - last.frame);
            } else {
                let lo = 0, hi = n - 1;
                while (lo < hi - 1) {
                    const mid = (lo + hi) >> 1;
                    if (kfs[mid].frame <= f) lo = mid; else hi = mid;
                }
                const prev = kfs[lo], next = kfs[hi];
                const t = (f - prev.frame) / (next.frame - prev.frame);
                arr[f] = prev.value + t * (next.value - prev.value);
            }
        }
        return arr;
    }

    recalculate() {
        super.recalculate();

        const defaultPos = LLAToEUS(0, 0, 0);
        this.array = new Array(this.frames);
        for (let f = 0; f < this.frames; f++) {
            this.array[f] = {position: defaultPos.clone()};
        }

        const byType = this.seriesMap;

        const hasMGRS = byType["MGRS Zone"] && byType["MGRS East"] && byType["MGRS North"];
        const hasLatLon = byType["Latitude"] && byType["Longitude"];

        if (!hasMGRS && !hasLatLon) return;

        const latArr = new Array(this.frames).fill(null);
        const lonArr = new Array(this.frames).fill(null);

        if (hasMGRS) {
            const zoneArr = this.expandStepped(byType["MGRS Zone"]);
            const eastTrack = byType["MGRS East"];
            const northTrack = byType["MGRS North"];
            const eastArr = this.expandLerp(eastTrack);
            const northArr = this.expandLerp(northTrack);
            const eastDigits = this.getKeyframeDigitLength(eastTrack);
            const northDigits = this.getKeyframeDigitLength(northTrack);

            for (let f = 0; f < this.frames; f++) {
                const zoneVal = zoneArr[f];
                const eastVal = eastArr[f];
                const northVal = northArr[f];
                if (zoneVal === null || eastVal === null || northVal === null) continue;
                if (zoneVal === "?????" || zoneVal === "") continue;

                const eastStr = Math.round(eastVal).toString().padStart(eastDigits, '0');
                const northStr = Math.round(northVal).toString().padStart(northDigits, '0');
                const mgrsStr = zoneVal.replace(/\s+/g, "") + eastStr + northStr;
                try {
                    const [lon, lat] = mgrsToPoint(mgrsStr);
                    latArr[f] = lat;
                    lonArr[f] = lon;
                } catch (e) {
                }
            }
        } else if (hasLatLon) {
            const latExpanded = this.expandStepped(byType["Latitude"]);
            const lonExpanded = this.expandStepped(byType["Longitude"]);

            for (let f = 0; f < this.frames; f++) {
                const latVal = latExpanded[f];
                const lonVal = lonExpanded[f];
                if (!latVal || latVal === "?????" || !lonVal || lonVal === "?????") continue;
                const parsedLat = parseSingleCoordinate(latVal);
                const parsedLon = parseSingleCoordinate(lonVal);
                if (parsedLat !== null && parsedLon !== null) {
                    latArr[f] = parsedLat;
                    lonArr[f] = parsedLon;
                }
            }
        }

        const altTrackM = byType["Altitude (m)"];
        const altTrackFt = byType["Altitude (ft)"];
        const altTrack = altTrackM || altTrackFt;
        const altArr = altTrack ? this.expandLerp(altTrack) : null;
        const hasAltitude = !!altTrack;

        for (let f = 0; f < this.frames; f++) {
            if (latArr[f] === null || lonArr[f] === null) continue;
            let alt = 0;
            if (altArr && altArr[f] !== null) {
                alt = altTrackFt ? f2m(altArr[f]) : altArr[f];
            }
            // Convert MSL to HAE if needed (h = H + N)
            if (this.altitudeReference === "MSL" && alt !== 0) {
                alt += meanSeaLevelOffset(latArr[f], lonArr[f]);
            }
            this.array[f] = {position: LLAToEUS(latArr[f], lonArr[f], alt)};
        }

        this.isGroundRelative = !hasAltitude;
        if (this.altitudeLock !== undefined && this.altitudeLock >= 0) {
            const lockFn = (this.altitudeLockAGL !== false) ? adjustHeightAboveGround : adjustHeightMSL;
            for (let f = 0; f < this.frames; f++) {
                this.array[f].position = lockFn(this.array[f].position, this.altitudeLock);
            }
        } else if (!hasAltitude) {
            const terrainNode = NodeMan.get("TerrainModel", false);
            if (terrainNode) {
                for (let f = 0; f < this.frames; f++) {
                    this.array[f].position = this.getPointBelowCached(terrainNode, this.array[f].position, 1, f);
                }
            }
        } else {
            this.elevationCache = null;
        }
    }

    getValueFrame(frame) {
        return this.array[Math.floor(frame)];
    }
}
