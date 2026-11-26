import {NodeMan} from "./Globals";
import {trackSelectors} from "./TrackSelectors";

// Use the same representation as a saved sitch. Some mod serializers return
// references to live parameter objects that the next edit will mutate.
export function captureNodeMods(ids) {
    const mods = [];
    for (const id of new Set(ids)) {
        const state = NodeMan.get(id, false)?.modSerialize?.();
        if (state) mods.push([id, JSON.parse(JSON.stringify(state))]);
    }
    return mods;
}

export function restoreNodeMods(mods) {
    for (const [id, state] of mods) {
        NodeMan.get(id, false)?.modDeserialize(structuredClone(state));
    }
}

export function captureTrackChoices(choice) {
    const ids = [...trackSelectors()].filter(node => node.choice === choice).map(node => node.id);
    return () => {
        for (const id of ids) {
            const node = NodeMan.get(id, false);
            if (node?.inputs[choice]) node.selectOption(choice);
        }
    };
}
