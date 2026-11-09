import {CTLEData, satRecToDate} from "./TLEUtils";
import {generateConstellationTLE} from "../tools/shf/syntheticOrbits.js";
import {STARLINK_SHELLS} from "../tools/shf/starlinkShells.js";
import {gmstRad} from "../tools/shf/astro.js";
import {starlinkPopulation} from "./StarlinkPopulation";

export const SIMULATED_SATELLITE_COLOR = "#87cefa";
export const SATELLITE_ORBIT_WINDOW_MS = 7 * 86400000; // SHF's real-orbit window
export const SIMULATED_SATELLITE_DESCRIPTION = "Approximate Starlink constellation from SHF, with population scaled to the viewing date. Positions and historical shell proportions are simulated. Light blue identifies simulated satellites. Future dates use the latest measured population.";

/** Select a display catalog without replacing, exporting, or filtering the loaded source. */
export class SatelliteSimulation {
    invalidateCatalog() {
        this.catalog = undefined;
    }

    hasUsableOrbits(data, date) {
        if (!data?.satData?.length) return false;
        if (this.catalog !== data) {
            this.catalog = data;
            const ranges = [];
            for (const sat of data.satData) {
                for (const rec of sat.satrecs) {
                    if (rec.error) continue;
                    const epoch = satRecToDate(rec).getTime();
                    const start = Math.max(epoch - SATELLITE_ORBIT_WINDOW_MS, sat.launchDate ?? -Infinity);
                    const end = epoch + SATELLITE_ORBIT_WINDOW_MS;
                    if (Number.isFinite(epoch) && start <= end) ranges.push([start, end]);
                }
            }
            ranges.sort((a, b) => a[0] - b[0]);
            this.ranges = [];
            for (const range of ranges) {
                const last = this.ranges[this.ranges.length - 1];
                if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
                else this.ranges.push(range);
            }
        }
        // Separate epoch clusters leave real gaps: min/max alone would hide those gaps.
        const ms = date.getTime();
        let lo = 0, hi = this.ranges.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.ranges[mid][1] < ms) lo = mid + 1;
            else hi = mid;
        }
        return lo < this.ranges.length && this.ranges[lo][0] <= ms;
    }

    select(data, date, enabled) {
        if (!enabled || !Number.isFinite(date.getTime()) || this.hasUsableOrbits(data, date)) return data;
        // Generate once per UTC day, not on every frame or time adjustment. SGP4 moves
        // this fixed population throughout the day. A small cache also covers scrubbing
        // back and forth across midnight without repeated parsing and allocation.
        const day = Math.floor(date.getTime() / 86400000);
        this.cache ??= new Map();
        if (!this.cache.has(day)) {
            const epoch = new Date(day * 86400000);
            const total = starlinkPopulation(epoch);
            const generated = new CTLEData(generateConstellationTLE(epoch, STARLINK_SHELLS, gmstRad, {total}));
            generated.simulated = true;
            generated.satData.forEach(sat => {
                sat.simulated = true;
                sat.name = sat.name.replace("SYNTH-STARLINK", "SIMULATED STARLINK");
                // Generator IDs only identify synthetic points, never real catalog entries.
                delete sat.launchDate;
            });
            this.cache.set(day, generated);
            if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
        }
        return this.cache.get(day);
    }
}
