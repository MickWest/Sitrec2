export * from "./vehicleSchema.js";
import {normalizeParameters, vehicleKind, isMultirotor} from "./vehicleSchema.js";
import {PRESETS as AIRCRAFT_PRESETS} from "./parameters.js";
import {ROAD_PRESETS} from "./roadPresets.js";
import {HELICOPTER_PRESETS} from "./helicopterPresets.js";
import {DRONE_PRESETS, BALLOON_PRESETS} from "./aerialPresets.js";
import {droneMotorLayout} from "./aerialParameters.js";

export const PRESETS = [...AIRCRAFT_PRESETS, ...HELICOPTER_PRESETS, ...ROAD_PRESETS,...DRONE_PRESETS,...BALLOON_PRESETS].map(p => {
    const parameters = normalizeParameters(p.role==="Drone"&&p.parameters.vehicleType!=="drone"?{...p.parameters,vehicleType:"drone",droneStyle:"fixedwing"}:p.parameters);
    let reference=p.reference;
    if(isMultirotor(parameters)) {
        const motors=droneMotorLayout(parameters),extent=axis=>Math.max(...motors.map(m=>m[axis]))-Math.min(...motors.map(m=>m[axis]))+parameters.rotorDiameter;
        reference={...reference,length:extent(1),wingspan:extent(0)};
    }
    return {...p, reference,parameters, vehicleType: vehicleKind(parameters)};
});
