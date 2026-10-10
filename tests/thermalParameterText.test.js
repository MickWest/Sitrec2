// The thermal parameter text exists twice: src/i18n/en.js (shown by Sitrec) and the copies in
// tools/thermal/thermalSchema.js and tools/vehicles/thermalPreview.js (shown by the standalone
// tools pages, which cannot load en.js). These tests require the copies to be identical.
import en from "../src/i18n/en.js";
import {THERMAL_PARAMETERS} from "../tools/thermal/thermalSchema.js";
import {CONTROL_REASONS} from "../tools/vehicles/thermalPreview.js";

const text = en.thermal.parameters;

test("en.js has one thermal parameter entry for each schema parameter", () => {
    expect(Object.keys(text).sort()).toEqual(THERMAL_PARAMETERS.map(parameter => parameter.key).sort());
});

test.each(THERMAL_PARAMETERS.map(parameter => [parameter.key, parameter]))(
    "%s: the schema label, tooltip and option labels equal en.js", (key, parameter) => {
        expect(parameter.label).toBe(text[key].label);
        expect(parameter.tooltip).toBe(text[key].tooltip);
        expect(parameter.labelKey).toBe(`thermal.parameters.${key}.label`);
        expect(parameter.tooltipKey).toBe(`thermal.parameters.${key}.tooltip`);
        const optionLabels = parameter.options
            ? Object.fromEntries(parameter.options.map(option => [String(option.value), option.label]))
            : undefined;
        expect(optionLabels).toEqual(text[key].options);
    });

test("the Vehicle Designer control reasons equal en.js", () => {
    for (const [reason, value] of Object.entries(CONTROL_REASONS))
        expect(value).toBe(en.thermal.controlReasons[reason]);
    // en.js has two more reasons that only a Sitrec host gives (sounding and geometry turbulence).
    expect(Object.keys(en.thermal.controlReasons).filter(reason => !(reason in CONTROL_REASONS)).sort())
        .toEqual(["sounding", "turbulence"]);
});
