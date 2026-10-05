import {ZONE_TABLE, PROFILE_DEFAULTS, PRESET_OVERRIDES, TURBOFAN_CLIMB_REFERENCE, recoveryTemperature, resolveSignatures} from "../tools/thermal/signatures.js";

test("all 48 zones retain the temperature and emissivity bounds and non-surface distinctions", () => {
    expect(ZONE_TABLE).toHaveLength(48);
    for (const zone of ZONE_TABLE) {
        expect(zone.temperature_K.default).toBeGreaterThanOrEqual(zone.temperature_K.min);
        expect(zone.temperature_K.default).toBeLessThanOrEqual(zone.temperature_K.max);
        if (zone.emissivity_3_5) {
            expect(zone.emissivity_3_5.default).toBeGreaterThanOrEqual(zone.emissivity_3_5.min);
            expect(zone.emissivity_3_5.default).toBeLessThanOrEqual(zone.emissivity_3_5.max);
        } else expect(["gas","state_only"]).toContain(zone.radiator_kind);
        expect(zone.temperature_K.status).toMatch(/assumed|estimated/);
    }
});
test("recovery temperature matches the independent reference example", () => {
    // Pr=0.71, gamma=1.4, Ta=220 K, Mach=0.82: 246.394 K.
    expect(recoveryTemperature(220,0.82)).toBeCloseTo(246.394,3);
});
test("A340 recipe resolves the separate-flow climb surface priors at reference power", () => {
    const result=resolveSignatures({presetId:"a340-600"},239.40,0.82,0.90);
    expect(result.profile).toBe("high_bypass_turbofan");
    for (const [zone, temperatureK, emissivity, rangeK, rangeEpsilon] of [
        ["turbofan_cavity", 750, .90, [650, 850], [.70, .98]],
        ["turbofan_plug", 650, .35, [550, 750], [.05, .80]],
        ["turbofan_core_nozzle", 550, .30, [450, 650], [.05, .80]],
        ["turbofan_core_inner", 700, .80, [600, 800], [.40, .95]],
        ["turbofan_fan_duct", 290, .70, [260, 330], [.30, .95]],
        ["turbofan_pylon_shield", 450, .30, [350, 550], [.05, .80]],
    ]) {
        expect(result.resolveZone(zone)).toMatchObject({temperatureK, emissivity, status: "estimated", fallback: false});
        const row = ZONE_TABLE.find(item => item.id === zone);
        expect(row.temperature_K).toMatchObject({min: rangeK[0], max: rangeK[1], status: "estimated"});
        expect(row.emissivity_3_5).toMatchObject({min: rangeEpsilon[0], max: rangeEpsilon[1], status: "estimated"});
        expect(result.resolveZone(zone).source).toMatch(/published study/);
    }
    expect(result.resolveZone("airframe").temperatureK).toBeCloseTo(recoveryTemperature(239.40,0.82),10);
    expect(result.fallback).toBe(false);
});
test("power changes temperature using the declared equilibrium prior", () => {
    const off=resolveSignatures({presetId:"a340-600"},220,0.82,0);
    const part=resolveSignatures({presetId:"a340-600"},220,0.82,0.3);
    const cruise=resolveSignatures({presetId:"a340-600"},220,0.82,0.65);
    for (const id of ZONE_TABLE.filter(zone => zone.id.startsWith("turbofan_")).map(zone => zone.id)) {
        expect(off.zones[id].temperatureK).toBe(off.airframe.temperatureK);
        expect(part.zones[id].temperatureK).toBeGreaterThan(off.zones[id].temperatureK);
        expect(part.zones[id].temperatureK).toBeLessThan(cruise.zones[id].temperatureK);
        const faster = resolveSignatures({presetId:"a340-600"},220,.9,.65);
        expect(faster.zones[id].temperatureK - cruise.zones[id].temperatureK)
            .toBeCloseTo(recoveryTemperature(220,.9) - recoveryTemperature(220,.82), 10);
    }
    expect(TURBOFAN_CLIMB_REFERENCE).toMatchObject({powerFraction: .90, mach: .82, ambientK: 239.40, status: "estimated"});
});
test("explicit zone temperature/emissivity overrides estimated equilibrium", () => {
    const result=resolveSignatures({thermal:{profile:"piston",zones:{piston_stack:{temperatureK:650,emissivity:0.7}}}},280,0.1,0);
    expect(result.resolveZone("piston_stack")).toMatchObject({temperatureK:650,emissivity:0.7});
});
test("unknown zones use the resolved airframe and report fallback", () => {
    const result=resolveSignatures({presetId:"a340-600"},220,0.82,0.65);
    expect(result.resolveZone("missing_zone")).toMatchObject({temperatureK:result.airframe.temperatureK,emissivity:0.85,fallback:true});
});
test("plain objects and empty objects have explicit fallback behavior", () => {
    expect(resolveSignatures({temperatureK:345,emissivity:0.3},280).airframe).toMatchObject({temperatureK:345,emissivity:0.3,fallback:false});
    for (const input of [{},null,{parameters:{engineType:"none"}}]) {
        const result=resolveSignatures(input,278);
        expect(result.airframe).toMatchObject({temperatureK:278,emissivity:1,fallback:true});
        expect(result.diagnostics[0]).toMatch(/ambient temperature and emissivity 1/);
    }
});
test("known propulsion overrides beat engineType none", () => {
    expect(resolveSignatures({presetId:"heli-r22",parameters:{engineType:"none"}},293).profile).toBe("piston");
    expect(resolveSignatures({presetId:"mil-v22",parameters:{engineType:"none"}},293).profile).toBe("turboshaft");
    expect(resolveSignatures({parameters:{vehicleType:"drone"}},293).profile).toBe("electric");
});
test("non-surface zones never become opaque gray emitters", () => {
    const result=resolveSignatures({thermal:{profile:"fighter",zones:{jet_plume:{temperatureK:1500}}}},293);
    expect(result.resolveZone("jet_plume").fallback).toBe(true);
    expect(result.diagnostics.join(" ")).toMatch(/spectral volume/);
});
test("explicit afterburner controls and capability metadata", () => {
    const off=resolveSignatures({thermal:{profile:"fighter",afterburnerFraction:0}},255);
    const on=resolveSignatures({thermal:{profile:"fighter",afterburnerFraction:1}},255);
    expect(on.zones.afterburner_liner.temperatureK).toBeGreaterThan(off.zones.afterburner_liner.temperatureK);
    const disabled=resolveSignatures({presetId:"mil-b2",thermal:{afterburnerFraction:1}},255);
    expect(disabled.zones.afterburner_liner.temperatureK).toBe(disabled.zones.jet_cavity.temperatureK);
});
test("tables remain unchanged and invalid physical inputs fail", () => {
    const before=JSON.stringify([ZONE_TABLE,PROFILE_DEFAULTS,PRESET_OVERRIDES]);
    resolveSignatures({presetId:"a340-600"},270,0.7,0.5);
    expect(JSON.stringify([ZONE_TABLE,PROFILE_DEFAULTS,PRESET_OVERRIDES])).toBe(before);
    for (const temperatureK of [NaN,Infinity]) expect(()=>resolveSignatures({temperatureK})).toThrow();
});

test("bare metal keeps the table emissivity and unknown overrides retain skin fallback", () => {
    const result=resolveSignatures({thermal:{profile:"high_bypass_turbofan",zones:{typo_nozzle:{temperatureK:2000}}}},220,0.82,0.65);
    expect(result.resolveZone("bare_metal_skin").emissivity).toBe(0.1);
    expect(result.resolveZone("typo_nozzle")).toMatchObject({temperatureK:result.airframe.temperatureK,emissivity:0.85,fallback:true});
    expect(result.diagnostics.join(" ")).toMatch(/Unknown zone/);
});
