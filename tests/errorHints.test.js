const { tileLoadHint, resetTileLoadHints, customSitchLoadHint } = require("../src/errorHints");

const page = "https://sitrec.example.test:8443/?sitch=custom";

describe("customSitchLoadHint", () => {
    test("a 404 in the server's upload directory explains scratch storage and names the fix", () => {
        const hint = customSitchLoadHint({ url: "https://sitrec.example.test:8443/sitrec-upload/42/Test/20260902_201052_c3a1b3b8600b.js", status: 404, pageUrl: page });
        expect(hint).toContain("upload directory, and it is no longer there");
        expect(hint).toContain("emptied when the container is replaced or restarted");
        expect(hint).toContain("SAVE_TO_S3");
        expect(hint).toContain("/var/www/html/sitrec-upload");
    });

    test("a 404 elsewhere, a refusal, another status, and no answer each get their own sentence", () => {
        expect(customSitchLoadHint({ url: "https://sitrec.example.test:8443/u/abc", status: 404, pageUrl: page })).toContain("This site has no file at that address");
        expect(customSitchLoadHint({ url: "https://other.example/x.js", status: "404", pageUrl: page })).toContain("other.example has no file at that address");
        expect(customSitchLoadHint({ url: "https://sitrec.example.test:8443/sitrec-upload/7/x.js", status: 403, pageUrl: page })).toContain("Under client certificate authentication");
        expect(customSitchLoadHint({ url: "https://sitrec.example.test:8443/x.js", status: 502, pageUrl: page })).toContain("answered HTTP 502");
        expect(customSitchLoadHint({ url: "https://gone.example/x.js", errorMessage: "TypeError: Failed to fetch", pageUrl: page })).toContain("No answer from gone.example");
    });

    test("never throws and says nothing for an unknown failure", () => {
        expect(() => customSitchLoadHint()).not.toThrow();
        expect(customSitchLoadHint({ url: "::bad::", errorMessage: "odd", pageUrl: "also bad" })).toBe("");
    });
});

describe("tileLoadHint", () => {
    beforeEach(() => resetTileLoadHints());

    test("says each thing once per source and kind of failure, so a tile flood does not repeat it", () => {
        const facts = { sourceName: "Local", url: "https://sitrec.example.test/sitrec-terrain/imagery/esri/4/8/15.jpg", errorMessage: "HTTP 404", pageUrl: page, secureBuild: false };
        expect(tileLoadHint(facts)).not.toBe("");
        expect(tileLoadHint({ ...facts, url: facts.url.replace("15", "16") })).toBe("");
        expect(tileLoadHint({ ...facts, errorMessage: "ServiceUnavailable" })).not.toBe("");
        expect(tileLoadHint({ ...facts, sourceName: "Other" })).not.toBe("");
        resetTileLoadHints();
        expect(tileLoadHint(facts)).not.toBe("");
    });

    test("a 404 on the pre-downloaded tile directory names the directory, the mount point and the setting", () => {
        const hint = tileLoadHint({
            sourceName: "Local",
            url: "https://sitrec.example.test:8443/sitrec-terrain/imagery/esri/0/0/0.jpg",
            errorMessage: "HTTP 404",
            pageUrl: page,
            secureBuild: false,
        });
        expect(hint).toContain('"Local" source reads pre-downloaded tiles from https://sitrec.example.test:8443/sitrec-terrain/imagery/esri/0/0/');
        expect(hint).toContain("/var/www/html/sitrec-terrain");
        expect(hint).toContain("SITREC_TERRAIN_URL");
        expect(hint).toContain("docs/dev/CustomTerrainSources.md");
        expect(hint).not.toContain("secure build");
    });

    test("a 404 from a remote provider points at the URL template and maximum zoom", () => {
        const hint = tileLoadHint({
            sourceName: "Imagery",
            url: "https://tiles.internal.example/imagery/22/1/2.jpg",
            errorMessage: "Error: HTTP 404",
            pageUrl: page,
            secureBuild: false,
        });
        expect(hint).toContain("tiles.internal.example has no tile at that address");
        expect(hint).toContain("SITREC_CUSTOM_MAP_<NAME>_URL");
    });

    test("a 404 on the site's own origin says the path does not exist", () => {
        const hint = tileLoadHint({
            sourceName: "Mirror",
            url: "https://sitrec.example.test:8443/mirror/7/1/2.png",
            errorMessage: "HTTP 404",
            pageUrl: page,
            secureBuild: false,
        });
        expect(hint).toContain("served by this site, but the tile path does not exist");
    });

    test("401 and 403 point at a missing or blank key; other statuses are reported plainly", () => {
        expect(tileLoadHint({ sourceName: "MapBox", url: "https://api.example/1/1/1.jpg", errorMessage: "HTTP 401", pageUrl: page, secureBuild: false }))
            .toContain("key or token that is missing, blank or expired");
        expect(tileLoadHint({ sourceName: "X", url: "https://api.example/1/1/1.jpg", errorMessage: "HTTP 502", pageUrl: page, secureBuild: false }))
            .toContain("answered HTTP 502");
    });

    test("the follow-on 'ServiceUnavailable' error points back at the first failure", () => {
        const hint = tileLoadHint({ sourceName: "Local", url: "https://sitrec.example.test/sitrec-terrain/imagery/esri/4/8/15.jpg", errorMessage: "Error: ServiceUnavailable", pageUrl: page, secureBuild: false });
        expect(hint).toContain('Earlier requests to "Local" source failed');
        expect(hint).toContain("the first failure, above in the console, says why");
    });

    test("a network failure names the host and the isolated-network case", () => {
        const hint = tileLoadHint({
            sourceName: "ESRI",
            url: "https://services.example/tile/1/1/1",
            errorMessage: "TypeError: Failed to fetch",
            pageUrl: page,
            secureBuild: false,
        });
        expect(hint).toContain("No answer from services.example");
        expect(hint).toContain("isolated network");
    });

    test("the secure build adds its own sentence, and an unknown error yields only that", () => {
        const hint = tileLoadHint({ sourceName: "Local", url: "x", errorMessage: "Something odd", pageUrl: page, secureBuild: true });
        expect(hint).toBe("This is the secure build: the built-in internet providers are disabled at compile time, so the map can show only the sources this deployment defines. See docs/dev/Secure-Build.md.");
        expect(tileLoadHint({ sourceName: "Local", url: "x", errorMessage: "Something odd", pageUrl: page, secureBuild: false })).toBe("");
    });

    test("never throws on missing or malformed facts", () => {
        expect(() => tileLoadHint()).not.toThrow();
        expect(() => tileLoadHint({ url: "::not a url::", errorMessage: null, pageUrl: "also bad", secureBuild: false })).not.toThrow();
        expect(tileLoadHint({ errorMessage: "HTTP 404", secureBuild: false })).toContain("has no tile at that address");
    });
});
