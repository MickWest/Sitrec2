import {Globals} from "./Globals";
import {isPowerSupport, powerLayers} from "./PowerObjectLinks";
import {mouseToNDC, setRaycasterFromCamera} from "./ViewUtils";

// Sample neighbouring pixels only for thin supports, only on a context click,
// and only after the pointer itself has missed all selectable geometry.
const diagonals = Math.SQRT2;
const pixelOffsets = [[2,0],[-2,0],[0,2],[0,-2],
    [diagonals,diagonals],[diagonals,-diagonals],[-diagonals,diagonals],[-diagonals,-diagonals]];

// Render-only rotations are undone between frames and Main and Look can use
// different scales for the same group. The move widget also picks its surface.
export function prepareObjectForPick(node, view) {
    if (!node.applyViewScale) return;
    const {rotateY,rotateX,rotateZ} = node.common ?? {};
    const rotate = !node.needsUndo && (rotateY || rotateX || rotateZ);
    if (!rotate && node.baseScale !== undefined && (Globals.objectScaleMain ?? 1) === 1 && node.baseScale === node._viewScale) return;
    const group = node.group, quaternion = group.quaternion.clone(), scale = group.scale.clone(), viewScale = node._viewScale;
    const flock = node.flockEnabled ? node.flock : null;
    const flockScale = flock?.writtenScale;
    node.applyViewScale(view);
    if (rotate) node.rotateForDisplay();
    group.updateWorldMatrix(true,true);
    flock?.preRender(node._viewScale ?? 1);
    return () => {
        group.quaternion.copy(quaternion);
        group.scale.copy(scale);
        node._viewScale = viewScale;
        group.updateWorldMatrix(true,true);
        flock?.preRender(flockScale ?? 1);
    };
}

export function intersectContextObjects(view, mouseX, mouseY, nodeMan, accept) {
    const {camera,raycaster} = view;
    const ndc = mouseToNDC(view,mouseX,mouseY);
    const previousMask = raycaster.layers.mask;
    const restore = [], supportRoots = [];
    try {
        nodeMan.iterate((id,node) => {
            if (!node.group?.visible || !node.applyViewScale) return;
            if (isPowerSupport(node) && node.model) supportRoots.push(node.model);
            const undo = prepareObjectForPick(node,view);
            if (undo) restore.push(undo);
        });
        for (const layer of powerLayers(nodeMan)) if (layer.visible) {
            layer.display.setView(camera,view.heightPx);
            supportRoots.push(layer.display.group);
        }
        raycaster.layers.mask = camera.layers.mask;
        setRaycasterFromCamera(raycaster,ndc,camera);
        const hits = raycaster.intersectObjects(view.scene.children,true).filter(accept);
        const exact = hits.filter(hit => !hit.supportPickMargin);
        if (exact.some(hit => view.findObjectID(hit.object)) || !supportRoots.length) return exact;

        // Ground in front of a support still blocks the near miss. Large empty
        // spaces between legs, and between a guy wire and the mast, stay open.
        const groundDistance = exact.find(hit => hit.object.isMesh)?.distance ?? Infinity;
        let nearest = hits.find(hit => hit.supportPickMargin && hit.distance <= groundDistance);
        if (!nearest) {
            const meshes = [];
            for (const root of supportRoots) root.traverseVisible(o => {if (o.isMesh) meshes.push(o);});
            for (const [dx,dy] of pixelOffsets) {
                const sample = mouseToNDC(view,mouseX+dx,mouseY+dy);
                if (Math.abs(sample.x)>1 || Math.abs(sample.y)>1) continue;
                setRaycasterFromCamera(raycaster,sample,camera);
                const hit = raycaster.intersectObjects(meshes,false).find(h =>
                    !h.supportPickMargin && h.distance <= groundDistance && accept(h));
                if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
            }
        }
        return nearest ? [nearest,...exact] : exact;
    } finally {
        for (const undo of restore.reverse()) undo();
        setRaycasterFromCamera(raycaster,ndc,camera);
        raycaster.layers.mask = previousMask;
    }
}
