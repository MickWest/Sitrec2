import {CustomManager, NodeFactory, NodeMan, UndoManager, markSitchDirty} from "./Globals";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {isPowerSupport, manualPowerLayerID, mappedSupport, powerLayers, wirePorts} from "./PowerObjectLinks";
import {t} from "./i18n";

function availableSupports(layers,self) {
    const names = new Map();
    for (const layer of layers) for (const [id,{label}] of layer.supports) {
        if (!layer.deleted.has(id)) names.set(id,label);
    }
    for (const {data} of Object.values(NodeMan.list)) if (isPowerSupport(data)) names.set(data.id,data.displayName);
    names.delete(self);
    const choices = {[t("powerNetwork.disconnected")]:""};
    for (const [id,name] of names) {
        let label = name;
        for (let n=2; Object.hasOwn(choices,label); n++) label = name + " (" + n + ")";
        choices[label] = id;
    }
    return choices;
}

function endpointAnchor(id,layers) {
    const object = NodeMan.get(id,false);
    if (isPowerSupport(object)) {
        const {x:lat,y:lon} = ECEFToLLAVD_radii(object.group.position);
        return {lat,lon,kind:object.proceduralModel.recipe.parameters.groundKind};
    }
    const p = mappedSupport(layers,id)?.point;
    return p && {lat:p.lat,lon:p.lon,kind:p.kind,design:p.design};
}

function refreshOpenLinks() {
    for (const {data} of Object.values(NodeMan.list)) {
        if (data.powerLinksFolder && !data.powerLinksFolder._closed) data.refreshPowerLinks();
    }
    const editing = CustomManager.getEditingObjectNode();
    editing?.refreshPowerLinks?.();
    if (editing) CustomManager.refreshEditingObjectMenu(editing.id);
}

function changeLink(layer,key,next) {
    const before = layer.edits[key];
    const apply = value => {
        const live = NodeMan.get(layer.id,false);
        if (!live) return;
        if (value) live.edits[key] = value;
        else delete live.edits[key];
        live.rebuildNetwork();
        refreshOpenLinks();
        markSitchDirty();
    };
    apply(next);
    UndoManager?.add({description:t("powerNetwork.editConnection"),undo:() => apply(before),redo:() => apply(next)});
}

export function refreshPowerLinks(object) {
    const folder = object.powerLinksFolder;
    if (!folder || !isPowerSupport(object)) return;
    for (const controller of [...folder.controllers]) controller.destroy();
    const layers = powerLayers(NodeMan);
    const choices = availableSupports(layers,object.id);
    const row = (role,layer,link) => {
        const state = {neighbor:link?.[role] ?? ""};
        const label = link ? t("powerNetwork."+role) : t("powerNetwork.add"+(role === "from" ? "From" : "To"));
        const controller = folder.add(state,"neighbor",choices).name(label);
        controller.tooltip(t("powerNetwork.portTip",{port:wirePorts[role === "from" ? "to" : "from"]}));
        controller.onChange(id => {
            if (link) {
                if (!id && link.added) {changeLink(layer,link.id,undefined); return;}
                const change = {...layer.edits[link.id]};
                if (id) {change[role] = id; change[role+"Anchor"] = endpointAnchor(id,layers);}
                else change.removed = true;
                changeLink(layer,link.id,change);
            } else if (id) {
                const from = role === "from" ? id : object.id, to = role === "to" ? id : object.id;
                if (layers.some(l => l.links.some(w => (w.from === from && w.to === to) || (w.from === to && w.to === from)))) {
                    controller.setValue(""); return;
                }
                const target = NodeMan.get(manualPowerLayerID,false) ?? NodeFactory.create("PowerNetwork",{id:manualPowerLayerID});
                const key = 'link-' + crypto.randomUUID();
                const fromAnchor = endpointAnchor(from,layers), toAnchor = endpointAnchor(to,layers);
                const minor = fromAnchor.kind === "pole" || toAnchor.kind === "pole";
                changeLink(target,key,{id:key,added:true,from,to,fromAnchor,toAnchor,minor,cables:minor ? 3 : 6});
            }
        });
    };
    for (const layer of layers) for (const link of layer.links) {
        if (link.from === object.id && link.to) row("to",layer,link);
        if (link.to === object.id && link.from) row("from",layer,link);
    }
    row("from"); row("to");
}

export function syncPowerLinkFolder(object) {
    const linkable = object.modelOrGeometry === "model" && isPowerSupport(object);
    if (linkable && !object.powerLinksFolder) {
        const folder = object.gui.addFolder(t("powerNetwork.connections")).close();
        folder.isCommon = true;
        object.powerLinksFolder = folder;
        folder.onOpenClose(changed => {if (changed === folder && !folder._closed) object.refreshPowerLinks();});
    }
    if (object.powerLinksFolder) linkable ? object.powerLinksFolder.show() : object.powerLinksFolder.hide();
}
