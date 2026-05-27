import {
    extractMetabunkLinkedURLs,
    extractMetabunkThreadTitle,
    isMetabunkThreadURL,
    resolveMetabunkThreadVideoURL,
} from "../src/MetabunkThreadUtils";
import {resetWarGovUFOCatalogCacheForTests} from "../src/WarGovUFOUtils";

const threadURL = "https://www.metabunk.org/threads/dow-uap-pr067-multiple-spherical-uap-uso-near-sub.14898/#post-369687";

const warCsv = `Redaction,Release Date,Title,Type,Video Pairing,PDF Pairing,Description Blurb,DVIDS Video ID,Video Title
TRUE,5/22/26,"DOW-UAP-PR067, ""Multiple Spherical UAP USO near Sub. [CALLSIGN] 2022/03/25 in and out of water""",VID,,,description,1007779,`;

function response(body, ok = true, status = 200) {
    return {ok, status, text: async () => body};
}

function makeFetchForTitlePriority() {
    return jest.fn(async (url) => {
        if (url === threadURL) {
            return response(`<html><head><meta property="og:title" content="DOW-UAP-PR067 Multiple Spherical UAP USO near Sub"></head><body>
                <article class="message"><div class="bbWrapper">
                    <a href="https://example.com/fallback.mp4">fallback</a>
                </div></article>
            </body></html>`);
        }
        if (url === "data/WARGOV/uap-data.csv") return response(warCsv);
        if (url === "data/WARGOV/uap-release001.csv") return response("");
        if (url === "https://www.dvidshub.net/video/1007779.m3u8") {
            return response(`#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=123
https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719900/DOD_111719900-1280x720-hls_1.m3u8`);
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
}

describe("MetabunkThreadUtils", () => {
    beforeEach(() => {
        resetWarGovUFOCatalogCacheForTests();
    });

    test("identifies Metabunk thread URLs", () => {
        expect(isMetabunkThreadURL(threadURL)).toBe(true);
        expect(isMetabunkThreadURL("https://www.metabunk.org/posts/123")).toBe(false);
        expect(isMetabunkThreadURL("https://example.com/threads/foo.1/")).toBe(false);
    });

    test("extracts thread title and linked URLs", () => {
        const html = `<title>Thread Title | Metabunk</title>
            <article class="message"><div class="bbWrapper">
                <a href="/attachments/example.mp4">video</a>
                <video controls><source src="/data/video/88/88889-47caef3ee85144bbbc29350deb1fa9fb.mp4?hash=2YVlVyLCCq" /></video>
                <a href="https://www.war.gov/ufo/#DOW-UAP-PR067-example">war</a>
            </div></article>`;

        expect(extractMetabunkThreadTitle(html)).toBe("Thread Title");
        expect(extractMetabunkLinkedURLs(html, "https://www.metabunk.org/threads/example.1/")).toEqual([
            "https://www.metabunk.org/attachments/example.mp4",
            "https://www.metabunk.org/data/video/88/88889-47caef3ee85144bbbc29350deb1fa9fb.mp4?hash=2YVlVyLCCq",
            "https://www.war.gov/ufo/#DOW-UAP-PR067-example",
        ]);
    });

    test("resolves title PR code before post MP4 links", async () => {
        await expect(resolveMetabunkThreadVideoURL(threadURL, makeFetchForTitlePriority())).resolves.toBe(
            "https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719900/DOD_111719900.mp4"
        );
    });

    test("resolves PR code from the thread URL before fetching Metabunk HTML", async () => {
        const pr072URL = "https://www.metabunk.org/threads/dow-uap-pr072-administrative-revision-iir-1777-j0032-22-kazakhstan.14909/";
        const fetchImpl = jest.fn(async (url) => {
            if (url === pr072URL) throw new Error("thread HTML should not be fetched");
            if (url === "data/WARGOV/uap-data.csv") {
                return response(`Redaction,Release Date,Title,Type,Video Pairing,PDF Pairing,Description Blurb,DVIDS Video ID,Video Title
,5/22/26,"DOW-UAP-PR072, ""ADMINISTRATIVE REVISION: IIR 1777 J0032 22 Kazakhstan""",VID,,,description,1007788,`);
            }
            if (url === "data/WARGOV/uap-release001.csv") return response("");
            if (url === "https://www.dvidshub.net/video/1007788.m3u8") {
                return response(`#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=123
https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719922/DOD_111719922-1280x720-hls_1.m3u8`);
            }
            throw new Error(`unexpected fetch: ${url}`);
        });

        await expect(resolveMetabunkThreadVideoURL(pr072URL, fetchImpl)).resolves.toBe(
            "https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719922/DOD_111719922.mp4"
        );
        expect(fetchImpl).not.toHaveBeenCalledWith(pr072URL, expect.anything());
    });

    test("resolves DVIDS links in posts when the title has no mapped PR", async () => {
        const fetchImpl = jest.fn(async (url) => {
            if (url === threadURL) {
                return response(`<html><head><title>No PR | Metabunk</title></head><body>
                    <div class="bbWrapper"><a href="https://www.dvidshub.net/video/1007706/example">dvids</a></div>
                </body></html>`);
            }
            if (url === "https://www.dvidshub.net/video/1007706.m3u8") {
                return response(`#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=123
https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719709/DOD_111719709-640x360-hls_1.m3u8`);
            }
            throw new Error(`unexpected fetch: ${url}`);
        });

        await expect(resolveMetabunkThreadVideoURL(threadURL, fetchImpl)).resolves.toBe(
            "https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719709/DOD_111719709.mp4"
        );
    });

    test("falls back to direct MP4 links", async () => {
        const fetchImpl = jest.fn(async (url) => {
            expect(url).toBe(threadURL);
            return response(`<html><head><title>No PR | Metabunk</title></head><body>
                <div class="bbWrapper"><a href="https://cdn.example.com/source.mp4?download=1">mp4</a></div>
            </body></html>`);
        });

        await expect(resolveMetabunkThreadVideoURL(threadURL, fetchImpl)).resolves.toBe(
            "https://cdn.example.com/source.mp4?download=1"
        );
    });

    test("falls back to relative XenForo video source MP4 links", async () => {
        const fetchImpl = jest.fn(async (url) => {
            expect(url).toBe(threadURL);
            return response(`<html><head><title>No PR | Metabunk</title></head><body>
                <video src="/styles/default/xenforo/add_to_home.mp4"></video>
                <article class="message"><div class="bbWrapper">
                    <video controls>
                        <source src="/data/video/88/88889-47caef3ee85144bbbc29350deb1fa9fb.mp4?hash=2YVlVyLCCq" />
                    </video>
                </div></article>
            </body></html>`);
        });

        await expect(resolveMetabunkThreadVideoURL(threadURL, fetchImpl)).resolves.toBe(
            "https://www.metabunk.org/data/video/88/88889-47caef3ee85144bbbc29350deb1fa9fb.mp4?hash=2YVlVyLCCq"
        );
    });

    test("finds raw relative MP4 paths when video source markup is escaped", async () => {
        const fetchImpl = jest.fn(async (url) => {
            expect(url).toBe(threadURL);
            return response(`<html><head><title>No PR | Metabunk</title></head><body>
                &lt;source src=&quot;/data/video/88/88890-eb97867a2fc323de763ef02cb208b2ec.mp4?hash=xhlQ9RXH7V&quot; /&gt;
            </body></html>`);
        });

        await expect(resolveMetabunkThreadVideoURL(threadURL, fetchImpl)).resolves.toBe(
            "https://www.metabunk.org/data/video/88/88890-eb97867a2fc323de763ef02cb208b2ec.mp4?hash=xhlQ9RXH7V"
        );
    });
});
