// A picture of the background around a camera that only turns (see
// src/photoBackdrop/PhotoBackdropFormat.js), drawn in the look view at the azimuth and
// elevation each pixel was photographed at. Because the camera does not move, the background
// is a pure function of where it points, so a mosaic of registered photos reproduces every
// photo exactly, with no terrain model.
//
// Layers, all centred on the look camera:
//   fill     - one color behind everything (optional), so the view outside the photos is plain;
//   sky      - the whole picture, drawn before the scene and without depth, like a skybox;
//   occluder - only the ground (terrainMask), "range" metres away, writing depth, so objects
//              beyond that range go behind the hills and nearer ones pass in front;
//   main     - the picture in the MAIN view, on the same sphere "range" metres away, so the
//              photographed ground can be seen where it is assumed to be. Only the photographed
//              part (coverageMask) is drawn. The other layers are look view only.
// The picture already shows where things appeared, refraction included, so it is excluded
// from terrestrial refraction. It also already shows the real ground, so by default the
// terrain model is hidden while the look view draws (a different ground would sit in front).
import {
    BackSide, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial,
    SphereGeometry, SRGBColorSpace, TextureLoader, Vector3,
} from "three";
import {CNode3DGroup} from "./CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {LLAToECEF} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {getLocalUpVector, getNorthPole} from "../SphericalMath";
import {guiMenus, NodeMan, setRenderOne} from "../Globals";
import {t} from "../i18n";
import {excludeFromTerrestrialRefraction} from "../atmosphere/terrestrialRefraction";
import {radians} from "../utils";

const PATCH_STEP_DEG = 0.1;     // tessellation of the picture; finer than any visible bend

export class CNodePhotoBackdrop extends CNode3DGroup {
    constructor(v) {
        super({...v, layers: v.layers ?? LAYER.MASK_LOOK});
        this.backdrop = v.backdrop;
        this.name = this.backdrop.name;
        this.range = v.range ?? this.backdrop.range;
        this.showSky = v.showSky ?? true;
        this.occlude = v.occlude ?? !!this.backdrop.terrainMask;
        this.fill = v.fill ?? !!this.backdrop.fillColor;
        this.fillColor = new Color(v.fillColor ?? this.backdrop.fillColor ?? "#808080");
        this.followCamera = v.followCamera ?? true;
        this.hideTerrain = v.hideTerrain ?? true;
        this.showInMain = v.showInMain ?? true;
        this.mainOpacity = v.mainOpacity ?? 1;

        this.placeFrame();
        this.loadTextures();
        this.buildMeshes();
        this.createGUIFolder();
    }

    // The capture point and its local basis, built the way Camera Heading ▸ Custom Az/El
    // builds it (CNodeControllerAzElZoom.apply): up = ellipsoid normal, north = toward the
    // pole perpendicular to up, east = up x south.
    placeFrame() {
        const {lat, lon, altMSL} = this.backdrop.origin;
        this.originECEF = LLAToECEF(lat, lon, altMSL + meanSeaLevelOffset(lat, lon));
        this.up = getLocalUpVector(this.originECEF);
        const toNorth = getNorthPole().clone().sub(this.originECEF).normalize();
        this.north = toNorth.sub(this.up.clone().multiplyScalar(toNorth.dot(this.up))).normalize();
        this.east = new Vector3().crossVectors(this.up, this.north.clone().negate());
        this.group.position.copy(this.originECEF);
    }

    direction(azDeg, elDeg) {
        const az = radians(azDeg), el = radians(elDeg);
        return this.north.clone().multiplyScalar(Math.cos(el) * Math.cos(az))
            .addScaledVector(this.east, Math.cos(el) * Math.sin(az))
            .addScaledVector(this.up, Math.sin(el));
    }

    loadTextures() {
        const loader = new TextureLoader();
        const done = () => setRenderOne(true);
        this.texture = loader.load(this.backdrop.image, done);
        this.texture.colorSpace = SRGBColorSpace;
        this.maskTexture = this.backdrop.terrainMask ? loader.load(this.backdrop.terrainMask, done) : null;
        this.coverageTexture = this.backdrop.coverageMask ? loader.load(this.backdrop.coverageMask, done) : null;
    }

