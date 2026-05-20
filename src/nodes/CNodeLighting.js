import {Globals, guiMenus, NodeMan, Sit, setRenderOne} from "../Globals";
import {AmbientLight, DirectionalLight} from "three";
import {GlobalScene} from "../LocalFrame";
import {CNode} from "./CNode";
import * as LAYER from "../LayerMasks";
import {updateNightTexture} from "../Globe";
import {t} from "../i18n";

// by default this will live in one node "lighting"
export class CNodeLighting extends CNode {
    constructor(v) {
        super(v);

        this.ambientIntensity = v.ambientIntensity ?? 0.05;
        this.IRAmbientIntensity = v.IRAmbientIntensity ?? 0.8;
        this.sunIntensity = v.sunIntensity ?? 0.7;
        this.sunScattering = v.sunScattering ?? 0.6;
        this.ambientOnly = v.ambientOnly ?? false;
        this.atmosphere = v.atmosphere ?? true;
        this.noMainLighting = v.noMainLighting ?? false;
        this.noCityLights = Sit.noCityLights ?? false;
        this.sunBoost = v.sunBoost ?? 1;
        this.sceneExposure = v.sceneExposure ?? 1.0;

        // V5 shadow tunables (defaults-off; only read when any view has shadows on).
        this.shadowMapSize = v.shadowMapSize ?? 2048;
        // Default 1000m radius keeps building shadows sharp at 2048² (~1m/texel).
        // Larger radius covers more distant casters/receivers but blurs detail.
        this.shadowRadius = v.shadowRadius ?? 1000;
        this.shadowBias = v.shadowBias ?? -0.0005;
        this.shadowNormalBias = v.shadowNormalBias ?? 1;
        this.shadowUpdateMinIntervalMs = v.shadowUpdateMinIntervalMs ?? 50;
        this.shadowUpdateAngleThreshold = v.shadowUpdateAngleThreshold ?? 0.25;
        this.terrainReceivesShadow = v.terrainReceivesShadow ?? false;
        // Mirror to Globals so per-tile construction can read without a
        // NodeMan lookup (avoids circular import in QuadTreeTile.js).
        Globals.terrainReceivesShadow = this.terrainReceivesShadow;

        this.addSimpleSerial("shadowMapSize");
        this.addSimpleSerial("shadowRadius");
        this.addSimpleSerial("shadowBias");
        this.addSimpleSerial("shadowNormalBias");
        this.addSimpleSerial("shadowUpdateMinIntervalMs");
        this.addSimpleSerial("shadowUpdateAngleThreshold");
        this.addSimpleSerial("terrainReceivesShadow");

        // First applyShadowConfig must wait for CNodeSunlight.update() to position
        // the sun at its real ~60000-unit magnitude; at construction the sun is
        // still at (0,7000,0).
        this._pendingFirstShadowConfig = true;
        this._prevShadowsAnyEnabled = false;

        this.gui = guiMenus.lighting;

        this.addGUIValue("ambientIntensity", 0, 2, 0.01, t("lighting.ambientIntensity.label"))
            .tooltip(t("lighting.ambientIntensity.tooltip"));
        this.addGUIValue("IRAmbientIntensity", 0, 2, 0.01, t("lighting.irAmbientIntensity.label"))
            .tooltip(t("lighting.irAmbientIntensity.tooltip"));
        this.addGUIValue("sunIntensity", 0, 2, 0.01, t("lighting.sunIntensity.label"))
            .tooltip(t("lighting.sunIntensity.tooltip"));
        this.addGUIValue("sunScattering", 0, 2, 0.01, t("lighting.sunScattering.label"))
            .tooltip(t("lighting.sunScattering.tooltip"));
        this.addGUIValue("sunBoost", 1, 100, 1, t("lighting.sunBoost.label"))
            .tooltip(t("lighting.sunBoost.tooltip"));
        this.addGUIValue("sceneExposure", 0.01, 2.0, 0.01, t("lighting.sceneExposure.label"))
            .tooltip(t("lighting.sceneExposure.tooltip"));
        this.addGUIBoolean("ambientOnly", t("lighting.ambientOnly.label"))
            .tooltip(t("lighting.ambientOnly.tooltip"));
        this.addGUIBoolean("atmosphere", t("lighting.atmosphere.label"))
            .tooltip(t("lighting.atmosphere.tooltip"));
        this.addGUIBoolean("noMainLighting", t("lighting.noMainLighting.label"))
            .tooltip(t("lighting.noMainLighting.tooltip"));
        this.addGUIBoolean("noCityLights", t("lighting.noCityLights.label"))
            .tooltip(t("lighting.noCityLights.tooltip"))
            .onChange((value) => { updateNightTexture(value) });



        Globals.ambientLight = new AmbientLight(0xFFFFFF, this.ambientIntensity * Math.PI);
        Globals.ambientLight.layers.mask = LAYER.MASK_LIGHTING
        GlobalScene.add(Globals.ambientLight);

        Globals.IRAmbientLight = new AmbientLight(0xFFFFFF, this.IRAmbientIntensity * Math.PI);
        Globals.IRAmbientLight.layers.mask = LAYER.MASK_LIGHTING
        GlobalScene.add(Globals.IRAmbientLight);
        // this light is disabled, and only gets used when rendering an IR viewport
        Globals.IRAmbientLight.visible = false;

        // then sunlight is direct light. In v5 shadow-system mode the sunLight
        // is hidden during per-view renders and a per-view DirectionalLight
        // ("viewSun") replaces it for that single render. The sunLight itself
        // never casts shadows — viewSun does.
        Globals.sunLight = new DirectionalLight(0xFFFFFF, this.sunIntensity * Math.PI);
        Globals.sunLight.layers.mask = LAYER.MASK_LIGHTING
        Globals.sunLight.position.set(0,7000,0);  // sun is along the y axis
        GlobalScene.add(Globals.sunLight);

        // Shadow tweaks subfolder — collapsed; controls only meaningful when
        // a view has shadows on, but always visible so users can tune them.
        if (this.gui && this.gui.addFolder) {
            const sf = this.gui.addFolder(t("lighting.shadowTweaks.label")).close();
            sf.tooltip?.(t("lighting.shadowTweaks.tooltip"));
            sf.add(this, "shadowMapSize", {1024: 1024, 2048: 2048, 4096: 4096})
                .name(t("lighting.shadowMapSize.label"))
                .tooltip(t("lighting.shadowMapSize.tooltip"))
                .onChange(() => this.applyShadowConfig({reason: "shadowMapSize"}));
            sf.add(this, "shadowRadius", 500, 50000, 100)
                .name(t("lighting.shadowRadius.label"))
                .tooltip(t("lighting.shadowRadius.tooltip"))
                .listen()
                .onChange(() => this.applyShadowConfig({reason: "shadowRadius"}));
            sf.add(this, "shadowBias", -0.01, 0.01, 0.00001)
                .name(t("lighting.shadowBias.label"))
                .tooltip(t("lighting.shadowBias.tooltip"))
                .listen()
                .onChange(() => this.applyShadowConfig({reason: "shadowBias"}));
            sf.add(this, "shadowNormalBias", 0, 50, 0.1)
                .name(t("lighting.shadowNormalBias.label"))
                .tooltip(t("lighting.shadowNormalBias.tooltip"))
                .listen()
                .onChange(() => this.applyShadowConfig({reason: "shadowNormalBias"}));
            sf.add(this, "shadowUpdateMinIntervalMs", 16, 500, 1)
                .name(t("lighting.shadowUpdateInterval.label"))
                .tooltip(t("lighting.shadowUpdateInterval.tooltip"))
                .listen();
            sf.add(this, "shadowUpdateAngleThreshold", 0.05, 5.0, 0.05)
                .name(t("lighting.shadowUpdateAngle.label"))
                .tooltip(t("lighting.shadowUpdateAngle.tooltip"))
                .listen();
        }
        this.gui.add(this, "terrainReceivesShadow")
            .name(t("lighting.terrainReceivesShadow.label"))
            .tooltip(t("lighting.terrainReceivesShadow.tooltip"))
            .listen()
            .onChange(() => {
                Globals.terrainReceivesShadow = this.terrainReceivesShadow;
                NodeMan.iterate((id, node) => {
                    if (node.constructor.name === "CNodeTerrain"
                        && typeof node.refreshShadowFlags === "function") {
                        node.refreshShadowFlags();
                    }
                });
                setRenderOne(true);
            });

        this.recalculate();

    }

