import {Body, Observer, SearchAltitude, SearchRiseSet} from "astronomy-engine";

// Rise/set includes the apparent disk and standard atmospheric refraction.
// Dawn/dusk use civil twilight: the Sun's center crossing -6 degrees.
// These are horizon events, without local terrain or building obstruction.
export function resolveCelestialTime(name, location, start, end) {
    if (!Number.isFinite(location?.lat) || Math.abs(location.lat) > 90
        || !Number.isFinite(location?.lon) || !start || !end || !(end > start)) return null;
    const observer = new Observer(location.lat, location.lon, 0);
    const days = (end - start) / 86400000;
    const riseSet = (body, direction) => SearchRiseSet(body, observer, direction, start, days)?.date ?? null;
    const twilight = direction => SearchAltitude(Body.Sun, observer, direction, start, days, -6)?.date ?? null;
    let event;
    let shift = 0;
    switch (name) {
        case 'sunrise': event = riseSet(Body.Sun, 1); break;
        case 'sunset': event = riseSet(Body.Sun, -1); break;
        case 'moonrise': event = riseSet(Body.Moon, 1); break;
        case 'moonset': event = riseSet(Body.Moon, -1); break;
        case 'dawn': event = twilight(1); break;
        case 'dusk': event = twilight(-1); break;
        case 'morning': event = riseSet(Body.Sun, 1); shift = 3600000; break;
        case 'evening': event = riseSet(Body.Sun, -1); shift = -3600000; break;
        case 'night': event = twilight(-1); shift = 3600000; break;
        default: return null;
    }
    // Some dates have no Moon crossing; polar day/night can lack Sun events.
    // Never silently choose an event from a different calendar day.
    if (!event || event < start || event >= end) return null;
    return new Date(event.getTime() + shift);
}
