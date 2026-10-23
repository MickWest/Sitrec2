// CNodeViewUI text (the look view date/time, the compass heading, sitch labels) is
// drawn with a thin outline under the fill, so it reads on a background of its own
// color. The base view, CUIText and the HUD color are replaced by stubs so the real
// renderCanvas text loop runs against a recording 2D context.
jest.mock("../src/nodes/CNodeViewCanvas", () => ({
    CNodeViewCanvas2D: class {
        constructor(v) {
            this.overlayView = v.overlayView;
            this.widthPx = 800;
            this.heightPx = 450;
            this.visible = true;
        }
        ignoreMouseEvents() {}
        inheritSize() {}
        renderCanvas() {}
        setVisible(visible) { this.visible = visible; }
    },
}));
jest.mock("../src/nodes/CNodeView", () => ({
    CUIText: class {
        constructor(text, x, y, size, color, align, font) {
            Object.assign(this, {text, x: x / 100, y: y / 100, size: size / 100, color, align, font});
            this.boxed = false;
            this.boxGap = 2;
            this.visible = true;
        }
        checkListener() {}
    },
}));
jest.mock("../src/Globals", () => ({
    NodeMan: {exists: () => false, get: () => undefined, iterate: () => {}},
    setRenderOne: () => {},
}));
jest.mock("../src/utils", () => ({
    cos: Math.cos, sin: Math.sin, radians: (d) => d * Math.PI / 180,
    getTextBBox: () => ({left: -50, top: -12, width: 50, height: 12}),
}));
let mockHUDColor = "#ffffff";
jest.mock("../src/HUDColor", () => ({
    resolveHUDColor: (color) => color === "hud" ? mockHUDColor : color,
}));

import {CNodeViewUI} from "../src/nodes/CNodeViewUI";

// A 2D context that records each draw with the state it was drawn in.
function recordingContext() {
    const stack = [];
    const ctx = {
        font: "10px sans-serif", fillStyle: "#000000", strokeStyle: "#000000",
        lineWidth: 1, lineJoin: "miter", textAlign: "start",
        draws: [],
        save() { stack.push({...this}); },
        restore() {
            const s = stack.pop();
            for (const k of ["font", "fillStyle", "strokeStyle", "lineWidth", "lineJoin", "textAlign"]) this[k] = s[k];
        },
        record(op, text, x, y) {
            this.draws.push({op, text, x, y, font: this.font, fillStyle: this.fillStyle,
                strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, lineJoin: this.lineJoin});
        },
        fillText(text, x, y) { this.record("fill", text, x, y); },
        strokeText(text, x, y) { this.record("stroke", text, x, y); },
        strokeRect() { this.record("rect"); },
    };
    return ctx;
}

// The look view date/time line as AddTimeDisplayToUI adds it: 16px, HUD color.
function drawTimeDisplay({color = "hud", size = -16, boxed = false} = {}) {
    const ui = new CNodeViewUI({id: "labelVideo", overlayView: {visible: true}});
    ui.ctx = recordingContext();
    const t = ui.addText("videoTimeLabelUTC", "2024-09-12 02:53:31.150 UTC", 99.5, 3, size, color, "right");
    t.boxed = boxed;
    ui.renderCanvas(0);
    return ui.ctx.draws;
}

beforeEach(() => {
    mockHUDColor = "#ffffff";
});

test("light text gets a thin black outline drawn under the fill", () => {
    const [stroke, fill] = drawTimeDisplay();
    expect(stroke).toMatchObject({op: "stroke", strokeStyle: "#000000", lineWidth: 2, lineJoin: "round"});
    expect(fill).toMatchObject({op: "fill", fillStyle: "#ffffff"});
    expect([stroke.text, stroke.x, stroke.y]).toEqual([fill.text, fill.x, fill.y]);
});

test("the outline follows the HUD color: black for yellow, white for dark text", () => {
    mockHUDColor = "#ffff00";
    expect(drawTimeDisplay()[0]).toMatchObject({op: "stroke", strokeStyle: "#000000"});
    mockHUDColor = "#000080";
    expect(drawTimeDisplay()[0]).toMatchObject({op: "stroke", strokeStyle: "#ffffff"});
    expect(drawTimeDisplay()[1]).toMatchObject({op: "fill", fillStyle: "#000080"});
});

test("the outline width scales with the font size", () => {
    expect(drawTimeDisplay({size: -32})[0]).toMatchObject({font: "32px sans-serif", lineWidth: 4});
    // A positive size is a percentage of the view width: 5% of 800px = 40px.
    expect(drawTimeDisplay({size: 5})[0]).toMatchObject({font: "40px sans-serif", lineWidth: 5});
});

test("translucent text is filled plain", () => {
    for (const color of ["#f0f00080", "#f0f00020", "rgba(240, 240, 0, 0.5)"]) {
        expect(drawTimeDisplay({color}).map(d => d.op)).toEqual(["fill"]);
    }
});

test("a boxed label's box is still drawn in black at its old width", () => {
    const draws = drawTimeDisplay({boxed: true});
    expect(draws.map(d => d.op)).toEqual(["stroke", "fill", "rect"]);
    expect(draws[2]).toMatchObject({strokeStyle: "black", lineWidth: 1});
});
