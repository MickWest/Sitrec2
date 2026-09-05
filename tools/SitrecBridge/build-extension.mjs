import {cpSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";

export function developmentManifest(base) {
    return {...base,
        name: "SitrecBridge Dev",
        description: "Development bridge: browser tabs, full-page and desktop screenshots, DevTools inspection and input",
        permissions: [...new Set([...base.permissions, "debugger", "desktopCapture", "storage"])],
        host_permissions: ["<all_urls>"],
        action: {...base.action, default_title: "SitrecBridge Dev"},
        // Leave automatic content scripts and page-bridge exposure scoped to Sitrec.
    };
}

export function buildExtension(source, destination, dev = false) {
    cpSync(source, destination, {recursive: true});
    if (dev) {
        const base = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
        writeFileSync(join(destination, "manifest.json"), JSON.stringify(developmentManifest(base), null, 2) + "\n");
        writeFileSync(join(destination, "dev-mode.js"), "export const DEV_MODE = true;\n");
    }
}
