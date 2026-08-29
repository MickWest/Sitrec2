/*
    * Parses a string input representing a geographic object with optional name, latitude, longitude, and altitude.
    * The input format can be:
    * - "Name lat lon alt"
    * - "lat lon alt"
    * - "Name lat,lon,alt"
    * - "lat,lon,alt"
    * Altitude can be specified in meters (default) or feet (e.g., "100ft").
    *
    * @param {string} inputString - The input string to parse.
    * @returns {Object|null} An object with properties: name (string|null), lat (number), lon (number), alt (number), hasExplicitAlt (boolean), or null if parsing fails.
    */
export function parseObjectInput(inputString) {
    if (!inputString || typeof inputString !== 'string') {
        return null;
    }
    
    const input = inputString.trim();
    if (input.length === 0) {
        return null;
    }
    
    const match = input.match(/(?:^|[\s,])(-?\d+\.?\d*)/);
    if (!match) {
        return null;
    }
    
    const coordStartIndex = match.index + (match[0].startsWith(' ') || match[0].startsWith(',') ? 1 : 0);
    
    let name = null;
    if (coordStartIndex > 0) {
        const namePart = input.substring(0, coordStartIndex).trim();
        if (namePart.length > 0) {
            name = namePart;
        }
    }
    
    const coordString = input.substring(coordStartIndex);
    
    const parts = coordString.split(/[,\s]+/).filter(p => p.length > 0);
    
    if (parts.length < 2) {
        return null;
    }
    
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    
    if (isNaN(lat) || isNaN(lon)) {
        return null;
    }
    
    let alt = 0;
    let hasExplicitAlt = false;
    
    if (parts.length >= 3) {
        const altString = parts[2];
        
        const altMatch = altString.match(/^([-\d.]+)(m|ft)?$/i);
        if (altMatch) {
            const altValue = parseFloat(altMatch[1]);
            if (!isNaN(altValue)) {
                const unit = altMatch[2] ? altMatch[2].toLowerCase() : 'm';
                
                if (unit === 'ft') {
                    alt = altValue * 0.3048;
                } else {
                    alt = altValue;
                }
                
                hasExplicitAlt = true;
            }
        }
    }
    
    return {
        name: name,
        lat: lat,
        lon: lon,
        alt: alt,
        hasExplicitAlt: hasExplicitAlt
    };
}

/**
 * Pick the next free "Object N" name given every name already in use.
 *
 * Split out from CCustomManager.getNextObjectName so the numbering rule can be
 * tested without a live node graph; the manager method supplies the names.
 *
 * @param {Iterable<string>} existingNames - names already in use (node ids,
 *        menuText, anything a previously created object could be carrying).
 *        Non-string and empty entries are ignored.
 * @returns {string} "Object <highest+1>", or "Object 1" when none are in use.
 */
export function nextSequentialObjectName(existingNames) {
    let maxNumber = 0;

    for (const name of existingNames ?? []) {
        if (typeof name !== "string") continue;
        const match = name.match(/^Object (\d+)$/);
        if (match) {
            const number = parseInt(match[1], 10);
            if (number > maxNumber) {
                maxNumber = number;
            }
        }
    }

    return `Object ${maxNumber + 1}`;
}
