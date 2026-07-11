import {CNodeDisplayTrack} from "./CNodeDisplayTrack";
import {CNodeTrack} from "./CNodeTrack";
import {V3} from "../threeUtils";

export class CNodeTrackAir extends CNodeTrack {
    constructor(v) {
        super(v);
        this.input("source")
        this.input("wind")
        this.frames = this.in.source.frames;
        this.fps = this.in.source.fps;
        this.recalculate()


    }

    recalculate() {
        this.array = []
        var totalWind = V3()
        for (var f = 0; f < this.frames; f++) {
            const sourcePosition = this.in.source.p(f);
            this.array.push({position: sourcePosition.clone().sub(totalWind)})
            const wind = typeof this.in.wind.windVectorAt === "function"
                ? this.in.wind.windVectorAt(f, sourcePosition)
                : this.in.wind.v(f);
            totalWind.add(wind)
        }
    }

    update(frame) {
        var totalWind = V3()
        for (var f = 0; f < frame; f++) {
            const sourcePosition = this.in.source.p(f);
            const wind = typeof this.in.wind.windVectorAt === "function"
                ? this.in.wind.windVectorAt(f, sourcePosition)
                : this.in.wind.v(f);
            totalWind.add(wind)
        }

        // PATCH, if one outputs is a CNodeDisplayTrack
        // then move its group
        for (var output of this.outputs)
            if (output instanceof CNodeDisplayTrack) {
                output.group.position.copy(totalWind);
            }
    }
}
