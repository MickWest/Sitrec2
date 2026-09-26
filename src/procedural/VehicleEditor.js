import markup from "../../tools/vehicles/index.html?raw";
import css from "../../tools/vehicles/style.css?raw";
import {mountVehicleDesigner} from "../../tools/vehicles/designer.js";

export function mountEmbeddedVehicleEditor(mount, {recipe,onApply,onBack,onSave}) {
    const host = document.createElement("div"); host.style.cssText = "height:100%;width:100%;"; mount.append(host);
    const shadow = host.attachShadow({mode:"open"}), style = document.createElement("style");
    style.textContent = css +
        "\n.designer-root{height:100%;} .brand{display:none} .topbar{height:64px;padding:0 16px} .title>span{display:none} #fullscreen{display:none}";
    const parsed = new DOMParser().parseFromString(markup,"text/html");
    parsed.body.querySelectorAll("script").forEach(script => script.remove());
    const root = document.createElement("div"); root.className = "designer-root";
    root.append(...parsed.body.childNodes);
    root.querySelector("footer a").href = new URL("tools/vehicles/README.md",document.baseURI).href;
    shadow.append(style,root);
    let editor;
    try {editor = mountVehicleDesigner(root,{initialRecipe:recipe,persist:false});}
    catch (error) {host.remove(); throw error;}
    const actions = root.querySelector(".header-actions");
    function button(label,action,primary=false) {
        const item = document.createElement("button"); item.textContent = label;
        if (primary) item.className = "primary";
        item.addEventListener("click",action); actions.append(item);
    }
    root.querySelector("#exportGLB").classList.remove("primary");
    button("My models +",async () => {
        try {await onSave(editor.getRecipe(),editor.thumbnail()); root.querySelector("#status").textContent = "Saved to My models on this browser";}
        catch (e) {const panel = root.querySelector("#error"); panel.hidden = false; panel.textContent = e.message;}
    });
    button("Back",() => onBack(editor.getRecipe()));
    button("Apply to object",() => onApply(editor.getRecipe()),true);
    return {dispose() {editor.dispose(); host.remove();}};
}
