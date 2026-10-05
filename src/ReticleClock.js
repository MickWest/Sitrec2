// Date and time in the "MM/DD/YY HH:MM:SS" form of a camera's on-screen clock.
// Values are epoch milliseconds whose UTC fields hold the displayed wall-clock time.

function pad2(n) {
    return String(n).padStart(2, "0");
}

// Returns null for anything that is not a complete, valid date and time. Two-digit
// years 70-99 are 19xx, so the common unset-clock reading "12/31/99" works.
export function parseReticleClock(text) {
    const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*$/.exec(text ?? "");
    if (!m) return null;
    let year = Number(m[3]);
    if (m[3].length === 2) year += year >= 70 ? 1900 : 2000;
    const [month, day, hours, minutes, seconds] = [m[1], m[2], m[4], m[5], m[6]].map(Number);
    const ms = Date.UTC(year, month - 1, day, hours, minutes, seconds);
    // Date.UTC rolls 02/30 over to 03/02; reject it instead of showing a different date.
    const d = new Date(ms);
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day
        || d.getUTCHours() !== hours || d.getUTCMinutes() !== minutes || d.getUTCSeconds() !== seconds) return null;
    return ms;
}

export function formatReticleClock(ms) {
    const d = new Date(ms);
    return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${pad2(d.getUTCFullYear() % 100)} `
        + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
