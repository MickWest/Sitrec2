import {BoxGeometry, ConeGeometry, CylinderGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, MeshPhongMaterial, Sphere, Vector3} from "three";
import {CNode3DGroup} from "./CNode3DGroup";
import {CustomManager, guiMenus, markSitchDirty, NodeMan, setRenderOne, Sit, Synth3DManager, UndoManager} from "../Globals";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {enuBasis} from "../clouds/CloudMath";
import {addNameControl} from "../DisplayName";
import {par} from "../par";
import {t} from "../i18n";
import {EventManager} from "../CEventManager";
import {getVisiblePointBelow} from "../threeExt";
import {DEFAULT_FLOWER_CODE, DEFAULT_FLOWER_PAN, defaultSpotlightBeam, isFlowerCode, MAX_PROJECTOR_BEAMS, MAX_SPOTLIGHT_LUMENS,
    PLANAR_PATTERNS, readSpotlightLumens, SPOTLIGHT_PATTERNS, SPOTLIGHT_PRESETS, spotlightCandela, spotlightDirection, spotlightPreset} from "../SpotlightMotion";
import {createSpotlightConeMaterial} from "../SpotlightCone";
import {DEFAULT_CONCERT} from "../SpotlightConcert";
import {readQLCSpotlightEffects} from "../SpotlightQLC";
import {showChoice, showError} from "../showError";

const GROUND_CLEARANCE = 0.05; // meters from the ground to the bottom of the base
const UP = new Vector3(0, 1, 0);
const BEAM_CONTROLS = {
    heading: [0, 360, 1], tilt: [0, 80, 0.5], swing: [0, 75, 0.5],
    period: [0.25, 120, 0.25], phase: [0, 360, 1], aspect: [0, 127, 0.001],
    width: [1, 45, 0.5],
};
const CONCERT_CONTROLS = {speed: [0.25, 4, 0.05], heading: [0, 360, 1], spacing: [0, 60, 1]};

function readBeam(saved, index) {
    const beam = defaultSpotlightBeam(index);
    if (SPOTLIGHT_PATTERNS.includes(saved?.pattern)) beam.pattern = saved.pattern;
    beam.reverse = saved?.reverse === true;
    beam.pingPong = saved?.pingPong === true;
    for (const [key, [min, max]] of Object.entries(BEAM_CONTROLS)) {
        if (Number.isFinite(saved?.[key])) beam[key] = Math.max(min, Math.min(max, saved[key]));
    }
    return beam;
}

