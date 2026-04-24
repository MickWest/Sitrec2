import {Color} from "three";
import {V3} from "../threeUtils";
import {LLAToECEFRadians} from "../LLA-ECEF-ENU";
import {SITREC_SERVER} from "../configUtils";
import {FileManager, GlobalDateTimeNode, guiMenus, NodeMan, setRenderOne} from "../Globals";
import {par} from "../par";
import {EventManager} from "../CEventManager";
import * as satellite from 'satellite.js';
import {bestSat, CTLEData, satRecToDate} from "../TLEUtils";
import {degrees} from "../utils";
import {hideProgress, initProgress, updateProgress} from "../CProgressIndicator";
import {DebugArrow, DebugArrowAB, getPointBelow, rayIntersectsEllipsoid, removeDebugArrow} from "../threeExt";
import {getLocalUpVector} from "../SphericalMath";
import * as LAYER from "../LayerMasks";
import {assert} from "../assert";
import {saveAs} from "file-saver";
import {showError} from "../showError";
import {CPointLightCloud} from "./CPointLightCloud";
import {t} from "../i18n";

/**
 * CSatellite handles all satellite-related functionality
 * including TLE data loading, positioning calculations, rendering, and flare detection
 */
export class CSatellite {
    constructor(options = {}) {
        // Visibility flags
        this.showSatellites = true;
        this.showStarlink = true;
        this.showISS = true;
        this.showBrightest = true;
        this.showOtherSatellites = false;
        this.showSatelliteTracks = options.showSatelliteTracks ?? false;
        this.showFlareTracks = options.showFlareTracks ?? false;
        this.showSatelliteGround = options.showSatelliteGround ?? false;
        this.showSatelliteNames = false;
        this.showSatelliteNamesMain = false;
        this.labelFlares = false;
        this.labelLit = false;
        this.labelLookVisible = false;
        this.showSatelliteList = "";

        // TLE Data
        this.TLEData = undefined;
        this.tleFilterResults = null; // boolean[] from TLE filter dialog, or null (no filter active)
        this.tleFilterFrameData = null; // per-frame visibility from "any frame in range" mode

        // Rendering via CPointLightCloud
        this.lightCloud = null;
        this.scene = null;

        // Flare and sun-related
        this.flareAngle = options.flareAngle ?? 5;
        this.flareModel = options.flareModel ?? "Geocentric Nadir";
        this.penumbraDepth = options.penumbraDepth ?? 5000;
        this.toSun = V3(0, 0, 1);
        this.fromSun = V3(0, 0, -1);

        // Arrow display range in km
        this.arrowRange = 100000;

        // Internal timing for position calculations
        this.timeStep = 2000;
        this.setupBrightestArray();

    }

