import {resolveSignatures} from "../tools/thermal/signatures.js";
import {resolveVehicleThermal} from "../tools/vehicles/thermalPreview.js";

const lantern = (power, canopyPowerFraction) => resolveSignatures({thermal: {profile: "lantern", powerFraction: power,
    ...(canopyPowerFraction === undefined ? {} : {canopyPowerFraction})}}, 299);

test("The canopy follows the burn power unless it is set apart", () => {
    const together = lantern(1);
    expect(lantern(1, null).resolveZone("lantern_envelope").temperatureK).toBe(together.resolveZone("lantern_envelope").temperatureK);
    // Canopy heating 0: the canopy is at the air temperature, while the flame keeps its full intensity.
    const apart = lantern(1, 0);
    expect(apart.resolveZone("lantern_envelope").temperatureK).toBeCloseTo(299, 6);
    expect(apart.resolveZone("lantern_flame").emissivity).toBe(together.resolveZone("lantern_flame").emissivity);
    // Full canopy heating with a weak flame: the canopy is at its full-burn temperature, the flame is weak.
    const weakFlame = lantern(0.1, 1);
    expect(weakFlame.resolveZone("lantern_envelope").temperatureK).toBe(together.resolveZone("lantern_envelope").temperatureK);
    expect(weakFlame.resolveZone("lantern_flame").emissivity).toBeCloseTo(0.1 * together.resolveZone("lantern_flame").emissivity, 10);
});

test("The vehicle recipe path passes the canopy heating through", () => {
    const recipe = {presetId: "sky-lantern", parameters: {vehicleType: "balloon", balloonShape: "lantern", thermalProfile: "auto",
        thermalPower: 1, thermalMach: 0, thermalAmbientK: 293, thermalEmissivity: 0.85}};
    const follows = resolveVehicleThermal(recipe, {airTemperatureK: 299, power: 0.5});
    const apart = resolveVehicleThermal(recipe, {airTemperatureK: 299, power: 0.5, canopyPower: 0});
    expect(apart.resolveZone("lantern_envelope").temperatureK).toBeCloseTo(299, 6);
    expect(follows.resolveZone("lantern_envelope").temperatureK).toBeGreaterThan(310);
});
