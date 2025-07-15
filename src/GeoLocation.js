import {Globals, NodeMan, Sit} from "./Globals";


// cache the value once, as we only need the location
let cachedLocation = null;
export async function getApproximateLocationFromIP() {
    if (cachedLocation) {
        console.log("Using cached IP-based location:", cachedLocation);
        return cachedLocation;
    }
    try {
        const res = await fetch("https://ipapi.co/json/");
        const data = await res.json();
        const lat = parseFloat(data.latitude.toFixed(2));
        const lon = parseFloat(data.longitude.toFixed(2));
        console.log("IP-based approximate location:", lat, lon);
        cachedLocation = { lat, lon };
        return cachedLocation;
    } catch (e) {
        console.warn("IP geolocation failed", e);
        return null;
    }
}

