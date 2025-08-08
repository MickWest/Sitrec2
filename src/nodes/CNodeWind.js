import {CNode, CNodeOrigin} from "./CNode";
import {metersPerSecondFromKnots, radians} from "../utils";
import {NodeMan, Sit} from "../Globals";
import {DebugArrowAB} from "../threeExt";
import {GlobalScene} from "../LocalFrame";
import {getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {assert} from "../assert.js";
import {V3} from "../threeUtils";

export class CNodeWind extends CNode {
    constructor(v, _guiMenu) {
        super(v);

        
        this.setGUI(v, _guiMenu)

        this.from = v.from;  // true heading of the wind soruce. North = 0
        this.knots = v.knots
        this.name = v.name ?? v.id // if no name is supplied, use the id

        this.max = v.max ?? 200;

        // this.input("pos")
        // this.input("radius")

        if(this.gui) {
            this.guiFrom = this.gui.add (this, "from", 0,359,1).name(this.name+" Wind From").onChange(x =>this.recalculateCascade()).wrap()
            this.guiKnots = this.gui.add (this, "knots", 0, this.max, 1).name(this.name+" Wind Knots").onChange(x => this.recalculateCascade())
        }

       // this.optionalInputs(["originTrack"])
        // wind defaults to being in the frame of reference of the EUS origin (0,0,0)
        this.position=V3(0,0,0);



        // we can't use originTrack as an input as typically it's going to be something like the
        // target position, which then depends on the wind, which depends on the target position
        // so in the update function we can just get the zero frame position of the origin track
        // the zero frame will NOT have any wind applied, as that time dependent (and the zero frame has t=0)
        this.originTrack = v.originTrack; // optional, if supplied, the wind is in the frame of reference of the track

        // forcing extra intial recalculate cascades (only of there's an origin track)
        // this is to ensure that the wind is in the correct frame of reference
        // bit of a patch, but it works. Really need to sort out the initialization order here
        this.extraRecalculate = 2;

        this.lock = v.lock;

        this.recalculate()
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            from: this.from,
            knots: this.knots,
            name: this.name,
            max: this.max,
            lock: this.lock,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.from = v.from;
        this.knots = v.knots;
        this.name = v.name;
        this.max = v.max;
        this.lock = v.lock;
        this.guiFrom.updateDisplay()
        this.guiKnots.updateDisplay()
    }

    // // hide and show will be called from a switch node
    // hide() {
    //     super.hide()
    //     this.guiFrom.hide()
    //     this.guiKnots.hide()
    //     return this;
    //
    // }

    show(visible=true) {
        super.show(visible)
        this.guiFrom.show(visible)
        this.guiKnots.show(visible)
        return this;
    }

    setPosition(pos) {
        assert(!isNaN(pos.x) && !isNaN(pos.y) && !isNaN(pos.z), "Setting Wind position has NaNs");
        this.position = pos.clone();
    }

    // returns a pre-frame wind vector, indicating wind motion for that frame
    // in EUS coordinates
    // optionally supply a position to get the wind at that position
    // with reference to local north and up vectors
    getValueFrame(f, position) {

        // if no position is supplied, use the current position
        // fine for a target that does not move much, but if the target moves a lot, then
        // we should supply the position of the target at the time of the frame
        if (position === undefined) {
            position = this.position;
        }

        //let wind = V3(0, 0, -metersPerSecondFromKnots(this.knots) / Sit.fps);
        //const posUp = V3(0, 1, 0)
        let wind = getLocalNorthVector(position)
        wind.multiplyScalar(metersPerSecondFromKnots(this.knots) / Sit.fps)
        const posUp = getLocalUpVector(position)
        wind.applyAxisAngle(posUp, radians(180-this.from))

        // assert no NaNs in the wind vector
        assert(!isNaN(wind.x) && !isNaN(wind.y) && !isNaN(wind.z), "Wind vector has NaNs");

        return wind;
    }


    update(f) {
        // if we have a lock, then hide the gui of the wind we lock to
        if (this.lock !== undefined) {
            if (NodeMan.exists("lockWind")) {
                const lock = NodeMan.get("lockWind");
                const target = NodeMan.get(this.lock);

                if (lock.value) {
                    this.updateLockedWind()
                }

                if (lock.value !== target.visible) {
                    target.recalculate();
                }

                target.show(!lock.value)
            }
        }

        // if we have an origin track, then update the position to be the zero frame position of that track
        // so we have an accurate frame of reference for the wind

        // if the originTrack is a string, then get the node from NodeMan
        // this allows to make the wind position depended on a track that has not been created yet
        // (i.e. the target position, which depends on the wind)
        if (typeof this.originTrack === "string") {
            this.originTrack = NodeMan.get(this.originTrack);
        }

        if (this.originTrack !== undefined) {
            const newPosition = this.originTrack.getValueFrame(0);
            if (!newPosition.equals(this.position)) {
                // force TWO recalculate cycles to ensure it propogates through the system
                this.extraRecalculate = 2;
                this.setPosition(newPosition);
            }

            if (this.extraRecalculate) {
                this.extraRecalculate--;
                // changing the frame of reference of the wind will change dependent nodes
                // so we need to recalculate them
                this.recalculateCascade();
            }
        }
    }

    updateLockedWind() {
        const target = NodeMan.get(this.lock);
        target.from = this.from;
        target.knots = this.knots;
        target.guiFrom.updateDisplay()
        target.guiKnots.updateDisplay()
    }

    recalculate() {
         if (this.dontRecurse) return;
         this.dontRecurse = true;

        if (this.lock !== undefined) {
            if (NodeMan.exists("lockWind")) {
                const lock = NodeMan.get("lockWind");
                if (lock.value) {
                    this.updateLockedWind()
                }
            }
        }

        this.dontRecurse = false;

        // var A = Sit.jetOrigin.clone()
        //
        // var B = A.clone().add(this.p().multiplyScalar(Sit.frames))
        // DebugArrowAB(this.id+" Wind",A,B,this.arrowColor,true,GlobalScene)
    }


}

export class CNodeDisplayWindArrow extends CNode {
    constructor(v) {
        super(v)
        this.input("source")
        this.input("displayOrigin",true)
        if (!this.in.displayOrigin) {
            this.addInput("displayOrigin", new CNodeOrigin({id:"displayOrigin"}))
        }
        this.arrowColor = v.arrowColor ?? "white"
        this.recalculate();
    }

    recalculate() {
    //    var A = Sit.jetOrigin.clone()
        var A = this.in.displayOrigin.p(0);
        var B = A.clone().add(this.in.source.p().multiplyScalar(10000))
        DebugArrowAB(this.id+" Wind",A,B,this.arrowColor,true,GlobalScene)
    }
}