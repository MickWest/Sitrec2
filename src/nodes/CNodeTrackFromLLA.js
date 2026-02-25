// A track from a lat, lon, alt source
import {Sit} from "../Globals";
import {LLAToEUS} from "../LLA-ECEF-ENU";
import {CNodeTrack} from "./CNodeTrack";
import {meanSeaLevelOffset} from "../EGM96Geoid";

export class CNodeTrackFromLLA extends CNodeTrack {
    constructor(v) {
        super(v);
        this.input("lat");
        this.input("lon");
        this.input("alt");
        // altitudeReference: "HAE" (default) or "MSL"
        // HAE = Height Above Ellipsoid (passed directly to LLAToEUS)
        // MSL = Mean Sea Level (converted to HAE via geoid undulation)
        this.altitudeReference = v.altitudeReference ?? "HAE";
        this.frames = this.in.lat.frames;
        if (this.frames === 0) {
            this.frames = Sit.frames
            this.useSitFrames = true;
        }
    }

    getValueFrame(frame) {
        const lat = this.in.lat.v(frame);
        const lon = this.in.lon.v(frame);
        let alt = this.in.alt.v(frame);
        if (this.altitudeReference === "MSL") {
            alt += meanSeaLevelOffset(lat, lon);
        }
        const eus = LLAToEUS(lat, lon, alt);
        return {position: eus}
    }
}