    setupBrightestArray() {
        // Brightest satellites list from Celestrack
        this.brightest = [
            [
                "00694",
                "ATLAS CENTAUR 2"
            ],
            [
                "00733",
                "THOR AGENA D R/B"
            ],
            [
                "00877",
                "SL-3 R/B"
            ],
            [
                "02802",
                "SL-8 R/B"
            ],
            [
                "03230",
                "SL-8 R/B"
            ],
            [
                "03597",
                "OAO 2"
            ],
            [
                "03669",
                "ISIS 1"
            ],
            [
                "04327",
                "SERT 2"
            ],
            [
                "05118",
                "SL-3 R/B"
            ],
            [
                "05560",
                "ASTEX 1"
            ],
            [
                "05730",
                "SL-8 R/B"
            ],
            [
                "06073",
                "COSMOS 482 DESCENT CRAFT"
            ],
            [
                "06153",
                "OAO 3 (COPERNICUS)"
            ],
            [
                "06155",
                "ATLAS CENTAUR R/B"
            ],
            [
                "08459",
                "SL-8 R/B"
            ],
            [
                "10114",
                "SL-3 R/B"
            ],
            [
                "10967",
                "SEASAT 1"
            ],
            [
                "11267",
                "SL-14 R/B"
            ],
            [
                "11574",
                "SL-8 R/B"
            ],
            [
                "11672",
                "SL-14 R/B"
            ],
            [
                "12139",
                "SL-8 R/B"
            ],
            [
                "12465",
                "SL-3 R/B"
            ],
            [
                "12585",
                "METEOR PRIRODA"
            ],
            [
                "12904",
                "SL-3 R/B"
            ],
            [
                "13068",
                "SL-3 R/B"
            ],
            [
                "13154",
                "SL-3 R/B"
            ],
            [
                "13403",
                "SL-3 R/B"
            ],
            [
                "13553",
                "SL-14 R/B"
            ],
            [
                "13819",
                "SL-3 R/B"
            ],
            [
                "14032",
                "COSMOS 1455"
            ],
            [
                "14208",
                "SL-3 R/B"
            ],
            [
                "14372",
                "COSMOS 1500"
            ],
            [
                "14699",
                "COSMOS 1536"
            ],
            [
                "14820",
                "SL-14 R/B"
            ],
            [
                "15483",
                "SL-8 R/B"
            ],
            [
                "15772",
                "SL-12 R/B(2)"
            ],
            [
                "15945",
                "SL-14 R/B"
            ],
            [
                "16182",
                "SL-16 R/B"
            ],
            [
                "16496",
                "SL-14 R/B"
            ],
            [
                "16719",
                "COSMOS 1743"
            ],
            [
                "16792",
                "SL-14 R/B"
            ],
            [
                "16882",
                "SL-14 R/B"
            ],
            [
                "16908",
                "AJISAI (EGS)"
            ],
            [
                "17295",
                "COSMOS 1812"
            ],
            [
                "17567",
                "SL-14 R/B"
            ],
            [
                "17589",
                "COSMOS 1833"
            ],
            [
                "17590",
                "SL-16 R/B"
            ],
            [
                "17912",
                "SL-14 R/B"
            ],
            [
                "17973",
                "COSMOS 1844"
            ],
            [
                "18153",
                "SL-14 R/B"
            ],
            [
                "18187",
                "COSMOS 1867"
            ],
            [
                "18421",
                "COSMOS 1892"
            ],
            [
                "18749",
                "SL-14 R/B"
            ],
            [
                "18958",
                "COSMOS 1933"
            ],
            [
                "19046",
                "SL-3 R/B"
            ],
            [
                "19120",
                "SL-16 R/B"
            ],
            [
                "19210",
                "COSMOS 1953"
            ],
            [
                "19257",
                "SL-8 R/B"
            ],
            [
                "19573",
                "COSMOS 1975"
            ],
            [
                "19574",
                "SL-14 R/B"
            ],
            [
                "19650",
                "SL-16 R/B"
            ],
            [
                "20261",
                "INTERCOSMOS 24"
            ],
            [
                "20262",
                "SL-14 R/B"
            ],
            [
                "20323",
                "DELTA 1 R/B"
            ],
            [
                "20443",
                "ARIANE 40 R/B"
            ],
            [
                "20453",
                "DELTA 2 R/B(1)"
            ],
            [
                "20465",
                "COSMOS 2058"
            ],
            [
                "20466",
                "SL-14 R/B"
            ],
            [
                "20511",
                "SL-14 R/B"
            ],
            [
                "20580",
                "HST"
            ],
            [
                "20625",
                "SL-16 R/B"
            ],
            [
                "20663",
                "COSMOS 2084"
            ],
            [
                "20666",
                "SL-6 R/B(2)"
            ],
            [
                "20775",
                "SL-8 R/B"
            ],
            [
                "21088",
                "SL-8 R/B"
            ],
            [
                "21397",
                "OKEAN-3"
            ],
            [
                "21422",
                "COSMOS 2151"
            ],
            [
                "21423",
                "SL-14 R/B"
            ],
            [
                "21574",
                "ERS-1"
            ],
            [
                "21610",
                "ARIANE 40 R/B"
            ],
            [
                "21819",
                "INTERCOSMOS 25"
            ],
            [
                "21876",
                "SL-8 R/B"
            ],
            [
                "21938",
                "SL-8 R/B"
            ],
            [
                "21949",
                "USA 81"
            ],
            [
                "22219",
                "COSMOS 2219"
            ],
            [
                "22220",
                "SL-16 R/B"
            ],
            [
                "22236",
                "COSMOS 2221"
            ],
            [
                "22285",
                "SL-16 R/B"
            ],
            [
                "22286",
                "COSMOS 2228"
            ],
            [
                "22566",
                "SL-16 R/B"
            ],
            [
                "22626",
                "COSMOS 2242"
            ],
            [
                "22803",
                "SL-16 R/B"
            ],
            [
                "22830",
                "ARIANE 40 R/B"
            ],
            [
                "23087",
                "COSMOS 2278"
            ],
            [
                "23088",
                "SL-16 R/B"
            ],
            [
                "23343",
                "SL-16 R/B"
            ],
            [
                "23405",
                "SL-16 R/B"
            ],
            [
                "23561",
                "ARIANE 40+ R/B"
            ],
            [
                "23705",
                "SL-16 R/B"
            ],
            [
                "24298",
                "SL-16 R/B"
            ],
            [
                "24883",
                "ORBVIEW 2 (SEASTAR)"
            ],
            [
                "25400",
                "SL-16 R/B"
            ],
            [
                "25407",
                "SL-16 R/B"
            ],
            [
                "25544",
                "ISS (ZARYA)"
            ],
            [
                "25732",
                "CZ-4B R/B"
            ],
            [
                "25860",
                "OKEAN-O"
            ],
            [
                "25861",
                "SL-16 R/B"
            ],
            [
                "25876",
                "DELTA 2 R/B"
            ],
            [
                "25977",
                "HELIOS 1B"
            ],
            [
                "25994",
                "TERRA"
            ],
            [
                "26070",
                "SL-16 R/B"
            ],
            [
                "26474",
                "TITAN 4B R/B"
            ],
            [
                "27386",
                "ENVISAT"
            ],
            [
                "27422",
                "IDEFIX & ARIANE 42P R/B"
            ],
            [
                "27424",
                "AQUA"
            ],
            [
                "27432",
                "CZ-4B R/B"
            ],
            [
                "27597",
                "MIDORI II (ADEOS-II)"
            ],
            [
                "27601",
                "H-2A R/B"
            ],
            [
                "28059",
                "CZ-4B R/B"
            ],
            [
                "28222",
                "CZ-2C R/B"
            ],
            [
                "28353",
                "SL-16 R/B"
            ],
            [
                "28415",
                "CZ-4B R/B"
            ],
            [
                "28480",
                "CZ-2C R/B"
            ],
            [
                "28499",
                "ARIANE 5 R/B"
            ],
            [
                "28738",
                "CZ-2D R/B"
            ],
            [
                "28931",
                "ALOS (DAICHI)"
            ],
            [
                "28932",
                "H-2A R/B"
            ],
            [
                "29228",
                "RESURS-DK 1"
            ],
            [
                "29252",
                "GENESIS 1"
            ],
            [
                "29507",
                "CZ-4B R/B"
            ],
            [
                "31114",
                "CZ-2C R/B"
            ],
            [
                "31598",
                "COSMO-SKYMED 1"
            ],
            [
                "31789",
                "GENESIS 2"
            ],
            [
                "31792",
                "COSMOS 2428"
            ],
            [
                "31793",
                "SL-16 R/B"
            ],
            [
                "33504",
                "KORONAS-FOTON"
            ],
            [
                "37731",
                "CZ-2C R/B"
            ],
            [
                "38341",
                "H-2A R/B"
            ],
            [
                "39358",
                "SHIJIAN-16 (SJ-16)"
            ],
            [
                "39679",
                "SL-4 R/B"
            ],
            [
                "39766",
                "ALOS-2"
            ],
            [
                "41038",
                "YAOGAN-29"
            ],
            [
                "41337",
                "ASTRO-H (HITOMI)"
            ],
            [
                "42758",
                "HXMT (HUIYAN)"
            ],
            [
                "43521",
                "CZ-2C R/B"
            ],
            [
                "43641",
                "SAOCOM 1A"
            ],
            [
                "43682",
                "H-2A R/B"
            ],
            [
                "46265",
                "SAOCOM 1B"
            ],
            [
                "48274",
                "CSS (TIANHE)"
            ],
            [
                "48865",
                "COSMOS 2550"
            ],
            [
                "52794",
                "CZ-2C R/B"
            ],
            [
                "54149",
                "GSLV R/B"
            ],
            [
                "57800",
                "XRISM"
            ],
            [
                "59588",
                "ACS3"
            ]
        ];
    }

