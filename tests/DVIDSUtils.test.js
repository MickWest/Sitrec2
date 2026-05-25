import {
    deriveDvidsMp4URLFromPlaylist,
    extractDvidsVideoURLFromHTML,
    getDvidsVideoId,
    isDvidsVideoPageURL,
} from "../src/DVIDSUtils";

describe("DVIDSUtils", () => {
    test("identifies DVIDS video pages", () => {
        expect(isDvidsVideoPageURL("https://www.dvidshub.net/video/1007735/dow-uap-pr061")).toBe(true);
        expect(isDvidsVideoPageURL("https://www.dvidshub.net/video/embed/1007735")).toBe(true);
        expect(isDvidsVideoPageURL("https://www.dvidshub.net/image/1007735/example")).toBe(false);
        expect(isDvidsVideoPageURL("https://example.com/video/1007735")).toBe(false);
    });

    test("extracts the DVIDS video id", () => {
        expect(getDvidsVideoId("https://www.dvidshub.net/video/1007735/dow-uap-pr061")).toBe("1007735");
        expect(getDvidsVideoId("https://www.dvidshub.net/video/embed/1007735")).toBe("1007735");
    });

    test("derives the original MP4 URL from the DVIDS HLS playlist", () => {
        const playlist = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2237000
https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719828/DOD_111719828-1280x720-4900k-hls_1.m3u8`;

        expect(deriveDvidsMp4URLFromPlaylist(playlist)).toBe(
            "https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719828/DOD_111719828.mp4"
        );
    });

    test("extracts the MP4 source from a DVIDS video element", () => {
        const html = `
            <video>
                <source src="/video/1007735.m3u8" type="application/x-mpegURL" />
                <source src="https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719828/DOD_111719828.mp4" type='video/mp4; codecs="avc1.42E01E, mp4a.40.2"' />
            </video>`;

        expect(extractDvidsVideoURLFromHTML(html)).toBe(
            "https://d34w7g4gy10iej.cloudfront.net/video/2605/DOD_111719828/DOD_111719828.mp4"
        );
    });

    test("resolves relative MP4 sources against the page URL", () => {
        const html = `<source src="/video/example.mp4" type="video/mp4">`;

        expect(extractDvidsVideoURLFromHTML(html, "https://www.dvidshub.net/video/100")).toBe(
            "https://www.dvidshub.net/video/example.mp4"
        );
    });
});
