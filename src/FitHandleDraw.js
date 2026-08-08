// The look of a camera-fit control point: a circle with a crosshair through it.
//
// Shared, because the same handle is drawn in three places — on the video, and on each 3D view —
// and the whole point of the widget is that they are recognisably the SAME control. A copy per
// call site would drift.

/** Cyan, magenta, yellow, orange first: the four that stay legible over terrain, sky and sea. */
export const POINT_COLORS = [
    "#00FFFF", "#FF00FF", "#FFFF00", "#FF8000",
    "#00FF80", "#FF0080", "#80FF00", "#8080FF",
    "#FF4040", "#40C0FF", "#C0FF40", "#FFFFFF",
];

/** Radius of the drawn circle, in canvas pixels. */
export const HANDLE_RADIUS = 9;

/** Click within this many canvas pixels of a handle to grab it. */
export const GRAB_RADIUS = 12;

/**
 * Draw one handle at a canvas position.
 *
 * Stroked twice — a dark halo, then the colour — because these sit over video and terrain of
 * every brightness, and a single-colour hairline disappears against half of it.
 */
export function drawFitHandle(ctx, cx, cy, color, label, alpha = 1) {
    const r = HANDLE_RADIUS;
    ctx.save();
    ctx.globalAlpha = alpha;

    const path = () => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.moveTo(cx - r - 4, cy); ctx.lineTo(cx - 2, cy);
        ctx.moveTo(cx + 2, cy);     ctx.lineTo(cx + r + 4, cy);
        ctx.moveTo(cx, cy - r - 4); ctx.lineTo(cx, cy - 2);
        ctx.moveTo(cx, cy + 2);     ctx.lineTo(cx, cy + r + 4);
        ctx.stroke();
    };

    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 3.5;
    path();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    path();

    if (label) {
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.lineWidth = 3;
        ctx.strokeText(label, cx + r + 4, cy);
        ctx.fillStyle = color;
        ctx.fillText(label, cx + r + 4, cy);
    }
    ctx.restore();
}