    /**
     * Replace/load TLE data
     */
    replaceTLE(tle) {
        this.removeSatellites();
        this.TLEData = new CTLEData(tle);
        this.TLEData.satData.forEach(sat => {
            sat.ecef = V3();
        });
        EventManager.dispatchEvent("tleLoaded", {});
        setRenderOne(2); // force a render update after loading the TLE data


        // if there's no export button, add one
        if (!this.exportTLEButton) {
            const obj = {
                exportTLE: () => {
                    const tleText = tle;
                    saveAs(new Blob([tleText]), "satellites.tle");
                }
            };
            this.exportTLEButton = guiMenus.file.add(obj, 'exportTLE').name(t("misc.exportTLE.label"));
        }

    }

    /**
     * Merge new TLE data into the existing TLEData, combining by NORAD number.
     * Rebuilds the light cloud since the satellite count may change.
     */
    mergeTLE(tle) {
        assert(this.TLEData !== undefined, "mergeTLE requires existing TLEData");
        const newData = new CTLEData(tle);
        this.TLEData.mergeFrom(newData);
        // Clear any active TLE filter — the boolean[] is indexed by satData position
        // and would be the wrong length after merge.
        this.tleFilterResults = null;
        this.tleFilterFrameData = null;
        // Rebuild the rendering since satellite count may have changed
        this.removeSatellites();
        this.TLEData.satData.forEach(sat => {
            if (!sat.ecef) sat.ecef = V3();
        });
        EventManager.dispatchEvent("tleLoaded", {});
        setRenderOne(2);

        // Update the export button to use merged raw text
        if (this.exportTLEButton) {
            this.exportTLEButton.destroy();
            this.exportTLEButton = null;
        }
        const rawText = this.TLEData.rawText;
        const obj = {
            exportTLE: () => {
                saveAs(new Blob([rawText]), "satellites.tle");
            }
        };
        this.exportTLEButton = guiMenus.file.add(obj, 'exportTLE').name(t("misc.exportTLE.label"));
    }

    removeSatellites() {
        if (this.TLEData !== undefined) {
            if (this.lightCloud) {
                NodeMan.disposeRemove(this.lightCloud);
                this.lightCloud = null;
            }

            for (const [index, satData] of Object.entries(this.TLEData.satData)) {
                if (satData.spriteText) {
                    if (satData.spriteText.parent) {
                        satData.spriteText.parent.remove(satData.spriteText);
                        satData.spriteText.parent = null;
                    }
                    satData.spriteText.dispose();
                    satData.spriteText = null;
                }

                this.removeSatSunArrows(satData);
                this.removeSatelliteArrows(satData);
            }
            this.satData = undefined;
        }
    }

