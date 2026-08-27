import {CNode} from "./CNode";
import {FLIRShader} from "../shaders/FLIRShader";
import {HorizontalBlurShader} from "three/addons/shaders/HorizontalBlurShader.js";
import {VerticalBlurShader} from "three/addons/shaders/VerticalBlurShader.js";
import {ZoomShader} from "../shaders/ZoomShader";
import {Pixelate2x2Shader, PixelateNxNShader} from "../shaders/Pixelate2x2Shader";
import {ShaderPass} from "three/addons/postprocessing/ShaderPass.js";
import {par} from "../par";
import {StaticNoiseShader} from "../shaders/StaticNoiseShader";
import {InvertShader} from "../shaders/InvertShader";
import {CompressShader} from "../shaders/CompressShader";
import {LevelsShader} from "../shaders/LevelsShader";
import {GreyscaleShader} from "../shaders/GreyscaleShader";
import {JPEGArtifactsShader} from "../shaders/JPEGArtifactsShader";
import {ThermalShader} from "../shaders/ThermalShader";
import {NightVisionShader} from "../shaders/NightVisionShader";
import {Globals, guiMenus, guiTweaks, Sit} from "../Globals";
import {CopyShader} from "../shaders/CopyShader";
import {assert} from "../assert";

let guiOnOffFolder = null;


export class CNodeEffect extends CNode {

    // this is perhaps something we could extract, like in registerNodes
    effectLookup = {
        "FLIRShader": FLIRShader,
        "hBlur": HorizontalBlurShader,
        "vBlur": VerticalBlurShader,
        "pixelZoom": ZoomShader,
        "digitalZoom": ZoomShader,
        "Pixelate2x2": Pixelate2x2Shader,
        "PixelateNxN": PixelateNxNShader,
        "StaticNoise": StaticNoiseShader,
        "Invert": InvertShader,
        "Compress": CompressShader,
        "Levels": LevelsShader,
        "Greyscale": GreyscaleShader,
        "JPEGArtifacts": JPEGArtifactsShader,
        "Copy": CopyShader,
        "Thermal": ThermalShader,
        "NightVision": NightVisionShader,
    }

    effectTips = {
        "FLIRShader": "Simulates a FLIR camera, with a color palette adjustment",
        "hBlur": "Horizontal Blur component",
        "vBlur": "Vertical Blur component",
        "pixelZoom": "Simulates a pixelated zoom effect when zooming in using View/VideoZoom",
        "digitalZoom": "Digital Zoom (scaling up sensor pixels)",
        "Pixelate2x2": "Pixelate 2x2",
        "PixelateNxN": "Pixelate NxN",
        "StaticNoise": "Static Noise (like an old TV)",
        "Invert": "Invert (Negative)",
        "Compress": "Compress",
        "Levels": "Levels (TV In/Out Balck, White, Gamma)",
        "Greyscale": "Greyscale (black and white)",
        "JPEGArtifacts": "Simulated JPEG Artifacts",
        "Copy": "Copy",
        "Thermal": "Advanced FLIR simulation (white/black hot, Ironbow palette, bloom, sensor noise)",
        "NightVision": "Night vision image intensifier (P43 phosphor, gain, bloom, tube mask)",
    }


    constructor(v) {

        Globals.defaultGui = guiTweaks;

        if (guiOnOffFolder === null) {
            guiOnOffFolder = Globals.defaultGui.addFolder("Effects On/Off").close().perm();
        }

        // the call to super will handle setting up the inputs
        // which can be other nodes, or values
        super(v);
        this.effectName = v.effectName;
        // look up the shader and create it as this.pass
        assert(this.effectLookup[this.effectName] !== undefined, "Unknown effect " + this.effectName)
        this.pass = new ShaderPass(this.effectLookup[this.effectName]);

        this.enabled = v.enabled ?? true;
        this.addSimpleSerial("enabled");
        this.filter  = v.filter  ?? "Nearest"; // filter for the source RenderBuffer texture

        // Optional named GUI destination for the enabled checkbox (e.g.
        // enabledGUI: "thermalNV" puts the flag in Effects > Thermal/NV);
        // defaults to the shared "Effects On/Off" folder.
        const flagFolder = (v.enabledGUI && guiMenus[v.enabledGUI]) ? guiMenus[v.enabledGUI] : guiOnOffFolder;
        this.enabledController = this._addEnabledToggle(flagFolder);


        Globals.defaultGui = null;


    }

    // Create the enabled checkbox in the given folder. Shared by the
    // constructor and setEnabledGUI, so a relocated toggle cannot drift
    // from the original behavior.
    _addEnabledToggle(folder) {
        return folder.add(this, "enabled").name(this.id).listen().onChange((v)=>{
            if (!v) {
                // if this.guiDisabled is true, then
                // don't allow anything else to turn it back on
                this.guiHasDisabled = true;
            } else {
                this.guiHasDisabled = false;
            }
        }).tooltip(this.effectTips[this.effectName]);
    }

    // Move the enabled checkbox to a named GUI folder (e.g. "thermalNV").
    // Used by CCustomManager.setup() to relocate an effect whose definition
    // lives in a (possibly old, saved) sitch and so cannot carry enabledGUI
    // itself. A no-op when the toggle is already there.
    setEnabledGUI(guiName) {
        const target = guiMenus[guiName];
        if (!target || !this.enabledController) return;
        if (this.enabledController.parent === target) return;
        this.enabledController.destroy();
        this.enabledController = this._addEnabledToggle(target);
    }

    updateUniforms(f, view) {

        // some parameters are in pixels or percentages, so we need to convert them to fractions
        const scales = {
            hBlur_h: 1/view.canvas.width,
            vBlur_v: 1/view.canvas.height,
            pixelZoom_magnifyFactor: 1/100,
            digitalZoom_magnifyFactor: 1/100,
        }


        const pass = this.pass
        const uniforms = pass.material.uniforms;
        for (let [key, node] of Object.entries(this.inputs)) {
            if (uniforms[key] !== undefined) {
                let value = node.v(f);
                const scaleName = this.effectName + "_" + key;
                if (scales[scaleName] !== undefined) {
                    value *= scales[scaleName];
                }

                uniforms[key].value = value;
            }
        }

        if (uniforms.resolution !== undefined) {
            uniforms.resolution.value.set(view.canvas.width, view.canvas.height);
        }

        // any extra uniforms that are not inputs
        // but are required by the shader
        switch (this.effectName) {
            case "StaticNoise":
                // time (the frame number) essentially acts as a random seed
                // so the noise is the same for any given frame
                uniforms['time'].value = par.frame;
                break;
            case "Thermal":
            case "NightVision":
                // time in seconds, derived from the frame number so the
                // drifting sensor noise is deterministic per frame
                uniforms['time'].value = par.frame / (Sit?.fps ?? 30);
                break;
        }


    }



}