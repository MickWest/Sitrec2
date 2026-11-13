import {CNodeGUIValue} from "./CNodeGUIValue";
import {Globals, NodeMan, Units} from "../Globals";
import {raycastGroundElevationFast} from "../raycastGround";

// The range is a presentation of the first LOS, not a new graph dependency:
// a camera can itself follow a traverse, so wiring LOS as an input can cycle.
export class CNodeStartDistance extends CNodeGUIValue {
    constructor(v, guiMenu) {
        super({...v, start: 1 / Units.big.toM, elastic: false}, guiMenu);
        this.losID = v.los ?? "JetLOS";
        this.fallbackMaxMeters = v.end * Units.big.toM;
        this.guiEntry?.allowInputExpandMax();
    }

    update(frame) {
        super.update(frame);
        this.updateRange();
    }

    updateRange() {
        if (!this.guiEntry) return;
        const los = NodeMan.get(this.losID, false)?.v(0);
        if (!los?.position || !los?.heading || !Number.isFinite(los.position.lengthSq())
            || !Number.isFinite(los.heading.lengthSq()) || los.heading.lengthSq() === 0) return;

        const terrain = NodeMan.get("TerrainModel", false);
        const revision = terrain?.elevationRevision;
        const previous = this.rangeLOS;
        if (previous && previous.position.equals(los.position) && previous.heading.equals(los.heading)
            && previous.terrain === terrain && previous.revision === revision
            && previous.equatorRadius === Globals.equatorRadius && previous.polarRadius === Globals.polarRadius) return;

        this.rangeLOS = {
            position: los.position.clone(), heading: los.heading.clone(), terrain, revision,
            equatorRadius: Globals.equatorRadius, polarRadius: Globals.polarRadius,
        };
        const hit = raycastGroundElevationFast(los.position, los.heading.clone().normalize(), 1000000, -100);
        const distance = hit ? los.position.distanceTo(hit) : this.fallbackMaxMeters;
        // Stay just in front of the camera: an exactly zero range is degenerate
        // for methods that derive a direction from the camera to the target.
        const maxMeters = distance > 1 ? distance : this.fallbackMaxMeters;
        this.start = 1 / Units.big.toM;
        this.end = maxMeters / Units.big.toM;
        this.step = Math.max(1, maxMeters / 500) / Units.big.toM;
        this.maxMax = this.end;
        this.guiEntry._maxMax = this.end;
        this.guiEntry.min(this.start).max(this.end).step(this.step)
            .decimals(Math.max(0, Math.ceil(Math.log10(Units.big.toM))));
        this.updateMirrors();
        // Do not clamp the value. Opening an old scene or moving the camera
        // must not silently change its reconstruction, even outside this range.
    }

    changeUnits(units, scaleFactors) {
        super.changeUnits(units, scaleFactors);
        this.rangeLOS = undefined;
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.rangeLOS = undefined;
    }
}
