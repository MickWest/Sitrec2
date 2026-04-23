/**
 * Reflection-analysis methods for CNode3DObject.
 *
 * Casts sample rays from the current camera against the object to visualize
 * how light would glint off it for a given view — useful for IR / specular
 * studies. Installed on CNode3DObject.prototype via Object.assign.
 */

import {Raycaster, Vector2, Vector3} from "three";
import {NodeMan, setRenderOne} from "../Globals";
import {DebugArrowAB, removeDebugArrow} from "../threeExt";
import {CNodeViewText} from "./CNodeViewText";

export const reflectionMethods = {
    startReflectionAnalysis() {
        // Clean up any previous arrows
        this.cleanUpReflectionAnalysis();

        // Apply rotation (same as preRender) so raycasting sees the rotated geometry
        const common = this.common;
        let needsRotationUndo = false;
        let savedQuaternion;
        if (common && this.group && (common.rotateX || common.rotateY || common.rotateZ)) {
            needsRotationUndo = true;
            savedQuaternion = this.group.quaternion.clone();
            if (common.rotateY) this.group.rotateY(common.rotateY * Math.PI / 180);
            if (common.rotateX) this.group.rotateX(common.rotateX * Math.PI / 180);
            if (common.rotateZ) this.group.rotateZ(common.rotateZ * Math.PI / 180);
            this.group.updateMatrix();
            this.group.updateMatrixWorld();
        }

        const lookCameraNode = NodeMan.get("lookCamera", false);
        if (!lookCameraNode) {
            console.warn("Reflection Analysis: no lookCamera found");
            return;
        }
        const camera = lookCameraNode.camera;

        const terrainNode = NodeMan.get("TerrainModel", false);
        if (!terrainNode) {
            console.warn("Reflection Analysis: no TerrainModel found");
            return;
        }

        if (!this.cachedBoundingSphere) {
            console.warn("Reflection Analysis: no bounding sphere cached");
            return;
        }

        // Get object world position and bounding sphere radius in world space
        const objectWorldPos = new Vector3();
        this.group.getWorldPosition(objectWorldPos);
        const worldScale = new Vector3();
        this.group.getWorldScale(worldScale);
        const worldRadius = this.cachedBoundingSphere.radius * Math.max(worldScale.x, worldScale.y, worldScale.z);

        console.log("Reflection Analysis: objectWorldPos", objectWorldPos);
        console.log("Reflection Analysis: worldScale", worldScale, "worldRadius", worldRadius);
        console.log("Reflection Analysis: cachedBoundingSphere radius", this.cachedBoundingSphere.radius, "center", this.cachedBoundingSphere.center);

        // Check if object is in front of the camera
        const toObject = objectWorldPos.clone().sub(camera.position);
        const cameraDir = new Vector3();
        camera.getWorldDirection(cameraDir);
        console.log("Reflection Analysis: camera pos", camera.position, "dir", cameraDir, "dot", toObject.dot(cameraDir));
        if (toObject.dot(cameraDir) < 0) {
            console.warn("Reflection Analysis: object is behind the camera");
            return;
        }

        // Project the bounding sphere center to NDC
        const centerNDC = objectWorldPos.clone().project(camera);
        console.log("Reflection Analysis: centerNDC", centerNDC);

        // Compute NDC extent by offsetting by the world-space radius along camera's right and up
        const camRight = new Vector3();
        const camUp = new Vector3();
        camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

        const edgePointRight = objectWorldPos.clone().add(camRight.clone().multiplyScalar(worldRadius));
        const edgeNDCRight = edgePointRight.project(camera);
        const ndcRadiusX = Math.abs(edgeNDCRight.x - centerNDC.x);

        const edgePointUp = objectWorldPos.clone().add(camUp.clone().multiplyScalar(worldRadius));
        const edgeNDCUp = edgePointUp.project(camera);
        const ndcRadiusY = Math.abs(edgeNDCUp.y - centerNDC.y);

        // Add a small margin
        const margin = 1.1;
        const halfExtentX = ndcRadiusX * margin;
        const halfExtentY = ndcRadiusY * margin;

        console.log("Reflection Analysis: NDC extents X", halfExtentX, "Y", halfExtentY);

        const gridSize = this.reflectionGridSize;
        const raycaster = new Raycaster();

        let objectHitCount = 0;
        let terrainHitCount = 0;
        let noObjectHitCount = 0;
        let noFaceCount = 0;
        let backFaceCount = 0;
        let noTerrainHitCount = 0;
        let skippedClipCount = 0;
        let totalTerrainDist = 0;
        let totalPathLength = 0;
        let minPathLength = Infinity;
        let maxPathLength = -Infinity;

        for (let gy = 0; gy < gridSize; gy++) {
            for (let gx = 0; gx < gridSize; gx++) {
                // Map grid cell to NDC coordinates centered on the object
                const u = gridSize > 1 ? gx / (gridSize - 1) : 0.5;
                const v = gridSize > 1 ? gy / (gridSize - 1) : 0.5;
                const ndcX = centerNDC.x + (u * 2 - 1) * halfExtentX;
                const ndcY = centerNDC.y + (v * 2 - 1) * halfExtentY;

                const arrowId = `ReflAnalysis_${this.id}_${gx}_${gy}`;

                // Skip points outside clip space
                if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
                    skippedClipCount++;
                    continue;
                }

                const ndcPoint = new Vector2(ndcX, ndcY);
                raycaster.setFromCamera(ndcPoint, camera);
                raycaster.layers.enableAll();

                // Intersect with this object's group
                const intersects = raycaster.intersectObjects([this.group], true);
                if (intersects.length === 0) {
                    noObjectHitCount++;
                    continue;
                }

                const hit = intersects[0];
                objectHitCount++;

                if (!hit.face) {
                    noFaceCount++;
                    continue;
                }

                // Get the world-space normal from the face
                const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();

                // Compute the incident direction (from camera toward hit point)
                const incident = raycaster.ray.direction.clone().normalize();

                // Reflect: r = d - 2(d·n)n
                const dotDN = incident.dot(worldNormal);
                // Only reflect if the ray hits the front face (normal facing toward camera)
                if (dotDN >= 0) {
                    backFaceCount++;
                    continue;
                }
                const reflected = incident.clone().sub(worldNormal.clone().multiplyScalar(2 * dotDN)).normalize();

                // Trace reflected ray against terrain
                const reflectedRaycaster = new Raycaster(hit.point.clone(), reflected);
                reflectedRaycaster.layers.mask |= 0xFFFFFFFF; // match all layers

                const terrainHit = terrainNode.getClosestIntersect(reflectedRaycaster);
                if (!terrainHit) {
                    noTerrainHitCount++;
                    continue;
                }

                // Terrain hit — draw in green
                terrainHitCount++;
                const terrainDist = hit.point.distanceTo(terrainHit.point);
                const cameraToObject = camera.position.distanceTo(hit.point);
                const pathLength = cameraToObject + terrainDist;
                totalTerrainDist += terrainDist;
                totalPathLength += pathLength;
                if (pathLength < minPathLength) minPathLength = pathLength;
                if (pathLength > maxPathLength) maxPathLength = pathLength;

                DebugArrowAB(arrowId, hit.point.clone(), terrainHit.point.clone(), "#00ff00", true, GlobalScene, 5);
                this.reflectionArrowIds.push(arrowId);
            }
        }

        // Compute "behind object" distance: ray from camera through object center to terrain
        let behindObjectDist = 0;
        const behindArrowId = `ReflAnalysis_${this.id}_behind`;
        const behindDir = objectWorldPos.clone().sub(camera.position).normalize();
        const behindRaycaster = new Raycaster(camera.position.clone(), behindDir);
        behindRaycaster.layers.enableAll();
        const behindHit = terrainNode.getClosestIntersect(behindRaycaster);
        if (behindHit) {
            behindObjectDist = camera.position.distanceTo(behindHit.point);
            DebugArrowAB(behindArrowId, objectWorldPos.clone(), behindHit.point.clone(), "#ff00ff", true, GlobalScene, 5);
            this.reflectionArrowIds.push(behindArrowId);
        }

        // Compute stats
        const distToObject = camera.position.distanceTo(objectWorldPos);
        const percentGround = objectHitCount > 0 ? (terrainHitCount / objectHitCount) * 100 : 0;
        const avgTerrainDist = terrainHitCount > 0 ? totalTerrainDist / terrainHitCount : 0;
        const avgPathLength = terrainHitCount > 0 ? totalPathLength / terrainHitCount : 0;
        const pathFraction = (behindObjectDist > 0 && avgPathLength > 0) ? avgPathLength / behindObjectDist : 0;
        if (terrainHitCount === 0) { minPathLength = 0; maxPathLength = 0; }

        console.log(`Reflection Analysis results for ${this.id}:`);
        console.log(`  Grid: ${gridSize}x${gridSize} = ${gridSize * gridSize} rays`);
        console.log(`  Skipped (outside clip): ${skippedClipCount}`);
        console.log(`  No object hit: ${noObjectHitCount}`);
        console.log(`  Object hits: ${objectHitCount}`);
        console.log(`    No face: ${noFaceCount}`);
        console.log(`    Back face: ${backFaceCount}`);
        console.log(`    No terrain hit: ${noTerrainHitCount}`);
        console.log(`    Terrain hits: ${terrainHitCount}`);

        // Restore rotation
        if (needsRotationUndo) {
            this.group.quaternion.copy(savedQuaternion);
            this.group.updateMatrix();
            this.group.updateMatrixWorld();
        }

        // Create or update the results text view
        this.showReflectionResults({
            gridSize, objectHitCount, terrainHitCount,
            noObjectHitCount, noFaceCount, backFaceCount,
            noTerrainHitCount, skippedClipCount,
            distToObject, percentGround, avgTerrainDist, avgPathLength,
            minPathLength, maxPathLength,
            behindObjectDist, pathFraction,
        });

        setRenderOne(true);
    },

    showReflectionResults(stats) {
        const viewId = `ReflAnalysisView_${this.id}`;

        // Create the view if it doesn't exist yet
        if (!this.reflectionView) {
            this.reflectionView = new CNodeViewText({
                id: viewId,
                title: `Reflection: ${this.id}`,
                idPrefix: "refl-view",
                draggable: true,
                resizable: true,
                freeAspect: true,
                left: 0.01, top: 0.05, width: 0.30, height: 0.45,
                visible: true,
                manualScroll: true,
                maxMessages: 0,
            });
        }

        const v = this.reflectionView;
        v.clearOutput();
        v.show(true);

        const nm = (value) => `${(value / 1852).toFixed(2)} NM`;
        const grid = stats.gridSize;

        v.addMessage(`=== Reflection Analysis: ${this.id} ===`);
        v.addMessage(`Grid: ${grid}x${grid} = ${grid * grid} rays`);
        v.addMessage(``);
        v.addMessage(`--- Ray Counts ---`);
        v.addMessage(`Object hits:      ${stats.objectHitCount} / ${grid * grid - stats.skippedClipCount}`);
        v.addMessage(`  No face:        ${stats.noFaceCount}`);
        v.addMessage(`  Back face:      ${stats.backFaceCount}`);
        v.addMessage(`  No terrain hit: ${stats.noTerrainHitCount}`);
        v.addMessage(`  Terrain hits:   ${stats.terrainHitCount}`);
        v.addMessage(`No object hit:    ${stats.noObjectHitCount}`);
        if (stats.skippedClipCount > 0) {
            v.addMessage(`Skipped (clip):   ${stats.skippedClipCount}`);
        }
        v.addMessage(``);
        v.addMessage(`--- Results ---`);
        v.addMessage(`Percent ground:        ${stats.percentGround.toFixed(1)}%`);
        v.addMessage(`Dist to object:        ${nm(stats.distToObject)}`);
        v.addMessage(`Avg terrain dist:      ${nm(stats.avgTerrainDist)}`);
        v.addMessage(`Avg total path length: ${nm(stats.avgPathLength)}`);
        v.addMessage(`Min path:              ${nm(stats.minPathLength)}`);
        v.addMessage(`Max path:              ${nm(stats.maxPathLength)}`);
        v.addMessage(`Dist to far ground:    ${nm(stats.behindObjectDist)}`, "#ff00ff");
        v.addMessage(`Path fraction:         ${(stats.pathFraction * 100).toFixed(1)}%`);
    },

    cleanUpReflectionAnalysis() {
        for (const id of this.reflectionArrowIds) {
            removeDebugArrow(id);
        }
        this.reflectionArrowIds = [];
        if (this.reflectionView) {
            this.reflectionView.hide();
        }
        setRenderOne(true);
    },

    reflectionDistanceToColor(distance) {
        // Map distance to a color gradient: red (close) -> yellow -> green -> cyan -> blue (far)
        // Normalize distance to 0-1 range using reasonable bounds
        const minDist = 100;   // meters
        const maxDist = 50000; // meters
        const t = Math.max(0, Math.min(1, (distance - minDist) / (maxDist - minDist)));

        let r, g, b;
        if (t < 0.25) {
            // red -> yellow
            const s = t / 0.25;
            r = 1; g = s; b = 0;
        } else if (t < 0.5) {
            // yellow -> green
            const s = (t - 0.25) / 0.25;
            r = 1 - s; g = 1; b = 0;
        } else if (t < 0.75) {
            // green -> cyan
            const s = (t - 0.5) / 0.25;
            r = 0; g = 1; b = s;
        } else {
            // cyan -> blue
            const s = (t - 0.75) / 0.25;
            r = 0; g = 1 - s; b = 1;
        }

        const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    },
};
