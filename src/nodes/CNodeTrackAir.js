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
        // Prefix sum of wind: cumulativeWind[k] = sum(wind[0..k-1]) (the running
        // total BEFORE frame k's wind is added — the same value baked into
        // array[k].position below). Length frames+1 so update() can read the
        // total up to any rendered frame in O(1) instead of re-summing.
        this.cumulativeWind = new Array(this.frames + 1)
        var totalWind = V3()
        for (var f = 0; f < this.frames; f++) {
            const sourcePosition = this.in.source.p(f);
            this.cumulativeWind[f] = totalWind.clone()
            this.array.push({position: sourcePosition.clone().sub(totalWind)})
            const wind = typeof this.in.wind.windVectorAt === "function"
                ? this.in.wind.windVectorAt(f, sourcePosition)
                : this.in.wind.v(f);
            totalWind.add(wind)
        }
        this.cumulativeWind[this.frames] = totalWind.clone()
    }

    update(frame) {
        // The wind offset at a rendered frame is a prefix sum over the baked
        // source track + wind field — independent of playback — yet this ran an
        // O(frame) re-sum every rendered frame (O(frames^2) per playback). Read
        // the cached prefix instead. Match the old `for (f=0; f<frame; f++)`
        // exactly: it accumulated every integer f strictly below `frame`, i.e.
        // ceil(frame) terms = cumulativeWind[ceil(frame)].
        const cw = this.cumulativeWind;
        if (!cw || cw.length === 0) return;
        const idx = Math.max(0, Math.min(Math.ceil(frame), cw.length - 1));
        const totalWind = cw[idx];

        // PATCH, if one outputs is a CNodeDisplayTrack
        // then move its group
        for (var output of this.outputs)
            if (output instanceof CNodeDisplayTrack) {
                output.group.position.copy(totalWind);
            }
    }
}
