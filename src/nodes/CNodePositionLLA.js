// A node that returns a EUS vector position based on LLA input
// Can be defined by a lat, lon, and alt
// or a LLA array of three values
// Note that the altitude is in meters in the LLA array
// and in feet in the GUI
//
// Now with optional wind to adjust the position over time
import {EUSToLLA, LLAToEUS} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {CNode} from "./CNode";
import {CNodeTrack} from "./CNodeTrack";
import {V3} from "../threeUtils";
import {CNodeGUIValue} from "./CNodeGUIValue";
import {isKeyHeld} from "../KeyBoardHandler";
import {adjustHeightAboveGround, elevationAtLL} from "../threeExt";
import {assert} from "../assert";
import {getCursorPositionFromTopView} from "../mouseMoveView";
import {EventManager} from "../CEventManager";
import {guiMenus, NodeMan, setSitchEstablished, Sit, UndoManager} from "../Globals";
import {getApproximateLocationFromIP} from "../GeoLocation";
import {customAltitudeFunction, customLocationFunction} from "../../config/config";
import {showError} from "../showError";
import {f2m} from "../utils";
import {parseLatLonPair, parseSingleCoordinate} from "../CoordinateParser";

export class CNodePositionLLA extends CNodeTrack {
    constructor(v) {
        v.frames = v.frames ?? Sit.frames;
        super(v);

        this.input("wind", true)
        this.useSitFrames = true; // use sit frames for the LLA

        this.agl = (v.agl !== undefined) ? v.agl : false; // above ground level, default to false
        this.addSimpleSerial("agl");

        this.tipName = v.tipName || v.gui || "Position";

        if (v.LLA !== undefined) {
            // copy the array in v.LLA to this._LLA
            this._LLA = v.LLA.slice()
            // if there's a gui specified, the add GUI inputs
            if (v.gui) {
                 const id = (v.desc ?? "Camera") + (v.key ? " ["+v.key+"]":"");
                const name = (v.desc ?? "Cam") + (v.key ? " ["+v.key+"]":"");
               this.guiLat = new CNodeGUIValue({
                   id: id + " Lat",
                   desc: name + " Lat",
                   tooltip: this.tipName + " latitude in degrees. Paste 'lat,lon' to set both.",
                   value: this._LLA[0],
                   start: -90, end: 90, step: 0.01,
                   stepExplicit: false, // prevent snapping
                   noSlider: true,
                   onChange: (v) => {
                       const $input = this.guiLat.guiEntry?.$input;
                       const input = $input?.value;
                       const isFocused = $input && document.activeElement === $input;
                       if (isFocused && input && String(v) !== input) {
                           const pair = parseLatLonPair(input);
                           if (pair) {
                               this.guiLat.guiEntry.$input.value = pair.lat;
                               this._LLA[0] = pair.lat;
                               this._LLA[1] = pair.lon;
                               this.guiLon.value = pair.lon;
                               this.recalculateCascade()
                               EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})
                               return;
                           }
                           const single = parseSingleCoordinate(input);
                           if (single !== null) {
                               this._LLA[0] = single;
                               this.recalculateCascade()
                               EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})
                               return;
                           }
                       }
                       this._LLA[0] = parseFloat(v);
                       EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})
                       this.recalculateCascade()
                   }
               }, v.gui)

               this.guiLon = new CNodeGUIValue({
                   id: id + " Lon",
                   desc: name + " Lon",
                   tooltip: this.tipName + " longitude in degrees.",
                   value: this._LLA[1],
                   start: -180, end: 180, step: 0.01,
                   stepExplicit: false, // prevent snapping
                   noSlider: true,
                   onChange: (v) => {
                       const $input = this.guiLon.guiEntry?.$input;
                       const input = $input?.value;
                       const isFocused = $input && document.activeElement === $input;
                       if (isFocused && input && String(v) !== input) {
                           const single = parseSingleCoordinate(input);
                           if (single !== null) {
                               this._LLA[1] = single;
                               this.recalculateCascade()
                               EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})
                               return;
                           }
                       }
                       this._LLA[1] = v;
                       this.recalculateCascade()
                       EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})
                   }
                }, v.gui)

               // The elastic range here will be increased to the default sitch altitude
                // (currently 1000 feet?)
                // but the eleasticShrink will be set to true, so it will shrink to the final range
               this.guiAlt = new CNodeGUIValue({
                   id: id + " Alt (ft)",  // including the (ft) for historical reasons, so we have the same id as older saves
                   desc: name + " Alt",
                   tooltip: this.tipName + " altitude.",
                   value: 0, // don't set the altitude, as we want to set it with units
                   unitType: "small",
                   start: 0, end: 1000, step: 1,
               //    stepExplicit: false, // prevent snapping

                   elastic: true,
                   elasticMin: 1,
                   elasticMax: 100000000,
                   elasticShrink: true,

                   onChange: (v) => {
                       this._LLA[2] = v;
                       this.recalculateCascade()
                       EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})

                     //  this.updateAltituide();

                   }
                }, v.gui)
                this.guiAlt.setValueWithUnits(this._LLA[2], "metric", "small")

                const gui = guiMenus[v.gui];

                gui.add(this, "agl").name("Above Ground Level").onChange((v) => {
                    this.recalculateCascade()
                }).listen();



                this.lookupString = "";

                if (customLocationFunction !== undefined) {
                    gui.add(this, "lookupString").name("Lookup").onFinishChange(async () => {
                        if (this.lookupString.length > 0) {
                            try {
                                const coord = parseLatLonPair(this.lookupString);
                                let lat, lon;
                                if (coord) {
                                    lat = coord.lat;
                                    lon = coord.lon;
                                } else {
                                    const location = await customLocationFunction(this.lookupString);
                                    if (!location) {
                                        alert("No results found for " + this.lookupString);
                                        return;
                                    }
                                    [lat, lon] = location;
                                }

                                this.guiLat.value = lat;
                                this.guiLon.value = lon;
                                this._LLA[0] = lat;
                                this._LLA[1] = lon;
                                this._LLA[2] = 0;
                                this.guiAlt.setValueWithUnits(this._LLA[2], "metric", "small", true);
                                this.recalculateCascade();
                                EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id});

                                const altitude = await customAltitudeFunction(lat, lon);
                                if (altitude > 0) {
                                    this._LLA[2] = altitude;
                                    this.guiAlt.setValueWithUnits(this._LLA[2], "metric", "small", true);
                                    this.recalculateCascade();
                                }

                                this.goTo();
                                EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id});

                                if (NodeMan.exists("terrainUI")) {
                                    const terrainUI = NodeMan.get("terrainUI");
                                    terrainUI.lat = this._LLA[0];
                                    terrainUI.lon = this._LLA[1];
                                    terrainUI.flagForRecalculation();
                                    terrainUI.startLoading = true;
                                }
                            } catch (error) {
                                showError("Error during lookup: ", error);
                                alert("Error during lookup: " + error.message);
                            }
                        }
                    });
                }

               // geolocate from browse
                gui.add(this, "geolocate").name("Geolocate from browser")

               // Add a "Go To" button to the GUI
                gui.add(this, "goTo").name("Go To the above position")




            }

            this.key = v.key;
            this.posKeyWasHeld = false;
            this.undoLLA = null;

        } else {
            // more customizable, so you can add your own sources or controls
            this.input("lat")
            this.input("lon")
            this.input("alt")
        }

        EventManager.addEventListener("elevationChanged", () => {
            if (this.agl) {
                this.onElevationChanged();
            }
        })

        this.recalculate()

        this.exportable = v.exportable ?? false;
        if (this.exportable) {
            NodeMan.addExportButton(this, "exportTrackCSV")
            NodeMan.addExportButton(this, "exportTrackKML")
            NodeMan.addExportButton(this, "exportMISBCompliantCSV")
        }
    }

    getAltitude() {
        return this._LLA[2];
    }

    setLLA(lat, lon, alt) {
        this._LLA = [lat, lon, alt];
        if (this.guiLat) {
            this.guiLat.value = lat;
            this.guiLon.value = lon;
            this.guiAlt.setValueWithUnits(alt, "metric", "small", true);
        }
        this.recalculateCascade();
        EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})

    }

