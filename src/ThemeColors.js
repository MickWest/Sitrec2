// Colors for the dark (light ink on black) and light (dark ink on white) themes.
//
// Most drawing code was written for one theme only. convertThemeColor() makes the color
// for the other theme, so a view does not need two full color tables:
//   - A grey (black, white, and all between) is mirrored exactly: black <-> white,
//     #444 <-> #bbb. So a background, a frame, a grid and text keep their contrast order.
//   - A color keeps its hue and saturation. Its lightness is mirrored, and then adjusted
//     until the color is clear on the new background: dark enough for white, light
//     enough for black.
// A color that a view registers for a theme always wins over a calculated one
// (seriesThemeColor).
//
// This file has no imports, so it runs in Jest and in a worker.

const GREY_SATURATION = 0.12;       // less saturation than this is a grey
const MAX_LIGHT_THEME_LIGHTNESS = 0.38;
const MAX_LIGHT_THEME_LUMA = 0.40;  // ink on white: not brighter than this
const MIN_DARK_THEME_LUMA = 0.35;   // ink on black: not darker than this

const NAMED_COLORS = {
    black: "#000000", white: "#ffffff", grey: "#808080", gray: "#808080", silver: "#c0c0c0",
    red: "#ff0000", green: "#008000", lime: "#00ff00", blue: "#0000ff", yellow: "#ffff00",
    cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff", orange: "#ffa500",
    purple: "#800080", maroon: "#800000", navy: "#000080", teal: "#008080", olive: "#808000",
    pink: "#ffc0cb", brown: "#a52a2a",
};

// -> [r, g, b, a] with all four in 0..1, or null for a format that is not known
export function parseColor(color) {
    let text = String(color).trim().toLowerCase();
    if (NAMED_COLORS[text]) text = NAMED_COLORS[text];
    let m = /^#([0-9a-f]{3,8})$/.exec(text);
    if (m) {
        let hex = m[1];
        if (hex.length === 3 || hex.length === 4) hex = hex.replace(/./g, (c) => c + c);
        if (hex.length !== 6 && hex.length !== 8) return null;
        const channel = (i) => parseInt(hex.substr(i, 2), 16) / 255;
        return [channel(0), channel(2), channel(4), hex.length === 8 ? channel(6) : 1];
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
    if (m) return [m[1] / 255, m[2] / 255, m[3] / 255, m[4] === undefined ? 1 : parseFloat(m[4])];
    return null;
}

function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t) => {
        t = (t % 1 + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function formatColor(r, g, b, a) {
    const byte = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    if (a < 1) return `rgba(${byte(r)},${byte(g)},${byte(b)},${a})`;
    return "#" + [r, g, b].map((v) => byte(v).toString(16).padStart(2, "0")).join("");
}

const cache = new Map();

// The color for the target theme, from a color that was made for the OTHER theme.
// toDark = true: the result is for a black background. Alpha does not change.
// A color in a format that is not known comes back with no change.
export function convertThemeColor(color, toDark) {
    const key = (toDark ? "D" : "L") + color;
    let result = cache.get(key);
    if (result !== undefined) return result;

    const rgba = parseColor(color);
    if (!rgba) {
        result = color;
    } else {
        const [h, s, l] = rgbToHsl(rgba[0], rgba[1], rgba[2]);
        let lightness = 1 - l;
        let rgb = hslToRgb(h, s, lightness);
        if (s >= GREY_SATURATION) {
            if (toDark) {
                while (luma(...rgb) < MIN_DARK_THEME_LUMA && lightness < 0.98) {
                    lightness += (1 - lightness) * 0.1;
                    rgb = hslToRgb(h, s, lightness);
                }
            } else {
                lightness = Math.min(lightness, MAX_LIGHT_THEME_LIGHTNESS);
                rgb = hslToRgb(h, s, lightness);
                while (luma(...rgb) > MAX_LIGHT_THEME_LUMA && lightness > 0.02) {
                    lightness *= 0.9;
                    rgb = hslToRgb(h, s, lightness);
                }
            }
        }
        result = formatColor(rgb[0], rgb[1], rgb[2], rgba[3]);
    }
    cache.set(key, result);
    return result;
}

export const lightThemeColor = (darkThemeColor) => convertThemeColor(darkThemeColor, false);
export const darkThemeColor = (lightThemeColor) => convertThemeColor(lightThemeColor, true);

// series = {dark, light?} or {light, dark?}: the registered color for the theme, or a
// calculated one when the series has no color for that theme
export function seriesThemeColor(series, dark) {
    if (dark) return series.dark ?? convertThemeColor(series.light, true);
    return series.light ?? convertThemeColor(series.dark, false);
}