    // Returns true if at least one CNodeView3D has effective shadows.
    isAnyViewShadowsEnabled() {
        let any = false;
        NodeMan.iterate((id, node) => {
            if (node.constructor.name !== "CNodeView3D") return;
            if (typeof node.areShadowsEffective === "function" && node.areShadowsEffective()) {
                any = true;
            }
        });
        return any;
    }

    // Top-level orchestrator. Called on:
    //   - first CNodeSunlight.update() (deferred-first-apply, gated by
    //     _pendingFirstShadowConfig);
    //   - any view toggling its shadowsEnabled flag;
    //   - any tunable change (shadowMapSize, shadowRadius, bias, normalBias).
    // §0 invariant: when never-on and currently-off this returns immediately
    // with zero side effects.
    applyShadowConfig({reason} = {}) {
        const anyEnabled = this.isAnyViewShadowsEnabled();
        const wasEnabled = this._prevShadowsAnyEnabled === true;
        const transitioned = anyEnabled !== wasEnabled;

        if (!anyEnabled && !wasEnabled) {
            this._prevShadowsAnyEnabled = false;
            return;
        }

        Globals.shadowsEnabled = anyEnabled;

        // Phase 1: create viewSuns + flip renderer.shadowMap.enabled. We
        // intentionally do NOT walk materials here — see Phase 2.
        NodeMan.iterate((id, node) => {
            const ctor = node.constructor.name;
            if (ctor === "CNodeView3D"
                && typeof node.applyShadowRendererConfig === "function") {
                node.applyShadowRendererConfig({transitioned});
            }
        });

        if (transitioned) {
            // Hide / show the global sun based on whether ANY view is on.
            // viewSun mirrors its state during that view's render.
            Globals.sunLight.visible = !anyEnabled;
            NodeMan.iterate((id, node) => {
                const ctor = node.constructor.name;
                if (ctor === "CNodeBuildings3DTiles"
                    && typeof node.refreshShadowFlags === "function") {
                    node.refreshShadowFlags();
                }
                if (ctor === "CNode3DObject"
                    && typeof node.refreshShadowFlags === "function") {
                    node.refreshShadowFlags();
                }
                if (ctor === "CNodeTerrain"
                    && typeof node.refreshShadowFlags === "function") {
                    node.refreshShadowFlags();
                }
            });
        }

        // Phase 2: NOW that all viewSuns are added to GlobalScene and
        // cast/receive flags are set, mark materials as needing recompile.
        // Doing this in one shared pass avoids per-view racing where mainView
        // marks materials with only its own viewSun in the scene, then
        // lookView adds its viewSun afterward and we get a directional-light
        // count mismatch between the compiled shader and the runtime uniforms
        // (the "Cannot read properties of undefined (reading 'shadowIntensity')"
        // error from Three.js's WebGLLights upload path).
        const anyPendingRefresh = (() => {
            let need = false;
            NodeMan.iterate((id, node) => {
                if (node.constructor.name === "CNodeView3D"
                    && node._pendingMaterialRefresh) need = true;
            });
            return need;
        })();
        if (anyPendingRefresh) {
            const seen = new Set();
            const markMaterial = m => {
                if (!m || seen.has(m)) return;
                seen.add(m);
                m.needsUpdate = true;
                Globals.shadowDiagCounters.materialNeedsUpdateWrites++;
            };
            // Walk every node-owned group/scene we know about.
            NodeMan.iterate((id, node) => {
                const root = node.group ?? node.object ?? node.scene;
                if (!root || typeof root.traverse !== "function") return;
                root.traverse(o => {
                    if (!o.material) return;
                    if (Array.isArray(o.material)) {
                        for (const m of o.material) markMaterial(m);
                    } else {
                        markMaterial(o.material);
                    }
                });
            });
            // Clear pending flags on every view.
            NodeMan.iterate((id, node) => {
                if (node.constructor.name === "CNodeView3D") {
                    node._pendingMaterialRefresh = false;
                }
            });
        }

        this._prevShadowsAnyEnabled = anyEnabled;
        setRenderOne(true);
    }


