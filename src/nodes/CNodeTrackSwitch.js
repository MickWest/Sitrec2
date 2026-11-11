import {CNodeSwitch} from "./CNodeSwitch";
import {Sit} from "../Globals";

// A track selector switch that auto-registers as a drop target for imported tracks
// and prevents circular dependencies by excluding downstream nodes.
export class CNodeTrackSwitch extends CNodeSwitch {
    constructor(v) {
        super(v);

        // Auto-register as a track drop target so imported tracks appear as options
        if (Sit.dropTargets && Sit.dropTargets["track"]
            && !Sit.dropTargets["track"].includes(this.id)) {
            Sit.dropTargets["track"].push(this.id);
        }
    }

    // A switch that is made for one object (its Position) goes away with that object, so it
    // must not stay in the list of drop targets.
    dispose() {
        const targets = Sit.dropTargets?.["track"];
        const index = targets ? targets.indexOf(this.id) : -1;
        if (index >= 0) targets.splice(index, 1);
        super.dispose();
    }

    addOption(option, value, label = undefined) {
        // Walk outputs recursively to find all downstream nodes
        const downstream = new Set();
        const stack = [...this.outputs];
        while (stack.length > 0) {
            const node = stack.pop();
            if (downstream.has(node)) continue;
            downstream.add(node);
            for (const output of node.outputs) {
                stack.push(output);
            }
        }

        // Skip if adding this track would create a cycle
        if (downstream.has(value)) {
            return;
        }

        super.addOption(option, value, label);
    }
}
