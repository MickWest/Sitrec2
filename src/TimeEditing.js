import {resolveDateTimeString} from "./DateTimeParser";

// Wall-clock editing uses Sitrec's selected fixed offset, never the host browser's zone.
export const timePartMS = {day: 86400000, hour: 3600000, minute: 60000, second: 1000, millisecond: 1};

export function wallTimeISO(date, offsetHours = 0) {
    return new Date(date.getTime() + offsetHours * 3600000).toISOString().slice(0, 23);
}

// Digit and calendar edits construct a complete ISO value. Keep that format
// requirement here, then use the same validation and zone handling as Go To.
export function parseTimeEntry(value, offsetHours = 0) {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)?$/i.test(value.trim())) return null;
    return resolveDateTimeString(value, {offsetHours});
}

export function replaceTimePart(date, part, value, offsetHours = 0) {
    const wall = wallTimeISO(date, offsetHours);
    if (part === "date") return /^\d{4}-\d\d-\d\d$/.test(value)
        ? parseTimeEntry(value + wall.slice(10), offsetHours) : null;
    const ranges = {year: [0, 4, 9999], month: [5, 7, 12], day: [8, 10, 31], hour: [11, 13, 23], minute: [14, 16, 59], second: [17, 19, 59], millisecond: [20, 23, 999]};
    const range = ranges[part];
    if (!range || !/^\d+$/.test(value) || Number(value) > range[2]) return null;
    return parseTimeEntry(wall.slice(0, range[0]) + value.padStart(range[1] - range[0], "0") + wall.slice(range[1]), offsetHours);
}

export function shiftTimePart(date, part, amount, offsetHours = 0) {
    if (part === "year" || part === "month") {
        const wall = new Date(date.getTime() + offsetHours * 3600000);
        const day = wall.getUTCDate();
        wall.setUTCDate(1);
        if (part === "year") wall.setUTCFullYear(wall.getUTCFullYear() + amount);
        else wall.setUTCMonth(wall.getUTCMonth() + amount);
        // Keep the local time and clamp the day when the destination month is shorter.
        const end = new Date(wall);
        end.setUTCMonth(end.getUTCMonth() + 1, 0);
        wall.setUTCDate(Math.min(day, end.getUTCDate()));
        return new Date(wall.getTime() - offsetHours * 3600000);
    }
    return new Date(date.getTime() + timePartMS[part] * amount);
}
