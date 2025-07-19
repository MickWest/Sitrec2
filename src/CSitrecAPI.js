// Client-side Sitrec API with callable functions and documentation
import {GlobalDateTimeNode, NodeMan, Sit} from "./Globals";
import {isLocal} from "./configUtils";

class CSitrecAPI {
    constructor() {

        this.debug = isLocal;

        // have a richer structure with the functions in it
        // and extract docs at the start.

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
                        console.error("Invalid date-time format:", v.dateTime);
                        return;
                    }
                    GlobalDateTimeNode.setStartDateTime(v.dateTime);

                }
            },

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
