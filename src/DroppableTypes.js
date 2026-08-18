// One list of what Sitrec can INGEST from a file, plus the helpers that read it.
//
// The same set had been written out three times — the Import dialog's `accept`
// attribute, the drag-and-drop routing in DragDropHandler, and the "is this a direct
// asset?" test that decides whether a pasted or dropped URL is worth fetching at all —
// and the three had drifted apart. The visible consequence was that a file could be
// DROPPED but not LINKED: an .ntf, .nsf, .klv, .glb, .pcap or .zip URL was refused with
// "Unsupported URL host or page type" while the identical file dropped from the desktop
// imported fine. Anything droppable should be linkable, so the URL gate and the file
// picker now read the same list, and adding a format in one place covers both.
//
// A leaf module on purpose (it imports only AudioFormats, which imports nothing), so the
// URL gate, the file picker and any parser can all use it without an import cycle.

import {MP4_DEMUXER_EXTENSIONS, WEBAUDIO_SUPPORTED_EXTENSIONS} from "./AudioFormats";

// Still pictures. jp2/j2k/jpx/jpc/j2c are JPEG 2000 (decoded in JPEG2000Utils), heic/heif
// go through libheif, and tif/tiff may carry GeoTIFF bounds and land as a ground overlay.
export const IMAGE_EXTENSIONS = [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff',
    'jp2', 'j2k', 'jpx', 'jpc', 'j2c', 'heic', 'heif',
];

// Moving pictures. 'ts'/'m2ts'/'mts' are MPEG transport streams, demuxed to their
// substreams rather than played directly; 'dad' and 'h264' are raw elementary streams.
// 'm4v'/'mp4v' need no case of their own in parseAsset — they are ISO-BMFF, so
// sniffFileType reports them as "mp4" from the bytes before the extension is consulted.
//
// Deliberately NOT here: 'ogv'. Ogg/Theora has no signature in sniffFileType, no branch
// in parseAsset, and is not among the codecs the video pipeline configures — listing it
// would fetch the file and then register it as unknown, which is a worse answer than
// declining the link.
export const VIDEO_EXTENSIONS = [
    'mp4', 'mov', 'webm', 'avi', 'm4v', 'mp4v', 'mpeg', 'mpg',
    'h264', 'dad', 'm2v', 'm1v', 'ts', 'm2ts', 'mts',
];

export const AUDIO_EXTENSIONS = [...WEBAUDIO_SUPPORTED_EXTENSIONS, ...MP4_DEMUXER_EXTENSIONS];

// Tracks, metadata, models and the containers they arrive in.
//
// Not here: `.js`. A sitch is a .sitch.js file, but it is loaded by reference through
// SitrecObjectResolver rather than fetched as an asset, and putting a bare "js" in this
// list would make every .js URL on the internet something Sitrec offers to download.
export const DATA_EXTENSIONS = [
    'kml', 'kmz', 'ksv', 'xml', 'csv', 'json', 'geojson', 'srt', 'txt',
    'tle', '2le', '3le', 'dat', 'klv',
    'glb', 'ply',                       // 3D models
    'ntf', 'nitf', 'nsf',               // NITF / NSIF imagery with sensor metadata
    'pcap', 'pcapng', 'raw',            // ASTERIX radar captures
    'zip', 'bin',
];

