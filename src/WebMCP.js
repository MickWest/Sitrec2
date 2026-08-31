// Curated WebMCP site tools for the top-level Sitrec page.
//
// This is deliberately a thin adapter over CSitrecAPI. It owns schemas, strict
// model-input validation, compact results, and WebMCP lifecycle/cancellation; all
// application behavior and security decisions remain in CSitrecAPI.

import {sitrecAPI} from "./CSitrecAPI";
import {Globals, Sit} from "./Globals";
import {par} from "./par";
import {
    getIsTransitioning,
    hasPendingTiles,
    hasPendingVideoFrames,
} from "./indexRender";
import {asyncOperationRegistry} from "./AsyncOperationRegistry";
import {sanitizeLabelForPrompt} from "./PromptSafety";

export const SITREC_WEBMCP_SOURCE = "webmcp";

export const SITREC_WEBMCP_TOOL_NAMES = Object.freeze([
    "sitrec_get_state",
    "sitrec_list_sitches",
    "sitrec_load_sitch",
    "sitrec_seek_frame",
    "sitrec_set_playback",
    "sitrec_get_camera",
    "sitrec_goto_lla",
    "sitrec_list_tracks",
    "sitrec_get_track_position",
    "sitrec_list_views",
]);

const REGISTRATION_KEY = "__sitrecWebMCPRegistration";
const MAX_IDENTIFIER_LENGTH = 200;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

function abortError() {
    if (typeof DOMException === "function") {
        return new DOMException("Tool execution was cancelled", "AbortError");
    }
    const error = new Error("Tool execution was cancelled");
    error.name = "AbortError";
    return error;
}

function isAbortError(error) {
    return error?.name === "AbortError";
}

function assertNotAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function compactFailure(code, message, extra = undefined) {
    return {
        success: false,
        code,
        message,
        ...(extra === undefined ? {} : extra),
    };
}

