import {RollingAverage} from "../smoothing";
import {CNodeEmptyArray} from "./CNodeArray";

export class CNodeSmoothedArray extends CNodeEmptyArray {
    constructor(v) {
        super(v)
        this.smoothingKind = "rolling";
        this.input("source") // source array node
        this.input("window") // amount to smooth (rolling average window size)
        this.frames = this.in.source.frames;
        this.recalculate();
    }

    recalculate() {
        this.array = RollingAverage(this.in.source.array, this.in.window.v0)
    }
}
