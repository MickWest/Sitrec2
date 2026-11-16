import {gpHistoryWindowDays} from "./TLEUtils";

const day = date => date.toISOString().slice(0, 10);

// Loading and display filtering are independent. One coordinator owns the request
// for both editors; changing a filter never downloads another catalog.
export function satelliteCatalogRequest(date, now = new Date()) {
    const viewingDate = day(date);
    if (viewingDate >= day(now)) return {date: day(now), type: "CURRENT", viewingDate, key: `CURRENT:${day(now)}`};
    const days = gpHistoryWindowDays(date);
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() - days / 2);
    return {date: day(start), type: "ALL", days, viewingDate, key: `ALL:${viewingDate}:${days}`};
}

// Template names are session provenance, not the name of a user's saved scene.
export function satelliteAutoloadDefault(sitch) {
    const template = sitch.templateSource?.name?.trim().toLowerCase();
    if (template) return ["starlink", "star tracker"].includes(template);
    return !sitch.mods && (sitch.name === "starlink" || sitch.name === "custom");
}

export class SatelliteCatalogLoader {
    constructor({automatic = false, fetchCatalog, installCatalog, now = () => Date.now(), focusDelay = 15000}) {
        Object.assign(this, {automatic, fetchCatalog, installCatalog, now, focusDelay});
        this.state = {phase: "idle"};
        this.cache = new Map();
        this.generation = 0;
    }

    setAutomatic(enabled) {
        if (this.automatic === !!enabled) return;
        this.automatic = !!enabled;
        this.cancel();
        if (enabled) this.attempted = null;
    }

    observe(date, {timeFocused = false, busy = false, visible = true} = {}) {
        if (this.disposed || !Number.isFinite(date?.getTime())) return;
        const request = satelliteCatalogRequest(date, new Date(this.now()));
        // Track the calendar date, not ticking playback seconds or focus events.
        if (request.viewingDate !== this.observedDate) {
            this.observedDate = request.viewingDate;
            this.changedAt = this.now();
        }
        if (request.key !== this.target?.key) {
            this.cancel();
            this.target = request;
            this.attempted = null;
        }
        if (this.loadedKey === request.key && !this.controller && this.loadedState) this.state = this.loadedState;
        if (!this.automatic || busy || !visible) return;
        if (timeFocused && this.now() - this.changedAt < this.focusDelay) return;
        if (this.attempted !== request.key && this.loadedKey !== request.key) this.load(request);
    }

    refresh(date) {
        return this.load(satelliteCatalogRequest(date, new Date(this.now())), true);
    }

    restoreLoadedRequest(request) {
        // The saved catalog was loaded before node mods. Remember its request so
        // restoring Autoload does not immediately download the same set again.
        if (!request || !["ALL", "CURRENT"].includes(request.type) || !request.key) return;
        this.loadedKey = request.key;
        this.loadedState = this.state = {phase: "loaded", request};
    }

    load(request, refresh = false) {
        if (this.disposed) return Promise.resolve();
        if (this.controller && this.target?.key === request.key) return this.pending;
        this.cancel();
        this.target = request;
        this.attempted = request.key;
        if (!refresh && this.loadedKey === request.key) return Promise.resolve();
        this.pending = this.loadCatalog(request, refresh);
        return this.pending;
    }

    async loadCatalog(request, refresh) {
        const generation = this.generation;
        const controller = this.controller = new AbortController();
        const current = () => !this.disposed && generation === this.generation;
        this.state = {phase: "loading", request, started: this.now(), bytes: 0};
        try {
            const cached = this.cache.get(request.key);
            const buffer = !refresh && cached ? cached : await this.fetchCatalog(request, controller.signal, bytes => {
                if (current()) this.state.bytes = bytes;
            });
            if (!current()) return;
            await this.installCatalog(buffer, request, current);
            if (!current()) return;
            this.loadedKey = request.key;
            this.cache.delete(request.key);
            this.cache.set(request.key, buffer);
            // History files are large. Keep two dates here; the server retains the rest.
            while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
            this.state = this.loadedState = {phase: "loaded", request, elapsed: this.now() - this.state.started, bytes: buffer.byteLength};
        } catch (error) {
            if (current()) this.state = {phase: "error", request, error: error.message};
        } finally {
            if (current()) this.controller = null;
        }
    }

    cancel() {
        this.generation++;
        this.controller?.abort();
        this.controller = null;
        if (this.state.phase === "loading") this.state = {...this.state, phase: "cancelled"};
    }

    protectCatalog() {
        this.setAutomatic(false);
        this.cancel();
        this.loadedKey = null;
        this.loadedState = null;
        this.state = {phase: "idle"};
        this.cache.clear();
    }

    dispose() { this.cancel(); this.disposed = true; this.cache.clear(); }
}