function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validateObject(input, {allowed = [], required = []} = {}) {
    if (!isPlainObject(input)) {
        return compactFailure("INVALID_ARGUMENT", "Tool input must be an object.");
    }

    const allowedSet = new Set(allowed);
    const unexpected = Object.keys(input).filter((key) => !allowedSet.has(key));
    if (unexpected.length) {
        return compactFailure(
            "INVALID_ARGUMENT",
            `Unexpected argument${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}.`,
        );
    }

    const missing = required.filter((key) => input[key] === undefined);
    if (missing.length) {
        return compactFailure(
            "INVALID_ARGUMENT",
            `Missing required argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
        );
    }
    return null;
}

function validateString(value, name, {minLength = 0, maxLength = MAX_IDENTIFIER_LENGTH} = {}) {
    if (typeof value !== "string") {
        return compactFailure("INVALID_ARGUMENT", `${name} must be a string.`);
    }
    if (value.length < minLength || value.length > maxLength) {
        return compactFailure(
            "INVALID_ARGUMENT",
            `${name} must contain between ${minLength} and ${maxLength} characters.`,
        );
    }
    return null;
}

function validateFiniteNumber(value, name, minimum, maximum) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return compactFailure("INVALID_ARGUMENT", `${name} must be a finite number.`);
    }
    if (value < minimum || value > maximum) {
        return compactFailure(
            "INVALID_ARGUMENT",
            `${name} must be between ${minimum} and ${maximum}.`,
        );
    }
    return null;
}

function validateInteger(value, name, minimum, maximum) {
    if (!Number.isInteger(value)) {
        return compactFailure("INVALID_ARGUMENT", `${name} must be an integer.`);
    }
    if (value < minimum || value > maximum) {
        return compactFailure(
            "INVALID_ARGUMENT",
            `${name} must be between ${minimum} and ${maximum}.`,
        );
    }
    return null;
}

function validateEnum(value, name, choices) {
    if (!choices.includes(value)) {
        return compactFailure(
            "INVALID_ARGUMENT",
            `${name} must be one of: ${choices.join(", ")}.`,
        );
    }
    return null;
}

function boundedIdentifier(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH) {
        return null;
    }
    return value;
}

function displayLabel(value) {
    return sanitizeLabelForPrompt(value);
}

function safeCall(fn, fallback = null) {
    try {
        return fn();
    } catch (error) {
        return fallback;
    }
}

function waitForFrame(signal) {
    return new Promise((resolve, reject) => {
        assertNotAborted(signal);
        let done = false;
        let rafID = null;
        let timerID = null;

        const cleanup = () => {
            signal?.removeEventListener("abort", onAbort);
            if (timerID !== null) clearTimeout(timerID);
            if (rafID !== null && typeof cancelAnimationFrame === "function") {
                cancelAnimationFrame(rafID);
            }
        };
        const finish = () => {
            if (done) return;
            done = true;
            cleanup();
            resolve();
        };
        const onAbort = () => {
            if (done) return;
            done = true;
            cleanup();
            reject(abortError());
        };

        signal?.addEventListener("abort", onAbort, {once: true});
        // requestAnimationFrame can stop in a background tab. The timeout is only a
        // settling fallback; it never changes or cancels application work.
        timerID = setTimeout(finish, 100);
        if (typeof requestAnimationFrame === "function") {
            rafID = requestAnimationFrame(finish);
        }
    });
}

async function nextRenderedState(signal) {
    await waitForFrame(signal);
    await waitForFrame(signal);
}

function cancellableDelay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        assertNotAborted(signal);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        signal?.addEventListener("abort", onAbort, {once: true});
    });
}

function runtimeDependencies() {
    return {
        api: sitrecAPI,
        getGlobals: () => Globals,
        getSit: () => Sit,
        getPar: () => par,
        getIsTransitioning,
        hasPendingTiles,
        hasPendingVideoFrames,
        getAsyncOperationCount: () => asyncOperationRegistry.getCount(),
        waitForRender: nextRenderedState,
        delay: cancellableDelay,
        now: () => Date.now(),
        settleTimeoutMs: 15000,
        settlePollMs: 50,
    };
}

function mergeDependencies(overrides = {}) {
    return {...runtimeDependencies(), ...overrides};
}

function pendingSnapshot(deps, {includeOptional = true} = {}) {
    const globals = deps.getGlobals();
    const queued = globals?.newSitchObject !== undefined;
    const transitioning = Boolean(safeCall(() => deps.getIsTransitioning(), false));
    const pendingActions = Number.isFinite(globals?.pendingActions)
        ? Math.max(0, globals.pendingActions)
        : 0;
    const operationCount = safeCall(() => deps.getAsyncOperationCount(), 0);
    const asyncOperations = Number.isFinite(operationCount)
        ? Math.max(0, operationCount)
        : 0;

    return {
        transitioning,
        requestQueued: queued,
        pendingActions,
        asyncOperations,
        tiles: includeOptional
            ? safeCall(() => Boolean(deps.hasPendingTiles()), null)
            : null,
        videoFrames: includeOptional
            ? safeCall(() => Boolean(deps.hasPendingVideoFrames()), null)
            : null,
    };
}

function readyState(deps, options = undefined) {
    const sit = deps.getSit();
    const playback = deps.getPar();
    const loading = pendingSnapshot(deps, options);
    return {
        sitch: typeof sit?.name === "string" ? sit.name.slice(0, MAX_IDENTIFIER_LENGTH) : null,
        sitchName: typeof sit?.sitchName === "string"
            ? sit.sitchName.slice(0, MAX_IDENTIFIER_LENGTH)
            : null,
        frame: Number.isFinite(playback?.frame) ? playback.frame : null,
        frames: Number.isFinite(sit?.frames) ? sit.frames : null,
        fps: Number.isFinite(sit?.fps) ? sit.fps : null,
        paused: typeof playback?.paused === "boolean" ? playback.paused : null,
        loading,
    };
}

function requireReady(deps) {
    const state = readyState(deps);
    if (state.loading.transitioning || state.loading.requestQueued || !state.sitch) {
        return compactFailure(
            "SITREC_NOT_READY",
            state.loading.transitioning || state.loading.requestQueued
                ? "Sitrec is changing situations."
                : "Sitrec has not established a situation yet.",
            {state},
        );
    }
    return null;
}

function apiFailure(fn, response) {
    const result = response?.result;
    const message = response?.error
        ?? (typeof result?.error === "string" ? result.error : null)
        ?? `${fn} failed`;
    const suggestions = response?.suggestions ?? result?.suggestions;
    return compactFailure("SITREC_API_ERROR", message, {
        fn,
        ...(suggestions === undefined ? {} : {suggestions}),
        ...(response?.expected === undefined ? {} : {expected: response.expected}),
        ...(response?.errorDialogs === undefined ? {} : {errorDialogs: response.errorDialogs}),
    });
}

async function callAPI(deps, fn, args, signal) {
    assertNotAborted(signal);
    const response = await deps.api.handleAPICall(
        {fn, args: args ?? {}},
        SITREC_WEBMCP_SOURCE,
    );

    const nestedFailure = response?.result
        && typeof response.result === "object"
        && (response.result.success === false
            || (typeof response.result.error === "string" && response.result.success !== true));
    if (response?.success !== true || nestedFailure) return apiFailure(fn, response);
    return {success: true, result: response.result};
}

function wrapExecute(handler) {
    return async (input = {}, context = {}) => {
        const signal = context?.signal;
        try {
            assertNotAborted(signal);
            return await handler(input, signal);
        } catch (error) {
            if (isAbortError(error)) throw error;
            return compactFailure(
                "SITREC_API_ERROR",
                error?.message ? String(error.message) : "Unexpected Sitrec tool failure.",
            );
        }
    };
}

function normalizeSitchCatalog(result) {
    const items = [];
    for (const sitch of Array.isArray(result?.builtIn) ? result.builtIn : []) {
        const id = boundedIdentifier(sitch?.key);
        if (!id || sitch?.hidden === true) continue;
        items.push({
            id,
            name: displayLabel(sitch?.name ?? id),
            source: "built-in",
            ...(sitch?.menuName ? {menuName: displayLabel(sitch.menuName)} : {}),
        });
    }
    for (const saved of Array.isArray(result?.saved) ? result.saved : []) {
        const id = boundedIdentifier(saved);
        if (!id) continue;
        items.push({id, name: displayLabel(id), source: "saved"});
    }
    return items;
}

async function readSitchCatalog(deps, signal) {
    const response = await callAPI(deps, "listSitches", {}, signal);
    if (!response.success) return response;
    return {success: true, items: normalizeSitchCatalog(response.result)};
}

function normalizeTracks(result) {
    const tracks = [];
    for (const track of Array.isArray(result?.tracks) ? result.tracks : []) {
        const id = boundedIdentifier(track?.id);
        if (!id) continue;
        tracks.push({
            id,
            ...(track?.menuText ? {name: displayLabel(track.menuText)} : {}),
            ...(typeof track?.trackID === "string"
                ? {trackID: track.trackID.slice(0, MAX_IDENTIFIER_LENGTH)}
                : {}),
            isSynthetic: Boolean(track?.isSynthetic),
        });
    }
    return tracks;
}

async function readTracks(deps, signal) {
    const response = await callAPI(deps, "listTracks", {}, signal);
    if (!response.success) return response;
    return {success: true, tracks: normalizeTracks(response.result)};
}

function filterItems(items, query, source) {
    const normalizedQuery = query?.trim().toLowerCase();
    return items.filter((item) => {
        if (source && source !== "all" && item.source !== source) return false;
        if (!normalizedQuery) return true;
        return [item.id, item.name, item.menuName]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
}

function suggestionsFor(items, requested) {
    const needle = String(requested ?? "").toLowerCase();
    return items
        .filter((item) => {
            const id = String(item.id ?? "").toLowerCase();
            const name = String(item.name ?? "").toLowerCase();
            return id.includes(needle) || name.includes(needle)
                || needle.includes(id) || needle.includes(name);
        })
        .slice(0, 5)
        .map((item) => ({id: item.id, source: item.source}));
}

function identityOf(state) {
    return `${state.sitch ?? ""}\u0000${state.sitchName ?? ""}`;
}

async function observeSitrecSettlement(deps, {signal, initialIdentity}) {
    const startedAt = deps.now();
    let observedStart = false;

    while (true) {
        assertNotAborted(signal);
        // Terrain traversal is comparatively expensive and optional loading does not
        // decide core settlement, so sample it only for the final/timeout result.
        const state = readyState(deps, {includeOptional: false});
        const loading = state.loading;
        if (loading.transitioning || loading.requestQueued || identityOf(state) !== initialIdentity) {
            observedStart = true;
        }

        const coreStable = observedStart
            && !loading.transitioning
            && !loading.requestQueued
            && loading.pendingActions === 0;
        if (coreStable) {
            await deps.waitForRender(signal);
            const settled = readyState(deps);
            return {
                stable: true,
                timedOut: false,
                state: settled,
                stillLoading: {
                    tiles: settled.loading.tiles,
                    videoFrames: settled.loading.videoFrames,
                    asyncOperations: settled.loading.asyncOperations,
                },
            };
        }

        if (deps.now() - startedAt >= deps.settleTimeoutMs) {
            const timedOutState = readyState(deps);
            return {
                stable: false,
                timedOut: true,
                state: timedOutState,
                stillLoading: {
                    transition: loading.transitioning || loading.requestQueued,
                    pendingActions: loading.pendingActions,
                    tiles: timedOutState.loading.tiles,
                    videoFrames: timedOutState.loading.videoFrames,
                    asyncOperations: loading.asyncOperations,
                },
            };
        }
        await deps.delay(deps.settlePollMs, signal);
    }
}

function tool(definition, handler) {
    return {...definition, execute: wrapExecute(handler)};
}

export function createSitrecWebMCPTools(dependencyOverrides = {}) {
    const deps = mergeDependencies(dependencyOverrides);
    const emptySchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
    };

    return [
        tool({
            name: "sitrec_get_state",
            title: "Read Sitrec state",
            description:
                "Read a compact summary of the open Sitrec situation, frame, playback, "
                + "simulation time, camera, and loading state. Does not change Sitrec.",
            inputSchema: emptySchema,
            annotations: {readOnlyHint: true, untrustedContentHint: true},
        }, async (input, signal) => {
            const invalid = validateObject(input);
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;

            const sitch = await callAPI(deps, "getSitchState", {}, signal);
            if (!sitch.success) return sitch;
            const frame = await callAPI(deps, "getFrame", {}, signal);
            if (!frame.success) return frame;
            const simulationTime = await callAPI(deps, "getCurrentSimTime", {}, signal);
            if (!simulationTime.success) return simulationTime;
            const camera = await callAPI(deps, "getCameraLLA", {}, signal);
            if (!camera.success) return camera;

            return {
                success: true,
                state: readyState(deps),
                sitch: sitch.result,
                frame: frame.result,
                simulationTime: simulationTime.result,
                camera: camera.result,
            };
        }),

        tool({
            name: "sitrec_list_sitches",
            title: "List Sitrec situations",
            description:
                "List or search loadable built-in and saved Sitrec situations. Returns the exact "
                + "identifier and source required by sitrec_load_sitch. Does not accept URLs.",
            inputSchema: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        maxLength: MAX_IDENTIFIER_LENGTH,
                        description: "Optional case-insensitive text to match against situation names.",
                    },
                    source: {
                        type: "string",
                        enum: ["all", "built-in", "saved"],
                        description: "Optional catalog section to return; defaults to all.",
                    },
                    limit: {
                        type: "integer",
                        minimum: 1,
                        maximum: MAX_LIST_LIMIT,
                        description: `Maximum records to return; defaults to ${DEFAULT_LIST_LIMIT}.`,
                    },
                },
                additionalProperties: false,
            },
            annotations: {readOnlyHint: true, untrustedContentHint: true},
        }, async (input, signal) => {
            const invalid = validateObject(input, {allowed: ["query", "source", "limit"]})
                ?? (input.query === undefined ? null : validateString(input.query, "query"))
                ?? (input.source === undefined
                    ? null
                    : validateEnum(input.source, "source", ["all", "built-in", "saved"]))
                ?? (input.limit === undefined
                    ? null
                    : validateInteger(input.limit, "limit", 1, MAX_LIST_LIMIT));
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;

            const catalog = await readSitchCatalog(deps, signal);
            if (!catalog.success) return catalog;
            const matches = filterItems(catalog.items, input.query, input.source ?? "all");
            const limit = input.limit ?? DEFAULT_LIST_LIMIT;
            return {
                success: true,
                query: input.query ?? null,
                source: input.source ?? "all",
                totalMatches: matches.length,
                returned: Math.min(limit, matches.length),
                truncated: matches.length > limit,
                items: matches.slice(0, limit),
            };
        }),

        tool({
            name: "sitrec_load_sitch",
            title: "Load a Sitrec situation",
            description:
                "Load a built-in or saved Sitrec situation selected from sitrec_list_sitches. "
                + "Changes the visible page. Never loads an arbitrary URL or local file.",
            inputSchema: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        minLength: 1,
                        maxLength: MAX_IDENTIFIER_LENGTH,
                        description: "Exact situation id returned by sitrec_list_sitches.",
                    },
                    source: {
                        type: "string",
                        enum: ["built-in", "saved"],
                        description: "Optional source returned by sitrec_list_sitches.",
                    },
                },
                required: ["name"],
                additionalProperties: false,
            },
            annotations: {readOnlyHint: false, untrustedContentHint: true},
        }, async (input, signal) => {
            const invalid = validateObject(input, {allowed: ["name", "source"], required: ["name"]})
                ?? validateString(input.name, "name", {minLength: 1})
                ?? (input.source === undefined
                    ? null
                    : validateEnum(input.source, "source", ["built-in", "saved"]));
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;

            const catalog = await readSitchCatalog(deps, signal);
            if (!catalog.success) return catalog;
            const candidates = catalog.items.filter((item) =>
                (input.source === undefined || item.source === input.source)
                && item.id === input.name);
            if (candidates.length !== 1) {
                return compactFailure(
                    candidates.length === 0 ? "SITCH_NOT_FOUND" : "INVALID_ARGUMENT",
                    candidates.length === 0
                        ? `No loadable situation has the exact id '${input.name}'.`
                        : `Situation id '${input.name}' is ambiguous; provide its source.`,
                    {suggestions: suggestionsFor(catalog.items, input.name), recoverable: true},
                );
            }

            const selected = candidates[0];
            const initialIdentity = identityOf(readyState(deps));
            const response = await callAPI(
                deps,
                "loadSitch",
                {name: selected.id, source: selected.source},
                signal,
            );
            if (!response.success) return response;

            try {
                const settlement = await observeSitrecSettlement(deps, {signal, initialIdentity});
                return {
                    success: true,
                    requested: selected,
                    loadResult: response.result,
                    stable: settlement.stable,
                    ...(settlement.timedOut ? {warningCode: "SETTLE_TIMEOUT"} : {}),
                    state: settlement.state,
                    stillLoading: settlement.stillLoading,
                };
            } catch (error) {
                if (!isAbortError(error)) throw error;
                return {
                    success: true,
                    requested: selected,
                    loadResult: response.result,
                    stable: false,
                    cancelledAfterRequest: true,
                    state: readyState(deps),
                };
            }
        }),

        tool({
            name: "sitrec_seek_frame",
            title: "Seek Sitrec frame",
            description:
                "Move the visible recreation to an exact zero-based frame. Changes playback "
                + "position but does not save or upload the situation.",
            inputSchema: {
                type: "object",
                properties: {
                    frame: {
                        type: "integer",
                        minimum: 0,
                        maximum: 100000000,
                        description: "Zero-based frame number in the current situation.",
                    },
                },
                required: ["frame"],
                additionalProperties: false,
            },
            annotations: {readOnlyHint: false, untrustedContentHint: false},
        }, async (input, signal) => {
            const invalid = validateObject(input, {allowed: ["frame"], required: ["frame"]})
                ?? validateInteger(input.frame, "frame", 0, 100000000);
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;

            const frames = deps.getSit()?.frames;
            if (!Number.isInteger(frames) || frames < 1) {
                return compactFailure("SITREC_NOT_READY", "The current situation has no valid frame range.");
            }
            if (input.frame >= frames) {
                return compactFailure(
                    "FRAME_OUT_OF_RANGE",
                    `Frame must be between 0 and ${frames - 1}.`,
                    {requestedFrame: input.frame, frames},
                );
            }

            const response = await callAPI(deps, "setFrame", {frame: input.frame}, signal);
            if (!response.success) return response;
            try {
                await deps.waitForRender(signal);
            } catch (error) {
                if (!isAbortError(error)) throw error;
                return {
                    success: true,
                    requestedFrame: input.frame,
                    committed: true,
                    verificationCancelled: true,
                    result: response.result,
                };
            }
            const actual = await callAPI(deps, "getFrame", {}, signal);
            if (!actual.success) return actual;
            return {
                success: true,
                requestedFrame: input.frame,
                currentFrame: actual.result?.frame,
                totalFrames: actual.result?.totalFrames,
                paused: actual.result?.paused,
            };
        }),

        tool({
            name: "sitrec_set_playback",
            title: "Control Sitrec playback",
            description:
                "Play, pause, or toggle the visible Sitrec timeline. Changes live playback but "
                + "does not save or upload the situation.",
            inputSchema: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["play", "pause", "toggle"],
                        description: "Playback action to perform.",
                    },
                },
                required: ["action"],
                additionalProperties: false,
            },
            annotations: {readOnlyHint: false, untrustedContentHint: false},
        }, async (input, signal) => {
            const invalid = validateObject(input, {allowed: ["action"], required: ["action"]})
                ?? validateEnum(input.action, "action", ["play", "pause", "toggle"]);
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;

            let response;
            if (input.action === "play") response = await callAPI(deps, "play", {}, signal);
            if (input.action === "pause") response = await callAPI(deps, "pause", {}, signal);
            if (input.action === "toggle") response = await callAPI(deps, "togglePlayPause", {}, signal);
            if (!response.success) return response;

            try {
                await deps.waitForRender(signal);
            } catch (error) {
                if (!isAbortError(error)) throw error;
                return {
                    success: true,
                    action: input.action,
                    committed: true,
                    verificationCancelled: true,
                    result: response.result,
                };
            }
            const actual = await callAPI(deps, "getFrame", {}, signal);
            if (!actual.success) return actual;
            return {
                success: true,
                action: input.action,
                paused: actual.result?.paused,
                frame: actual.result?.frame,
            };
        }),

        tool({
            name: "sitrec_get_camera",
            title: "Read Sitrec camera position",
            description:
                "Read the current Sitrec camera latitude, longitude, and altitude. Does not "
                + "change the situation.",
            inputSchema: emptySchema,
            annotations: {readOnlyHint: true, untrustedContentHint: false},
        }, async (input, signal) => {
            const invalid = validateObject(input);
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;
            const response = await callAPI(deps, "getCameraLLA", {}, signal);
            if (!response.success) return response;
            return {success: true, camera: response.result};
        }),

        tool({
            name: "sitrec_goto_lla",
            title: "Move the Sitrec camera",
            description:
                "Move the visible Sitrec camera to a validated geodetic latitude, longitude, "
                + "and altitude in meters. Does not save or upload the situation.",
            inputSchema: {
                type: "object",
                properties: {
                    lat: {
                        type: "number", minimum: -90, maximum: 90,
                        description: "Geodetic latitude in degrees.",
                    },
                    lon: {
                        type: "number", minimum: -180, maximum: 180,
                        description: "Longitude in degrees, east positive.",
                    },
                    alt: {
                        type: "number", minimum: -1000, maximum: 100000000,
                        description: "Altitude in meters using the current Sitrec camera convention; defaults to 0.",
                    },
                },
                required: ["lat", "lon"],
                additionalProperties: false,
            },
            annotations: {readOnlyHint: false, untrustedContentHint: false},
        }, async (input, signal) => {
            const invalid = validateObject(input, {
                allowed: ["lat", "lon", "alt"], required: ["lat", "lon"],
            })
                ?? validateFiniteNumber(input.lat, "lat", -90, 90)
                ?? validateFiniteNumber(input.lon, "lon", -180, 180)
                ?? (input.alt === undefined
                    ? null
                    : validateFiniteNumber(input.alt, "alt", -1000, 100000000));
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;

            const requested = {lat: input.lat, lon: input.lon, alt: input.alt ?? 0};
            const response = await callAPI(deps, "gotoLLA", requested, signal);
            if (!response.success) return response;
            try {
                await deps.waitForRender(signal);
            } catch (error) {
                if (!isAbortError(error)) throw error;
                return {
                    success: true,
                    requested,
                    committed: true,
                    verificationCancelled: true,
                };
            }
            const actual = await callAPI(deps, "getCameraLLA", {}, signal);
            if (!actual.success) return actual;
            return {success: true, requested, camera: actual.result};
        }),

        tool({
            name: "sitrec_list_tracks",
            title: "List Sitrec tracks",
            description:
                "List or search tracks in the current situation. Returns exact track ids for "
                + "sitrec_get_track_position. Does not change Sitrec.",
            inputSchema: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        maxLength: MAX_IDENTIFIER_LENGTH,
                        description: "Optional case-insensitive text to match against track ids and names.",
                    },
                    limit: {
                        type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT,
                        description: `Maximum records to return; defaults to ${DEFAULT_LIST_LIMIT}.`,
                    },
                },
                additionalProperties: false,
            },
            annotations: {readOnlyHint: true, untrustedContentHint: true},
        }, async (input, signal) => {
            const invalid = validateObject(input, {allowed: ["query", "limit"]})
                ?? (input.query === undefined ? null : validateString(input.query, "query"))
                ?? (input.limit === undefined
                    ? null
                    : validateInteger(input.limit, "limit", 1, MAX_LIST_LIMIT));
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;

            const response = await readTracks(deps, signal);
            if (!response.success) return response;
            const query = input.query?.trim().toLowerCase();
            const matches = response.tracks.filter((track) => !query
                || [track.id, track.name, track.trackID]
                    .filter(Boolean)
                    .some((value) => String(value).toLowerCase().includes(query)));
            const limit = input.limit ?? DEFAULT_LIST_LIMIT;
            return {
                success: true,
                query: input.query ?? null,
                totalMatches: matches.length,
                returned: Math.min(limit, matches.length),
                truncated: matches.length > limit,
                tracks: matches.slice(0, limit),
            };
        }),

        tool({
            name: "sitrec_get_track_position",
            title: "Read a Sitrec track position",
            description:
                "Read one current track's position at an optional zero-based frame. The track id "
                + "must be an exact id returned by sitrec_list_tracks. Does not change Sitrec.",
            inputSchema: {
                type: "object",
                properties: {
                    id: {
                        type: "string", minLength: 1, maxLength: MAX_IDENTIFIER_LENGTH,
                        description: "Exact track id returned by sitrec_list_tracks.",
                    },
                    frame: {
                        type: "integer", minimum: 0, maximum: 100000000,
                        description: "Optional zero-based frame; defaults to the current frame.",
                    },
                },
                required: ["id"],
                additionalProperties: false,
            },
            annotations: {readOnlyHint: true, untrustedContentHint: true},
        }, async (input, signal) => {
            const invalid = validateObject(input, {allowed: ["id", "frame"], required: ["id"]})
                ?? validateString(input.id, "id", {minLength: 1})
                ?? (input.frame === undefined
                    ? null
                    : validateInteger(input.frame, "frame", 0, 100000000));
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;

            const frames = deps.getSit()?.frames;
            if (input.frame !== undefined && Number.isInteger(frames) && input.frame >= frames) {
                return compactFailure(
                    "FRAME_OUT_OF_RANGE",
                    `Frame must be between 0 and ${frames - 1}.`,
                    {requestedFrame: input.frame, frames},
                );
            }

            const tracks = await readTracks(deps, signal);
            if (!tracks.success) return tracks;
            if (!tracks.tracks.some((track) => track.id === input.id)) {
                return compactFailure(
                    "TRACK_NOT_FOUND",
                    `No current track has the exact id '${input.id}'.`,
                    {suggestions: suggestionsFor(tracks.tracks, input.id), recoverable: true},
                );
            }

            const response = await callAPI(
                deps,
                "getTrackPosition",
                {id: input.id, ...(input.frame === undefined ? {} : {frame: input.frame})},
                signal,
            );
            if (!response.success) return response;
            const result = response.result ?? {};
            return {
                success: true,
                id: input.id,
                frame: result.frame ?? input.frame ?? deps.getPar()?.frame ?? null,
                ...(result.position === undefined ? {} : {position: result.position}),
                ...(result.lla === undefined ? {} : {lla: result.lla}),
                ...(result.value === undefined
                    ? {}
                    : {value: String(result.value).slice(0, 500)}),
            };
        }),

        tool({
            name: "sitrec_list_views",
            title: "List Sitrec views",
            description:
                "List the current Sitrec views with visibility and normalized layout bounds. "
                + "Does not change Sitrec.",
            inputSchema: emptySchema,
            annotations: {readOnlyHint: true, untrustedContentHint: true},
        }, async (input, signal) => {
            const invalid = validateObject(input);
            if (invalid) return invalid;
            const notReady = requireReady(deps);
            if (notReady) return notReady;
            const response = await callAPI(deps, "listViews", {}, signal);
            if (!response.success) return response;
            const views = (Array.isArray(response.result) ? response.result : [])
                .slice(0, MAX_LIST_LIMIT)
                .map((view) => ({
                    id: typeof view?.id === "string"
                        ? view.id.slice(0, MAX_IDENTIFIER_LENGTH)
                        : null,
                    visible: Boolean(view?.visible),
                    left: Number.isFinite(view?.left) ? view.left : null,
                    top: Number.isFinite(view?.top) ? view.top : null,
                    width: Number.isFinite(view?.width) ? view.width : null,
                    height: Number.isFinite(view?.height) ? view.height : null,
                }))
                .filter((view) => view.id);
            return {success: true, count: views.length, views};
        }),
    ];
}

export async function registerSitrecWebMCP(options = {}) {
    const documentObject = options.documentObject
        ?? (typeof document === "undefined" ? null : document);
    const windowObject = options.windowObject
        ?? (typeof window === "undefined" ? globalThis : window);
    const registerTool = documentObject?.modelContext?.registerTool;

    if (typeof registerTool !== "function") {
        return {supported: false, registered: 0, errors: []};
    }

    windowObject[REGISTRATION_KEY]?.abort?.();
    const controller = new AbortController();
    windowObject[REGISTRATION_KEY] = controller;
    const tools = options.tools ?? createSitrecWebMCPTools(options.dependencies);
    const errors = [];
    let registered = 0;

    for (const definition of tools) {
        try {
            await registerTool.call(documentObject.modelContext, definition, {
                signal: controller.signal,
            });
            registered += 1;
        } catch (error) {
            errors.push({
                tool: definition.name,
                error: error?.message ? String(error.message) : String(error),
            });
        }
    }

    if (errors.length) {
        console.warn("Some Sitrec WebMCP tools failed to register", errors);
    } else {
        console.info(`Registered ${registered} Sitrec WebMCP tools.`);
    }

    return {
        supported: true,
        registered,
        errors,
        unregister: () => controller.abort(),
    };
}
