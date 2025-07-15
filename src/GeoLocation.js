// Helper to set a cookie
function setCookie(name, value, days) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; domain=metabunk.org; SameSite=Lax`;
}

// Helper to get a cookie
function getCookie(name) {
    return document.cookie.split('; ').reduce((r, v) => {
        const parts = v.split('=');
        return parts[0] === name ? decodeURIComponent(parts[1]) : r
    }, null);
}

// cache the value once, as we only need the location
let cachedLocation = null;

export async function getApproximateLocationFromIP() {
    if (cachedLocation) {
        console.log("Using cached IP-based location:", cachedLocation);
        return cachedLocation;
    }

    const cookieValue = getCookie("sitrecLocation");
    if (cookieValue) {
        try {
            const parsed = JSON.parse(cookieValue);
            console.log("Using cookie cached IP-based location:", parsed);
            cachedLocation = parsed;
            return cachedLocation;
        } catch (e) {
            console.warn("Failed to parse location cookie", e);
        }
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch("https://ipapi.co/json/", { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await res.json();
        const lat = parseFloat(data.latitude.toFixed(2));
        const lon = parseFloat(data.longitude.toFixed(2));
        cachedLocation = { lat, lon };
        setCookie("sitrecLocation", JSON.stringify(cachedLocation), 7);
        console.log("IP-based approximate location:", lat, lon);
        return cachedLocation;
    } catch (e) {
        console.warn("IP geolocation failed", e);
        return null;
    }
}
