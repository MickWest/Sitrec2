// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original is the marker layer that polls one live feed and draws its positions. It is
// loaded on demand from src/CustomManagerSetup.js, once per feed in LiveFeedRegistry; with
// that table stubbed to empty, nothing constructs this class. It is kept as a plain class
// (not a node) with the original's public method names so that, if constructed anyway, it
// polls nothing and reports itself unavailable.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:CNodeLiveFeedLayer";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export class CNodeLiveFeedLayer {
    constructor(v) {
        const o = v || {};
        this.id = o.id;
        this.feed = o.feed || null;
        this.polling = false;
        this.markers = [];
    }

    get group() {
        return null;
    }

    start() {
    }

    stop() {
    }

    setHoverTarget() {
    }

    update() {
    }

    labelCandidates() {
        return [];
    }

    findMarkerAtScreen() {
        return null;
    }

    setSelected() {
    }

    status() {
        return "not available in this build";
    }

    dispose() {
    }
}
