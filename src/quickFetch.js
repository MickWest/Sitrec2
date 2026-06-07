import {indexedDBManager} from "./IndexedDBManager";
import {LoadingManager} from "./CLoadingManager";
import {Globals} from "./Globals";

const INITIAL_CHUNK_SIZE = 3 * 1024 * 1024; // 3MB initial request

function logNetwork(url, status) {
    if (Globals.regression) {
        console.log(`[NET:${url}:${status}]`);
    }
}
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB subsequent chunks
const CONCURRENCY = 4;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

let quickFetchEnabled = true;
let cacheEnabled = true;

export function setQuickFetchEnabled(enabled) {
    quickFetchEnabled = enabled;
}

export function setCacheEnabled(enabled) {
    cacheEnabled = enabled;
}

function isS3Url(url) {
    return url.includes('.s3.') || url.includes('.s3-');
}

function getCacheKey(url) {
    return `quickfetch:${url}`;
}

// --- Stall protection -------------------------------------------------------
// A browser fetch on a half-open / silently-dropped connection never resolves
// AND never rejects. quickFetch downloads large files as many independent range
// requests, so a single stalled chunk would otherwise wedge the whole load
// forever (the CITD .mov "stuck on LOADING" hang: a 43MB video = ~23 chunk
// fetches, any one of which can silently stall, with nothing to time it out).
//
// These are INACTIVITY timeouts — the timer is reset on every byte received, so
// a legitimately slow-but-progressing transfer is never aborted; only a true
// stall (no headers, or no body bytes for the window) trips them. On a trip the
// fetch is aborted with a TimeoutError, which the chunk/initial retry logic and
// ultimately loadAsset's catch can act on (unwind pendingActions, surface an
// error) instead of hanging indefinitely.
const HEADER_TIMEOUT_MS = 10000; // max wait for response headers (time-to-first-byte)
const STALL_TIMEOUT_MS = 10000;  // max gap between body-byte arrivals
const STALL_RETRIES = 1;         // retry a stalled chunk / initial fetch this many times

// Combine multiple AbortSignals into one. Prefer the native AbortSignal.any;
// fall back to manual linking for older runtimes (e.g. some Electron builds).
function combineSignals(signals) {
    const list = signals.filter(Boolean);
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
        try { return AbortSignal.any(list); } catch (e) { /* fall through to manual */ }
    }
    const controller = new AbortController();
    const propagate = (s) => { try { controller.abort(s.reason); } catch (e) { controller.abort(); } };
    for (const s of list) {
        if (s.aborted) { propagate(s); break; }
        s.addEventListener("abort", () => propagate(s), { once: true });
    }
    return controller.signal;
}

// True when the rejection is our own inactivity-timeout abort (not a caller abort).
function isStallTimeout(err) {
    return !!err && err.name === "TimeoutError";
}

// Fetch a URL and fully read its body, guarded by a header (TTFB) timeout and a
// body inactivity timeout. Returns { response, buffer } — `response` carries the
// real status/headers (body already consumed), `buffer` is the bytes.
// Throws a TimeoutError (name) on stall; propagates the caller's AbortError.
async function fetchBufferWithStall(url, init, callerSignal) {
    if (Globals.regression) {
        // Deterministic CI must not depend on wall-clock timers (they'd add flakes).
        const response = await fetch(url, { ...init, signal: callerSignal });
        return { response, buffer: await response.arrayBuffer() };
    }
    const stallController = new AbortController();
    const signal = combineSignals([callerSignal, stallController.signal]);
    let timer = null;
    const arm = (ms, why) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => stallController.abort(new DOMException(why, "TimeoutError")), ms);
    };
    arm(HEADER_TIMEOUT_MS, `quickFetch: no response headers within ${HEADER_TIMEOUT_MS}ms`);
    try {
        const response = await fetch(url, { ...init, signal });
        const body = response.body;
        if (!body || typeof body.getReader !== "function") {
            // Runtime without a readable stream — guard arrayBuffer() with a single window.
            arm(STALL_TIMEOUT_MS, `quickFetch: stalled reading body after ${STALL_TIMEOUT_MS}ms`);
            const buffer = await response.arrayBuffer();
            return { response, buffer };
        }
        const reader = body.getReader();
        const parts = [];
        let received = 0;
        arm(STALL_TIMEOUT_MS, `quickFetch: stalled mid-body after ${STALL_TIMEOUT_MS}ms`);
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            received += value.byteLength;
            arm(STALL_TIMEOUT_MS, `quickFetch: stalled mid-body after ${STALL_TIMEOUT_MS}ms`);
        }
        const out = new Uint8Array(received);
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.byteLength; }
        return { response, buffer: out.buffer };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Header-timeout-only fetch for passthrough paths whose body is read by the
