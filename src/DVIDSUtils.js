import {SITREC_SERVER} from "./configUtils";

const DVIDS_VIDEO_PAGE_RE = /^https?:\/\/(?:www\.)?dvidshub\.net\/video\/(?:embed\/)?\d+(?:[/?#].*)?$/i;

// Single-pass replacement. Sequential .replace() calls would double-unescape:
// "&amp;lt;" -> "&lt;" -> "<". A single regex sweep visits each character once,
// so the substituted "&" from "&amp;" is never reconsidered as the start of
// another entity. CodeQL: js/double-escaping.
const HTML_ENTITY_MAP = {amp: "&", quot: "\"", "#39": "'", lt: "<", gt: ">"};
function decodeHTMLEntities(value) {
    return String(value || "").replace(/&(amp|quot|#39|lt|gt);/g, (_, name) => HTML_ENTITY_MAP[name]);
}

function absolutizeURL(candidate, baseURL) {
    try {
        return new URL(candidate, baseURL).href;
    } catch (e) {
        return null;
    }
}

export function isDvidsVideoPageURL(url) {
    if (typeof url !== "string") return false;
    return DVIDS_VIDEO_PAGE_RE.test(url.trim());
}

export function getDvidsVideoId(url) {
    if (typeof url !== "string") return null;
    const match = url.trim().match(/^https?:\/\/(?:www\.)?dvidshub\.net\/video\/(?:embed\/)?(\d+)(?:[/?#].*)?$/i);
    return match ? match[1] : null;
}

export function deriveDvidsMp4URLFromPlaylist(playlistText) {
    if (typeof playlistText !== "string") return null;

    const variantURLs = playlistText.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^https?:\/\/.*\.m3u8(?:[?#].*)?$/i.test(line));

    for (const variantURL of variantURLs) {
        try {
            const url = new URL(variantURL);
            const parts = url.pathname.split("/");
            const variantName = parts.pop() || "";
            const videoDir = parts[parts.length - 1] || "";

            if (videoDir && variantName.toLowerCase().endsWith(".m3u8")) {
                parts.push(videoDir + ".mp4");
                url.pathname = parts.join("/");
                url.search = "";
                url.hash = "";
                return url.href;
            }
        } catch (e) {
            // Try the next playlist URL.
        }
    }

    return null;
}

export function extractDvidsVideoURLFromHTML(html, pageURL = "https://www.dvidshub.net/") {
    if (typeof html !== "string" || html.length === 0) return null;

    if (typeof DOMParser !== "undefined") {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const source = doc.querySelector('video source[type*="video/mp4"][src], source[src$=".mp4"]');
        if (source) {
            const resolved = absolutizeURL(source.getAttribute("src"), pageURL);
            if (resolved) return resolved;
        }
    }

    const sourceRe = /<source\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
    let match;
    while ((match = sourceRe.exec(html)) !== null) {
        const tag = match[0];
        const src = decodeHTMLEntities(match[2].trim());
        if (/\.mp4(?:[?#]|$)/i.test(src) || /\btype\s*=\s*(["'])[^"']*video\/mp4/i.test(tag)) {
            const resolved = absolutizeURL(src, pageURL);
            if (resolved) return resolved;
        }
    }

    const directRe = /https?:\/\/[^"'<>\\\s]+\.mp4(?:\?[^"'<>\\\s]*)?/i;
    const direct = html.match(directRe);
    return direct ? decodeHTMLEntities(direct[0]) : null;
}

export async function resolveDvidsVideoURL(pageURL, fetchImpl = fetch) {
    if (!isDvidsVideoPageURL(pageURL)) return null;

    const videoId = getDvidsVideoId(pageURL);
    if (videoId) {
        try {
            const playlistURL = `https://www.dvidshub.net/video/${videoId}.m3u8`;
            const playlistResponse = await fetchImpl(playlistURL, {mode: "cors", cache: "no-store"});
            if (playlistResponse.ok) {
                const playlistText = await playlistResponse.text();
                const videoURL = deriveDvidsMp4URLFromPlaylist(playlistText);
                if (videoURL) return videoURL;
            }
        } catch (e) {
            console.log(`[DVIDS] Playlist resolver failed, trying Sitrec resolver: ${e.message}`);
        }
    }

    const resolverURL = SITREC_SERVER + "dvidsVideo.php?url=" + encodeURIComponent(pageURL);
    const response = await fetchImpl(resolverURL, {mode: "cors", cache: "no-store"});
    if (!response.ok) {
        let detail = "";
        try {
            const data = await response.json();
            detail = data?.error ? `: ${data.error}` : "";
        } catch (e) {
            // Ignore malformed error bodies.
        }
        throw new Error(`DVIDS resolver failed: ${response.status}${detail}`);
    }
    const data = await response.json();
    if (!data?.videoUrl) {
        throw new Error("DVIDS resolver did not return a video URL");
    }
    return data.videoUrl;
}
