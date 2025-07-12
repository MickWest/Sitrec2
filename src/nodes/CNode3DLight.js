import {CNode3D} from "./CNode3D";
import {SphereGeometry} from "three/src/geometries/SphereGeometry";
import {MeshBasicMaterial} from "three/src/materials/Materials";
import {Mesh} from "three/src/objects/Mesh";
import {assert} from "../assert";

export class CNode3DLight extends CNode3D {
    constructor(v) {
        super(v);
        this.type = 'CNode3DLight';

        this.light = v.light; // the light objectm required for this node
        assert(this.light, "CNode3DLight requires a light object");

        console.log("CNode3DLight created for light: " + this.light.name);


        // create a sphere to represent the light
        const geometry = new SphereGeometry(8, 16, 16);
        const material = new MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.5});

        this._object = new Mesh(geometry, material);
        this._object.name = "LightSphere";


        this._object.position.copy(this.light.position);

        v.scene.add(this._object);



    }

    dispose() {
        if (this._object) {
            this._object.geometry.dispose();
            this._object.material.dispose();
            this._object = null;
        }
    }


    update() {
    }
}