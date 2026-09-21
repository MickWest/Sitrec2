import {convertThemeColor, darkThemeColor, lightThemeColor, parseColor, seriesThemeColor} from "../src/ThemeColors";

// weighted brightness of a color, 0 (black) to 1 (white)
function luma(color) {
    const [r, g, b] = parseColor(color);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const channels = (color) => parseColor(color).slice(0, 3).map((v) => Math.round(v * 255));

describe("ThemeColors", () => {
    test("greys mirror exactly, so a background changes with the ink", () => {
        expect(lightThemeColor("#000000")).toBe("#ffffff");
        expect(lightThemeColor("#ffffff")).toBe("#000000");
        expect(lightThemeColor("#fff")).toBe("#000000");
        expect(lightThemeColor("#444")).toBe("#bbbbbb");
        expect(darkThemeColor("white")).toBe("#000000");
        expect(darkThemeColor("black")).toBe("#ffffff");
    });

    test("a bright color becomes a darker color of the same hue for the light theme", () => {
        const [r, g, b] = channels(lightThemeColor("#f08020"));
        expect(r).toBeGreaterThan(g);   // still orange: red > green > blue
        expect(g).toBeGreaterThan(b);
        expect(luma(lightThemeColor("#f08020"))).toBeLessThan(luma("#f08020"));

        const [r2, g2, b2] = channels(lightThemeColor("#2a8cf0"));
        expect(b2).toBeGreaterThan(g2); // still blue: blue > green > red
        expect(g2).toBeGreaterThan(r2);
    });

    test("every color is dark enough for a white background", () => {
        for (const color of ["#ffff00", "#44aaff", "#ff4444", "#44ff44", "#f08020", "#4ff", "yellow"]) {
            expect(luma(lightThemeColor(color))).toBeLessThan(0.45);
        }
    });

    test("every color is light enough for a black background", () => {
        for (const color of ["blue", "red", "green", "maroon", "navy", "#800000", "#0a4fb4"]) {
            expect(luma(darkThemeColor(color))).toBeGreaterThan(0.3);
        }
        const [r, g, b] = channels(darkThemeColor("blue"));
        expect(b).toBeGreaterThan(r);   // still blue
        expect(b).toBeGreaterThan(g);
    });

    test("alpha does not change", () => {
        expect(lightThemeColor("rgba(255,255,255,0.22)")).toBe("rgba(0,0,0,0.22)");
        expect(parseColor(darkThemeColor("rgba(0, 0, 0, 0.5)"))[3]).toBe(0.5);
    });

    test("a color in a format that is not known comes back with no change", () => {
        expect(convertThemeColor("hsl(10, 20%, 30%)", true)).toBe("hsl(10, 20%, 30%)");
        expect(convertThemeColor("transparent", false)).toBe("transparent");
    });

    test("a registered color wins over the calculated one", () => {
        expect(seriesThemeColor({dark: "#ffffff", light: "#123456"}, false)).toBe("#123456");
        expect(seriesThemeColor({dark: "#ffffff", light: "#123456"}, true)).toBe("#ffffff");
        expect(seriesThemeColor({dark: "#ffffff"}, false)).toBe("#000000");
        expect(seriesThemeColor({light: "#000000"}, true)).toBe("#ffffff");
    });
});
