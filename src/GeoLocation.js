import {Globals, NodeMan, Sit} from "./Globals";

async function getApproximateLocationFromIP() {
    try {
        const res = await fetch("https://ipapi.co/json/");
        const data = await res.json();
        const lat = parseFloat(data.latitude.toFixed(2));
        const lon = parseFloat(data.longitude.toFixed(2));
        console.log("IP-based approximate location:", lat, lon);
        return { lat, lon };
    } catch (e) {
        console.warn("IP geolocation failed", e);
        return null;
    }
}

export async function requestGeoLocation(force = false) {
    console.log("Requesting IP-based geolocation... Situation =", Sit.name);

    if (!Sit.localLatLon && !force) {
        console.warn("Local lat/lon not enabled in this situation. Aborting geolocation.");
        return false;
    }

    if (!NodeMan.exists("cameraLat") && !NodeMan.exists("fixedCameraPosition")) {
        console.error("cameraLat or fixedCameraPosition node not found. Aborting geolocation.");
        return false;
    }

    const ipLocation = await getApproximateLocationFromIP();
    if (!ipLocation) {
        return false;
    }

    const { lat, lon } = ipLocation;

    Sit.fromLat = lat;
    Sit.fromLon = lon;

    console.log("Resolved approximate lat/lon from IP:", lat, lon);

    if (NodeMan.exists("fixedCameraPosition")) {
        const fixedCameraPosition = NodeMan.get("fixedCameraPosition");
        fixedCameraPosition.setLLA(lat, lon, 0);
    } else {
        NodeMan.get("cameraLat").value = lat;
        NodeMan.get("cameraLon").value = lon;
    }

    return true;
}

// To allow cancellation, you can expose a function to clear the watch from outside
export function cancelGeoLocationRequest() {
    // if (typeof Globals.geolocationWatchID === 'number') {
    //     console.log("Cancelling geolocation request.");
    //     navigator.geolocation.clearWatch(Globals.geolocationWatchID);
    //     Globals.geolocationWatchID = null;
    // }
}