    addSatellites(scene, globeRadius = 1) {
        assert(this.TLEData !== undefined, "addSatellites needs TLEData to be set");

        if (this.lightCloud) {
            NodeMan.disposeRemove(this.lightCloud);
            this.lightCloud = null;
        }

        const len = this.TLEData.satData.length;
        this.scene = scene;

        this.lightCloud = new CPointLightCloud({
            id: "SatelliteLightCloud",
            mode: 'world',
            singleColor: null,  // per-satellite colors
            useLogDepth: true,
            useSkyAttenuation: true,
            useSizeRange: true,
            useDistanceAttenuation: true,
            distanceReference: 3000000,
            minPointSize: 0.0,
            maxPointSize: 20.0,
            baseScale: 1.0,
            count: len,
            scene: scene,
        });

        this.lightCloud.createMainViewMaterial({
            nearDist: 20000000,
            farDist: 100000000,
            nearScale: 0.5,
            farScale: 0.1,
            baseScale: 10,
            minPointSize: 1.0,
            maxPointSize: 20.0,
        });

        this.lightCloud.points.layers.mask = LAYER.MASK_LOOK;
        this.lightCloud.mainViewPoints.layers.mask = LAYER.MASK_MAIN;

        for (let i = 0; i < len; i++) {
            const sat = this.TLEData.satData[i];
            sat.ecef = V3();

            let color = new Color(0xF0F0FF);
            if (sat.name.includes("STARLINK")) {
                const name = sat.name.replace("0 STARLINK", "SL").replace("STARLINK", "SL").replace(/\s+$/, '');
                color = name.length > 7 ? new Color(0xFFA080) : new Color(0xFFFFC0);
            }

            this.lightCloud.setColor(i, color.r, color.g, color.b);
            this.lightCloud.setBrightness(i, 0.1);
        }

        this.lightCloud.markColorsNeedUpdate();
        this.lightCloud.markBrightnessNeedUpdate();
    }

    /**
     * Filter which satellites are visible based on user settings
     */
    filterSatellites() {
        if (this.TLEData === undefined) return;

        // first get the satellite list into an array of NORAD numbers
        const satList = this.showSatelliteList.split(",").map(x => x.trim());
        const list = [];
        // this can be names or numbers, convert to numbers
        for (let i = 0; i < satList.length; i++) {
            const num = parseInt(satList[i]);
            if (isNaN(num)) {
                const matching = this.TLEData.getMatchingRecords(satList[i]);
                // add the "matching" array to the list
                if (matching.length > 0) {
                    for (const number of matching) {
                        // if the number is not already in the list, add it
                        if (!list.includes(number)) {
                            list.push(number);
                        }
                    }
                }
            } else {
                list.push(num);
            }
        }

        // iterate over the satellites and flag visibility
        // based on the name and the GUI flags
        for (const satData of this.TLEData.satData) {

            // this is just a clean time to remove the debug arrows
            // they will get recreated for all visible satellites
            this.removeSatelliteArrows(satData);

            satData.visible = false;
            satData.userFiltered = false;
            let filterHit = false;

            if (!this.showSatellites)
                continue;

            if (satData.name.startsWith("STARLINK")) {
                filterHit = true;
                if (this.showStarlink) {
                    satData.visible = true;
                    continue;
                }
            }

            if (satData.name.startsWith("ISS (ZARYA)")) {
                filterHit = true;
                if (this.showISS) {
                    satData.visible = true;
                    satData.userFiltered = true;
                    continue;
                }
            }

            // check the number against the brightest list
            if (this.showBrightest) {
                for (const [num, name] of this.brightest) {
                    if (satData.number === parseInt(num)) {
                        filterHit = true;
                        satData.visible = true;
                        satData.userFiltered = true;
                        continue;
                    }
                }
            }

            // check the number against the user supplied list
            // comma separated list of names or NORAD numbers
            if (this.showSatelliteList) {
                for (const number of list) {
                    if (satData.number === parseInt(number)) {
                        filterHit = true;
                        satData.visible = true;
                        satData.userFiltered = true;
                        continue;
                    }
                }
            }

            if (!filterHit && this.showOtherSatellites) {
                satData.visible = true;
                continue;
            }
        }

        // Apply TLE filter results (from Filter TLEs dialog) as an AND on top of category filters
        if (this.tleFilterResults) {
            for (let i = 0; i < this.TLEData.satData.length; i++) {
                if (!this.tleFilterResults[i]) {
                    this.TLEData.satData[i].visible = false;
                }
            }
        }
    }