// Extensions that can bring a TRACK into the scene — a path through space with
// times on it. Used only by the "Reset on Track Import" tweak, to decide whether
// an import is the kind that tweak is about.
//
// This is a judgement made from the FILENAME, before anything is parsed, and it
// cannot be exact: a .csv is a track in a dozen formats or a list of something
// else entirely, and only the parser knows which. It is therefore drawn to fail
// SAFE — the cost of a false positive is a scene thrown away, the cost of a
// false negative is the old behaviour — so anything whose usual job is to add to
// a scene rather than to be one is left out: images, audio, 3D models, NITF
// imagery, and archives.
//
// Transport streams ARE here even though they are also video. A .ts is the
// common case of "import a track": the KLV in it is the sensor path, and the
// video rides along. Plain video (.mp4 and friends) is not — dropping a video
// onto an existing track is how a scene gets built, and resetting there would
// destroy the work rather than continue it.
export const TRACK_EXTENSIONS = Object.freeze([
    'kml', 'kmz', 'ksv', 'csv', 'json', 'geojson', 'srt', 'txt',
    'tle', '2le', '3le', 'dat', 'klv', 'xml',
    'pcap', 'pcapng', 'raw',            // ASTERIX radar captures
    'ts', 'm2ts', 'mts',                // transport streams: KLV plus video
]);

const TRACK_SET = new Set(TRACK_EXTENSIONS);

/** @param {string} name a filename; the extension is read from the last dot. */
export function isTrackFilename(name) {
    if (!name) return false;
    const dot = String(name).lastIndexOf(".");
    if (dot < 0) return false;
    return TRACK_SET.has(String(name).slice(dot + 1).toLowerCase());
}

/**
 * Does this batch of files count as "importing a track"?
 *
 * TRUE when at least one of them can carry a track. One track among several
 * files is still a track import — a sidecar beside its video, a .csv beside its
 * .scenario.json — and splitting the batch would reset in the middle of it.
 */
export function filesAreTrackImport(files) {
    if (!files || !files.length) return false;
    for (const f of files) {
        if (isTrackFilename(f?.name)) return true;
    }
    return false;
}

/** Every extension Sitrec will attempt to ingest, lower-case, without the dot. */
export const DROPPABLE_EXTENSIONS = Object.freeze([...new Set([
    ...IMAGE_EXTENSIONS,
    ...VIDEO_EXTENSIONS,
    ...AUDIO_EXTENSIONS,
    ...DATA_EXTENSIONS,
])]);

const DROPPABLE_SET = new Set(DROPPABLE_EXTENSIONS);

/** @param {string} ext extension with or without a leading dot; case-insensitive. */
export function isDroppableExtension(ext) {
    if (!ext) return false;
    return DROPPABLE_SET.has(String(ext).replace(/^\./, "").toLowerCase());
}

/**
 * Does this URL point straight at a file Sitrec can ingest?
 *
 * Only the path is consulted, so a query string or fragment cannot change the answer.
 * False for anything without a recognised extension — including pages that merely
 * CONTAIN a video, which have their own resolvers (DVIDS, war.gov, Metabunk threads).
 */
export function urlLooksDroppable(url) {
    try {
        const pathname = new URL(url, typeof window !== "undefined" ? window.location.href : undefined).pathname;
        const lastDot = pathname.lastIndexOf(".");
        if (lastDot < 0) return false;
        return isDroppableExtension(pathname.slice(lastDot + 1));
    } catch (e) {
        return false;
    }
}

/** The `accept` attribute for a file <input>, covering everything above. */
export function droppableAcceptAttribute() {
    return DROPPABLE_EXTENSIONS.map(e => "." + e).join(",");
}

// MIME types for rebuilding a File from fetched bytes.
//
// A DROPPED file arrives with the browser's own type already on it; a file fetched from
// a URL arrives as a bare ArrayBuffer, so the URL path has to name the type itself before
// handing it to the video node. Guessing `video/${ext}` invents types nothing accepts
// ("video/m4v", "audio/aif"), which is why these are explicit.
export const VIDEO_MIME_TYPES = Object.freeze({
    mp4: 'video/mp4', m4v: 'video/mp4', mp4v: 'video/mp4',   // all three are ISO-BMFF
    mov: 'video/quicktime',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
});

export const AUDIO_MIME_TYPES = Object.freeze({
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    aif: 'audio/aiff', aiff: 'audio/aiff',
    caf: 'audio/x-caf',
});
