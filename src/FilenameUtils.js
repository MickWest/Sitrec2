export function getDisplayFilename(source) {
    if (!source) return "";

    let value = String(source).trim();
    if (!value) return "";

    try {
        const url = new URL(value, window.location.href);
        value = url.pathname || value;
    } catch (e) {
        value = value.split("?")[0].split("#")[0];
    }

    value = value.replace(/\\/g, "/");
    const filename = value.split("/").filter(Boolean).pop() || value;

    try {
        return decodeURIComponent(filename);
    } catch (e) {
        return filename;
    }
}
