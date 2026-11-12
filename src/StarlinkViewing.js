// Shared input/formatting rules for the Starlink viewing panel. Display time is
// explicitly UTC or the Time menu's selected zone, never the browser's implicit zone.
export function viewingDateInput(date, offsetHours = 0) {
    return new Date(date.getTime() + offsetHours * 3600000).toISOString().slice(0, 19);
}

export function parseViewingDate(value, offsetHours = 0) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(value)) return null;
    const normalized = value.length === 16 ? value + ":00" : value;
    const wall = new Date(normalized + "Z");
    // Reject impossible dates rather than allowing Date to roll into another month.
    if (!Number.isFinite(wall.getTime()) || wall.toISOString().slice(0, 19) !== normalized) return null;
    return new Date(wall.getTime() - offsetHours * 3600000);
}

export function compassHeading(az) {
    const heading = ((az % 360) + 360) % 360;
    const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return `${heading.toFixed(1)}° ${names[Math.round(heading / 45) % 8]}`;
}

export function satelliteMatchesSearch(satellite, query) {
    const terms = query.trim().toUpperCase().split(",").map(s => s.trim()).filter(Boolean);
    if (!terms.length) return true;
    const name = satellite.name.toUpperCase().replace(/^0\s+/, "");
    return terms.some(term => /^\d+$/.test(term)
        ? satellite.number === Number(term)
        : name.includes(term.replace(/^SL-/, "STARLINK-")));
}