//     updateAltituide() {
//         const altitude = altitudeAtLL(this._LLA[0], this._LLA[1]);
//
//         // so we need to atually calculate the AGL, based on the terrain
//         // also need to adjust it when terrain elevations
//
// //        this.guiAGL.setValueWithUnits(altitude, "metric", "small")
//
//     }

    goTo() {
        NodeMan.get("mainCamera").goToPoint(this.EUS,100000,100);
    }


    gotoLLA(lat, lon, alt=2) {

        this._LLA = [lat, lon, alt];
        this.guiLat.value = lat
        this.guiLon.value = lon
        this.guiAlt.value = alt; // set altitude to 3m above ground

        this.agl = true; // set AGL to true, so we adjust the altitude above ground level

        this.recalculateCascade();
        NodeMan.get("mainCamera").goToPoint(this.EUS,2300000,100000);


        if (NodeMan.exists("terrainUI")) {
            const terrainUI = NodeMan.get("terrainUI")
            terrainUI.lat = this._LLA[0]
            terrainUI.lon = this._LLA[1]
            terrainUI.flagForRecalculation();
            terrainUI.startLoading = true;

        }

        EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})
    }


    geolocate() {
        getApproximateLocationFromIP().then( (result) => {

            if(!result) {
                showError("Geolocation failed or was cancelled.");
                return;
            }

            this.gotoLLA(result.lat, result.lon, 3); // set altitude to 3m above ground




        })
    }


    updateGroundLevel() {
        // given the current lat/lon, find this.groundLevel
        if (this._LLA !== undefined) {
            this.groundLevel = elevationAtLL(this._LLA[0], this._LLA[1], true); // in meters
        }
    }

    onElevationChanged() {
        const terrainNode = NodeMan.get("TerrainModel", false);
        if (terrainNode) {
            const aglHeight = this.guiAlt ? this.guiAlt.getValue() : this._LLA[2];
            if (this.refreshElevationCache(terrainNode, aglHeight)) {
                this.recalculateCascade();
            }
        } else {
            this.recalculateCascade();
        }
    }

    update() {
        if (this.key) {
            const posHeld = isKeyHeld(this.key.toLowerCase()) || isKeyHeld('l');
            if (posHeld) {
                const cursorPos = getCursorPositionFromTopView();
                if (cursorPos) {
                    if (!this.posKeyWasHeld) {
                        this.undoLLA = this._LLA.slice();
                    }
                    setSitchEstablished(true);
                    this.setFromEUS(cursorPos, true);
                }
            }
            if (!posHeld && this.posKeyWasHeld && this.undoLLA && UndoManager) {
                const oldLLA = this.undoLLA.slice();
                const newLLA = this._LLA.slice();
                const self = this;
                UndoManager.add({
                    description: "Move position " + this.id,
                    undo: () => { self.setLLA(oldLLA[0], oldLLA[1], oldLLA[2]); },
                    redo: () => { self.setLLA(newLLA[0], newLLA[1], newLLA[2]); }
                });
                this.undoLLA = null;
            }
            this.posKeyWasHeld = posHeld;
        }
    }

    setFromEUS(cursorPos, changeAlt=false) {

        // convert to LLA
        const LLA = EUSToLLA(cursorPos);

        // we set the values in the UI nodes
        this.guiLat.value = LLA.x
        this.guiLon.value = LLA.y
        this._LLA[0] = LLA.x
        this._LLA[1] = LLA.y

        if (changeAlt) {

            if (this.agl) {
                // AGL, so leave altitude alone, or
                // (if shift held) set it to ground level
                if (isKeyHeld('Shift')) {
                    const groundAlt = f2m(7);  // 7 feet
                    this._LLA[2] = this.guiAlt.setValueWithUnits(groundAlt, "metric", "small", true)
                }

            } else {
                // altitude is absolute, so we either leave it alone, or
                // (if shift held) set it to ground + 2m
                // if the shift key is held, then set the altitude to the ground + 2m
                if (isKeyHeld('Shift')) {
                    // get the ground altitude, buy first getting the cursor position, adjusted for height
                    const groundPoint = adjustHeightAboveGround(cursorPos, 2, true);
                    // converts the ground point to LLA
                    const groundPointLLA = EUSToLLA(groundPoint);
                    // so the altitude is in the Z component
                    const groundAlt = groundPointLLA.z;
                    this._LLA[2] = this.guiAlt.setValueWithUnits(groundAlt, "metric", "small", true)
                }
            }

        }




        this.recalculateCascade();
        EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})
    }


    recalculate() {
        this.array = [];
        this.elevationCache = null; // flush cache for fresh terrain queries

        if (this._LLA !== undefined) {
            const aglHeight = this.guiAlt.getValue();
            const terrainNode = this.agl ? (NodeMan.get("TerrainModel", false) ?? null) : null;

            if (this.agl && terrainNode) {
                // Use cached terrain query for ground level
                const queryPos = LLAToEUS(this._LLA[0], this._LLA[1], 100000);
                this.EUS = this.getPointBelowCached(terrainNode, queryPos, aglHeight, 0);
            } else if (this.agl) {
                // No terrain node, use sphere-based ground level
                this.updateGroundLevel();
                this.EUS = LLAToEUS(this._LLA[0], this._LLA[1], aglHeight + this.groundLevel);
            } else {
                // aglHeight is MSL; convert to HAE for LLAToEUS (h = H + N)
                this.EUS = LLAToEUS(this._LLA[0], this._LLA[1], aglHeight + meanSeaLevelOffset(this._LLA[0], this._LLA[1]));
            }

            for (let f = 0; f < this.frames; f++) {
                const time = f * Sit.simSpeed;
                let pos = this.EUS.clone();
                if (this.in.wind) {
                    const wind = this.in.wind.v0.multiplyScalar(time);
                    pos.add(wind);
                    if (this.agl) {
                        if (terrainNode) {
                            pos = this.getPointBelowCached(terrainNode, pos, aglHeight, f);
                        } else {
                            pos = adjustHeightAboveGround(pos, this._LLA[2]);
                        }
                    }
                }
                const lla = EUSToLLA(pos);
                this.array.push({
                    position: pos,
                    lla: [lla.x, lla.y, lla.z],
                });
            }
        }
    }

    // return vector3 EUS for the specified LLA (animateabel)
    getValueFrame(f) {

        // f is the frame niumber in the video
        // but we need the physical time this represents
        // as video might be running at different speeds to reality
        const time = f * Sit.simSpeed;

        if (this._LLA !== undefined) {
            assert(this.guiAlt !== undefined, "CNodePositionLLA: no guiAlt defined")
       //     return LLAToEUS(this._LLA[0], this._LLA[1], this.guiAlt.getValueFrame(f))
             let pos = this.EUS.clone();
            if (this.in.wind) {
                const wind = this.in.wind.v0.multiplyScalar(time);
                pos.add(wind);

                if (this.agl) {
                    const terrainNode = NodeMan.get("TerrainModel", false);
                    if (terrainNode) {
                        pos = this.getPointBelowCached(terrainNode, pos, this._LLA[2], Math.floor(f));
                    } else {
                        pos = adjustHeightAboveGround(pos, this._LLA[2]);
                    }
                }
            }

            return pos
        }
        const lat = this.in.lat.v(f)
        const lon = this.in.lon.v(f)
        let alt = this.in.alt.v(f)
        // alt is MSL in meters; convert to HAE for LLAToEUS (h = H + N)

        return LLAToEUS(lat, lon, alt + meanSeaLevelOffset(lat, lon))
    }


}

// an XYZ position node that can be defined by x, y, and z
// or a XYZ array of three values
// in the EUS space
// mostly for debugging
export class CNodePositionXYZ extends CNode {
    constructor(v) {
        super(v);

        if (v.XYZ !== undefined) {
            this.XYZ = v.XYZ.slice()
        } else {

            this.input("x")
            this.input("y")
            this.input("z")
        }
        this.recalculate()
    }

    recalculate() {
    }

    setXYZ(x,y,z) {
        this.XYZ = [x,y,z]
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            ...(this.XYZ !== undefined ? { XYZ: this.XYZ.slice() } : {})
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v)
        if (v.XYZ !== undefined) {
            this.XYZ = v.XYZ.slice()
        }
    }

    getValueFrame(f) {
        if (this.XYZ !== undefined) {
            return V3(this.XYZ[0], this.XYZ[1], this.XYZ[2])
        }
        const x = this.in.x.v(f)
        const y = this.in.y.v(f)
        const z = this.in.z.v(f)
        return V3(x, y, z)
    }


}


export function makePositionLLA(id, lat, lon, alt) {
    return new CNodePositionLLA({
        id: id,
        lat: lat, lon: lon, alt: alt
    })
}