import {showErrorOnce} from "./showError";
import {identifyServiceFromUrl} from "./TileUsageTracker";
import {tileFetchOptions} from "./tileFetchOptions";

// How often a watch started by watchRecovery() asks the service again.
const RECOVERY_INTERVAL_MS = 60000;
// A probe that has no answer after this long counts as no answer.
const PROBE_TIMEOUT_MS = 20000;

class ServiceAvailabilityClass {
    constructor() {
        this.services = {};
        // Only 5xx server errors and network failures count as failures
        // (404s are expected for missing tiles and are not counted).
        //
        // A service is marked unavailable when MOST of its recent requests
        // failed: at least failureThreshold of the last windowSize, and at
        // least failureRatio of them. Not "N failures in a row": when some
        // tiles of a service fail and the rest load, the failing requests hang
        // (CloudFront gives up after ~15 s) and hold the request slots, so they
        // finish together, after the fast successes, and their retries then
        // fail at once on the CDN's cached error. That is a run of failures
        // from a service that works. The minimum of 10 keeps the ratio from
        // deciding on the first few requests alone.
        this.failureThreshold = 10;
        this.windowSize = 20;
        this.failureRatio = 0.8;
        this.callbacks = {}; // serviceName → [callback, ...]
    }

    _getService(name) {
        if (!this.services[name]) {
            // outcomes: true/false for the last windowSize requests, oldest first
            this.services[name] = {outcomes: [], available: true, notified: false, lastFailedUrl: null};
        }
        return this.services[name];
    }

    _recordOutcome(svc, ok) {
        svc.outcomes.push(ok);
        if (svc.outcomes.length > this.windowSize) {
            svc.outcomes.shift();
        }
    }

    _failureCount(svc) {
        return svc.outcomes.filter(ok => !ok).length;
    }

    isAvailable(serviceName) {
        const svc = this.services[serviceName];
        return !svc || svc.available;
    }

    isAvailableByUrl(url) {
        return this.isAvailable(identifyServiceFromUrl(url));
    }

    recordFailure(serviceName, url = null) {
        const svc = this._getService(serviceName);
        if (!svc.available) return; // already marked unavailable
        if (url) svc.lastFailedUrl = url;
        this._recordOutcome(svc, false);
        const failures = this._failureCount(svc);
        if (failures >= this.failureThreshold && failures >= this.failureRatio * svc.outcomes.length) {
            this.markUnavailable(serviceName);
        }
    }

    recordFailureByUrl(url) {
        this.recordFailure(identifyServiceFromUrl(url), url);
    }

    recordSuccess(serviceName) {
        const svc = this._getService(serviceName);
        if (!svc.available) {
            // Back after an outage: the failures in the window are history.
            svc.outcomes = [];
            svc.available = true;
        }
        this._recordOutcome(svc, true);
    }

    recordSuccessByUrl(url) {
        this.recordSuccess(identifyServiceFromUrl(url));
    }

    markUnavailable(serviceName) {
        const svc = this._getService(serviceName);
        svc.available = false;

        if (!svc.notified) {
            svc.notified = true;
            showErrorOnce(
                `service-unavailable-${serviceName}`,
                `Service "${serviceName}" appears to be unavailable (${this._failureCount(svc)} of its last ${svc.outcomes.length} requests failed). ` +
                `Switching to offline fallback. A map switches back by itself when the service answers again. ` +
                `An elevation source must be selected again in the Terrain menu.`
            );
        }

        // Invoke registered fallback callbacks, with the URL that failed last,
        // which a callback can give to watchRecovery().
        const cbs = this.callbacks[serviceName];
        if (cbs) {
            for (const cb of cbs) {
                try {
                    cb(serviceName, svc.lastFailedUrl);
                } catch (e) {
                    console.warn(`ServiceAvailability: fallback callback error for ${serviceName}`, e);
                }
            }
        }
    }

    onUnavailable(serviceName, callback) {
        if (!this.callbacks[serviceName]) {
            this.callbacks[serviceName] = [];
        }
        this.callbacks[serviceName].push(callback);
    }

    offUnavailable(serviceName, callback) {
        const cbs = this.callbacks[serviceName];
        if (cbs) {
            this.callbacks[serviceName] = cbs.filter(cb => cb !== callback);
        }
    }

    /**
     * Ask the server for one URL again, past the browser cache, the way a tile
     * request does (tileFetchOptions). True when it serves the tile, or answers
     * 404 (no tile there, but the server is up); the service then counts as
     * available again. False for anything else: a 5xx, a 401/403/429 (a real
     * tile request would fail the same way), a network failure, an error page
     * the browser blocks for CORS, or no answer in time.
     */
    async probe(url) {
        try {
            const response = await fetch(url, {
                cache: "no-store",
                ...tileFetchOptions(url),
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
            if (!response.ok && response.status !== 404) return false;
        } catch (e) {
            return false;
        }
        this.recordSuccessByUrl(url);
        return true;
    }

    /**
     * Probe `url` every intervalMs until the server answers, then call
     * onAnswer() once. Independent of reset(): the caller owns the watch.
     *
     * @returns {function()} stops the watch
     */
    watchRecovery(url, onAnswer, intervalMs = RECOVERY_INTERVAL_MS) {
        let stopped = false;
        let timer = null;
        const check = async () => {
            const answered = await this.probe(url);
            if (stopped) return;
            if (answered) {
                onAnswer();
            } else {
                timer = setTimeout(check, intervalMs);
            }
        };
        timer = setTimeout(check, intervalMs);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }

    reset(serviceName) {
        if (serviceName) {
            delete this.services[serviceName];
        } else {
            this.services = {};
        }
    }
}

export const ServiceAvailability = new ServiceAvailabilityClass();
