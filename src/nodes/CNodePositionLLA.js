// A node that returns an ECEF vector position based on LLA input
// Can be defined by a lat, lon, and alt
// or a LLA array of three values
// Note that the altitude is in meters in the LLA array
// and in feet in the GUI
//
// Now with optional wind to adjust the position over time
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {CNode} from "./CNode";
import {CNodeTrack} from "./CNodeTrack";
import {V3} from "../threeUtils";
import {CNodeGUIValue} from "./CNodeGUIValue";
import {isKeyHeld} from "../KeyBoardHandler";
import {adjustHeightAboveGround, elevationAtLL, getTilesPointBelow} from "../threeExt";
import {getLocalUpVector} from "../SphericalMath";
import {assert} from "../assert";
import {getCursorPositionFromTopView} from "../mouseMoveView";
import {EventManager} from "../CEventManager";
import {guiMenus, markSitchDirty, NodeMan, setSitchEstablished, Sit, UndoManager} from "../Globals";
import {getApproximateLocationFromIP} from "../GeoLocation";
import {customAltitudeFunction, customLocationFunction} from "../runtimeConfig";
import {showError} from "../showError";
import {f2m} from "../utils";
import {attachLatLonInputs, moveTerrainTo, resolveLocationString} from "../CoordinateInput";
import {t} from "../i18n";

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
                   tooltip: this.tipName + " latitude in degrees. Paste a full 'lat, lon' (any format) to set both.",
                   value: this._LLA[0],
                   start: -90, end: 90, step: 0.01,
                   stepExplicit: false, // prevent snapping
                   noSlider: true,
                   onChange: (v) => {
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
                       this._LLA[1] = v;
                       this.recalculateCascade()
                       EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})
                   }
                }, v.gui)

               // Both boxes accept any coordinate format (decimal, D M, D M S,
               // hemisphere letters, degree symbols, MGRS); a complete pair
               // dropped into either one fills in both.
               attachLatLonInputs(this.guiLat.guiEntry, this.guiLon.guiEntry)

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

                this.aglController = gui.add(this, "agl").name(t("positionLLA.aboveGroundLevel.label")).tooltip(t("positionLLA.aboveGroundLevel.tooltip")).onChange((v) => {
                    this.recalculateCascade()
                    markSitchDirty();
                }).listen();



                this.lookupString = "";

                // Optional location tools (Lookup / Geolocate / Go To). On by
                // default — the Camera/Target location menus want them — but
                // simple embedded positions (e.g. the football broadcast
                // camera) pass locationTools:false for a compact folder.
                const locationTools = v.locationTools ?? true;

                if (locationTools && customLocationFunction !== undefined) {
                    this.lookupController = gui.add(this, "lookupString").name(t("positionLLA.lookup.label")).tooltip(t("positionLLA.lookup.tooltip")).onFinishChange(async () => {
                        if (this.lookupString.length > 0) {
                            try {
                                // Coordinates in any supported format resolve here,
                                // without a geocoder round trip; only a genuine place
                                // name is looked up.
                                const location = await resolveLocationString(this.lookupString);
                                if (!location) {
                                    showError("No results found for " + this.lookupString);
                                    return;
                                }
                                const {lat, lon} = location;

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
                                markSitchDirty();
                                EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id});

                                moveTerrainTo(this._LLA[0], this._LLA[1]);
                            } catch (error) {
                                showError("Error during lookup: " + error.message, error);
                            }
                        }
                    });
                }

                if (locationTools) {
                    // geolocate from browser
                    this.geolocateController = gui.add(this, "geolocate").name(t("positionLLA.geolocate.label")).tooltip(t("positionLLA.geolocate.tooltip"))

                    // Add a "Go To" button to the GUI (stays enabled regardless of source —
                    // it's a viewport-navigation action, not a manual-value editor)
                    this.goToController = gui.add(this, "goTo").name(t("positionLLA.goTo.label")).tooltip(t("positionLLA.goTo.tooltip"))
                }




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
        markSitchDirty();
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
        NodeMan.get("mainCamera").goToPoint(this.ecef,100000,100);
    }


    gotoLLA(lat, lon, alt=2) {

        this._LLA = [lat, lon, alt];
        this.guiLat.value = lat
        this.guiLon.value = lon
        this.guiAlt.value = alt; // set altitude to 3m above ground

        this.agl = true; // set AGL to true, so we adjust the altitude above ground level

        this.recalculateCascade();
        markSitchDirty();
        NodeMan.get("mainCamera").goToPoint(this.ecef,2300000,100000);

        moveTerrainTo(this._LLA[0], this._LLA[1]);

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

    // An AGL camera is first positioned at sitch-load, before the 3D building tiles
    // have streamed in, so it initially sits on the smooth elevation map. The tiles
    // then stream coarse→fine; we re-anchor onto the tile surface whenever the tile
    // ground directly below changes by more than a few cm, CONVERGING onto the final
    // settled tile rather than latching onto the first (possibly coarse) one — a
    // one-shot refine made the witness flaky (it locked onto whatever LOD happened to
    // be loaded first). The fully-settled tile geometry is deterministic, so once the
    // tiles stop refining the height stops changing and this stops firing. Per-node
    // recalc only — never the global elevationChanged broadcast (which re-runs every
    // AGL track/label/MISB node and, fired on the hundreds of mid-stream tile events,
    // would starve the tile loader).
    _refineAGLToTiles() {
        if (!this.agl || this.ecef === undefined || !NodeMan.exists("buildings3DTiles")) return;
        const tg = getTilesPointBelow(this.ecef);
        if (tg === null) return;
        const h = tg.dot(getLocalUpVector(this.ecef));
        if (this._lastTileGroundH === undefined || Math.abs(h - this._lastTileGroundH) > 0.05) {
            this._lastTileGroundH = h;
            this.recalculateCascade();
        }
    }

    update() {
        this._refineAGLToTiles();
        if (this.key) {
            const posHeld = isKeyHeld(this.key.toLowerCase());
            if (posHeld) {
                const cursorPos = getCursorPositionFromTopView();
                if (cursorPos) {
                    if (!this.posKeyWasHeld) {
                        this.undoLLA = this._LLA.slice();
                    }
                    setSitchEstablished(true);
                    this.setFromECEF(cursorPos, true);
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

    setFromECEF(cursorPos, changeAlt=false) {

        // convert to LLA
        const LLA = ECEFToLLAVD_radii(cursorPos);

        // we set the values in the UI nodes
        this.guiLat.value = LLA.x
        this.guiLon.value = LLA.y
        this._LLA[0] = LLA.x
        this._LLA[1] = LLA.y
        markSitchDirty();

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
                // (if shift held) set it to eye level above ground
                if (isKeyHeld('Shift')) {
                    const eyeLevel = f2m(7); // ~2.13m
                    // Get the point at eye level above local ground.
                    // ECEFToLLAVD_radii returns ellipsoid height (HAE), but _LLA[2] stores MSL.
                    const groundPoint = adjustHeightAboveGround(cursorPos, eyeLevel, true);
                    const groundPointLLA = ECEFToLLAVD_radii(groundPoint);
                    const geoidOffset = meanSeaLevelOffset(groundPointLLA.x, groundPointLLA.y);
                    const groundAltMSL = groundPointLLA.z - geoidOffset;
                    this._LLA[2] = this.guiAlt.setValueWithUnits(groundAltMSL, "metric", "small", true)
                }
            }

        }




        this.recalculateCascade();
        EventManager.dispatchEvent("PositionLLA.onChange", {id: this.id})
    }


    // True when this position is identical for every frame: a fixed LLA with no wind.
    // (agl is fine — the per-frame value is still constant; only this.ecef changes between
    // recalculates as terrain refines.) getValueFrame already serves the value on demand,
    // so CNodeSmoothedPositionTrack reads this to skip baking a per-frame array of clones.
    get isConstantOverFrames() {
        return this._LLA !== undefined && !this.in.wind;
    }

    // Ground point for AGL mode: `agl` metres above the ground directly below `pos`.
    // Prefers the actual 3D building/photogrammetry tiles (the rendered surface that
    // WASD walking snaps to) when they are loaded directly below, and falls back to
    // the cached elevation-map lookup otherwise. This makes AGL altitudes ride the
    // same 3D-tile surface as WASD instead of the smooth elevation map, which ignores
    // buildings and often disagrees with the tiles.
    _aglGroundPoint(terrainNode, pos, agl, frame) {
        // The elevation-map ground directly below pos — a NEAR-SURFACE point. We
        // raycast the 3D tiles from HERE, not from pos: callers pass pos at 100 km
        // altitude (the elevation-map column query is lever-arm-immune), but a tile
        // raycast from that height has a local-up that differs from the surface
        // normal by ~5e-5 rad, which over the 100 km lever arm becomes a fixed ~5 m
        // horizontal miss — that swamped the WASD step and walked the camera off in
        // one direction regardless of the key pressed. Querying from the near-surface
        // ground keeps the tile column directly below the camera.
        const elevGround = this.getPointBelowCached(terrainNode, pos, 0, frame);
        // Ride the 3D-tile surface when a believable tile is loaded directly below
        // (groundBelow() rejects coarse-streaming garbage and roofs); otherwise fall
        // back to the smooth elevation map. update() re-anchors as finer tiles stream
        // in (see _refineAGLToTiles) so we converge onto the final settled tile.
        const tilesGround = getTilesPointBelow(elevGround);
        const ground = (tilesGround !== null) ? tilesGround : elevGround;
        return ground.clone().add(getLocalUpVector(ground).multiplyScalar(agl));
    }

    recalculate() {
        this.array = [];
        this.elevationCache = null; // flush cache for fresh terrain queries

        if (this._LLA !== undefined) {
            const aglHeight = this.guiAlt.getValue();
            const terrainNode = this.agl ? (NodeMan.get("TerrainModel", false) ?? null) : null;

            if (this.agl && terrainNode) {
                // Use cached terrain query for ground level
                const queryPos = LLAToECEF(this._LLA[0], this._LLA[1], 100000);
                this.ecef = this._aglGroundPoint(terrainNode, queryPos, aglHeight, 0);
            } else if (this.agl) {
                // No terrain node, use sphere-based ground level
                this.updateGroundLevel();
                this.ecef = LLAToECEF(this._LLA[0], this._LLA[1], aglHeight + this.groundLevel);
            } else {
                // aglHeight is MSL; convert to HAE for LLAToECEF (h = H + N)
                this.ecef = LLAToECEF(this._LLA[0], this._LLA[1], aglHeight + meanSeaLevelOffset(this._LLA[0], this._LLA[1]));
            }

            // No wind => the position is identical for every frame, and getValueFrame()
            // returns this.ecef.clone() on demand (the per-frame loop below only differs
            // when wind drifts it). So skip baking an array of identical entries — on an
            // hours-long fromApp sitch that was ~88k-414k wasted clones rebuilt on every
            // elevation cascade while dragging the camera. Leave this.array undefined;
            // getValueFrame serves the value, and refreshElevationCache already guards
            // `this.array && this.array[f]`, so an undefined array is safe there.
            if (!this.in.wind) {
                this.array = undefined;
                return;
            }

            for (let f = 0; f < this.frames; f++) {
                const time = f * Sit.simSpeed;
                let pos = this.ecef.clone();
                if (this.in.wind) {
                    const wind = this.in.wind.v0.multiplyScalar(time);
                    pos.add(wind);
                    if (this.agl) {
                        if (terrainNode) {
                            pos = this._aglGroundPoint(terrainNode, pos, aglHeight, f);
                        } else {
                            pos = adjustHeightAboveGround(pos, this._LLA[2]);
                        }
                    }
                }
                const lla = ECEFToLLAVD_radii(pos);
                const altMSL = lla.z - meanSeaLevelOffset(lla.x, lla.y);
                this.array.push({
                    position: pos,
                    lla: [lla.x, lla.y, altMSL],
                    altReference: "MSL",
                });
            }
        }
    }

    // return vector3 ECEF for the specified LLA (animateabel)
    getValueFrame(f) {

        // f is the frame niumber in the video
        // but we need the physical time this represents
        // as video might be running at different speeds to reality
        const time = f * Sit.simSpeed;

        if (this._LLA !== undefined) {
            assert(this.guiAlt !== undefined, "CNodePositionLLA: no guiAlt defined")
       //     return LLAToECEF(this._LLA[0], this._LLA[1], this.guiAlt.getValueFrame(f))
             let pos = this.ecef.clone();
            if (this.in.wind) {
                const wind = this.in.wind.v0.multiplyScalar(time);
                pos.add(wind);

                if (this.agl) {
                    const terrainNode = NodeMan.get("TerrainModel", false);
                    if (terrainNode) {
                        pos = this._aglGroundPoint(terrainNode, pos, this._LLA[2], Math.floor(f));
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
        // alt is MSL in meters; convert to HAE for LLAToECEF (h = H + N)

        return LLAToECEF(lat, lon, alt + meanSeaLevelOffset(lat, lon))
    }


}

// an XYZ position node that can be defined by x, y, and z
// or a XYZ array of three values
// in ECEF space
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