    /**
     * Calculate satellite ECEF position for a given date
     */
    calcSatECEF(sat, date) {
        const positionAndVelocity = satellite.propagate(sat, date);
        if (positionAndVelocity && positionAndVelocity.position) {
            const gmst = satellite.gstime(date);
            // get geodetic (LLA) coordinates directly from satellite.js
            const GD = satellite.eciToGeodetic(positionAndVelocity.position, gmst);
            const altitude = GD.height * 1000; // convert from km to meters

            // if the altitude is less than 100km, then it's in the atmosphere so we don't show it
            if (altitude < 100000) {
                return null;
            }

            // if it's significantly (10%) greater than geostationary orbit (35,786 km), then it's probably an error
            // so we don't show it
            if (altitude > 40000000) {
                return null;
            }

            const ecef = LLAToECEFRadians(GD.latitude, GD.longitude, altitude);
            return ecef;
        } else {
            return null;
        }
    }

    /**
     * Get the ECEF position of the satellite the camera is currently riding on,
     * if any. Returns {ecef} or null. Uses the pre-computed track array position
     * (which is frame-accurate) rather than the TLE interpolation position
     * (which may be from a stale interpolation interval).
     */
    _getCameraSatelliteState() {
        try {
            const sw = NodeMan.get('cameraTrackSwitch', false);
            if (!sw) return null;
            const trackNode = sw.inputs[sw.choice];
            if (!trackNode || trackNode.constructor.name !== 'CNodeSatelliteTrack' || !trackNode.norad) {
                return null;
            }
            // Use the track node's pre-computed position for the current frame
            assert(!trackNode._needsRecalculate, "call ensureRecalculated() before direct array access on " + trackNode.id);
            const trackValue = trackNode.array[par.frame];
            if (trackValue && trackValue.position) {
                return {ecef: trackValue.position};
            }
            // Fallback to live TLE satData
            const satData = this.TLEData.getRecordFromNORAD(trackNode.norad);
            if (!satData || !satData.ecef || satData.invalidPosition) return null;
            return {ecef: satData.ecef};
        } catch {
            return null;
        }
    }

    /**
     * Find the nearest sample index in tleFilterFrameData for a given timeMS.
     * Linear scan — fast for ≤60 samples.
     */
    _nearestSampleIndex(timeMS) {
        const times = this.tleFilterFrameData.sampleTimesMS;
        let bestIdx = 0;
        let bestDist = Math.abs(timeMS - times[0]);
        for (let s = 1; s < times.length; s++) {
            const d = Math.abs(timeMS - times[s]);
            if (d < bestDist) { bestDist = d; bestIdx = s; }
            else break; // times are sorted, so once distance increases we're past the nearest
        }
        return bestIdx;
    }

