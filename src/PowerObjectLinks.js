// A route can contain survey bends without poles. Keep those vertices on the
// connection between the actual objects, including the open ends of a clipped way.
export function importedWireLinks(network) {
    const links = [];
    network.ways.forEach((way, wi) => {
        let start = 0;
        for (let end = 1; end < way.path.length; end++) {
            if (end !== way.path.length-1 && !network.points[way.path[end]].kind) continue;
            const path = way.path.slice(start,end+1);
            links.push({id: wi + "/" + start, from: network.points[path[0]].objectId,
                to: network.points[path.at(-1)].objectId, path, minor: way.minor,
                cables: way.cables, voltage: way.voltage});
            start = end;
        }
    });
    return links;
}

export const wirePorts = Object.freeze({from: "out", to: "in"});
export const manualPowerLayerID = "ManualPowerConnections";

export function isPowerSupport(object) {
    const kind = object?.proceduralModel?.recipe?.parameters?.groundKind;
    return kind === "pole" || kind === "pylon";
}

// Mapped supports need an endpoint ID even while they have no individual scene node.
let cachedManager, cachedVersion, cachedLayers;
export function powerLayers(nodeMan) {
    if (cachedManager !== nodeMan || cachedVersion !== nodeMan.listVersion) {
        cachedManager = nodeMan;
        cachedVersion = nodeMan.listVersion;
        cachedLayers = Object.values(nodeMan.list ?? {}).map(entry => entry.data).filter(node => node.supports instanceof Map && Array.isArray(node.sourceLinks));
    }
    return cachedLayers;
}

export function mappedSupport(layers,id) {
    for (const layer of layers) {
        const info = layer.supports.get(id);
        if (info && !layer.deleted.has(id)) return {layer,info,point:layer.display.points[info.index]};
    }
    return null;
}
