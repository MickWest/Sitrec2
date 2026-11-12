import {buildAircraft, disposeAircraft} from "./aircraft.js";
import {buildRoadVehicle} from "./roadVehicle.js";
import {isRoad, isMultirotor, isBalloon, isKite, isBird, normalizeParameters} from "./vehicleSchema.js";
import {buildMultirotor} from "./multirotor.js";
import {buildBalloon} from "./balloon.js";
import {buildKite} from "./kite.js";
import {buildBird} from "./bird.js";
import {addVehicleLights} from "./vehicleLights.js";
import {addVehicleLivery} from "./vehicleLivery.js";
import {visibleVehicleBounds, tagThermalMesh} from "./thermalTags.js";
import {Group, Vector3} from "three";
export function buildVehicle(input) {
    const p = normalizeParameters(input), plain = isKite(p) || isBird(p);     // no lettering on a kite or a bird
    const styled = p.brandLivery === "sitrec" && !plain ? {...p,bodyColor:"#f1f5f7",wingColor:"#e3eaed",cargoColor:"#f1f5f7",trimColor:p.brandColor,accentColor:p.brandColor,engineColor:p.brandColor,livery:"tail",sideStripe:false,...(isBalloon(p)?{balloonPattern:"solid"}:{})} : p;
    const model = isKite(p)?buildKite(p):isBird(p)?buildBird(p):isMultirotor(p)?buildMultirotor(styled):isBalloon(p)?buildBalloon(styled):isRoad(p) ? buildRoadVehicle(styled) : buildAircraft(styled);
    model.root.userData.parameters = p;
    model.root.userData.generator = "Sitrec Vehicle Designer";
    model.root.userData.units = "metres";
    model.root.userData.up = "+Y";
    model.root.userData.forward = "+Z";
    if (!plain) addVehicleLivery(model,p);
    addVehicleLights(model, p);
    model.root.traverse(object => {if (object.isMesh) tagThermalMesh(object, p);});
    const scale = p.overallScale;
    if (scale !== 1) {
        // The scale is on a group inside the root, not on the root: Sitrec measures a model with the
        // scale of its root set to 1, and the motion of the parts stays in full-size metres. At a
        // scale of 1 there is no group, so the model is the same as before this control existed.
        const group = new Group(); group.name = "Overall scale"; group.scale.setScalar(scale);
        group.add(...model.root.children.filter(child => !child.isLight)); model.root.add(group);
        // The lamps stay on the root, at their scaled positions: Sitrec reads the position of a lamp in
        // the root only. Their intensity goes with the square of the scale, so the scale model looks
        // the same as the full-size object from a distance that is in proportion.
        for (const light of model.root.children) if (light.isLight) {light.position.multiplyScalar(scale); light.intensity *= scale * scale;}
        for (const lamp of model.lamps ?? []) lamp.intensity *= scale * scale;
        // The builders made these for the full-size model.
        if (model.sweepBounds) {model.sweepBounds.min.multiplyScalar(scale); model.sweepBounds.max.multiplyScalar(scale);}
        for (const key of ["wingspan", "width", "height", "wheelbase", "bodyLength"]) if (Number.isFinite(model.stats[key])) model.stats[key] *= scale;
        for (const key of ["area", "wingArea"]) if (Number.isFinite(model.stats[key])) model.stats[key] *= scale * scale;
    }
    model.root.updateMatrixWorld(true);
    model.bounds = visibleVehicleBounds(model.root); model.stats.size = model.bounds.getSize(new Vector3());
    model.stats.triangles = 0;
    model.root.traverse(o => {if (o.isMesh && !o.userData.thermalOnly) model.stats.triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count)/3;});
    return model;
}
export const disposeVehicle = disposeAircraft;
