import {Color} from "three";

export function vehicleLightState(node) {
    return {intensity: node.light.intensity, color: `#${node.light.color.getHexString()}`,
        visible: node.lightVisible, illuminates: node.lightIlluminates,
        radius: node._object?.material.uniforms.uRadius.value,
        ...(node.strobeEvery !== undefined ? {strobeEvery: node.strobeEvery, strobeLength: node.strobeLength, strobeOffset: node.strobeOffset} : {})};
}
export function captureVehicleLightOverrides(lights, baseline = {}, previous = {}) {
    const result = JSON.parse(JSON.stringify(previous));
    for (const light of lights ?? []) {
        const name = light.light.name, state = vehicleLightState(light), base = baseline[name];
        if (!base) continue;
        for (const [key, value] of Object.entries(state)) {
            if (value !== base[key]) (result[name] ??= {})[key] = value;
            else if (result[name]) delete result[name][key];
        }
    }
    return result;
}
export function applyVehicleLightOverrides(lights, overrides) {
    for (const node of lights ?? []) {
        const state = overrides?.[node.light.name];
        if (!state) continue;
        const controls = {intensity:"intensityControl", visible:"lightVisibleControl", illuminates:"lightIlluminatesControl",
            radius:"radiusControl", strobeEvery:"strobeEveryControl", strobeLength:"strobeLengthControl", strobeOffset:"strobeOffsetControl"};
        for (const [key, control] of Object.entries(controls)) {
            const value = state[key];
            if (typeof value === "boolean") node[control]?.setValue(value ? 1 : 0);
            else if (Number.isFinite(value) && value >= 0) node[control]?.setValue(value);
        }
        if (typeof state.color === "string" && /^#[0-9a-f]{6}$/i.test(state.color)) node.colorControl?.guiEntry.setValue(new Color(state.color));
    }
}
