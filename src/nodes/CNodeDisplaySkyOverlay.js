// CNodeDisplaySkyOverlay takes a CNodeCanvas derived node, CNodeDisplayNightSky and a camera
// and displays star names on an overlay
import {CNodeViewUI} from "./CNodeViewUI";
import {GlobalDateTimeNode, guiShowHide, setRenderOne} from "../Globals";
import {raDec2Celestial} from "../CelestialMath";

export class CNodeDisplaySkyOverlay extends CNodeViewUI {

    constructor(v) {
        super(v);
        this.addInput("startTime", GlobalDateTimeNode)

        this.camera = v.camera;
        this.nightSky = v.nightSky;

        this.showSatelliteNames = false;
        this.showStarNames = false;

        const gui = v.gui ?? guiShowHide;

        if (this.overlayView.id === "lookView") {
            this.syncVideoZoom = true;
        }

        // this.seperateVisibility = true;

        //    guiShowHide.add(this,"showSatelliteNames" ).onChange(()=>{setRenderOne(true);}).name(this.overlayView.id+" Sat names")
        gui.add(this, "showStarNames").onChange(() => {

            //this.show(!this.showStarNames)

            setRenderOne(true);
        }).name(this.overlayView.id + " Star names").listen();
        this.addSimpleSerial("showStarNames");


    }

    //
    renderCanvas(frame) {



        super.renderCanvas(frame);

        if (!this.showStarNames) return


        const camera = this.camera.clone();
        camera.position.set(0, 0, 0)
        camera.updateMatrix()
        camera.updateWorldMatrix()
        camera.updateProjectionMatrix()

//         var cameraECEF = ESUToECEF()
//         var cameraLLA = ECEFToLLA()

        var font_h = 9

        this.ctx.font = Math.floor(font_h) + 'px' + " " + 'Arial'
        this.ctx.fillStyle = "#ffffff";
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.textAlign = 'left';

        if (this.showStarNames) {
            for (var HR in this.nightSky.starField.commonNames) {

                // HR is the HR number, i.e. the index into the BSC + 1
                // So we sub 1 to get the actual index.
                const n = HR - 1

                const ra = this.nightSky.starField.getStarRA(n)
                const dec = this.nightSky.starField.getStarDEC(n)
                const pos = raDec2Celestial(ra, dec, 100) // get equatorial
                pos.applyMatrix4(this.nightSky.celestialSphere.matrix) // convert equatorial to EUS
                pos.project(camera) // project using the EUS camera

                if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                    // Apply videoZoom to the projected coordinates
                    var zoomedX = pos.x * this.zoom;
                    var zoomedY = pos.y * this.zoom;                    
                    var x = (zoomedX + 1) * this.widthPx / 2
                    var y = (-zoomedY + 1) * this.heightPx / 2
                    x += 5
                    y -= 5

                    const commonName = this.nightSky.starField.getStarCommonName(HR);
                    this.ctx.fillText(commonName, x, y)
                }
            }

            // iterate over ALL the stars, not just the common ones
            // and lable them with the index.
            // ToDo: Only display names of rendered stars, hold "false" for now until implemented.
            if (false) {
                for (let n = 0; n < this.nightSky.starField.getStarCount(); n++) {
                    const ra = this.nightSky.starField.getStarRA(n)
                    const dec = this.nightSky.starField.getStarDEC(n)
                    //assert(ra !== 0 || dec !== 0, "ra AND dec is 0 for star "+n)
                    const pos1 = raDec2Celestial(ra, dec, 100) // get equatorial
                    pos1.applyMatrix4(this.nightSky.celestialSphere.matrix) // convert equatorial to EUS
                    pos1.project(camera) // project using the EUS camera            
                    if (pos1.z > -1 && pos1.z < 1 && pos1.x >= -1 && pos1.x <= 1 && pos1.y >= -1 && pos1.y <= 1) {
                        // Apply videoZoom to the projected coordinates
                        var zoomedX = pos1.x * this.zoom;
                        var zoomedY = pos1.y * this.zoom;
                        
                        var x = (zoomedX + 1) * this.widthPx / 2
                        var y = (-zoomedY + 1) * this.heightPx / 2
                        x += 5
                        y -= 5
                        const starName = this.nightSky.starField.getBSCStarName(n)
                        this.ctx.fillText(starName, x, y)
                    }
                }
            }


            // Note this is overlay code, so we use this.nightSky.
            // CNodeDisplayNightSky would use this.planetSprites
            for (const [name, planet] of Object.entries(this.nightSky.planets.planetSprites)) {
                var pos = planet.equatorial.clone()
                pos.applyMatrix4(this.nightSky.celestialSphere.matrix)

                pos.project(camera)

                this.ctx.strokeStyle = planet.color;
                this.ctx.fillStyle = planet.color;

                if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                    // Apply videoZoom to the projected coordinates
                    var zoomedX = pos.x * this.zoom;
                    var zoomedY = pos.y * this.zoom;
                    
                    var x = (zoomedX + 1) * this.widthPx / 2
                    var y = (-zoomedY + 1) * this.heightPx / 2
                    x += 5
                    y -= 5
                    this.ctx.fillText(name, x, y)
                }

            }
        }

    }
}