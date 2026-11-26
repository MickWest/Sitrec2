import {CNode3DGroup} from "./CNode3DGroup";
import {EventManager} from "../CEventManager";
import {CustomManager, Globals, guiMenus, markSitchDirty, NodeMan, setRenderOne, UndoManager} from "../Globals";
import {Euler, MathUtils, Matrix4, Vector3} from "three";
import {getPointBelowLL} from "../threeExt";
import {setPowerNetworkAttribution} from "../AttributionOverlay";
import {createPowerNetworkGeometry} from "../PowerNetworkGeometry";
import {importedWireLinks, isPowerSupport, manualPowerLayerID, mappedSupport, powerLayers} from "../PowerObjectLinks";
import {localENU} from "../cloudField/CloudFieldFormat";
import {createVehicleRecipe} from "../../tools/vehicles/recipe";
import {par} from "../par";
import {t} from "../i18n";

export class CNodePowerNetwork extends CNode3DGroup {
    constructor(v) {
        super(v);
        this.manual = this.id === manualPowerLayerID;
        this.network = v.network ?? {points:[],ways:[]};
        this.edits = {};
        this.deleted = new Set();
        this.supports = new Map();
        let poles = 0, towers = 0;
        const points = this.network.points.map((p,index) => {
            if (!p.kind) return {...p};
            const objectId = p.objectId ?? 'powerSupport:' + this.id + ':' + p.lat + ',' + p.lon;
            const label = p.kind === "pole" ? t("powerNetwork.pole",{n:++poles}) : t("powerNetwork.tower",{n:++towers});
            this.supports.set(objectId,{index,label});
            return {...p,objectId,batched:!p.objectId};
        });
        this.network = {...this.network,points};
        this.sourceLinks = importedWireLinks(this.network);
        this.rebuildNetwork();
        if (!this.manual) {
            this.control = guiMenus.objects.add(this,"visible").name(t("powerNetwork.label",{filename:v.filename})).listen()
                .tooltip(t("powerNetwork.tooltip",{towers,poles,ways:this.network.ways.length}))
                .onChange(value => {this.show(value); markSitchDirty();});
        }
        this.show(this.visible);
        this.onElevation = () => {
            if (this.refreshTimer === undefined) this.refreshTimer = setTimeout(() => {
                this.refreshTimer = undefined;
                this.display.refreshGround();
                setRenderOne(true);
            },250);
        };
        this.onObject = ({id}) => {
            const object = NodeMan.get(id,false);
            if (!this.supports.has(id) || !object || object._vehicleDisposed) return;
            // A fixed object is restored after the source file, including on undo.
            if (this.deleted.delete(id)) this.rebuildNetwork();
            this.display.watchSupport(id);
        };
        EventManager.addEventListener("elevationChanged",this.onElevation);
        EventManager.addEventListener("objectsChanged",this.onObject);
    }

    rebuildNetwork() {
        const points = this.network.points.map(p => ({...p,deleted:this.deleted.has(p.objectId)}));
        const indices = new Map(points.map((p,i) => [p.objectId,i]));
        const ways = [];
        this.links = [];
        const indexAt = (id,fallback,anchor) => {
            if (!id) return fallback;
            if (indices.has(id)) return indices.get(id);
            if (!anchor) return undefined;
            const index = points.length;
            points.push({...anchor,objectId:id,external:true});
            indices.set(id,index);
            return index;
        };
        const add = (original,edit) => {
            const link = {...original,...edit};
            if (link.removed) return;
            if (this.deleted.has(link.from) || this.deleted.has(link.to)) return;
            const path = original.path?.slice() ?? [undefined,undefined];
            path[0] = indexAt(link.from,path[0],link.fromAnchor);
            path[path.length-1] = indexAt(link.to,path.at(-1),link.toAnchor);
            if (path[0] === undefined || path.at(-1) === undefined) return;
            this.links.push(link);
            ways.push({...link,path});
        };
        for (const link of this.sourceLinks) add(link,this.edits[link.id]);
        for (const edit of Object.values(this.edits)) if (edit.added) add(edit);
        const previous = this.display;
        this.display = createPowerNetworkGeometry({points,ways},getPointBelowLL);
        this.group.add(this.display.group);
        if (previous) {this.group.remove(previous.group); previous.dispose();}
        for (const id of this.supports.keys()) if (NodeMan.get(id,false)) this.display.watchSupport(id);
        setRenderOne(true);
    }

