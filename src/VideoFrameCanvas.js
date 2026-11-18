// The encoder needs even dimensions. Share its exact padding with the preview.
export function padVideoFrame(canvas, width = Math.ceil(canvas.width / 2) * 2,
    height = Math.ceil(canvas.height / 2) * 2) {
    if (canvas.width === width && canvas.height === height) return canvas;
    const padded = document.createElement("canvas");
    padded.width = width;
    padded.height = height;
    const ctx = padded.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(canvas, 0, 0);
    return padded;
}