    updateAllSatellites(date, options = {}) {
        if (!this.TLEData || !this.lightCloud) {
            return;
        }

        const timeMS = date.getTime();
        const numSats = this.TLEData.satData.length;

        if (numSats < 100) {
            this.timeStep = 100;
        } else {
            this.timeStep = numSats;
        }

        const lookPos = options.lookCameraPos || V3(0, 0, 0);

        // When the camera is riding a satellite (e.g. ISS), hide that satellite
        // AND any co-located objects (docked spacecraft with separate TLE entries).
        // Matched by proximity alone (<500m). At orbital altitudes no independent
        // satellite stays within 300m for more than a fraction of a second, so
        // distance is sufficient — no velocity check needed.
        const camSatState = this._getCameraSatelliteState();

        let validCount = 0;
        let visibleCount = 0;
        const maxTLEAgeDays = 90;
        const maxTLEAgeMS = maxTLEAgeDays * 24 * 60 * 60 * 1000;

        for (let i = 0; i < numSats; i++) {
            const satData = this.TLEData.satData[i];
            const satrec = bestSat(satData.satrecs, date);

            const tleEpochDate = satRecToDate(satrec);
            const tleAgeMS = Math.abs(timeMS - tleEpochDate.getTime());
            if (tleAgeMS > maxTLEAgeMS) {
                satData.invalidPosition = true;
                satData.outOfRange = true;
                this.removeSatSunArrows(satData);
                this.lightCloud.setBrightness(i, 0);
                this.lightCloud.setPosition(i, 1000000000, 0, 0);
                if (satData.visible) {
                    visibleCount++;
                }
                continue;
            }
            satData.outOfRange = false;

            if (satData.timeA === undefined
                || timeMS < satData.timeA  // check if time is outside current interval
                || timeMS > satData.timeB) {
                // When crossing the boundary (timeMS > timeB), start new interval from old endpoint
                // to ensure smooth continuity. Otherwise we'd jump from position-at-timeB to position-at-timeMS.
                if (satData.timeB !== undefined
                    && timeMS > satData.timeB               // current time is past B time
                    && (timeMS - satData.timeB) < 1000      // but less than a second past
                    && satData.ecefB !== null) {             // and we were interpolating valid     positions
                    // Carry forward: old end becomes new start
                    satData.timeA = satData.timeB;
                    satData.ecefA = satData.ecefB;
                } else {
                    // First time or backwards jump or jump fwd more that a second, calculate fresh
                    satData.timeA = timeMS;
                    satData.ecefA = this.calcSatECEF(satrec, date);
                }
                if (satData.timeB === undefined) {
                    satData.timeB = satData.timeA + Math.floor(1 + this.timeStep * (i / numSats));
                } else {
                    satData.timeB = satData.timeA + this.timeStep;
                }
                const dateB = new Date(satData.timeB);
                satData.ecefB = this.calcSatECEF(satrec, dateB);
            }

            if (satData.ecefA !== null && satData.ecefB !== null) {
                const velocity = satData.ecefB.clone().sub(satData.ecefA).multiplyScalar(1000 / (satData.timeB - satData.timeA)).length();

                if (velocity < 2500 || velocity > 11000) {
                    satData.invalidPosition = true;
                } else {
                    var t = (timeMS - satData.timeA) / (satData.timeB - satData.timeA);
                    satData.ecef.lerpVectors(satData.ecefA, satData.ecefB, t);

                    this.lightCloud.setPosition(i, satData.ecef.x, satData.ecef.y, satData.ecef.z);
                    satData.invalidPosition = false;
                    satData.currentPosition = satData.ecef.clone();

                    if (satData.spriteText) {
                        satData.spriteText.position.set(satData.ecef.x, satData.ecef.y, satData.ecef.z);
                    }

                    let arrowsDrawn = false;
                    const inRange = satData.ecefA.distanceTo(lookPos) < this.arrowRange * 1000;
                    const arrowVisible = satData.visible && inRange && 
                        (!this.labelLookVisible || satData.visibleInLook) &&
                        (!this.labelFlares || satData.isFlaring) &&
                        (!this.labelLit || satData.isLit);
                    
                    if (arrowVisible) {
                        if (this.showSatelliteTracks && options.satelliteTrackGroup) {
                            let dir = satData.ecefB.clone().sub(satData.ecefA).normalize();
                            DebugArrow(satData.name + "_t", dir, satData.ecef, 500000, "#FFFF00", true, options.satelliteTrackGroup, 20, LAYER.MASK_LOOKRENDER);
                            arrowsDrawn = true;
                            satData.hasArrowsNeedingCleanup = true;
                        }

                        if (this.showSatelliteGround && options.satelliteGroundGroup) {
                            let A = satData.ecefA.clone();
                            let B = getPointBelow(A);
                            DebugArrowAB(satData.name + "_g", A, B, "#00FF00", true, options.satelliteGroundGroup, 20, LAYER.MASK_LOOKRENDER);
                            arrowsDrawn = true;
                            satData.hasArrowsNeedingCleanup = true;
                        }
                    }

                    if (!arrowsDrawn) {
                        this.removeSatelliteArrows(satData);
                    }
                }
            } else {
                satData.invalidPosition = true;
            }

            // Detect satellites co-located with the camera satellite (docked objects).
            // These are hidden in the look view only (dots + labels) but remain
            // visible in the main 3D overview.
            satData.hiddenInLookView = false;
            if (camSatState && !satData.invalidPosition && satData.ecef) {
                satData.hiddenInLookView = satData.ecef.distanceTo(camSatState.ecef) < 500;
            }

            // Per-frame TLE filter: if "any frame in range" precalculated data exists,
            // check whether this satellite is visible at the current time.
            let tleFrameHidden = false;
            if (this.tleFilterFrameData && satData.visible && !satData.invalidPosition) {
                const fd = this.tleFilterFrameData.perSat[i];
                if (fd === 'off') {
                    tleFrameHidden = true;
                } else if (Array.isArray(fd)) {
                    // 'changeable' — find nearest sample for current time
                    const idx = this._nearestSampleIndex(timeMS);
                    tleFrameHidden = !fd[idx];
                }
                // 'on' → always visible, no action needed
            }

            if (satData.invalidPosition || !satData.visible || tleFrameHidden) {
                this.removeSatSunArrows(satData);
                this.lightCloud.setBrightness(i, 0);
                this.lightCloud.setPosition(i, 1000000000, 0, 0);
            } else {
                validCount++;
            }

            if (satData.visible) {
                visibleCount++;
            }
        }

        this.lightCloud.markPositionsNeedUpdate();
        this.lightCloud.markBrightnessNeedUpdate();

        return { validCount, visibleCount };
    }

    /**
     * Remove satellite track arrows
     */
    removeSatelliteArrows(satData) {
        if (satData.hasArrowsNeedingCleanup) {
            removeDebugArrow(satData.name + "_t");
            removeDebugArrow(satData.name + "_g");
            satData.hasArrowsNeedingCleanup = false;
        }
    }

    /**
     * Remove satellite sun/flare arrows
     */
    removeSatSunArrows(satData) {
        if (satData.hasSunArrow) {
            removeDebugArrow(satData.name);
            removeDebugArrow(satData.name + "sun");
            removeDebugArrow(satData.name + "reflected");
            removeDebugArrow(satData.name + "flare");
            satData.hasSunArrow = false;
        }
    }


    updateCustomSats() {
        this.updateSats("CUSTOM");
    }

