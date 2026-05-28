import {getDisplayFilename} from "../src/FilenameUtils";

describe("getDisplayFilename", () => {
    test("extracts and decodes the final URL path segment", () => {
        expect(getDisplayFilename("https://example.com/video/My%20Clip%201.mp4?token=abc"))
            .toBe("My Clip 1.mp4");
    });

    test("handles plain local paths", () => {
        expect(getDisplayFilename("/Users/example/Videos/PR055-5Pct.mp4"))
            .toBe("PR055-5Pct.mp4");
    });
});
