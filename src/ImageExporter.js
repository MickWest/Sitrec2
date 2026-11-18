export const DEFAULT_IMAGE_ENCODING = {format: "png", quality: 0.92};

export function encodeRenderedImage(canvas, {format = "png", quality = 0.92} = {}) {
    const mime = format === "jpeg" ? "image/jpeg" : "image/png";
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("The rendered image could not be encoded."));
    }, mime, Math.max(0.1, Math.min(1, quality))));
}

export function downloadRenderedImage(blob, {viewId, frame, prefix = "sitrec"}) {
    const extension = blob.type === "image/jpeg" ? "jpg" : "png";
    const filename = `${prefix}_${viewId}_frame-${frame}.${extension}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return {filename, size: blob.size};
}
