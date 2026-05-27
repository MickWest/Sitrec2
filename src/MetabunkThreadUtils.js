import {isDvidsVideoPageURL, resolveDvidsVideoURL} from "./DVIDSUtils";
import {isWarGovUFOPageURL, getWarGovUFODvidsIdForPrCode, extractWarGovPRCode, resolveWarGovUFOVideoURL} from "./WarGovUFOUtils";

const METABUNK_THREAD_RE = /^https?:\/\/(?:www\.)?metabunk\.org\/threads\/[^?#]+(?:[?#].*)?$/i;

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
        return new URL(decodeHTMLEntities(candidate), baseURL).href;
    } catch (e) {
        return null;
    }
}

function isIgnoredMetabunkMP4URL(url) {
    try {
        const parsed = new URL(url);
        // Require exact host OR a true subdomain — bare endsWith would also
        // match attacker-controlled hostnames like "evilmetabunk.org".
        // CodeQL: js/incomplete-url-substring-sanitization.
        const onMetabunk = parsed.hostname === "metabunk.org"
            || parsed.hostname.endsWith(".metabunk.org");
        return onMetabunk && parsed.pathname.startsWith("/styles/");
    } catch (e) {
        return false;
    }
}

export function isMetabunkThreadURL(url) {
    if (typeof url !== "string") return false;
    return METABUNK_THREAD_RE.test(url.trim());
}

export function extractMetabunkThreadTitle(html) {
    if (typeof html !== "string") return "";

    if (typeof DOMParser !== "undefined") {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const ogTitle = doc.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.getAttribute("content");
        if (ogTitle) return ogTitle.trim();
        const title = doc.querySelector("title")?.textContent || "";
        return title.replace(/\s*\|\s*Metabunk\s*$/i, "").trim();
    }

    const ogMatch = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i);
    if (ogMatch) return decodeHTMLEntities(ogMatch[1]).trim();

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return titleMatch ? decodeHTMLEntities(titleMatch[1]).replace(/\s*\|\s*Metabunk\s*$/i, "").trim() : "";
}

export function extractMetabunkLinkedURLs(html, pageURL = "https://www.metabunk.org/") {
    if (typeof html !== "string") return [];
    const urls = [];
    const seen = new Set();

    const addURL = candidate => {
        const url = absolutizeURL(candidate, pageURL);
        if (url && !seen.has(url)) {
            seen.add(url);
            urls.push(url);
        }
    };

    if (typeof DOMParser !== "undefined") {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const postRoots = Array.from(doc.querySelectorAll(".message-body, .bbWrapper, article.message"));
        const linkedElements = postRoots.length > 0
            ? postRoots.flatMap(root => Array.from(root.querySelectorAll("a[href], source[src], video[src]")))
            : Array.from(doc.querySelectorAll("a[href], source[src], video[src]"));

        linkedElements.forEach(element => addURL(element.getAttribute("href") || element.getAttribute("src")));
    } else {
        const urlAttributeRe = /\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi;
        let match;
        while ((match = urlAttributeRe.exec(html)) !== null) {
            addURL(match[2]);
        }
    }

    const bareURLRe = /https?:\/\/[^\s"'<>]+/gi;
    let bareMatch;
    while ((bareMatch = bareURLRe.exec(html)) !== null) {
        addURL(bareMatch[0]);
    }

    const decodedHTML = decodeHTMLEntities(html);
    const mp4PathRe = /(?:https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\.mp4(?:\?[^\s"'<>]*)?/gi;
    let mp4PathMatch;
    while ((mp4PathMatch = mp4PathRe.exec(decodedHTML)) !== null) {
        addURL(mp4PathMatch[0]);
    }

    return urls;
}

export async function resolveMetabunkThreadVideoURL(threadURL, fetchImpl = fetch) {
    if (!isMetabunkThreadURL(threadURL)) return null;

    const urlPrCode = extractWarGovPRCode(threadURL);
    if (urlPrCode) {
        try {
            const dvidsId = await getWarGovUFODvidsIdForPrCode(urlPrCode, fetchImpl);
            if (dvidsId) {
                return resolveDvidsVideoURL(`https://www.dvidshub.net/video/${dvidsId}`, fetchImpl);
            }
        } catch (error) {}
    }

    const response = await fetchImpl(threadURL, {mode: "cors", cache: "no-store"});
    if (!response.ok) {
        throw new Error(`Metabunk thread fetch failed: ${response.status}`);
    }

    const html = await response.text();
    const title = extractMetabunkThreadTitle(html);
    const titlePrCode = extractWarGovPRCode(title);
    if (titlePrCode) {
        const dvidsId = await getWarGovUFODvidsIdForPrCode(titlePrCode, fetchImpl);
        if (dvidsId) {
            return resolveDvidsVideoURL(`https://www.dvidshub.net/video/${dvidsId}`, fetchImpl);
        }
    }

    const linkedURLs = extractMetabunkLinkedURLs(html, threadURL);

    for (const url of linkedURLs) {
        if (isDvidsVideoPageURL(url)) {
            return resolveDvidsVideoURL(url, fetchImpl);
        }
        if (isWarGovUFOPageURL(url)) {
            return resolveWarGovUFOVideoURL(url, fetchImpl);
        }
    }

    const directMP4 = linkedURLs.find(url => /\.mp4(?:[?#]|$)/i.test(url) && !isIgnoredMetabunkMP4URL(url));
    if (directMP4) return directMP4;

    throw new Error(`No DVIDS, war.gov, or MP4 video link found in Metabunk thread: ${threadURL}`);
}
