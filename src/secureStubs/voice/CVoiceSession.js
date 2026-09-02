// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original opens the microphone and a WebRTC session to a speech model provider. Here
// start() rejects before anything is opened, with a message src/nodes/CNodeVIewChat.js shows
// in the assistant log as-is; the session is never active, so the typed-input hand-off
// (sendUserText) always declines.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:CVoiceSession";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

// Same values as the original.
export const VOICE_MODEL = 'gpt-realtime-2';
export const VOICE_NAME = 'alloy';

export function toRealtimeTools() {
    return [];
}

export function usageFromResponse() {
    return null;
}

export class CVoiceSession {
    constructor(options) {
        this.options = options || {};
        this.model = this.options.model || VOICE_MODEL;
        this.pc = null;
        this.dc = null;
        this.micStream = null;
        this.audioEl = null;
        this.active = false;
        this.muted = false;
        this.usedEphemeralKey = null;
        this.activeTools = [];
        this.specialistTools = {};
    }

    async start() {
        throw new Error("The spoken assistant is not available in this build");
    }

    refreshTools() {
    }

    sendUserText() {
        return false;
    }

    setMuted() {
    }

    stop() {
    }
}