// caller (so we can't install a body-inactivity timer here). Still protects
// against a connection that never returns response headers.
async function fetchWithHeaderTimeout(url, init, callerSignal) {
    if (Globals.regression) return fetch(url, { ...init, signal: callerSignal });
    const stallController = new AbortController();
    const signal = combineSignals([callerSignal, stallController.signal]);
    const timer = setTimeout(() => stallController.abort(
        new DOMException(`quickFetch: no response headers within ${HEADER_TIMEOUT_MS}ms`, "TimeoutError")),
        HEADER_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal });
    } finally {
        clearTimeout(timer);
    }
}

async function downloadChunk(url, start, end, signal) {
    const init = { headers: { 'Range': `bytes=${start}-${end}` } };
    let lastErr;
    for (let attempt = 0; attempt <= STALL_RETRIES; attempt++) {
        try {
            const { response, buffer } = await fetchBufferWithStall(url, init, signal);
            if (!response.ok && response.status !== 206) {
                throw new Error(`Chunk download failed: ${response.status}`);
            }
            return buffer;
        } catch (err) {
            lastErr = err;
            // Retry only our own inactivity-timeout; a caller abort or HTTP error propagates.
            if (!isStallTimeout(err) || (signal && signal.aborted) || attempt === STALL_RETRIES) {
                throw err;
            }
            console.warn(`[quickFetch] chunk ${start}-${end} stalled, retrying (${attempt + 2}/${STALL_RETRIES + 1})`);
        }
    }
    throw lastErr;
}

