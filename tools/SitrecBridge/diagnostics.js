/**
 * SitrecBridge — Diagnostics
 *
 * Every bridge failure so far has been diagnosed by hand, after the fact, from `ps` output and
 * guesswork, because neither side of the bridge kept a record. Server logs went to stderr, where
 * the MCP client swallows them; extension logs went to the service worker console, which Chrome
 * ERASES when it kills the worker — precisely the event worth investigating.
 *
 * So: an append-only JSONL trail on disk that outlives the process, plus an in-memory ring for the
 * `sitrec_diagnostics` tool to read back without touching the filesystem.
 *
 * Writes are queued and asynchronous. Diagnostics must never be able to stall the MCP loop or take
 * the bridge down with them, so every failure here is swallowed on purpose.
 */

import {appendFile, mkdir, readdir, readFile, rename, stat, unlink} from "fs/promises";
import {homedir} from "os";
import {join} from "path";

export const LOG_DIR = process.env.SITREC_BRIDGE_LOG_DIR || join(homedir(), ".sitrec-bridge", "logs");

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RING_SIZE = 400;

const ring = [];
let queue = Promise.resolve();
let logDirReady = false;
let diskLoggingBroken = false;
let context = {};

/** Fields stamped onto every record — pid, port, who spawned us. Merged, never replaced. */
export function setContext(fields) {
    context = {...context, ...fields};
}

function dayStamp(now) {
    return new Date(now).toISOString().slice(0, 10);
}

function logPath(now) {
    return join(LOG_DIR, `bridge-${dayStamp(now)}.jsonl`);
}

async function ensureLogDir() {
    if (logDirReady) return;
    await mkdir(LOG_DIR, {recursive: true});
    logDirReady = true;
}

/**
 * Roll the current file aside once it gets large, and drop anything older than a week. A machine
 * that runs bridges all day should not accumulate logs without bound.
 */
async function rotateIfNeeded(path, now) {
    try {
        const info = await stat(path);
        if (info.size > MAX_FILE_BYTES) {
            await rename(path, `${path}.${now}.old`);
        }
    } catch {
        // No file yet — nothing to rotate.
    }

    try {
        for (const name of await readdir(LOG_DIR)) {
            if (!name.startsWith("bridge-")) continue;
            const info = await stat(join(LOG_DIR, name));
            if (now - info.mtimeMs > MAX_LOG_AGE_MS) {
                await unlink(join(LOG_DIR, name));
            }
        }
    } catch {
        // Pruning is best-effort.
    }
}

let recordsSinceRotateCheck = 0;

/**
 * Record one event. Fire-and-forget: callers never await, and a broken disk just means the
 * in-memory ring is all `sitrec_diagnostics` has to show.
 */
export function record(event, fields = {}) {
    const now = Date.now();
    const entry = {t: now, ts: new Date(now).toISOString(), event, ...context, ...fields};

    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();

    if (diskLoggingBroken) return entry;

    queue = queue
        .then(async () => {
            await ensureLogDir();
            const path = logPath(now);
            if (recordsSinceRotateCheck++ % 50 === 0) {
                await rotateIfNeeded(path, now);
            }
            await appendFile(path, JSON.stringify(entry) + "\n");
        })
        .catch(() => {
            // One failure is usually permissions or a missing home dir; stop trying rather than
            // burning a syscall per event forever.
            diskLoggingBroken = true;
        });

    return entry;
}

/** Most recent entries from this process, newest last. */
export function recent(limit = 100) {
    return ring.slice(-Math.max(1, limit));
}

/**
 * Read back today's (and optionally yesterday's) trail from disk, across ALL bridge processes.
 * This is the cross-session view — the one that shows a port changing hands.
 */
export async function readLog({limit = 200, days = 1} = {}) {
    const now = Date.now();
    const lines = [];
    for (let back = days - 1; back >= 0; back--) {
        const path = logPath(now - back * 24 * 60 * 60 * 1000);
        try {
            const text = await readFile(path, "utf-8");
            for (const line of text.split("\n")) {
                if (line.trim()) lines.push(line);
            }
        } catch {
            // Day with no log.
        }
    }

    return lines.slice(-Math.max(1, limit)).map((line) => {
        try {
            return JSON.parse(line);
        } catch {
            return {event: "unparseable", raw: line.slice(0, 400)};
        }
    });
}