    getEffectiveSunIntensity() {
        return this.ambientOnly ? 0 : this.sunIntensity;
    }

    getEffectiveSunScattering() {
        return this.ambientOnly ? 0 : this.sunScattering;
    }

    setIR(on) {
        if (on) {
            Globals.IRAmbientLight.visible = true;
            Globals.ambientLight.visible = false;
            //Globals.sunLight.visible = false;
        } else {
            Globals.IRAmbientLight.visible = false;
            Globals.ambientLight.visible = true;
            //Globals.sunLight.visible = true;
        }
    }

    // for serialization, we don't need to do anything with the variables that were added with addGUIValue (hence addSimpleSerial)
    modSerialize() {
        return {...super.modSerialize()}
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        // V5 shadows: addSimpleSerial restored terrainReceivesShadow + tunables
        // onto `this`, but Globals.terrainReceivesShadow and the existing
        // terrain meshes' receiveShadow flag don't auto-update. Mirror into
        // Globals so QuadTreeTile.buildMesh (called when new tiles load)
        // sees the right value, and re-apply across the node graph so
        // already-loaded tiles get their receiveShadow flipped immediately.
        Globals.terrainReceivesShadow = this.terrainReceivesShadow;
        this._pendingFirstShadowConfig = true;
        NodeMan.iterate((id, node) => {
            if (node.constructor.name === "CNodeTerrain"
                && typeof node.refreshShadowFlags === "function") {
                node.refreshShadowFlags();
            }
        });
        this.recalculate();
    }


    recalculate(isMain = false) {
        let sunIntensity = this.sunIntensity;
        if (this.ambientOnly)   {
            sunIntensity = 0;
        }

        let ambientIntensity = this.ambientIntensity;


        if (isMain && this.noMainLighting) {
            ambientIntensity = 1;
            sunIntensity = 0;
        }

        // if there's a sunlight node, then that's managing the lights
        // so we pass the values to it
        if (NodeMan.exists("theSun")) {
            const sunNode = NodeMan.get("theSun");
            sunNode.ambientIntensity = ambientIntensity;
            sunNode.sunIntensity = sunIntensity;
            sunNode.ambientOnly = this.ambientOnly;
            sunNode.sunScattering = this.sunScattering;
            sunNode.atmosphere = this.atmosphere;
            sunNode.sunBoost = this.sunBoost;

        } else {
            // otherwise we manage the lights directly
            Globals.ambientLight.intensity = ambientIntensity;
            Globals.sunLight.intensity = sunIntensity * this.sunBoost;
        }

        // but we manage the IR ambient light directly, as it's somewhat ad-hoc
        // and will vary based on the colors of the local texture
        Globals.IRAmbientLight.intensity = this.IRAmbientIntensity * Math.PI;
    }

}