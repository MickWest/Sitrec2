import {FileManager, Globals, NodeMan, markSitchDirty, setRenderOne, Sit} from "../Globals";
import {loadModelAsset} from "../ModelLoader";
import {disposeScene} from "../threeExt";
import {showError} from "../showError";
import {copyProceduralModel, copyVehicleRecipe, vehicleFileStem} from "../../tools/vehicles/recipeFormat.js";
import {exportProceduralVehicle, loadProceduralVehicle, openVehicleBrowser} from "../procedural/VehicleLoader";
import {refreshVehicleBakeUsage} from "../procedural/VehicleBakeAssets";
import {collectVehicleSpinners, poseVehicleSpinners} from "../procedural/VehicleAnimation";
import {applyVehicleLightOverrides, captureVehicleLightOverrides, vehicleLightState} from "../procedural/VehicleLightState";

export const proceduralObjectMethods = {
    setupVehicleControls(v) {
        this.proceduralModel = copyProceduralModel(v.proceduralModel);
        this.vehicleAnimation = v.vehicleAnimation ?? true;
        this.vehicleLightOverrides = v.vehicleLightOverrides ?? {};
        this.vehicleStatus = this.proceduralModel?.recipe.name ?? "File model";
        const actions = {
            browse: () => this.openVehicleDesigner(false),
            edit: () => this.openVehicleDesigner(true),
            freeze: () => this.freezeVehicle().catch(e => showError(`Could not freeze the model: ${e.message}`)),
            file: () => {this.proceduralModel = null; this.vehicleLightOverrides = {}; this._vehicleSpinParts = []; this.rebuild(); markSitchDirty();},
            retry: () => {this.currentModel = undefined; this.rebuild();},
        };
        this.vehicleControls = {};
        const tips = {
            browse: "Open the Custom Object Designer to choose a car, truck, aircraft, drone, balloon, sky lantern, kite or bird.\n"
                + "The design you apply becomes this object's model.",
            edit: "Open the Custom Object Designer on this object's current design, to change it.",
            freeze: "Make a GLB model file from this design, and use it in place of the design.\n"
                + "The file is saved with the sitch. The design is kept, so Edit design… still works.",
            file: "Stop using the custom object design, and go back to the model selected in Model.",
            retry: "Try again to build or load the custom object model. Shown only after a load fails.",
        };
        for (const [key, label] of Object.entries({browse:"Browse custom objects…", edit:"Edit design…", freeze:"Freeze as GLB", file:"Use file model", retry:"Retry model load"})) {
            const control = this.gui.add(actions, key).name(label).tooltip(tips[key]);
            control.isCommon = true; this.vehicleControls[key] = control;
        }
        const animation = this.gui.add(this, "vehicleAnimation").name("Animate moving parts").onChange(() => {
            this.updateVehicleAnimation(0); markSitchDirty(); setRenderOne(true);
        }).tooltip("Move the parts of the design as the sitch time runs: propellers, rotors and wheels turn, the tails of a kite move in the wind, and the wings of a bird beat.\n"
            + "Off holds them still. A bird then has its wings in the glide position.");
        animation.isCommon = true; this.vehicleControls.animation = animation;
        // A bird design has these two controls here too, so the wingbeat can be set without opening the design.
        this.birdFlight = "flap"; this.birdWingbeat = 3;
        const flight = this.gui.add(this, "birdFlight", {"Flapping": "flap", "Gliding": "glide", "Flap, then glide": "bursts"}).name("Bird flight")
            .onChange(value => this.setBirdParameter("flightStyle", value))
            .tooltip("How this bird flies: it flaps its wings, it glides with its wings held still, or it flaps in bursts with a glide after each burst.\n"
                + "This is the Flight value of the bird's design. Edit design… has the other values of the wing motion.");
        flight.isCommon = true; this.vehicleControls.birdFlight = flight;
        const wingbeat = this.gui.add(this, "birdWingbeat", 0.5, 25, 0.01).name("Wingbeats per second")
            .onFinishChange(value => this.setBirdParameter("wingbeatRate", value))
            .tooltip("The number of complete wingbeats (down and up) in one second of sitch time.\n"
                + "It starts as the rate of the species in cruising flight: a measured value where one was found, or an estimate. To match a video, count the wingbeats in the video.\n"
                + "This is the Wingbeats per second value of the bird's design. It has no effect while the bird glides.");
        wingbeat.isCommon = true; this.vehicleControls.birdWingbeat = wingbeat;
        const status = this.gui.add(this, "vehicleStatus").name("Custom object")
            .tooltip("The custom object design this object uses, and its state: procedural, frozen, loading, or the load error.")
            .listen().disable();
        status.isCommon = true; this.vehicleControls.status = status;
    },

    updateVehicleControls() {
        refreshVehicleBakeUsage(FileManager?.list,NodeMan?.list);
        if (!this.vehicleControls) return;
        const model = this.modelOrGeometry === "model", source = model && this.proceduralModel;
        this.vehicleControls.browse.show();
        if (source) this.modelMenu?.hide();
        for (const key of ["edit", "animation", "status"]) this.vehicleControls[key][source ? "show" : "hide"]();
        this.vehicleControls.file[source ? "show" : "hide"]();
        this.vehicleControls.freeze[source?.mode === "procedural" ? "show" : "hide"]();
        // A frozen bird has its wing motion in its GLB file, so these two controls are for a procedural bird only.
        const bird = source?.mode === "procedural" && source.recipe.parameters.vehicleType === "bird" ? source.recipe.parameters : null;
        if (bird) {
            this.birdFlight = bird.flightStyle; this.birdWingbeat = bird.wingbeatRate;
            this.vehicleControls.birdFlight.updateDisplay(); this.vehicleControls.birdWingbeat.updateDisplay();
        }
        for (const key of ["birdFlight", "birdWingbeat"]) this.vehicleControls[key][bird ? "show" : "hide"]();
        this.vehicleControls.retry[this._vehicleLoadFailed && source ? "show" : "hide"]();
    },

    async openVehicleDesigner(edit) {
        const generation = Globals.loadGeneration, request = (this._vehicleDialogRequest ?? 0) + 1;
        this._vehicleDialogRequest = request;
        try {
            this._vehicleDialog?.dispose();
            const dialog = await openVehicleBrowser({
                initialRecipe: this.proceduralModel?.recipe, edit,
                isAlive: () => !this._vehicleDisposed && generation === Globals.loadGeneration && request === this._vehicleDialogRequest,
                onApply: (recipe,options) => this.applyVehicleRecipe(recipe,options),
            });
            if (this._vehicleDisposed || generation !== Globals.loadGeneration || request !== this._vehicleDialogRequest) dialog.dispose();
            else this._vehicleDialog = dialog;
        } catch (e) {showError(`Could not open Custom Object Designer: ${e.message}`);}
    },

    applyVehicleRecipe(value, {preserveObjectSettings = false} = {}) {
        const recipe = copyVehicleRecipe(value);
        if (this._vehicleDisposed) return;
        const sameDesign = Boolean(this.proceduralModel) && preserveObjectSettings;
        this.vehicleLightOverrides = sameDesign ? this.captureVehicleOverrides() : {};
        this.proceduralModel = {mode:"procedural", recipe};
        this.modelOrGeometry = "model";
        // Native design dimensions are metres. Explicit later Model Length edits
        // remain independent of the saved recipe and are retained while editing.
        if (!sameDesign) this.modelLengthNode?.setValue(0);
        if (!sameDesign) this.common.applyMaterial = false;
        this.vehicleStatus = recipe.name;
        this.rebuild(); markSitchDirty(); setRenderOne(true);
    },

    // Change one value of a bird design and build the bird again. The object keeps its size and its other settings.
    setBirdParameter(key, value) {
        const recipe = this.proceduralModel?.recipe;
        if (this.proceduralModel?.mode !== "procedural" || recipe.parameters.vehicleType !== "bird" || recipe.parameters[key] === value) return;
        this.applyVehicleRecipe({...recipe, parameters: {...recipe.parameters, [key]: value}}, {preserveObjectSettings: true});
    },

    captureVehicleOverrides() {
        return captureVehicleLightOverrides(this.lights, this._vehicleLightBaseline, this.vehicleLightOverrides);
    },

    rebuildProceduralModel() {
        const source = copyProceduralModel(this.proceduralModel), key = JSON.stringify(source);
        if (this.currentModel?.vehicleKey === key) return;
        const request = {vehicleKey:key}, generation = Globals.loadGeneration;
        this.currentModel = request;
        this._vehicleLoadFailed = false;
        this.vehicleStatus = `Loading ${source.recipe.name}…`;
        Globals.pendingActions++;
        const promise = Promise.resolve().then(() => source.mode === "frozen" ? loadModelAsset(source.file) : loadProceduralVehicle(source.recipe));
        this._vehicleReady = promise.then(asset => {
            if (this._vehicleDisposed || generation !== Globals.loadGeneration || this.currentModel !== request || this.modelOrGeometry !== "model") {
                disposeScene(asset.scene); return;
            }
            // Frozen exports are already in native metres; a filename hint must
            // not overwrite a saved object-size override.
            if (source.mode === "frozen" && FileManager.list[source.file]) FileManager.list[source.file].proceduralBake = true;
            this.installModelAsset(asset, source.recipe.name, false);

            this.vehicleStatus = `${source.recipe.name}${source.mode === "frozen" ? " · frozen" : " · procedural"}`;
            this.updateVehicleAnimation(0);
        }).catch(error => {
            if (this._vehicleDisposed || generation !== Globals.loadGeneration || this.currentModel !== request) return;
            this._vehicleLoadFailed = true;
            this.vehicleStatus = `Could not load: ${error.message}`;
            console.error("Procedural model load failed", error);
        }).finally(() => {
            Globals.pendingActions--;
            if (!this._vehicleDisposed) {this.updateVehicleControls(); setRenderOne(true);}
        });
    },

    configureVehicleModel(asset) {
        // An imported frozen GLB can carry its original editable recipe in extras.
        if (!this.proceduralModel && asset.format === "glb" && this.currentModel?.file) {
            let embedded;
            this.model.traverse(part => {embedded ??= part.userData?.sitrecVehicleRecipe;});
            if (embedded) {
                try {
                    this.proceduralModel = {mode:"frozen",file:this.currentModel.file,recipe:copyVehicleRecipe(embedded,{allowFuture:true})};
                    this.currentModel.vehicleKey = JSON.stringify(this.proceduralModel);
                    this.vehicleStatus = `${this.proceduralModel.recipe.name} · frozen`;
                } catch (error) {console.warn("Ignoring invalid embedded vehicle recipe",error);}
            }
        }
        this._vehicleSpinParts = collectVehicleSpinners(this.model);
        if (this.proceduralModel) {
            this._vehicleLightBaseline = Object.fromEntries(this.lights.map(light => [light.light.name,vehicleLightState(light)]));
            applyVehicleLightOverrides(this.lights,this.vehicleLightOverrides);
        }
        const lamps = new Map(this.lights.map(light => [light.light.name,light]));
        this.model.traverse(part => {
            const light = lamps.get(part.userData.vehicleLightLens);
            if (light) light.vehicleLens = part;
        });
        this.updateVehicleControls();
    },

    // `offset` is in seconds. A flock uses it to show its birds at different moments of the motion.
    updateVehicleAnimation(frame, offset = 0) {
        const seconds = frame * (Sit?.simSpeed ?? 1) / (Sit?.fps || 30) + offset;
        // On a kite track, the tails of a kite move with the wind at the kite.
        const flow = this.getSourceTrack?.()?.kiteAirAt?.(frame);
        poseVehicleSpinners(this._vehicleSpinParts, seconds, this.vehicleAnimation, flow);
    },

    async freezeVehicle() {
        if (!this.proceduralModel || this.proceduralModel.mode === "frozen") return;
        const source = copyProceduralModel(this.proceduralModel), key = JSON.stringify(source), generation = Globals.loadGeneration;
        this.vehicleLightOverrides = this.captureVehicleOverrides();
        this.vehicleControls.freeze.disable();
        try {
            const bytes = await exportProceduralVehicle(source.recipe);
            if (this._vehicleDisposed || generation !== Globals.loadGeneration || JSON.stringify(this.proceduralModel) !== key) return;
            const base = vehicleFileStem(source.recipe.name,60);
            const id = FileManager.UniqueName(`${base}-${Date.now()}.glb`);
            FileManager.add(id, bytes, bytes);
            Object.assign(FileManager.list[id], {filename:id, dynamicLink:true, dataType:"glb", proceduralBake:true});
            this.proceduralModel = {...source, mode:"frozen", file:id};
            this.rebuild(); markSitchDirty();
            await this._vehicleReady;
        } finally {if (!this._vehicleDisposed) this.vehicleControls.freeze.enable();}
    },
};
