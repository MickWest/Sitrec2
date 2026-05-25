import {resolveDvidsVideoURL} from "./DVIDSUtils";

const WAR_GOV_UFO_PAGE_RE = /^https?:\/\/(?:www\.)?war\.gov\/ufo\/?(?:[?#].*)?$/i;
const WAR_GOV_CSV_PATHS = [
    "data/WARGOV/uap-data.csv",
    "data/WARGOV/uap-release001.csv",
];

let warGovCatalogPromise = null;

export function isWarGovUFOPageURL(url) {
    if (typeof url !== "string") return false;
    return WAR_GOV_UFO_PAGE_RE.test(url.trim());
}

export function getWarGovUFORecordKey(url) {
    if (!isWarGovUFOPageURL(url)) return null;
    try {
        const parsed = new URL(url);
        const hash = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)).trim() : "";
        return hash || null;
    } catch (e) {
        return null;
    }
}

export function getWarGovUFOPrCode(url) {
    const recordKey = getWarGovUFORecordKey(url);
    return extractWarGovPRCode(recordKey);
}

export function extractWarGovPRCode(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/\bPR-?(\d{3})\b/i);
    return match ? `PR${match[1]}` : null;
}

export function normalizeWarGovRecordText(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/^\uFEFF/, "")
        .replace(/&/g, " and ")
        .replace(/\[|\]/g, "")
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
}

export function parseWarGovCSV(csvText) {
    const rows = parseCSVRows(csvText);
    if (rows.length < 2) return [];

    const headers = rows[0].map(header => String(header || "").replace(/^\uFEFF/, "").trim());
    return rows.slice(1)
        .map(row => {
            const record = {};
            for (let i = 0; i < headers.length; i++) {
                record[headers[i]] = row[i] ?? "";
            }
            return record;
        })
        .filter(record => record.Title || record["DVIDS Video ID"]);
}

export function findWarGovUFORecord(records, pageURL) {
    const recordKey = getWarGovUFORecordKey(pageURL);
    const prCode = getWarGovUFOPrCode(pageURL);
    const normalizedKey = normalizeWarGovRecordText(recordKey);

    return records.find(record => {
        const dvidsId = String(record["DVIDS Video ID"] || "").trim();
        if (!dvidsId) return false;

        const title = String(record.Title || "");
        const titlePrCode = extractWarGovPRCode(title);
        if (prCode && titlePrCode === prCode) return true;

        return normalizedKey && normalizeWarGovRecordText(title) === normalizedKey;
    }) || null;
}

export async function loadWarGovUFOCatalog(fetchImpl = fetch) {
    if (!warGovCatalogPromise) {
        warGovCatalogPromise = (async () => {
            const catalog = [];

            for (const path of WAR_GOV_CSV_PATHS) {
                const response = await fetchImpl(path, {cache: "no-store"});
                if (!response.ok) {
                    throw new Error(`Failed to load ${path}: ${response.status}`);
                }

                const text = await response.text();
                catalog.push({
                    path,
                    records: parseWarGovCSV(text),
                });
            }

            return catalog;
        })();
    }

    return warGovCatalogPromise;
}

export function resetWarGovUFOCatalogCacheForTests() {
    warGovCatalogPromise = null;
}

export async function getWarGovUFODvidsId(url, fetchImpl = fetch) {
    const catalog = await loadWarGovUFOCatalog(fetchImpl);

    for (const source of catalog) {
        const record = findWarGovUFORecord(source.records, url);
        const dvidsId = String(record?.["DVIDS Video ID"] || "").trim();
        if (dvidsId) return dvidsId;
    }

    return null;
}

export async function resolveWarGovUFOVideoURL(pageURL, fetchImpl = fetch) {
    if (!isWarGovUFOPageURL(pageURL)) return null;

    const dvidsId = await getWarGovUFODvidsId(pageURL, fetchImpl);
    if (!dvidsId) {
        const recordKey = getWarGovUFORecordKey(pageURL) || pageURL;
        throw new Error(`No DVIDS video ID found for war.gov UFO record: ${recordKey}`);
    }

    return resolveDvidsVideoURL(`https://www.dvidshub.net/video/${dvidsId}`, fetchImpl);
}

function parseCSVRows(csvText) {
    const rows = [];
    let row = [];
    let value = "";
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        const next = csvText[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                value += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === "," && !inQuotes) {
            row.push(value);
            value = "";
            continue;
        }

        if ((char === "\n" || char === "\r") && !inQuotes) {
            if (char === "\r" && next === "\n") i++;
            row.push(value);
            if (row.some(cell => cell !== "")) rows.push(row);
            row = [];
            value = "";
            continue;
        }

        value += char;
    }

    row.push(value);
    if (row.some(cell => cell !== "")) rows.push(row);
    return rows;
}
