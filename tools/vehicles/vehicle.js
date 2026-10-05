import {buildAircraft, disposeAircraft} from "./aircraft.js";
import {buildRoadVehicle} from "./roadVehicle.js";
import {isRoad, isMultirotor, isBalloon, normalizeParameters} from "./vehicleSchema.js";
import {buildMultirotor} from "./multirotor.js";
import {buildBalloon} from "./balloon.js";
import {addVehicleLights} from "./vehicleLights.js";
import {addVehicleLivery} from "./vehicleLivery.js";
import {visibleVehicleBounds, tagThermalMesh} from "./thermalTags.js";
import {Vector3} from "three";
export function buildVehicle(input) {
    const p = normalizeParameters(input);
    const styled = p.brandLivery === "sitrec" ? {...p,bodyColor:"#f1f5f7",wingColor:"#e3eaed",cargoColor:"#f1f5f7",trimColor:p.brandColor,accentColor:p.brandColor,engineColor:p.brandColor,livery:"tail",sideStripe:false,...(isBalloon(p)?{balloonPattern:"solid"}:{})} : p;
    const model = isMultirotor(p)?buildMultirotor(styled):isBalloon(p)?buildBalloon(styled):isRoad(p) ? buildRoadVehicle(styled) : buildAircraft(styled);
    model.root.userData.parameters = p;
    model.root.userData.generator = "Sitrec Vehicle Designer";
    model.root.userData.units = "metres";
    model.root.userData.up = "+Y";
    model.root.userData.forward = "+Z";
    addVehicleLivery(model,p);
    addVehicleLights(model, p);
    model.root.traverse(object => {if (object.isMesh) tagThermalMesh(object, p);});
    model.root.updateMatrixWorld(true);
    model.bounds = visibleVehicleBounds(model.root); model.stats.size = model.bounds.getSize(new Vector3());
    model.stats.triangles = 0;
    model.root.traverse(o => {if (o.isMesh && !o.userData.thermalOnly) model.stats.triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count)/3;});
    return model;
}
export const disposeVehicle = disposeAircraft;
