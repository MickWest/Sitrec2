// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original scans a range of loopback ports for a local compute helper and opens a
// WebSocket to it. Here there is never a connection: connect() and request() reject with the
// message the caller (src/CMotionAnalysisUI.js) already shows as "Fallback: ..." before it
// runs the analysis in the browser instead.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:LocalComputeBridge";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

const NOT_AVAILABLE = "Local compute is not available in this build";

let singleton = null;

export function getLocalComputeBridge() {
    if (!singleton) singleton = new LocalComputeBridge();
    return singleton;
}

export class LocalComputeBridge {
    constructor() {
        this.ws = null;
        this.hello = null;
        this.port = null;
        this.pending = new Map();
        this.nextId = 1;
        this.connectPromise = null;
        this.lastError = NOT_AVAILABLE;
    }

    get connected() {
        return false;
    }

    async connect() {
        throw new Error(NOT_AVAILABLE);
    }

    async scanPorts() {
        throw new Error(NOT_AVAILABLE);
    }

    candidatePorts() {
        return [];
    }

    normalizePort() {
        return null;
    }

    rememberedPort() {
        return null;
    }

    hintedPorts() {
        return [];
    }

    rememberPort() {
    }

    async hasPortListener() {
        return false;
    }

    tryPort() {
        return Promise.reject(new Error(NOT_AVAILABLE));
    }

    handleMessage() {
    }

    handleClose() {
    }

    close() {
    }

    async request() {
        throw new Error(NOT_AVAILABLE);
    }

    installOrUpdate() {
        return Promise.reject(new Error(NOT_AVAILABLE));
    }

    cancel() {
    }
}