    /**
     * Update Starlink constellation (current, not historical)
     */
    updateStarlink() {
        const url = SITREC_SERVER + "proxy.php?request=CURRENT_STARLINK";
        console.log("Getting starlink from " + url);
        const id = "starLink_current.tle";
        this.loadSatellites(url, id);
    }

    updateActive() {
        const url = SITREC_SERVER + "proxy.php?request=CURRENT_ACTIVE";
        console.log("Getting active from " + url);
        const id = "active_current.tle";
        this.loadSatellites(url, id);
    }



    /**
     * Update LEO satellites for the current simulation date
     */
    updateLEOSats() {
        this.updateSats("LEO");
    }

    /**
     * Update SLOW satellites (experimental)
     */
    updateSLOWSats() {
        this.updateSats("SLOW");
    }

    /**
     * Update ALL satellites (experimental)
     */
    updateALLSats() {
        this.updateSats("ALL");
    }

    /**
     * Internal method to update satellites of a specific type
     */
    updateSats(satType) {
        let startTime = new Date(GlobalDateTimeNode.dateStart);

        const now = new Date();
        const someTimeAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
        if (startTime > someTimeAgo) {
            startTime = someTimeAgo;
        }

        startTime.setDate(startTime.getDate() - 1);

        this.loadDatedTLEWithRetry(startTime, satType, 0);
    }

    loadDatedTLEWithRetry(startTime, satType, retryCount) {
        const maxRetries = 3;
        const daysBackPerRetry = 3;

        const dateStr = startTime.toISOString().split('T')[0];
        const url = SITREC_SERVER + "proxyStarlink.php?request=" + dateStr + "&type=" + satType;
        const id = "starLink_" + dateStr + ".tle";

        console.log(`Getting satellites from ${url} (attempt ${retryCount + 1})`);

        this.currentTLEAbortController = new AbortController();

        initProgress({
            title: "Loading TLE Data",
            filename: `${satType} satellites for ${dateStr}`,
            showAbort: true,
            onAbort: () => {
                if (this.currentTLEAbortController) {
                    this.currentTLEAbortController.abort();
                }
                hideProgress();
            }
        });

        if (retryCount > 0) {
            updateProgress({ retryInfo: { attempt: retryCount, maxRetries, daysBack: retryCount * daysBackPerRetry } });
        } else {
            updateProgress({ status: "Connecting to server..." });
        }

        this.fetchTLEWithProgress(url, this.currentTLEAbortController.signal)
            .then(response => {
                if (response.status >= 500) {
                    throw new Error(`SERVER_ERROR_${response.status}`);
                }
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                return response;
            })
            .then(response => {
                const contentLength = response.headers.get('content-length');
                const total = contentLength ? parseInt(contentLength, 10) : 0;
                return this.readResponseWithProgress(response, total, this.currentTLEAbortController.signal);
            })
            .then(buffer => {
                // Check if response is an error (plain text starting with "ERROR:")
                const byteView = new Uint8Array(buffer);
                const isZip = byteView[0] === 0x50 && byteView[1] === 0x4B; // "PK" magic bytes
                
                if (!isZip) {
                    // Likely a text error message
                    const text = new TextDecoder().decode(buffer).trim();
                    if (text.startsWith("ERROR:")) {
                        if (retryCount < maxRetries) {
                            const newStartTime = new Date(startTime);
                            newStartTime.setDate(newStartTime.getDate() - daysBackPerRetry);
                            console.log(`Server error: ${text}`);
                            console.log(`Retrying with date ${newStartTime.toISOString().split('T')[0]} (attempt ${retryCount + 2}/${maxRetries + 1})`);
                            this.loadDatedTLEWithRetry(newStartTime, satType, retryCount + 1);
                            return;
                        }
                        hideProgress();
                        showError("TLE Loading Error: " + text);
                        return;
                    }
                }

                hideProgress();
                this.processTLEData(id, buffer);
            })
            .catch(error => {
                if (error.name === 'AbortError') {
                    hideProgress();
                    console.log("TLE loading aborted by user");
                    return;
                }

                if (error.message.startsWith("SERVER_ERROR_") && retryCount < maxRetries) {
                    const newStartTime = new Date(startTime);
                    newStartTime.setDate(newStartTime.getDate() - daysBackPerRetry);
                    console.log(`${error.message}, retrying with date ${newStartTime.toISOString().split('T')[0]} (attempt ${retryCount + 2}/${maxRetries + 1})`);
                    this.loadDatedTLEWithRetry(newStartTime, satType, retryCount + 1);
                    return;
                }

                hideProgress();
                const displayMsg = error.message.replace("SERVER_ERROR_", "HTTP ");
                showError("TLE Loading Error: " + displayMsg);
            });
    }

    fetchTLEWithProgress(url, signal) {
        return fetch(url, { signal });
    }