    // The picture as a patch of a sphere of the given radius: vertex (az, el) at
    // texture (u, v) = ((az - azMin) / width, (el - elMin) / height). The default flipY puts
    // image row 0 at v = 1, the top.
    buildPatchGeometry(radius) {
        const {azMin, azMax, elMin, elMax} = this.backdrop;
        const nx = Math.max(8, Math.ceil((azMax - azMin) / PATCH_STEP_DEG));
        const ny = Math.max(4, Math.ceil((elMax - elMin) / PATCH_STEP_DEG));
        const positions = [], uvs = [], indices = [];
        for (let j = 0; j <= ny; j++) {
            const el = elMin + (elMax - elMin) * j / ny;
            for (let i = 0; i <= nx; i++) {
                const az = azMin + (azMax - azMin) * i / nx;
                const p = this.direction(az, el).multiplyScalar(radius);
                positions.push(p.x, p.y, p.z);
                uvs.push(i / nx, j / ny);
            }
        }
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
                indices.push(a, c, b, b, c, d);
            }
        }
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
        geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        return geometry;
    }

    addMesh(geometry, material, renderOrder) {
        // The picture already includes the real haze; aerial perspective would add more to the
        // depth-tested ground only, leaving a seam against the picture.
        material.userData.atmosphere = false;
        const mesh = new Mesh(geometry, material);
        mesh.renderOrder = renderOrder;
        mesh.frustumCulled = false;
        mesh.layers.mask = this.group.layers.mask;
        excludeFromTerrestrialRefraction(mesh);
        this.group.add(mesh);
        return mesh;
    }

    buildMeshes() {
        this.disposeMeshes();
        const flat = {fog: false, toneMapped: false};
        this.fillMesh = this.addMesh(new SphereGeometry(this.range, 32, 16),
            new MeshBasicMaterial({...flat, side: BackSide, depthTest: false, depthWrite: false}), -1002);
        this.fillMesh.material.color = this.fillColor;   // shared, so the Fill Color control edits it live
        this.skyMesh = this.addMesh(this.buildPatchGeometry(this.range),
            new MeshBasicMaterial({...flat, map: this.texture, side: DoubleSide, depthTest: false, depthWrite: false}), -1001);
        if (this.maskTexture) {
            this.occluderMesh = this.addMesh(this.buildPatchGeometry(this.range),
                new MeshBasicMaterial({...flat, map: this.texture, alphaMap: this.maskTexture, alphaTest: 0.5, side: DoubleSide}), 0);
        }
        this.mainMesh = this.addMesh(this.buildPatchGeometry(this.range), new MeshBasicMaterial({
            ...flat, map: this.texture, alphaMap: this.coverageTexture, alphaTest: this.coverageTexture ? 0.5 : 0,
            side: DoubleSide,
        }), 0);
        this.mainMesh.layers.mask = LAYER.MASK_MAIN;
        this.applyMainOpacity();
        this.applyVisibility();
    }

    applyMainOpacity() {
        const material = this.mainMesh.material;
        material.opacity = this.mainOpacity;
        material.transparent = this.mainOpacity < 1;
        material.depthWrite = this.mainOpacity >= 1;
        material.needsUpdate = true;
    }

    applyVisibility() {
        this.fillMesh.visible = this.fill;
        this.skyMesh.visible = this.showSky;
        if (this.occluderMesh) this.occluderMesh.visible = this.occlude;
        this.mainMesh.visible = this.showInMain;
    }

    // Centre on the camera that took the photos, so the angles stay exact even if the camera
    // track and the file's origin differ by a few metres.
    preRender(view) {
        if (this.followCamera) {
            const camera = NodeMan.get("lookCamera", false)?.camera;
            if (camera) this.group.position.copy(camera.position);
        }
        // Hide the terrain only for the look view. Any other view's preRender restores it, as
        // does postRender and dispose, so a draw that throws, or an exporter that calls
        // preRender without postRender, cannot leave the terrain hidden elsewhere.
        if (this.hideTerrain && this.visible && view.id === "lookView") {
            const terrain = NodeMan.get("TerrainModel", false)?.group;
            if (terrain?.visible) {
                terrain.visible = false;
                this._hiddenTerrain = terrain;
            }
        } else {
            this.restoreTerrain();
        }
    }

    postRender(view) {
        this.restoreTerrain();
    }

    restoreTerrain() {
        if (this._hiddenTerrain) {
            this._hiddenTerrain.visible = true;
            this._hiddenTerrain = null;
        }
    }

    createGUIFolder() {
        this.guiFolder = guiMenus.objects.addFolder(t("photoBackdrop.folder.label", {name: this.name}));
        const changed = () => { this.applyVisibility(); setRenderOne(true); };
        this.guiFolder.add(this, "visible").name(t("photoBackdrop.visible.label")).onChange(value => {
            this.show(value);
            setRenderOne(true);
        });
        this.guiFolder.add(this, "showSky").name(t("photoBackdrop.showSky.label"))
            .tooltip(t("photoBackdrop.showSky.tooltip")).onChange(changed);
        if (this.occluderMesh) {
            this.guiFolder.add(this, "occlude").name(t("photoBackdrop.occlude.label"))
                .tooltip(t("photoBackdrop.occlude.tooltip")).onChange(changed);
        }
        this.guiFolder.add(this, "range", 100, 200000, 100).name(t("photoBackdrop.range.label"))
            .tooltip(t("photoBackdrop.range.tooltip")).onFinishChange(() => { this.buildMeshes(); setRenderOne(true); });
        this.guiFolder.add(this, "fill").name(t("photoBackdrop.fill.label"))
            .tooltip(t("photoBackdrop.fill.tooltip")).onChange(changed);
        this.guiFolder.addColor(this, "fillColor").name(t("photoBackdrop.fillColor.label"))
            .onChange(() => setRenderOne(true));
        this.guiFolder.add(this, "showInMain").name(t("photoBackdrop.showInMain.label"))
            .tooltip(t("photoBackdrop.showInMain.tooltip")).onChange(changed);
        this.guiFolder.add(this, "mainOpacity", 0, 1, 0.01).name(t("photoBackdrop.mainOpacity.label"))
            .onChange(() => { this.applyMainOpacity(); setRenderOne(true); });
        this.guiFolder.add(this, "hideTerrain").name(t("photoBackdrop.hideTerrain.label"))
            .tooltip(t("photoBackdrop.hideTerrain.tooltip")).onChange(() => setRenderOne(true));
        this.guiFolder.add(this, "followCamera").name(t("photoBackdrop.followCamera.label"))
            .tooltip(t("photoBackdrop.followCamera.tooltip")).onChange(value => {
                if (!value) this.group.position.copy(this.originECEF);
                setRenderOne(true);
            });
        this.guiFolder.close();
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            visible: this.visible,
            showSky: this.showSky,
            occlude: this.occlude,
            range: this.range,
            fill: this.fill,
            fillColor: "#" + this.fillColor.getHexString(),
            followCamera: this.followCamera,
            hideTerrain: this.hideTerrain,
            showInMain: this.showInMain,
            mainOpacity: this.mainOpacity,
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.showSky !== undefined) this.showSky = !!v.showSky;
        if (v.occlude !== undefined) this.occlude = !!v.occlude;
        if (v.fill !== undefined) this.fill = !!v.fill;
        if (v.fillColor !== undefined) this.fillColor.set(v.fillColor);
        if (v.followCamera !== undefined) this.followCamera = !!v.followCamera;
        if (v.hideTerrain !== undefined) this.hideTerrain = !!v.hideTerrain;
        if (v.showInMain !== undefined) this.showInMain = !!v.showInMain;
        if (v.mainOpacity !== undefined) this.mainOpacity = v.mainOpacity;
        if (v.visible !== undefined) this.show(v.visible);
        if (v.range !== undefined && v.range > 0 && v.range !== this.range) {
            this.range = v.range;
            this.buildMeshes();
        }
        if (!this.followCamera) this.group.position.copy(this.originECEF);
        this.applyMainOpacity();
        this.applyVisibility();
        this.guiFolder?.controllersRecursive().forEach(c => c.updateDisplay());
    }

    disposeMeshes() {
        for (const key of ["fillMesh", "skyMesh", "occluderMesh", "mainMesh"]) {
            const mesh = this[key];
            if (!mesh) continue;
            this.group.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
            this[key] = null;
        }
    }

    dispose() {
        this.restoreTerrain();
        this.disposeMeshes();
        this.texture?.dispose();
        this.maskTexture?.dispose();
        this.coverageTexture?.dispose();
        this.guiFolder?.destroy();
        this.guiFolder = null;
        super.dispose();
    }
}
