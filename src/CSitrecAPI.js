// Client-side Sitrec API with callable functions and documentation
import {Sit} from "./Globals";

class CSitrecAPI {
    constructor() {
        this.docs = {
            gotoLLA: "Move the camera to the location specified by Lat/Lon/Alt (Alt optional, defaults to 0). Parameters: lat (float), lon (float), alt (float, optional).",
            setDateTime: "Set the date and time for the simulation. Parameter: dateTime (ISO 8601 string).",
        };
    }

    gotoLLA(lat, lon, alt = 0) {
        Sit.setLatLon(lat, lon); // Extend if altitude support is needed later
    }

    setDateTime(dateTime) {
        Sit.setDateTime(dateTime);
    }

    getDocumentation() {
        return this.docs;
    }
}

export const sitrecAPI = new CSitrecAPI();
