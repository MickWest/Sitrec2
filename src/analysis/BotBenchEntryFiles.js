/** Read paired sidecars only for the entry currently being used. */
export async function readEntrySidecars(entry) {
    // Keep texts off queued/completed entries: truth sidecars can contain a
    // label for every frame. Inline texts remain supported for script callers.
    const loaded = {...entry};
    for (const [textKey, fileKey] of [["sidecarText", "sidecarFile"], ["labelsText", "labelsFile"]]) {
        if (loaded[textKey] != null || !entry[fileKey]) continue;
        try { loaded[textKey] = await (await entry[fileKey].getFile()).text(); }
        catch (e) { /* Optional sidecar unavailable; ingest handles its absence. */ }
    }
    return loaded;
}

async function sha256Hex(data) {
    const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash every input, including sidecars, before reusing any cached result. */
export async function entryFileHashes(entry) {
    const hashes = {csv: await sha256Hex(await (await entry.getFile()).arrayBuffer())};
    const loaded = await readEntrySidecars(entry);
    if (loaded.sidecarText != null) hashes.sidecar = await sha256Hex(loaded.sidecarText);
    if (loaded.labelsText != null) hashes.truth = await sha256Hex(loaded.labelsText);
    return hashes;
}
