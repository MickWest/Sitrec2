import {toPoint as mgrsToPoint} from "mgrs";

export function parseCoordinate(input) {
    if (typeof input !== "string" || !input.trim()) return null;
    const trimmed = input.trim();

    const mgrs = parseMGRS(trimmed);
    if (mgrs) return mgrs;

    const pair = parseLatLonPair(trimmed);
    if (pair) return pair;

    const single = parseSingleCoordinate(trimmed);
    if (single !== null) return {value: single};

    return null;
}

export function parseMGRS(input) {
    const normalized = input.replace(/\s+/g, "").toUpperCase();
    const mgrsPattern = /^\d{1,2}[A-Z]{3}(\d{2}|\d{4}|\d{6}|\d{8}|\d{10})$/;
    if (!mgrsPattern.test(normalized)) return null;
    try {
        const [lon, lat] = mgrsToPoint(normalized);
        return {lat, lon};
    } catch {
        return null;
    }
}

export function parseSingleCoordinate(input) {
    const trimmed = input.trim();
    const {value, direction} = extractDirection(trimmed);
    const degrees = parseDMSorDM(value);
    if (degrees === null) return null;
    const sign = getDirectionSign(direction, degrees);
    return sign * Math.abs(degrees);
}

function extractDirection(input) {
    const upper = input.toUpperCase();
    const leadingMatch = upper.match(/^([NSEW])\s*/);
    if (leadingMatch) {
        return {
            value: input.slice(leadingMatch[0].length).trim(),
            direction: leadingMatch[1]
        };
    }
    const trailingMatch = upper.match(/\s*([NSEW])$/);
    if (trailingMatch) {
        return {
            value: input.slice(0, -trailingMatch[0].length).trim(),
            direction: trailingMatch[1]
        };
    }
    return {value: input, direction: null};
}

function getDirectionSign(direction, originalValue) {
    if (direction === "S" || direction === "W") return -1;
    if (direction === "N" || direction === "E") return 1;
    return originalValue < 0 ? -1 : 1;
}

function parseDMSorDM(input) {
    let str = input.replace(/[°˚º]/g, " ")
        .replace(/[′']/g, " ")
        .replace(/[″"]/g, " ")
        .replace(/,/g, " ")
        .trim();

    const parts = str.split(/\s+/).filter(p => p !== "");

    if (parts.length === 0) return null;

    if (parts.length === 1) {
        const val = parseFloat(parts[0]);
        return isNaN(val) ? null : val;
    }

    if (parts.length === 2) {
        const deg = parseFloat(parts[0]);
        const min = parseFloat(parts[1]);
        if (isNaN(deg) || isNaN(min)) return null;
        const sign = deg < 0 ? -1 : 1;
        return sign * (Math.abs(deg) + min / 60);
    }

    if (parts.length >= 3) {
        const deg = parseFloat(parts[0]);
        const min = parseFloat(parts[1]);
        const sec = parseFloat(parts[2]);
        if (isNaN(deg) || isNaN(min) || isNaN(sec)) return null;
        const sign = deg < 0 ? -1 : 1;
        return sign * (Math.abs(deg) + min / 60 + sec / 3600);
    }

    return null;
}

export function parseLatLonPair(input) {
    const mgrs = parseMGRS(input);
    if (mgrs) return mgrs;

    const trimmed = input.trim();
    const parts = splitLatLon(trimmed);
    if (!parts) return null;

    const lat = parseSingleCoordinate(parts.lat);
    const lon = parseSingleCoordinate(parts.lon);

    if (lat === null || lon === null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;

    return {lat, lon};
}

function splitLatLon(input) {
    const upper = input.toUpperCase();

    const nsMatch = upper.match(/([NS])/g);
    const ewMatch = upper.match(/([EW])/g);
    if (nsMatch && ewMatch && nsMatch.length === 1 && ewMatch.length === 1) {
        const nsIdx = upper.search(/[NS]/);
        const ewIdx = upper.search(/[EW]/);
        const nsIsTrailing = nsIdx > 0 && (upper[nsIdx - 1].match(/[\d\s°′″'".]/) || nsIdx === upper.length - 1);
        const ewIsTrailing = ewIdx > 0 && (upper[ewIdx - 1].match(/[\d\s°′″'".]/) || ewIdx === upper.length - 1);

        if (nsIsTrailing && ewIsTrailing) {
            const firstDir = nsIdx < ewIdx ? "NS" : "EW";
            const splitIdx = firstDir === "NS" ? nsIdx + 1 : ewIdx + 1;
            const part1 = input.slice(0, splitIdx).trim();
            const part2 = input.slice(splitIdx).trim().replace(/^[,\s]+/, "");
            const lat = firstDir === "NS" ? part1 : part2;
            const lon = firstDir === "NS" ? part2 : part1;
            return {lat, lon};
        }

        const nsIsLeading = nsIdx === 0 || (nsIdx > 0 && upper[nsIdx - 1].match(/[\s,;]/));
        const ewIsLeading = ewIdx === 0 || (ewIdx > 0 && upper[ewIdx - 1].match(/[\s,;]/));
        if (nsIsLeading && ewIsLeading) {
            const firstDir = nsIdx < ewIdx ? "NS" : "EW";
            const secondIdx = firstDir === "NS" ? ewIdx : nsIdx;
            const part1 = input.slice(0, secondIdx).trim();
            const part2 = input.slice(secondIdx).trim().replace(/^[,\s]+/, "");
            const lat = firstDir === "NS" ? part1 : part2;
            const lon = firstDir === "NS" ? part2 : part1;
            return {lat, lon};
        }
    }

    const commaIdx = findSplitPoint(input, ",");
    if (commaIdx !== -1) {
        return {
            lat: input.slice(0, commaIdx).trim(),
            lon: input.slice(commaIdx + 1).trim()
        };
    }

    const semicolonIdx = findSplitPoint(input, ";");
    if (semicolonIdx !== -1) {
        return {
            lat: input.slice(0, semicolonIdx).trim(),
            lon: input.slice(semicolonIdx + 1).trim()
        };
    }

    // Bare whitespace is intentionally NOT treated as a pair separator:
    // "32 55" is ambiguous with degrees-minutes notation (32°55'), and
    // greedy pair-matching breaks live typing in the LLA Lat input.
    // Pairs must use comma, semicolon, or N/S/E/W direction markers.
    return null;
}

function findSplitPoint(input, delimiter) {
    return input.indexOf(delimiter);
}
