import fs from "fs";
import path from "path";
import en from "../src/i18n/en";
import {CLOUD_EXTENT_MODES, CLOUD_PRESET_NAMES, CLOUD_QUALITIES, CLOUD_TYPE_NAMES, CLOUD_WIND_MODES} from "../src/clouds/CloudLayerModel";

// The node module pulls in the whole GUI; read its source for the keys instead.
const source = fs.readFileSync(path.resolve(__dirname, "../src/nodes/CNodeCloudLayers.js"), "utf8");

function lookup(key) {
    return key.split(".").reduce((node, part) => node?.[part], en);
}

// The same mapping as presetKey() in CNodeCloudLayers.js.
function presetKey(name) {
    return name.split(/\s+/).map((word, index) => index === 0 ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");
}

describe("cloud layer i18n", () => {
    test("every literal cloudLayers key in the node exists in en.js", () => {
        const keys = [...source.matchAll(/t\("(cloudLayers\.[A-Za-z0-9_.]+)"/g)].map(match => match[1]);
        expect(keys.length).toBeGreaterThan(30);
        const missing = keys.filter(key => typeof lookup(key) !== "string");
        expect(missing).toEqual([]);
    });

    test("every templated key (labels built from a name) exists", () => {
        // The control helpers build their keys as cloudLayers.<label>.label / .tooltip.
        expect(source).toContain("t(`cloudLayers.${label}.label`)");
        const labels = [...source.matchAll(/(?:length|number|windNumber)\("\w+", [^"]*"(\w+)"/g)].map(match => match[1]);
        expect(labels.length).toBeGreaterThan(8);
        const missing = [];
        for (const label of labels) {
            for (const part of ["label", "tooltip"]) {
                if (typeof lookup(`cloudLayers.${label}.${part}`) !== "string") missing.push(`${label}.${part}`);
            }
        }
        for (const name of CLOUD_TYPE_NAMES) if (!lookup(`cloudLayers.types.${name}`)) missing.push(`types.${name}`);
        for (const name of CLOUD_QUALITIES) if (!lookup(`cloudLayers.qualities.${name}`)) missing.push(`qualities.${name}`);
        for (const name of CLOUD_EXTENT_MODES) if (!lookup(`cloudLayers.extents.${name}`)) missing.push(`extents.${name}`);
        for (const name of CLOUD_WIND_MODES) if (!lookup(`cloudLayers.windModes.${name}`)) missing.push(`windModes.${name}`);
        for (const name of CLOUD_PRESET_NAMES) if (!lookup(`cloudLayers.presets.${presetKey(name)}`)) missing.push(`presets.${name}`);
        expect(missing).toEqual([]);
    });
});