    async readResponseWithProgress(response, total, signal) {
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;

        try {
            while (true) {
                if (signal && signal.aborted) {
                    reader.cancel();
                    throw new DOMException('Aborted', 'AbortError');
                }
                
                const { done, value } = await reader.read();
                if (done) break;
                
                chunks.push(value);
                loaded += value.length;
                
                if (total > 0) {
                    updateProgress({ loaded, total });
                } else {
                    updateProgress({ status: `Downloaded ${(loaded / 1024).toFixed(0)} KB...` });
                }
            }
        } catch (e) {
            reader.cancel();
            throw e;
        }

        // Combine chunks into a single ArrayBuffer
        const allChunks = new Uint8Array(loaded);
        let position = 0;
        for (const chunk of chunks) {
            allChunks.set(chunk, position);
            position += chunk.length;
        }
        
        return allChunks.buffer;
    }

    processTLEData(id, buffer) {
        // Use FileManager.parseResult to handle unzipping, parsing, and routing
        // The proxyStarlink returns zipped TLE data
        FileManager.remove(id);
        FileManager.parseResult(id + ".tle", buffer, null)
            .then(results => {
                // parseResult returns an array of results
                // Mark the files as dynamic links (not static URLs)
                if (Array.isArray(results)) {
                    results.forEach(result => {
                        const fileInfo = FileManager.list[result.filename];
                        if (fileInfo) {
                            fileInfo.staticURL = null;
                            fileInfo.dynamicLink = true;
                        }
                    });
                }
            })
            .catch(err => {
                console.error("Error parsing TLE data:", err);
                showError("Error parsing TLE data: " + err.message);
            });
    }

    /**
     * Load satellites from a URL (non-dated, e.g., current Starlink)
     */
    loadSatellites(url, id) {
        this.currentTLEAbortController = new AbortController();

        initProgress({
            title: "Loading TLE Data",
            filename: id,
            showAbort: true,
            onAbort: () => {
                if (this.currentTLEAbortController) {
                    this.currentTLEAbortController.abort();
                }
                hideProgress();
            }
        });

        updateProgress({ status: "Connecting to server..." });

        this.fetchTLEWithProgress(url, this.currentTLEAbortController.signal)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const contentLength = response.headers.get('content-length');
                const total = contentLength ? parseInt(contentLength, 10) : 0;
                return this.readResponseWithProgress(response, total, this.currentTLEAbortController.signal);
            })
            .then(buffer => {
                hideProgress();

                // Check if response is an error (plain text starting with "ERROR:")
                const byteView = new Uint8Array(buffer);
                const isZip = byteView[0] === 0x50 && byteView[1] === 0x4B; // "PK" magic bytes
                
                if (!isZip) {
                    const text = new TextDecoder().decode(buffer).trim();
                    if (text.startsWith("ERROR:")) {
                        showError("TLE Loading Error: " + text);
                        return;
                    }
                }

                this.processTLEData(id, buffer);
            })
            .catch(error => {
                hideProgress();

                if (error.name === 'AbortError') {
                    console.log("TLE loading aborted by user");
                    return;
                }

                showError("TLE Loading Error: " + error.message);
            });
    }

    /**
     * Compute the satellite surface normal for flare reflection based on the selected model.
     * "Geocentric Nadir" - vector from Earth center to satellite (original, simple model)
     * "Geodetic Nadir"   - WGS84 ellipsoid surface normal (physically correct for nadir-pointing satellites)
     */
    getSatelliteNormal(satPosition, globeCenter) {
        if (this.flareModel === "Geocentric Nadir") {
            return satPosition.clone().sub(globeCenter).normalize();
        }
        // Geodetic Nadir: normal to the WGS84 ellipsoid at the satellite's position.
        // For a nadir-pointing satellite, the antenna panel is perpendicular to this direction.
        return getLocalUpVector(satPosition);
    }

    /**
     * Perform flare detection and return flare info for a satellite
     * Called from CNodeDisplayNightSky for rendering
     */
    detectFlare(satData, camera, globe, toSun, showFlareTracks, satelliteFlareTracksGroup, sunArrowGroup) {
        if (!satData.visible || !satData.currentPosition) {
            return null;
        }

        const satPosition = satData.currentPosition;
        const camToSat = satPosition.clone().sub(camera.position);

        // check if it's visible (use ellipsoid for accurate horizon at all latitudes)
        const belowHorizon = rayIntersectsEllipsoid(camera.position, camToSat);

        if (!belowHorizon) {
            const satNormal = this.getSatelliteNormal(satPosition, globe.center);
            const reflected = camToSat.clone().reflect(satNormal).normalize();
            const dot = reflected.dot(toSun);
            const glintAngle = Math.abs(degrees(Math.acos(Math.max(-1, Math.min(1, dot)))));

            const spread = this.flareAngle;
            const ramp = spread * 0.25;
            const middle = spread - ramp;

            if (glintAngle < spread) {
                let glintScale;
                let d = Math.abs(glintAngle);
                if (d < middle) {
                    glintScale = 1.0; // maximum
                } else {
                    d = d - middle;
                    glintScale = (ramp - d) * (ramp - d) / (ramp * ramp);
                }

                return {
                    angle: glintAngle,
                    scale: glintScale,
                    belowHorizon: belowHorizon,
                    satPosition: satPosition,
                    camToSat: camToSat,
                    reflected: reflected
                };
            }
        }

        return null;
    }
}