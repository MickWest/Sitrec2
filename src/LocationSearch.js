// Keep the default geocoder's result checks in one place for Go To, chat, and
// coordinate fields. Search rank describes scale; importance is prominence,
// not confidence that the result matches the user's words.
const NAME_KEY = /^(?:name|official_name|alt_name|short_name|loc_name|int_name|old_name)(?::[a-z]{2,3}(?:[-_][a-z0-9]+)*)?$/i;
const FACILITY_CATEGORIES = new Set([
    "amenity", "shop", "office", "craft", "healthcare", "railway", "aeroway", "building", "highway",
]);
const LODGING_TYPES = new Set(["hotel", "motel", "hostel", "guest_house", "apartment", "chalet", "camp_site", "caravan_site"]);
const ABBREVIATIONS = {
    st: "street", rd: "road", ave: "avenue", blvd: "boulevard", dr: "drive",
    ln: "lane", hwy: "highway", mt: "mount", ft: "fort", usa: "us", uk: "gb",
};

function words(text) {
    return String(text ?? "").normalize("NFD").replace(/\p{M}/gu, "")
        .toLowerCase().match(/[\p{L}\p{N}]+/gu)?.map(word => ABBREVIATIONS[word] ?? word) ?? [];
}

function actualNames(item) {
    const names = [item.name];
    for (const [key, value] of Object.entries(item.namedetails ?? {})) {
        // Language-qualified names are valid. Attributes such as
        // alt_name:signed=yes and name:etymology are not names.
        if (NAME_KEY.test(key) && typeof value === "string") names.push(value);
    }
    return names.filter(name => typeof name === "string" && name.trim());
}

function matchesName(queryWords, item) {
    const names = actualNames(item);
    if (queryWords.length === 1) {
        // Do not match an incidental address component, tag value, or airport
        // code when the user supplied a bare word such as "yes".
        return names.some(name => words(name).includes(queryWords[0]));
    }

    // Qualified names and street addresses may include a city, region,
    // country, postcode, or house number in addition to the feature's name.
    // The formatted address can contain a region omitted from the structured
    // fields (for example Greater London around the City of Westminster).
    const addressWords = [...Object.values(item.address ?? {}), item.display_name].flatMap(words);
    return [...names, ""].some(name => {
        const available = new Set([...words(name), ...addressWords]);
        return queryWords.every(word => available.has(word));
    });
}

/** Pick a name match with enough context to navigate, preserving server order. */
export function selectNominatimLocation(query, results) {
    const queryWords = words(query);
    if (!queryWords.length || !Array.isArray(results)) return null;
    for (const item of results) {
        if (!item || !matchesName(queryWords, item)) continue;
        const lat = Number(item.lat), lon = Number(item.lon);
        if (item.lat == null || item.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)
            || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        if (queryWords.length === 1) {
            const rank = Number(item.place_rank);
            const category = item.category ?? item.class;
            // Importance measures prominence, not the user's intent. A hospital
            // acronym such as HUG may score highly without making "hug" a safe
            // destination. Facilities need a fuller name or location qualifier.
            if (FACILITY_CATEGORIES.has(category)
                || (category === "tourism" && LODGING_TYPES.has(item.type))
                || (category === "landuse" && ["industrial", "commercial", "retail"].includes(item.type))) continue;
            const townOrLarger = (category === "place" || (category === "boundary" && item.type === "administrative"))
                && rank > 0 && rank <= 18;
            // A bare word must identify a town/region or a prominent feature.
            // Small villages, shops, and streams remain searchable by adding
            // their region or using a more specific name.
            if (!townOrLarger && !(Number(item.importance) >= 0.3)) continue;
        }
        return [lat, lon];
    }
    return null;
}

/** Default configured resolver. Custom providers can still supply their own. */
export async function lookupNominatimLocation(query) {
    if (typeof query !== "string" || !query.trim()) return null;
    try {
        const params = new URLSearchParams({
            format: "jsonv2", limit: "5", namedetails: "1", addressdetails: "1", q: query.trim(),
        });
        const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
        if (!response.ok) return null;
        return selectNominatimLocation(query, await response.json());
    } catch (error) {
        console.error("Error fetching location: ", error);
        return null;
    }
}
