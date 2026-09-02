// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original draws screen-space labels and a hover box for the live feeds. It makes no
// request itself, but it exists only to serve the feed layers, which are stubbed. Here the
// overlay draws nothing; src/traffic/CNodeADSBLiveTraffic.js calls setHover(), update() and
// clear() on it and expects no return value.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:LiveFeedOverlay";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

let overlay = null;

export function getLiveFeedOverlay() {
    if (!overlay) overlay = new CLiveFeedOverlay();
    return overlay;
}

class CLiveFeedOverlay {
    constructor() {
        this.root = null;
        this.labelPool = [];
        this.hoverBox = null;
        this.hover = null;
        this.lastLayoutMs = 0;
        this.showLabels = true;
    }

    setHover() {
    }

    update() {
    }

    clear() {
    }
}
