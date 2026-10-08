import { CTrackFile } from "./CTrackFile";
import { MISB, MISBFields } from "../MISBFields";
import { validateFireball } from "../FireballData";
export class CTrackFileFireball extends CTrackFile {
    static canHandle(filename, data) {
        return data?.kind === "sitrec-fireball-v1";
    }
    constructor(data) {
        super(validateFireball(data));
        this.fireball = data;
    }
    doesContainTrack() {
        return true;
    }
    getTrackCount() {
        return 1;
    }
    hasMoreTracks() {
        return false;
    }
    getShortName() {
        return "Fireball " + this.fireball.id;
    }
    isAltitudeHAE() {
        return true;
    }
    syncsSitchDuration() {
        return true;
    }
    cpaCandidate() {
        return false;
    }
    toMISB() {
        return this.fireball.samples.map((p) => {
            const row = Array(MISBFields).fill(null);
            row[MISB.UnixTimeStamp] = Date.parse(p.time);
            row[MISB.SensorLatitude] = p.lat;
            row[MISB.SensorLongitude] = p.lon;
            row[MISB.SensorTrueAltitude] = p.altitude;
            return row;
        });
    }
}
