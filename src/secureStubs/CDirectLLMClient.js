// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original is the browser-side client for the user's own model-provider keys: it builds
// the tool set and system prompt and calls the providers directly. Here no provider token is
// ever recognized (isBYOKProvider is false for everything), the model lists are empty, and
// the call functions reject. Every caller checks isBYOKProvider() first, so the call
// functions are unreachable in practice; they reject rather than resolve so that a future
// caller cannot mistake an empty reply for a real one.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:CDirectLLMClient";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

const NOT_AVAILABLE = "The browser-side assistant is not available in this build";

// Same token values as the original, so any equality test elsewhere behaves the same.
export const BYOK_ANTHROPIC_PROVIDER = 'byok-anthropic';
export const BYOK_OPENROUTER_PROVIDER = 'byok-openrouter';
export const BYOK_OPENAI_PROVIDER = 'byok-openai';
export const BYOK_CUSTOM_PROVIDER = 'byok-custom';
export const BYOK_PROVIDER = BYOK_ANTHROPIC_PROVIDER;

export function keyProviderForBYOK() {
    return null;
}

export function isBYOKProvider() {
    return false;
}

export const BYOK_MODELS = [];

export function resolveEndpoint() {
    return null;
}

export function isUsableEndpointURL() {
    return false;
}

export function getBYOKModels() {
    return [];
}

export function getVoiceModels() {
    return [];
}

export const SPECIALIST_TOOL_NAMES = new Set();

export function buildToolSet() {
    return {tools: [], specialistTools: {}};
}

export function buildTools() {
    return [];
}

export function convertToolsForAnthropic() {
    return [];
}

export function buildSystemPromptParts() {
    return {staticPart: "", menuPart: "", volatilePart: ""};
}

export function buildSystemPrompt() {
    return "";
}

export async function callAnthropic() {
    throw new Error(NOT_AVAILABLE);
}

export async function callOpenAIFormat() {
    throw new Error(NOT_AVAILABLE);
}

export async function callOpenRouter() {
    throw new Error(NOT_AVAILABLE);
}

export async function chat() {
    throw new Error(NOT_AVAILABLE);
}
