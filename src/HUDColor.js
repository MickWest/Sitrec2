import {NodeMan, setRenderOne} from "./Globals";
import {CNodeGUIColor} from "./nodes/CNodeGUIColor";

export const DEFAULT_HUD_COLOR = "#ffffff";

export function setupHUDColor(guiMenu) {
    if (NodeMan.exists("hudColor")) return NodeMan.get("hudColor");

    const node = new CNodeGUIColor({
        id: "hudColor",
        value: DEFAULT_HUD_COLOR,
        desc: "HUD Color",
        onChange: () => setRenderOne(true),
    }, guiMenu);

    node.guiEntry?.perm();
    return node;
}

export function getHUDColor(alpha = 1) {
    const value = NodeMan.get("hudColor", false)?.v0;
    let color = DEFAULT_HUD_COLOR;

    if (value?.getHexString) {
        color = "#" + value.getHexString();
    } else if (typeof value === "string") {
        color = value;
    }

    if (alpha >= 1 || !color.startsWith("#") || color.length !== 7) {
        return color;
    }

    const alphaHex = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
        .toString(16)
        .padStart(2, "0");
    return color + alphaHex;
}

export function resolveHUDColor(color, alpha = 1) {
    return color === "hud" ? getHUDColor(alpha) : color;
}
