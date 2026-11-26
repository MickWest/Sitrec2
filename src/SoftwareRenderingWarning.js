import {t} from "./i18n";

// Keep the warning while ANY active view uses a software renderer. A hardware
// view must not hide a warning raised by another view. No polling or frame work.
const softwareRenderers = new Map();
let notice;
let dismissed = false;

function renderWarning() {
    if (dismissed || softwareRenderers.size === 0) {
        notice?.remove();
        notice = undefined;
        return;
    }
    if (typeof document === "undefined" || !document.body) return;
    const {info, benchmarkURL} = softwareRenderers.values().next().value;
    if (!notice?.isConnected) {
        notice = document.createElement("section");
        notice.id = "software-rendering-warning";
        notice.setAttribute("role", "status");
        notice.setAttribute("aria-live", "polite");
        notice.setAttribute("aria-labelledby", "software-rendering-warning-title");
        const bannerBottom = document.getElementById("BannerTop")?.getBoundingClientRect().bottom || 0;
        notice.style.cssText = `position:fixed;top:${bannerBottom + 48}px;left:50%;transform:translateX(-50%);`
            + "width:min(560px,calc(100vw - 24px));box-sizing:border-box;max-height:calc(100vh - 100px);"
            + "overflow:auto;z-index:9000;padding:16px 18px;border:1px solid #d9a441;border-radius:8px;"
            + "background:#302719;color:#fff1d2;box-shadow:0 4px 20px #0008;font:14px/1.5 Arial,sans-serif;";
        // Buttons retain their native keyboard behavior without invoking scene shortcuts.
        notice.addEventListener("keydown", event => event.stopPropagation());

        const title = document.createElement("h2");
        title.id = "software-rendering-warning-title";
        title.textContent = t("softwareRenderingWarning.title");
        title.style.cssText = "margin:0 0 8px;font-size:17px;color:inherit;";
        const message = document.createElement("p");
        message.textContent = t("softwareRenderingWarning.message");
        message.style.cssText = "margin:0 0 8px;";
        const advice = document.createElement("p");
        advice.textContent = t("softwareRenderingWarning.advice");
        advice.style.cssText = "margin:0 0 10px;";
        const renderer = document.createElement("div");
        renderer.dataset.gpuRenderer = "";
        renderer.style.cssText = "font:12px/1.5 monospace;overflow-wrap:anywhere;margin-bottom:12px;";
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap;";
        const benchmark = document.createElement("a");
        benchmark.dataset.gpuBenchmark = "";
        benchmark.textContent = t("softwareRenderingWarning.benchmark");
        benchmark.target = "_blank";
        benchmark.rel = "noopener noreferrer";
        benchmark.style.cssText = "color:#ffdf98;text-decoration:underline;";
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.textContent = t("softwareRenderingWarning.dismiss");
        dismiss.style.cssText = "margin-left:auto;padding:6px 12px;border:1px solid #d9a441;border-radius:5px;"
            + "background:#4b3c24;color:#fff1d2;font:inherit;cursor:pointer;";
        dismiss.addEventListener("click", () => {
            dismissed = true;
            renderWarning();
        });
        actions.append(benchmark, dismiss);
        notice.append(title, message, advice, renderer, actions);
        document.body.appendChild(notice);
    }
    notice.querySelector("[data-gpu-renderer]").textContent =
        t("softwareRenderingWarning.renderer", {renderer: info.rendererName});
    const link = notice.querySelector("[data-gpu-benchmark]");
    link.hidden = !benchmarkURL;
    if (benchmarkURL) link.href = benchmarkURL;
}

export function updateSoftwareRenderingWarning(renderer, info, benchmarkURL) {
    try {
        if (info?.softwareRendererDetected) softwareRenderers.set(renderer, {info, benchmarkURL});
        else softwareRenderers.delete(renderer);
        renderWarning();
    } catch {
        // Diagnostics must never prevent a 3D view from starting or recovering.
    }
}

export function removeSoftwareRenderingWarning(renderer) {
    try {
        softwareRenderers.delete(renderer);
        renderWarning();
    } catch {
        // View disposal must complete even if the warning UI is unavailable.
    }
}