export class CNodeSpotlight extends CNode3DGroup {
    constructor(v) {
        super(v);
        this.groundMoveOnly = true;
        // The move widget and locator ring pick the projector housing.
        this.cachedBoundingSphere = new Sphere(new Vector3(0, 0.5, 0), 2.5);
        this.name = v.name ?? this.id;
        this.lat = v.lat;
        this.lon = v.lon;
        this.altitude = this.groundAltitude(this.lat, this.lon);
        this.count = Number.isFinite(v.count) ? Math.max(1, Math.min(MAX_PROJECTOR_BEAMS, Math.round(v.count))) : 4;
        this.lumens = readSpotlightLumens(v, this.count);
        this.spread = Number.isFinite(v.spread) ? Math.max(0.1, Math.min(3, v.spread)) : 1;
        this.settings = (Array.isArray(v.beams) ? v.beams.slice(0, MAX_PROJECTOR_BEAMS) : []).map(readBeam);
        this.beams = [];
        this.showCones = v.showCones ?? false;
        this.flowerCode = isFlowerCode(v.flowerCode) ? v.flowerCode : DEFAULT_FLOWER_CODE;
        this.flowerPan = Number.isFinite(v.flowerPan) ? Math.max(0, Math.min(180, v.flowerPan)) : DEFAULT_FLOWER_PAN;
        this.concert = {...DEFAULT_CONCERT};
        for (const [key, [min, max]] of Object.entries(CONCERT_CONTROLS)) {
            const value = v.concert?.[key];
            if (Number.isFinite(value)) this.concert[key] = Math.max(min, Math.min(max, value));
        }
        this.coneHit = new Vector3();
        this.field = Synth3DManager.spotlights;

        this.housing = new MeshPhongMaterial({color: 0x494c52});
        this.lens = new MeshBasicMaterial({color: 0xfff9e8});
        this.headGeometry = new CylinderGeometry(0.29, 0.24, 0.55, 12);
        this.coneGeometry = new ConeGeometry(1, 1, 36, 1, true).rotateX(Math.PI).translate(0, 0.5, 0);
        this.base = new Mesh(new BoxGeometry(3.4, 0.6, 3.4), this.housing);
        this.base.position.y = 0.3;
        this.group.add(this.base);
        this.placeProjector();
        this.field.projectors.set(this.id, this);

        this.guiFolder = guiMenus.objects.addFolder(this.name).close();
        addNameControl(this.guiFolder, this, {onRename: markSitchDirty});
        this.guiFolder.add(this, "visible").name(t("spotlight.visible")).onChange(value => {
            this.show(value);
            this.changed();
        });
        this.guiFolder.add(this, "showCones").name(t("spotlight.showCones")).onChange(() => this.changed());
        this.guiFolder.add(this, "lumens", 0, MAX_SPOTLIGHT_LUMENS, 100).listen().name(t("spotlight.lumens"))
            .tooltip(t("spotlight.lumensHelp")).onChange(() => this.changed());
        this.guiFolder.add(this, "spread", 0.1, 3, 0.01).name(t("spotlight.spread"))
            .tooltip(t("spotlight.spreadHelp")).onChange(() => this.changed());
        this.preset = "";
        const choices = {[t("spotlight.choosePreset")]: ""};
        for (const name of SPOTLIGHT_PRESETS) choices[t(`spotlight.presets.${name}`)] = name;
        this.guiFolder.add(this, "preset", choices).name(t("spotlight.preset")).listen().onChange(name => {
            this.preset = "";
            if (name) this.applyPreset(name);
        });
        this.guiFolder.add(this, "chooseQLCFile").name(t("spotlight.importQLC")).tooltip(t("spotlight.qlcHelp"));
        this.guiFolder.add(this, "count", 1, MAX_PROJECTOR_BEAMS, 1).listen().name(t("spotlight.count")).onChange(() => {
            this.resize();
            this.changed();
        });
        this.concertFolder = this.guiFolder.addFolder(t("spotlight.concert.title"));
        for (const [key, range] of Object.entries(CONCERT_CONTROLS)) {
            this.concertFolder.add(this.concert, key, ...range).name(t(`spotlight.concert.${key}`))
                .listen().onChange(() => this.changed());
        }
        this.flowerFolder = this.guiFolder.addFolder(t("spotlight.flowerProgram"));
        const dial = {code: this.flowerCode};
        this.codeControl = this.flowerFolder.add(dial, "code").name(t("spotlight.flowerCode"))
            .tooltip(t("spotlight.flowerCodeHelp")).onChange(value => {
                if (isFlowerCode(value)) {
                    this.flowerCode = value;
                    this.changed();
                }
            }).onFinishChange(() => this.codeControl.setValue(this.flowerCode));
        this.flowerFolder.add(this, "flowerPan", 0, 180, 1).listen().name(t("spotlight.flowerPan")).onChange(() => this.changed());
        const location = this.guiFolder.addFolder(t("spotlight.location")).close();
        const move = () => this.setGroundLocation(this.lat, this.lon);
        location.add(this, "lat", -90, 90, 0.000001).noSlider().listen().name(t("spotlight.lat")).onChange(move);
        location.add(this, "lon", -180, 180, 0.000001).noSlider().listen().name(t("spotlight.lon")).onChange(move);
        this.guiFolder.add({remove: () => Synth3DManager.deleteSpotlight(this)}, "remove").name(t("spotlight.remove"));
        this.resize();
        this.aim(par.frame);
        this.onGroundChange = () => {
            const height = this.groundAltitude(this.lat, this.lon);
            if (Math.abs(this.altitude - height) < 0.01) return;
            this.altitude = height;
            this.placeProjector();
            this.aim(par.frame);
            setRenderOne(true);
        };
        EventManager.addEventListener("elevationChanged", this.onGroundChange);
        EventManager.addEventListener("visibleGroundChanged", this.onGroundChange);
    }

    groundAltitude(lat, lon) {
        return ECEFToLLAVD_radii(getVisiblePointBelow(LLAToECEF(lat, lon, 0))).z;
    }

    setGroundLocation(lat, lon) {
        this.lat = lat;
        this.lon = lon;
        this.altitude = this.groundAltitude(lat, lon);
        this.placeProjector();
        this.changed();
    }

    getPositionEditTarget() {
        return {
            getECEF: () => this.group.position.clone(),
            getLLA: () => [this.lat, this.lon, GROUND_CLEARANCE],
            // An undo may follow deletion and restoration of the projector.
            setLLA: (lat, lon) => NodeMan.get(this.id, false)?.setGroundLocation(lat, lon),
        };
    }

