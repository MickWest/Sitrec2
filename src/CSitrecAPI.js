// Client-side Sitrec API with callable functions and documentation
import {GlobalDateTimeNode, NodeMan} from "./Globals";
import {isLocal} from "./configUtils";
import {showError} from "./showError";

class CSitrecAPI {
    constructor() {

        this.debug = isLocal;

        this.docs = {
            gotoLLA: "Move the camera to the location specified by Lat/Lon/Alt (Alt optional, defaults to 0). Parameters: lat (float), lon (float), alt (float, optional).",
            setDateTime: "Set the date and time for the simulation. Parameter: dateTime (ISO 8601 string).",
        };

        this.api = {
            gotoLLA: {
                doc: "Move the camera to the specified latitude, longitude, and altitude.",
                params: {
                    lat: "Latitude in degrees (float)",
                    lon: "Longitude in degrees (float)",
                    alt: "Altitude in meters (float, optional, defaults to 0)"
                },
                fn: (v) => {
                    const camera = NodeMan.get("fixedCameraPosition");
                    camera.gotoLLA(v.lat, v.lon, v.alt)
                }
            },

            setDateTime: {
                doc: "Set the date and time for the simulation.",
                params: {
                    dateTime: "ISO 8601 date-time string with Z or timezone offset (e.g. '2023-10-01T12:00:00+02:00')"
                },
                fn: (v) => {
                    const dateTime = new Date(v.dateTime);
                    if (isNaN(dateTime.getTime())) {
                        showError("Invalid date-time format:", v.dateTime);
                        return;
                    }
                    GlobalDateTimeNode.setStartDateTime(v.dateTime);

                }
            },

            pointCameraAtRaDec: {
                doc: "Set the camera orientation based on Right Ascension and Declination. Use for looking at stars and other fixed sky object (not planets or the sun",
                params: {
                    ra: "Right Ascension in hours (float)",
                    dec: "Declination in degrees (float)",
                },
                fn: (v) => {
                    const camera = NodeMan.get("lookCamera");
                    camera.setFromRaDec(v.ra, v.dec);
                }
            },

            pointCameraAtNamedObject: {
                doc: "Point the camera at a named celestial object (e.g. 'Sun', 'Moon', 'Mars'). Use this for things that are not fixed.",
                params: {
                    object: "Name of the celestial object (string)"
                },
                fn: (v) => {
                    const camera = NodeMan.get("lookCamera");
                    camera.setFromNamedObject(v.object);
                }
            },

            satellitesShowSatellites: {
                doc: "Show satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatellites = true;
                    }
                }
            },
            satellitesHideSatellites: {
                doc: "Hide satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatellites = false;
                    }
                }
            },

            satellitesShowStarlink: {
                doc: "Show Starlink satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showStarlink = true;
                    }
                }
            },
            satellitesHideStarlink: {
                doc: "Hide Starlink satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showStarlink = false;
                    }
                }
            },

            satellitesShowISS: {
                doc: "Show ISS satellite.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showISS = true;
                    }
                }
            },
            satellitesHideISS: {
                doc: "Hide ISS satellite.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showISS = false;
                    }
                }
            },

            satellitesShowBrightest: {
                doc: "Show Celestrak brightest satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showBrightest = true;
                    }
                }
            },
            satellitesHideBrightest: {
                doc: "Hide Celestrak brightest satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showBrightest = false;
                    }
                }
            },

            satelliteLookViewNamesOn: {
                doc: "Switch on satellite names in the look view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNames = true;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteLookViewNamesOff: {
                doc: "Switch off satellite names in the look view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNames = false;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteLookViewNamesToggle: {
                doc: "Toggle satellite names in the look view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNames = nightSky.showSatelliteNames === true ? false : true;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteMainViewNamesOn: {
                doc: "Switch on satellite names in the main view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNamesMain = true;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteMainViewNamesOff: {
                doc: "Switch off satellite names/lables in the main view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNamesMain = false;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteNamesMainViewToggle: {
                doc: "Toggle the display of satellite names in the main view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNamesMain = nightSky.showSatelliteNamesMain === true ? false : true ;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteLabelsOn: {
                doc: "Switches on satellite labels.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showAllLabels = true;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteLabelsOff: {
                doc: "Switches off satellite labels.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showAllLabels = false;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satellitesLoadLEO: {
                doc: "Loads LEO low-earth orbit satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.satellites.updateLEOSats();
                    }
                }
            },

            satellitesLoadCurrentStarlink: {
                doc: "Loads current Starlink satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.satellites.updateStarlink();
                    }
                }
            },

            //{ key: "showFlareRegion", name: "Flare Region", object: this, action: () => this.flareRegionGroup.visible = this.showFlareRegion},
            satellitesFlareRegionOn: {
                doc: "Loads current Starlink satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.satellites.updateStarlink();
                    }
                }
            },


            //{ key: "showFlareBand", name: "Flare Band", object: this, action: () => this.flareBandGroup.visible = this.showFlareBand},

            debug: {
                doc: "Toggle debug mode",
                params: {
                },
                fn: (v) => {
                    this.debug = !this.debug;
                }
            }

        }

    }


    getDocumentation() {
        //return this.docs;
        return Object.entries(this.api).reduce((acc, [key, value]) => {
            // conver the parameters to strings, like
            //             gotoLLA: "Move the camera to the location specified by Lat/Lon/Alt (Alt optional, defaults to 0). Parameters: lat (float), lon (float), alt (float, optional).",
            let paramsString = Object.entries(value.params || {})
                .map(([param, desc]) => `${param} (${desc})`)
                .join(", ");
            let docString = value.doc || "No documentation available.";
            acc[key] = `${docString} Parameters: ${paramsString}`;
            return acc;
        }, {});
    }


    handleAPICall(call) {
        console.log("Handling API call:", call);
        this.api[call.fn]?.fn(call.args);
    }

}

export const sitrecAPI = new CSitrecAPI();
