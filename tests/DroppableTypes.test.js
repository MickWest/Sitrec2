/**
 * The list of ingestable file types must stay true.
 *
 * DroppableTypes decides three things at once: what the Import dialog offers, how a
 * dropped file is routed, and — the one with teeth — whether a pasted or dropped URL is
 * fetched at all. Advertising an extension that nothing downstream handles is worse than
 * declining it: the file is fetched (potentially hundreds of MB), then registered as
 * "unknown" or logged as "Unknown video format" while the import silently does nothing.
 *
 * Two separate dispatches have to agree with the list, and they do NOT key off the same
 * thing, which is exactly how they drifted apart before:
 *
 *   parseAsset()        dispatches on the SNIFFED type when the bytes carry a signature,
 *                       falling back to the filename extension.
 *   handleParsedFile()  dispatches on the FILENAME extension only.
 *
 * So a .m4v sniffs as "mp4", parses as dataType "video", and then finds no branch under
 * its own name in the second dispatch. These tests read both dispatches out of the source
 * so adding a format to the list without wiring it up fails here rather than in the field.
 */

import fs from "fs";
import path from "path";
import {DROPPABLE_EXTENSIONS, AUDIO_MIME_TYPES, VIDEO_MIME_TYPES, urlLooksDroppable} from "../src/DroppableTypes";
import {MP4_DEMUXER_EXTENSIONS, WEBAUDIO_SUPPORTED_EXTENSIONS} from "../src/AudioFormats";

// Comments are stripped before any of the scanning below. They quote the very strings
// and identifiers being searched for (the whole point of the comments is to explain the
// dispatch), so leaving them in makes a scan land inside prose instead of code — which
// silently truncated an earlier version of this check to the first branch.
// Only WHOLE-LINE `//` comments are removed, so URLs inside string literals survive.
const parseSource = fs.readFileSync(
    path.resolve(__dirname, "../src/CFileManagerParse.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const AUDIO_EXTS = [...WEBAUDIO_SUPPORTED_EXTENSIONS, ...MP4_DEMUXER_EXTENSIONS];

// Handled before parseAsset's switch is ever reached (their own parsers/containers).
const PRE_SWITCH = ["ts", "ntf", "nitf", "nsf", "zip", "kmz"];

// Extensions sniffFileType resolves to a DIFFERENT, handled type from the magic bytes,
// before the filename extension is consulted. These legitimately have no case of their own.
const SNIFF_ALIAS = {m4v: "mp4", mp4v: "mp4", m1v: "m2v", m2ts: "ts", mts: "ts"};

/** The `case "x":` labels in parseAsset's switch. */
function parseAssetCases() {
    const cases = new Set(
        [...parseSource.matchAll(/^\s*case "([a-z0-9.]+)":/gm)].map(m => m[1]));
    expect(cases.size).toBeGreaterThan(20);   // the scrape found the switch at all
    return cases;
}

/** The video/audio upload chain inside handleParsedFile. */
function uploadDispatch() {
    const start = parseSource.indexOf('if (fileExt === "h264"');
    const end = parseSource.indexOf("Unknown video format");
    expect(start).toBeGreaterThan(-1);        // the scrape found the dispatch at all
    expect(end).toBeGreaterThan(start);
    const branch = parseSource.slice(start, end);
    return {
        named: new Set([...branch.matchAll(/fileExt === "([a-z0-9]+)"/g)].map(m => m[1])),
        usesAudioHelper: branch.includes("isAudioOnlyFormat(filename)"),
    };
}

describe("droppable types stay ingestable", () => {

    test("every offered extension reaches a handler in parseAsset", () => {
        const cases = parseAssetCases();
        const unhandled = DROPPABLE_EXTENSIONS.filter(ext => {
            const effective = SNIFF_ALIAS[ext] ?? ext;
            return !cases.has(effective)
                && !PRE_SWITCH.includes(effective)
                && !AUDIO_EXTS.includes(ext);     // the default branch takes audio
        });
        expect(unhandled).toEqual([]);
    });

    test("everything that parses as video is actually uploaded to the video node", () => {
        const cases = parseAssetCases();
        const {named, usesAudioHelper} = uploadDispatch();

        // Which offered extensions come out of parseAsset as dataType "video"?
        const VIDEO_CASES = ["dad", "h264", "m2v", "mp4", "mov", "webm", "avi", "mpg", "mpeg"];
        VIDEO_CASES.forEach(c => expect(cases.has(c)).toBe(true));
        const parsesAsVideo = DROPPABLE_EXTENSIONS.filter(ext => {
            const effective = SNIFF_ALIAS[ext] ?? ext;
            if (effective === "ts") return false;          // demuxed to substreams
            return VIDEO_CASES.includes(effective) || AUDIO_EXTS.includes(ext);
        });
        expect(parsesAsVideo.length).toBeGreaterThan(10);

        // ...and does the second dispatch, which reads the FILENAME extension, name it?
        // "webm" is excluded from the audio helper there: it is in the audio list but is
        // also a video container, and is handled by the video branch.
        const notUploaded = parsesAsVideo.filter(ext =>
            !named.has(ext)
            && !(usesAudioHelper && AUDIO_EXTS.includes(ext) && ext !== "webm"));
        expect(notUploaded).toEqual([]);
    });

    test("every container rebuilt from fetched bytes has a real MIME type", () => {
        // A URL import has no browser-assigned type, so the File is rebuilt by hand.
        // Guessing `video/${ext}` invents types nothing accepts, e.g. "video/m4v".
        const rebuilt = [...Object.keys(VIDEO_MIME_TYPES), ...Object.keys(AUDIO_MIME_TYPES)];
        for (const ext of rebuilt) {
            expect(DROPPABLE_EXTENSIONS).toContain(ext);
            const mime = VIDEO_MIME_TYPES[ext] ?? AUDIO_MIME_TYPES[ext];
            expect(mime).toMatch(/^(video|audio)\/[a-z0-9.+-]+$/);
        }
        for (const ext of AUDIO_EXTS) {
            if (ext === "webm") continue;                   // handled as video
            expect(AUDIO_MIME_TYPES[ext]).toBeDefined();
        }
    });

    test("urlLooksDroppable reads the path only, and rejects the rest", () => {
        expect(urlLooksDroppable("https://x.test/a/b/track.ntf")).toBe(true);
        expect(urlLooksDroppable("https://x.test/clip.MP4")).toBe(true);
        // a query string or fragment must not change the answer either way
        expect(urlLooksDroppable("https://x.test/f.kml?v=2#frag")).toBe(true);
        expect(urlLooksDroppable("https://x.test/page?file=x.kml")).toBe(false);
        expect(urlLooksDroppable("https://x.test/watch/12345")).toBe(false);
        expect(urlLooksDroppable("https://x.test/app.js")).toBe(false);  // never fetch scripts
        expect(urlLooksDroppable("not a url")).toBe(false);
        expect(urlLooksDroppable("")).toBe(false);
    });
});