    placeProjector() {
        this.group.position.copy(LLAToECEF(this.lat, this.lon, this.altitude + GROUND_CLEARANCE));
        const basis = enuBasis(this.lat, this.lon);
        this.group.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(
            new Vector3(...basis.east), new Vector3(...basis.up), new Vector3(...basis.north).negate()));
    }

    applyPreset(name) {
        const after = spotlightPreset(name);
        if (!after) return;
        if (name === "spaceflower") Object.assign(after, {flowerCode: DEFAULT_FLOWER_CODE, flowerPan: DEFAULT_FLOWER_PAN});
        if (name === "concert") after.concert = {...DEFAULT_CONCERT};
        this.replaceLayout(after, t("spotlight.preset"));
    }

    chooseQLCFile() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".qxw,.xml";
        input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            try {
                await this.importQLCEffects(await file.text());
            } catch (error) {
                showError(error.message);
            }
        };
        input.click();
    }

    async importQLCEffects(xml) {
        const effects = readQLCSpotlightEffects(xml);
        if (!effects.length) return showError(t("spotlight.qlcEmpty"));
        const index = effects.length === 1 ? 0 : await showChoice(t("spotlight.qlcChoose"), {
            title: t("spotlight.importQLC"), options: effects.map(({name}, i) => ({label: name, value: i})),
        });
        if (index === null || NodeMan.get(this.id, false) !== this) return;
        const {beams} = effects[index];
        this.replaceLayout({beams, count: beams.length}, t("spotlight.importQLC"));
    }

    replaceLayout(after, description) {
        const current = this.serialize();
        const before = Object.fromEntries(Object.keys(after).map(key => [key, current[key]]));
        const restore = state => NodeMan.get(this.id, false)?.restoreBeams(state);
        restore(after);
        UndoManager?.add({description, undo: () => restore(before), redo: () => restore(after)});
    }

    restoreBeams({count, beams, lumens, flowerCode, flowerPan, concert}) {
        // Preserve controller bindings for the beams present in both layouts.
        beams.forEach((saved, i) => Object.assign(this.settings[i] ??= {}, saved));
        if (lumens !== undefined) this.lumens = lumens;
        if (concert) Object.assign(this.concert, concert);
        if (flowerCode !== undefined) {
            this.flowerCode = flowerCode;
            this.codeControl.object.code = flowerCode;
            this.codeControl.updateDisplay();
            this.flowerPan = flowerPan;
        }
        this.count = count;
        this.resize();
        this.settings.length = beams.length;
        for (const beam of this.beams) {
            for (const control of beam.folder.controllers) control.updateDisplay();
        }
        this.changed();
    }

    resize() {
        while (this.beams.length > this.count) {
            const beam = this.beams.pop();
            beam.folder.destroy();
            beam.cone.material.dispose();
            this.group.remove(beam.head);
        }
        while (this.beams.length < this.count) {
            const index = this.beams.length;
            const settings = this.settings[index] ??= defaultSpotlightBeam(index);
            const folder = this.guiFolder.addFolder(t("spotlight.beam", {number: index + 1})).close();
            const patterns = Object.fromEntries(SPOTLIGHT_PATTERNS.map(p => [t(`spotlight.patterns.${p}`), p]));
            folder.add(settings, "pattern", patterns).name(t("spotlight.pattern")).onChange(() => {
                this.layoutHeads();
                this.changed();
            });
            for (const [key, range] of Object.entries(BEAM_CONTROLS)) {
                const control = folder.add(settings, key, ...range).name(t(`spotlight.${key}`)).onChange(() => this.changed());
                if (key === "aspect") control.noSlider();
            }
            for (const key of ["reverse", "pingPong"]) {
                folder.add(settings, key).name(t(`spotlight.${key}`)).onChange(() => this.changed());
            }
            const head = new Group();
            const lamp = new Mesh(this.headGeometry, [this.housing, this.lens, this.housing]);
            const cone = new Mesh(this.coneGeometry, createSpotlightConeMaterial());
            cone.position.y = 0.26;
            cone.userData.ignoreContextMenu = true;
            cone.raycast = () => {};
            head.add(lamp, cone);
            this.group.add(head);
            this.beams.push({settings, folder, head, lamp, cone, origin: new Vector3(), direction: new Vector3()});
        }
        this.layoutHeads();
    }

    layoutHeads() {
        // The flower's 36 rays leave one optic. Each other beam has its own head.
        const flower = this.beams.filter(b => b.settings.pattern === "Flower");
        this.flowerFolder.show(flower.length > 0);
        const concertCount = this.beams.filter(b => b.settings.pattern === "Concert").length;
        this.concertFolder.show(concertCount > 0);
        const heads = this.beams.filter(b => b.settings.pattern !== "Flower" || b === flower[0]);
        const concertRig = concertCount === 12 && this.count === 12;
        const columns = concertRig ? 6 : Math.ceil(Math.sqrt(heads.length));
        const rows = Math.ceil(heads.length / columns);
        const spacing = Math.min(0.8, 3 / columns);
        heads.forEach(({head, lamp}, i) => {
            lamp.visible = true;
            head.position.set((i % columns - (columns - 1) / 2) * spacing, 1,
                (Math.floor(i / columns) - (rows - 1) / 2) * (concertRig ? 1.6 : spacing));
            lamp.scale.setScalar(Math.min(1, spacing / 0.6));
        });
        flower.slice(1).forEach(({head, lamp}) => {
            lamp.visible = false;
            head.position.copy(flower[0].head.position);
        });
        for (const beam of this.beams) {
            const pattern = beam.settings.pattern;
            beam.folder.controllers.find(c => c.property === "aspect").show(PLANAR_PATTERNS.includes(pattern));
        }
    }

    aim(frame) {
        const seconds = frame * (Sit.simSpeed ?? 1) / Sit.fps;
        for (let i = 0; i < this.beams.length; i++) {
            const beam = this.beams[i];
            spotlightDirection(beam.settings, seconds, beam.direction, this.flowerCode, this.flowerPan, i, this.concert, this.spread);
            beam.upComponent = beam.direction.y;
            beam.head.quaternion.setFromUnitVectors(UP, beam.direction);
            beam.direction.applyQuaternion(this.group.quaternion);
            beam.origin.copy(beam.head.position).applyQuaternion(this.group.quaternion).add(this.group.position);
        }
        this.updateCones();
        this.lastSeconds = seconds;
        this.field.dirty = true;
    }

    updateCones() {
        const layers = this.showCones ? NodeMan.get("cloudLayers", false) : null;
        for (const beam of this.beams) {
            const cone = beam.cone;
            cone.visible = this.showCones && this.lumens > 0 && beam.upComponent > 0;
            if (!cone.visible) continue;
            let length = 6000; // clear-air fading range when the beam misses all receivers
            const sourceAltitude = this.altitude + GROUND_CLEARANCE + beam.head.position.y;
            for (const layer of layers?.visibleLayers ?? []) {
                const distance = (layer.baseAltitude - sourceAltitude) / beam.upComponent;
                if (distance <= 0 || distance >= length || !layer.coverage || !layer.density) continue;
                const derived = layers.derived.get(layer.id);
                if (derived.discECEF) {
                    this.coneHit.copy(beam.origin).addScaledVector(beam.direction, distance);
                    const [cx, cy, cz] = derived.discECEF;
                    const [wx, wy, wz] = derived.windECEF;
                    const [ux, uy, uz] = derived.discUp;
                    this.coneHit.x -= cx + wx;
                    this.coneHit.y -= cy + wy;
                    this.coneHit.z -= cz + wz;
                    const height = this.coneHit.x * ux + this.coneHit.y * uy + this.coneHit.z * uz;
                    if (this.coneHit.lengthSq() - height * height > layer.extent.radius ** 2) continue;
                }
                length = distance;
            }
            // Sprite patches use a finite disc that can drift with wind.
            Synth3DManager.iterateClouds((_id, cloud) => {
                const distance = (cloud.altitude - sourceAltitude) / beam.upComponent;
                if (!cloud.group.visible || !cloud.opacity || !cloud.cloudCount || distance <= 0 || distance >= length) return;
                this.coneHit.copy(beam.origin).addScaledVector(beam.direction, distance);
                if (this.coneHit.distanceToSquared(cloud.group.position) <= cloud.radius ** 2) length = distance;
            });
            const radius = length * Math.tan(beam.settings.width * Math.PI / 360) * 1.5;
            cone.scale.set(radius, length, radius);
            cone.material.uniforms.lengthMeters.value = length;
            cone.material.uniforms.intensity.value = spotlightCandela(this.lumens, beam.settings.width) * 4e-9;
        }
    }

    changed() {
        this.aim(par.frame);
        markSitchDirty();
        setRenderOne(true);
    }

    update(frame) {
        super.update(frame);
        if (frame * (Sit.simSpeed ?? 1) / Sit.fps !== this.lastSeconds) this.aim(frame);
        else if (this.showCones) this.updateCones();
    }

    serialize() {
        return {id: this.id, name: this.name, visible: this.visible, lat: this.lat, lon: this.lon, altitude: this.altitude,
            count: this.count, lumens: this.lumens, spread: this.spread, showCones: this.showCones, flowerCode: this.flowerCode, flowerPan: this.flowerPan,
            concert: {...this.concert}, beams: this.settings.map(beam => ({...beam}))};
    }

    dispose() {
        EventManager.removeEventListener("elevationChanged", this.onGroundChange);
        EventManager.removeEventListener("visibleGroundChanged", this.onGroundChange);
        if (CustomManager?.editingObjectNodeId === this.id) CustomManager.editingObjectMenu?.destroy();
        this.field.projectors.delete(this.id);
        this.field.dirty = true;
        if (!this.field.projectors.size) this.field.rebuild();
        this.guiFolder.destroy();
        this.base.geometry.dispose();
        this.headGeometry.dispose();
        for (const beam of this.beams) beam.cone.material.dispose();
        this.coneGeometry.dispose();
        this.housing.dispose();
        this.lens.dispose();
        super.dispose();
    }
}
