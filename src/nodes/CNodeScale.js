import {CNode} from "./CNode";
import {scaleF2M} from "../utils";

export class CNodeScale extends CNode {
    constructor(id, scale, node) {
        if (scale !== undefined) {
            super({id: id})
            this.addInput("in", node)
            this.scale = scale
        } else {
            // if we just have "id" then that's actually the v parapmeter
            // passed to node consstructor with data
            super(id)
            this.input("in")
            this.input("scale");
        }
    }

    getValueFrame(frame) {
        let value;
        if (this.scale !== undefined) {
            value = this.in.in.v(frame) * this.scale
        } else {
            value = this.in.in.v(frame) * this.in.scale.v(frame)
        }
//        console.log("... "+value)
        return value


    }
}

export function scaleNodeF2M(id, node) {
    return new CNodeScale(id, scaleF2M, node)
}