    // Return the same regular fixed object for every click on this batch instance.
    editSupport(id, record = true) {
        const existing = NodeMan.get(id,false);
        if (isPowerSupport(existing)) return existing;
        const info = this.supports.get(id);
        if (!info || existing || this.deleted.has(id)) return null;
        const p = this.display.points[info.index];
        const node = CustomManager.createFixedObject(id,id + "_manualPosition",[p.lat,p.lon,0],true,info.label);
        const parameters = {...p.parameters,height:p.height ?? p.parameters.height};
        node.applyVehicleRecipe(createVehicleRecipe(parameters,info.label,p.presetId));
        const {north,east} = localENU(p.lat,p.lon);
        // A fixed Sitrec model faces north (+Z). Its unrotated +X points west.
        node.common.rotateY = MathUtils.radToDeg(Math.atan2(-p.side.dot(new Vector3(...north)),
            -p.side.dot(new Vector3(...east))));
        node.powerNetworkOwner = this;
        node.update(par.frame);
        this.display.watchSupport(id);
        markSitchDirty();
        if (record) UndoManager?.add({
            description:t("powerNetwork.editSupport",{name:info.label}),
            undo:() => {
                const object = NodeMan.get(id,false), layer = NodeMan.get(this.id,false);
                if (!object || !layer) return;
                // Restore the original mapped instance and its wires when undoing promotion.
                object.powerNetworkOwner = undefined;
                CustomManager.deleteObject(object);
                layer.display.syncLinkedSupports(key => layer.resolveSupport(key));
            },
            redo:() => NodeMan.get(this.id,false)?.editSupport(id,false),
        });
        return node;
    }

    removeSupport(id) {
        if (!this.supports.has(id)) return;
        this.deleted.add(id);
        this.rebuildNetwork();
        markSitchDirty();
    }

    preRender(view) {
        if (!this.visible || !view.camera || !(view.heightPx > 0)) return;
        this.display.syncLinkedSupports(id => this.resolveSupport(id));
        this.display.setView(view.camera,view.heightPx);
    }

    resolveSupport(id) {
        const object = NodeMan.get(id,false), parameters = object?.proceduralModel?.recipe?.parameters;
        if (!object?.model || !isPowerSupport(object) || object.modelOrGeometry !== "model") {
            // Extra wires may terminate on a still-batched support in another import.
            if (this.supports.has(id)) return null;
            const match = mappedSupport(powerLayers(NodeMan),id);
            if (!match?.layer.visible || !match.point.parameters) return null;
            const p = match.point;
            const matrix = new Matrix4().makeBasis(p.side,p.up,new Vector3().crossVectors(p.side,p.up)).setPosition(p.base)
                .scale(new Vector3(1,(p.height ?? p.parameters.height)/p.parameters.height,1));
            return {parameters:p.parameters,matrix};
        }
        if (this.supports.has(id)) {
            object.powerNetworkOwner = this;
            if (id.startsWith("powerSupport:") && object.group.parent !== this.group) {
                object.container = this.group;
                this.group.add(object.group);
            }
        }
        object.model.updateWorldMatrix(true,false);
        const scale = (parameters.overallScale ?? 1) * object.baseScale / object.group.scale.x;
        const matrix = object.model.matrixWorld.clone();
        if (!object.needsUndo) {
            const {rotateX=0,rotateY=0,rotateZ=0} = object.common;
            const rad = MathUtils.degToRad;
            matrix.multiply(new Matrix4().makeRotationFromEuler(new Euler(rad(rotateX),rad(rotateY),rad(rotateZ),"YXZ")));
        }
        return {parameters,matrix:matrix.scale(new Vector3(scale,scale,scale))};
    }

    show(visible = true) {
        super.show(visible);
        if (!this.manual) setPowerNetworkAttribution(this.id,visible);
        setRenderOne(true);
    }

    modSerialize() {
        return {...super.modSerialize(),...(Object.keys(this.edits).length ? {wireEdits:this.edits} : {}),
            ...(this.deleted.size ? {deletedSupports:[...this.deleted]} : {})};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.wireEdits || v.deletedSupports) {
            this.edits = v.wireEdits ?? {};
            this.deleted = new Set(v.deletedSupports);
            this.rebuildNetwork();
        }
        this.show(this.visible);
    }

    dispose() {
        clearTimeout(this.refreshTimer);
        EventManager.removeEventListener("elevationChanged",this.onElevation);
        EventManager.removeEventListener("objectsChanged",this.onObject);
        if (!this.manual) setPowerNetworkAttribution(this.id,false);
        if (!Globals.disposing) {
            for (const id of this.supports.keys()) {
                const object = NodeMan.get(id,false);
                if (object?.powerNetworkOwner !== this) continue;
                object.powerNetworkOwner = undefined;
                if (object.group.parent === this.group) {
                    object.container = this.container;
                    this.container.add(object.group);
                }
            }
        }
        this.control?.destroy();
        this.display.dispose();
        super.dispose();
    }
}
