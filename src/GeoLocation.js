import {Globals, NodeMan, Sit} from "./Globals";

export async function requestGeoLocation(force = false) {
    console.log("Requesting geolocation... Situation = " + Sit.name);

    let watchID = null; // Variable to store the watch ID

    const geolocationPromise = new Promise((resolve, reject) => {
        // Use watchPosition instead of getCurrentPosition
        watchID = navigator.geolocation.watchPosition((position) => {

            // Check if local lat/lon is enabled in this situation
            // if not, then this is a patch, to avoid the situation where the user
            // changes sitches before the geolocation is obtained
            // I've tried to cancel it, but it's not working
            if (!Sit.localLatLon && !force) {
                console.warn("Local lat/lon not enabled in this situation. Aborting geolocation.");
                // Clear the watch to stop receiving updates after the first position is obtained
                if (watchID !== null) {
                    navigator.geolocation.clearWatch(watchID);
                    watchID = null;
                }
                resolve(); // Resolve to continue with defaults
                return;
            }

            // a more serious patch, to avoid the situation where the user
            // this seems unlikely to happen, but I've escalated it to an error
            if (!NodeMan.exists("cameraLat") && !NodeMan.exists("fixedCameraPosition")) {
                console.error("cameraLat or fixedCameraPosition node not found. Aborting geolocation.");
                // Clear the watch to stop receiving updates after the first position is obtained
                if (watchID !== null) {
                    navigator.geolocation.clearWatch(watchID);
                    watchID = null;
                }
                resolve(); // Resolve to continue with defaults
                return;
            }

            // Successfully obtained the position
            let lat = position.coords.latitude;
            let lon = position.coords.longitude;


            // Can't change Sit.lat and Sit.lon
            // after setup,

            lat = parseFloat(lat.toFixed(2));
            lon = parseFloat(lon.toFixed(2));




            Sit.fromLat = lat;
            Sit.fromLon = lon;

            console.log("RESOLVED Local Lat, Lon =", lat, lon, " situation = " + Sit.name);

            if (NodeMan.exists("fixedCameraPosition")) {
                const fixedCameraPosition = NodeMan.get("fixedCameraPosition");
                // this is PositionLLA node, so we can set the lat/lon
                fixedCameraPosition.setLLA(lat, lon, 0);

            } else {

                NodeMan.get("cameraLat").value = lat;
                NodeMan.get("cameraLon").value = lon;
            }

            // Clear the watch to stop receiving updates after the first position is obtained
            if (watchID !== null) {
                navigator.geolocation.clearWatch(watchID);
                watchID = null;
            }

            resolve(true); // Resolve the promise when geolocation is obtained
        }, (error) => {
            // Handle errors
            console.log("Location request failed");
            resolve(false); // Resolve to continue with defaults
            // If you wish to reject the promise on error, use reject(error); but ensure to handle the rejection where requestGeoLocation is called
        });
        console.log("Geolocation watch ID:", watchID);
    });

    // Return the promise so calling code can await it or handle completion/failure
    return geolocationPromise;
}

// To allow cancellation, you can expose a function to clear the watch from outside
export function cancelGeoLocationRequest() {
    if (typeof Globals.geolocationWatchID === 'number') {
        console.log("Cancelling geolocation request.");
        navigator.geolocation.clearWatch(Globals.geolocationWatchID);
        Globals.geolocationWatchID = null;
    }
}