async function fetchRemainingChunks(url, remainingStart, totalSize, signal, loadingId) {
    const remainingChunks = [];
    let pos = remainingStart;
    while (pos < totalSize) {
        const end = Math.min(pos + CHUNK_SIZE - 1, totalSize - 1);
        remainingChunks.push({ start: pos, end, index: remainingChunks.length });
        pos = end + 1;
    }
    
    if (remainingChunks.length === 0) return [];
    
    const chunkBuffers = new Array(remainingChunks.length);
    let activeDownloads = 0;
    let nextIdx = 0;
    let completedBytes = remainingStart;
    
    return new Promise((resolve, reject) => {
        const startNext = () => {
            if (signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            
            while (activeDownloads < CONCURRENCY && nextIdx < remainingChunks.length) {
                const chunk = remainingChunks[nextIdx++];
                activeDownloads++;
                downloadChunk(url, chunk.start, chunk.end, signal)
                    .then(buf => {
                        chunkBuffers[chunk.index] = buf;
                        completedBytes += buf.byteLength;
                        activeDownloads--;
                        
                        if (loadingId) {
                            LoadingManager.updateProgress(loadingId, (completedBytes / totalSize) * 100);
                        }
                        
                        if (nextIdx >= remainingChunks.length && activeDownloads === 0) {
                            resolve(chunkBuffers);
                        } else {
                            startNext();
                        }
                    })
                    .catch(reject);
            }
        };
        startNext();
    });
}

export async function quickFetch(url, options = {}) {
    const {
        useCache = cacheEnabled,
        showLoading = false,
        loadingCategory = "Download",
        // Optional id of an EXISTING LoadingManager task (e.g. CFileManager's
        // "Asset" task) to report byte-progress to, so its row advances during a
        // chunked download instead of sitting at "Starting...". quickFetch does
        // not own this task's lifecycle (no register/complete), only updates it.
        progressId = null,
        signal,
        ...fetchOptions
    } = options;

    if (!quickFetchEnabled) {
        logNetwork(url, 'pending');
        const response = await fetchWithHeaderTimeout(url, fetchOptions, signal);
        logNetwork(url, response.status);
        return response;
    }
    
    if (useCache) {
        try {
            const cached = await indexedDBManager.getCachedData(getCacheKey(url));
            if (cached) {
                console.log(`[quickFetch] Cache hit: ${url}`);
                logNetwork(url, 200);
                return new Response(cached, {
                    status: 200,
                    headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
                });
            }
        } catch (e) {
        }
    }
    
    if (!isS3Url(url)) {
        logNetwork(url, 'pending');
        const response = await fetchWithHeaderTimeout(url, fetchOptions, signal);
        logNetwork(url, response.status);
        return response;
    }

    let loadingId = null;
    if (showLoading) {
        loadingId = `quickfetch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        LoadingManager.registerLoading(loadingId, url, loadingCategory);
    }
    // Report byte-progress to a caller-supplied task if given, else to our own.
    const reportId = progressId ?? loadingId;

    logNetwork(url, 'pending');

    try {
        const { response: initialResponse, buffer: initialBodyBuffer } =
            await fetchInitialChunkWithStall(url, signal);

        if (initialResponse.status === 200) {
            const buffer = initialBodyBuffer;
            if (loadingId) LoadingManager.completeLoading(loadingId);
            if (useCache) {
                try {
                    await indexedDBManager.cacheData(getCacheKey(url), buffer, CACHE_TTL);
                } catch (e) {}
            }
            logNetwork(url, 200);
            return new Response(buffer, {
                status: 200,
                headers: new Headers({
                    'Content-Type': initialResponse.headers.get('Content-Type') || 'application/octet-stream',
                    'Content-Length': buffer.byteLength.toString(),
                }),
            });
        }
        
        if (initialResponse.status !== 206) {
            if (loadingId) LoadingManager.completeLoading(loadingId);
            logNetwork(url, initialResponse.status);
            // Body already consumed by fetchInitialChunkWithStall — re-wrap it so
            // the caller still sees the real status (e.g. an error body to read).
            return new Response(initialBodyBuffer, {
                status: initialResponse.status,
                statusText: initialResponse.statusText,
                headers: initialResponse.headers,
            });
        }

        const contentRange = initialResponse.headers.get('Content-Range');
        const match = contentRange?.match(/bytes \d+-\d+\/(\d+)/);
        if (!match) {
            if (loadingId) LoadingManager.completeLoading(loadingId);
            logNetwork(url, 200);
            return new Response(initialBodyBuffer, { status: 200, headers: initialResponse.headers });
        }

        const totalSize = parseInt(match[1], 10);
        const initialBuffer = initialBodyBuffer;
        const contentType = initialResponse.headers.get('Content-Type') || 'application/octet-stream';

        if (reportId) {
            LoadingManager.updateProgress(reportId, (initialBuffer.byteLength / totalSize) * 100);
        }
        
        if (initialBuffer.byteLength >= totalSize) {
            if (loadingId) LoadingManager.completeLoading(loadingId);
            if (useCache) {
                try {
                    await indexedDBManager.cacheData(getCacheKey(url), initialBuffer, CACHE_TTL);
                } catch (e) {}
            }
            logNetwork(url, 200);
            return new Response(initialBuffer, {
                status: 200,
                headers: new Headers({
                    'Content-Type': contentType,
                    'Content-Length': totalSize.toString(),
                }),
            });
        }
        
        console.log(`[quickFetch] Parallel download: ${url} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
        
        const chunkBuffers = await fetchRemainingChunks(url, initialBuffer.byteLength, totalSize, signal, reportId);
        
        const combined = new Uint8Array(totalSize);
        combined.set(new Uint8Array(initialBuffer), 0);
        let offset = initialBuffer.byteLength;
        for (const buf of chunkBuffers) {
            combined.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
        }
        
        if (loadingId) LoadingManager.completeLoading(loadingId);
        
        if (useCache) {
            try {
                await indexedDBManager.cacheData(getCacheKey(url), combined.buffer, CACHE_TTL);
                console.log(`[quickFetch] Cached: ${url}`);
            } catch (e) {
                console.warn(`[quickFetch] Cache write failed:`, e);
            }
        }
        
        logNetwork(url, 200);
        return new Response(combined.buffer, {
            status: 200,
            headers: new Headers({
                'Content-Type': contentType,
                'Content-Length': totalSize.toString(),
            }),
        });
        
    } catch (err) {
        if (loadingId) LoadingManager.completeLoading(loadingId);

        if (err.name === 'AbortError') {
            logNetwork(url, 0);
            throw err;
        }

        // Our own inactivity-timeout (already retried STALL_RETRIES times). Do NOT
        // fall back to a plain full GET — that has no body-stall protection and would
        // just re-hang. Surface it so loadAsset's catch unwinds pendingActions.
        if (isStallTimeout(err)) {
            console.warn(`[quickFetch] giving up on stalled download after retries: ${url} (${err.message})`);
            logNetwork(url, 0);
            throw err;
        }

        // Genuine error from the range/chunk path (e.g. server doesn't support
        // ranges). Fall back to a single GET, still guarded by a header timeout.
        console.warn(`[quickFetch] Parallel download failed, falling back to regular fetch:`, err);
        const response = await fetchWithHeaderTimeout(url, fetchOptions, signal);
        logNetwork(url, response.status);
        return response;
    }
}

// Initial S3 range fetch (0..INITIAL_CHUNK_SIZE) with stall protection and a
// bounded retry on stall — mirrors downloadChunk for the first request.
async function fetchInitialChunkWithStall(url, signal) {
    const init = { headers: { 'Range': `bytes=0-${INITIAL_CHUNK_SIZE - 1}` } };
    let lastErr;
    for (let attempt = 0; attempt <= STALL_RETRIES; attempt++) {
        try {
            return await fetchBufferWithStall(url, init, signal);
        } catch (err) {
            lastErr = err;
            if (!isStallTimeout(err) || (signal && signal.aborted) || attempt === STALL_RETRIES) {
                throw err;
            }
            console.warn(`[quickFetch] initial fetch stalled, retrying (${attempt + 2}/${STALL_RETRIES + 1}): ${url}`);
        }
    }
    throw lastErr;
}

export async function clearQuickFetchCache() {
    try {
        await indexedDBManager.clearCache();
        console.log('[quickFetch] Cache cleared');
    } catch (e) {
        console.error('[quickFetch] Failed to clear cache:', e);
    }
}

export default quickFetch;
