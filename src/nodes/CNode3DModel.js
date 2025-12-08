// CNode3DModel.js - CNode3DModel
// a 3D model node - a gltf model, with the model loaded from a file
import {CNode3DGroup} from "./CNode3DGroup";
import {FileManager} from "../Globals";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {DRACOLoader} from "three/addons/loaders/DRACOLoader.js";
import {disposeScene} from "../threeExt";
import {NoColorSpace} from "three";

// Create and configure a DRACO loader
function createDRACOLoader() {
    const dracoLoader = new DRACOLoader();
    // Set the path to the DRACO decoder files (served locally)
    dracoLoader.setDecoderPath('./libs/draco/');
    return dracoLoader;
}

// Create and configure a GLTF loader with DRACO support
function createGLTFLoader() {
    const loader = new GLTFLoader();
    const dracoLoader = createDRACOLoader();
    loader.setDRACOLoader(dracoLoader);
    return loader;
}

export function loadGLTFModel(file, callback) {

    console.log("Async Loading asset for", file);
    FileManager.loadAsset(file, file).then( (asset) => {
        const loader = createGLTFLoader()
        loader.parse(asset.parsed, "", gltf => {
            console.log("(after async) Parsed asset for", file, " now traversing...");
            gltf.scene.traverse((child) => {
                if (child.isMesh) {
                    if (child.material.map) child.material.map.colorSpace = NoColorSpace;
                    if (child.material.emissiveMap) child.material.emissiveMap.colorSpace = NoColorSpace;
                }
            });
            callback(gltf);
        })
    })
}

export class CNode3DModel extends CNode3DGroup {
    constructor(v) {
        super(v);

        const data = FileManager.get(v.TargetObjectFile ?? "TargetObjectFile")

        const loader = createGLTFLoader()
        loader.parse(data, "", (gltf2) => {
            this.model = gltf2.scene //.getObjectByName('FA-18F')
            this.model.scale.setScalar(1);
            this.model.visible = true
            this.group.add(this.model)
        })

    }

    dispose()
    {
        this.group.remove(this.model)
        disposeScene(this.model)
        this.model = undefined
        super.dispose()
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            tiltType: this.tiltType,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v)
        this.tiltType = v.tiltType
    }

    update(f) {
        super.update(f)
        this.recalculate() // every frame so scale is correct after the jet loads

    }

    recalculate() {
        super.recalculate()
        this.propagateLayerMask()

    }

}