import {
    extractWarGovPRCode,
    getAaroDvidsIdForPrCode,
    getWarGovUFODvidsId,
    getWarGovUFODvidsIdForPrCode,
    getWarGovUFOPrCode,
    getWarGovUFORecordKey,
    isWarGovUFOPageURL,
    parseWarGovCSV,
    resetWarGovUFOCatalogCacheForTests,
    resolveWarGovUFOVideoURL,
} from "../src/WarGovUFOUtils";

const pr050URL = "https://www.war.gov/ufo/#DOW-UAP-PR050-4-UAP-Formation-Iran-26-Aug-2022-over-water-CALLSIGN";
const pr099URL = "https://www.war.gov/UFO/?search=PR099#DOW-UAP-PR099-Hi-Res-CALLSIGN-Observes-UAP-on-25SEP19-at-1715Z";
const uapDataCsv = `\uFEFFRedaction,Release Date,Title,Type,Video Pairing,PDF Pairing,Description Blurb,DVIDS Video ID,Video Title
TRUE,5/22/26,"DOW-UAP-PR050, ""4 UAP Formation Iran 26 Aug 2022 over water [CALLSIGN]""",VID,,,"line one
line two",1007706,
TRUE,5/22/26,"DOW-UAP-PR099, ""Hi-Res: [CALLSIGN] Observes UAP on 25SEP19 at 1715Z""",VID,,,description,1007738,`;
const releaseCsv = `Redaction,Release Date,Title,Type,Video Pairing,PDF Pairing,Description Blurb,DVIDS Video ID,Video Title
TRUE,5/8/26,"DOW-UAP-PR019, ""fallback video""",VID,,,description,1007001,`;

function makeWarGovFetch() {
    return jest.fn(async (url) => {
        if (url === "data/WARGOV/uap-data.csv") {
            return {ok: true, text: async () => uapDataCsv};
        }
        if (url === "data/WARGOV/uap-release001.csv") {
            return {ok: true, text: async () => releaseCsv};
        }
        if (url === "https://www.dvidshub.net/video/1007706.m3u8") {
            return {
                ok: true,
                text: async () => `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1412000
https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719709/DOD_111719709-640x360-3066k-hls_1.m3u8`,
            };
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
}

describe("WarGovUFOUtils", () => {
    beforeEach(() => {
        resetWarGovUFOCatalogCacheForTests();
    });

    test("identifies war.gov UFO catalog URLs", () => {
        expect(isWarGovUFOPageURL(pr050URL)).toBe(true);
        expect(isWarGovUFOPageURL(pr099URL)).toBe(true);
        expect(isWarGovUFOPageURL("https://www.war.gov/news/")).toBe(false);
        expect(isWarGovUFOPageURL("https://example.com/ufo/")).toBe(false);
    });

    test("extracts the hash record key and PR code", () => {
        expect(getWarGovUFORecordKey(pr050URL)).toBe("DOW-UAP-PR050-4-UAP-Formation-Iran-26-Aug-2022-over-water-CALLSIGN");
        expect(getWarGovUFOPrCode(pr050URL)).toBe("PR050");
        expect(getWarGovUFOPrCode(pr099URL)).toBe("PR099");
    });

    test("parses quoted multiline war.gov CSV rows", () => {
        const records = parseWarGovCSV(uapDataCsv);

        expect(records).toHaveLength(2);
        expect(records[0].Title).toBe('DOW-UAP-PR050, "4 UAP Formation Iran 26 Aug 2022 over water [CALLSIGN]"');
        expect(records[0]["Description Blurb"]).toBe("line one\nline two");
        expect(records[0]["DVIDS Video ID"]).toBe("1007706");
    });

    test("maps war.gov PR records to DVIDS IDs from local CSVs", async () => {
        const fetchImpl = makeWarGovFetch();

        await expect(getWarGovUFODvidsId(pr050URL, fetchImpl)).resolves.toBe("1007706");
        await expect(getWarGovUFODvidsId(pr099URL, fetchImpl)).resolves.toBe("1007738");
        await expect(getWarGovUFODvidsId("https://www.war.gov/ufo/#DOW-UAP-PR019-fallback-video", fetchImpl)).resolves.toBe("1007001");
    });

    test("resolves known war.gov PR records through the DVIDS playlist path", async () => {
        const fetchImpl = makeWarGovFetch();

        await expect(resolveWarGovUFOVideoURL(pr050URL, fetchImpl)).resolves.toBe(
            "https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719709/DOD_111719709.mp4"
        );
    });

    // AARO "Official UAP Imagery" cases PR-001..PR-018 (not in the war.gov CSVs).
    const AARO_EXPECTED = {
        PR001: "973045", PR002: "973048", PR003: "973055", PR004: "977221",
        PR005: "977834", PR006: "977837", PR007: "977838", PR008: "977839",
        PR009: "977840", PR010: "976937", PR011: "992261", PR012: "989428",
        PR013: "992262", PR014: "989429", PR015: "989430", PR016: "988673",
        PR017: "988675", PR018: "988676",
    };

    test("maps every AARO PR code (PR001..PR018) to its DVIDS ID", () => {
        for (const [pr, id] of Object.entries(AARO_EXPECTED)) {
            expect(getAaroDvidsIdForPrCode(pr)).toBe(id);
        }
        // Out of the AARO range -> not in the fixed table.
        expect(getAaroDvidsIdForPrCode("PR019")).toBeNull();
        expect(getAaroDvidsIdForPrCode("PR050")).toBeNull();
    });

    test("extracts single-digit PR codes and normalises to 3 digits", () => {
        expect(extractWarGovPRCode("PR1")).toBe("PR001");
        expect(extractWarGovPRCode("PR5")).toBe("PR005");
        expect(extractWarGovPRCode("PR18")).toBe("PR018");
        expect(extractWarGovPRCode("PR-9")).toBe("PR009");
    });

    test("resolves AARO PR codes without consulting the war.gov CSVs", async () => {
        // fetchImpl throws if the catalog is loaded — proves the AARO short-circuit.
        const noFetch = jest.fn(async () => { throw new Error("CSV should not be fetched for AARO codes"); });
        await expect(getWarGovUFODvidsIdForPrCode("PR001", noFetch)).resolves.toBe("973045");
        await expect(getWarGovUFODvidsId("https://www.war.gov/ufo/#PR018", noFetch)).resolves.toBe("988676");
        expect(noFetch).not.toHaveBeenCalled();
    });
});
