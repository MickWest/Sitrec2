import {validateAngularSize, angularSizeInventory, angularSizeFitUnavailableReason} from "./AngularSize";

/** Edit optional observation bounds. Frame numbers are relative to this analysis. */
export function showAngularSizeDialog({n, observations = null, options = {}, onApply, allowFit = false}) {
    const previousFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "angular-size-dialog";
    overlay.dataset.interactionNative = "true";
    overlay.style.cssText = "position:fixed;inset:0;z-index:10020;background:#0009;display:grid;place-items:center;color:#e7ecf2;font:14px system-ui";
    const panel = document.createElement("form");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Angular-size evidence");
    panel.style.cssText = "background:#18212b;border:1px solid #64778a;border-radius:10px;padding:22px;width:min(650px,90vw);max-height:85vh;overflow:auto;display:grid;gap:12px";
    const title = document.createElement("strong"); title.textContent = "Angular-size evidence";
    const info = document.createElement("div");
    info.textContent = "Bounds are observations, not exact sizes. Sparse frames stay sparse. Absolute size is checked against broad object-size envelopes; this does not identify the object. Relative size constrains range changes only if projected physical size stays constant.";
    const availability = document.createElement("div");
    availability.setAttribute("role", "status");
    availability.style.cssText = "padding:10px;background:#233447;border-radius:5px;white-space:pre-line";
    panel.append(title, availability, info);
    if (observations?.source) {
        const source = document.createElement("small"); source.textContent = observations.source; panel.append(source);
    }
    const checkbox = (label, checked) => {
        const row = document.createElement("label"), input = document.createElement("input");
        input.type = "checkbox"; input.checked = checked;
        row.append(input, document.createTextNode(" " + label)); panel.append(row); return input;
    };
    const judge = checkbox("Use angular size to judge and order results", !!options.judge);
    const constant = checkbox("Assume constant projected physical size (recommended when shape and orientation stay stable)", !!options.constantProjectedSize);
    const fit = allowFit ? checkbox("Also use size during supported fits (experimental; refits the paths)", !!options.fit) : null;
    const fitStatus = document.createElement("small");
    if (fit) panel.append(fitStatus);
    const note = document.createElement("small");
    note.textContent = "Rotation, inflation and occlusion can invalidate this assumption. A single absolute size does not fix distance without a physical-size assumption.";
    panel.append(note);
    const field = (label, value, placeholder = "") => {
        const row = document.createElement("label"), input = document.createElement("input");
        row.textContent = label + " "; input.type = "number"; input.step = "any";
        input.value = value ?? ""; input.placeholder = placeholder; input.style.width = "90px";
        row.append(input); panel.append(row); return input;
    };
    const variation = checkbox("Observed throughout a frame interval: size stays within these ratios of a reference frame", !!observations?.relativeBound);
    const min = field("Minimum ratio", observations?.relativeBound?.minRatio ?? .5);
    const max = field("Maximum ratio", observations?.relativeBound?.maxRatio ?? 1.5);
    const referenceFrame = field("Reference frame", observations?.relativeBound?.referenceFrame ?? 0);
    const startFrame = field("First frame of interval", observations?.relativeBound?.startFrame ?? 0);
    const endFrame = field("Last frame of interval", observations?.relativeBound?.endFrame ?? n - 1);
    const initial = field("Add an initial angular-diameter measurement (degrees)", "", "not added");
    const end = field("Add a final angular-diameter measurement (degrees)", "", "not added");
    const error = field("Bounds around entered initial/final values (±%)", 10);
    const label = document.createElement("label");
    label.textContent = `Absolute samples: frame, minimum degrees, maximum degrees (frames 0–${n - 1})`;
    const samples = document.createElement("textarea");
    samples.setAttribute("aria-label", "Absolute angular-size samples"); samples.rows = 6;
    samples.value = (observations?.samples ?? []).map(s => `${s.frame},${s.minDeg},${s.maxDeg}`).join("\n");
    label.append(samples); samples.style.cssText = "display:block;width:100%;box-sizing:border-box"; panel.append(label);
    const relativeLabel = document.createElement("label");
    relativeLabel.textContent = "Relative samples: frame, reference frame, minimum ratio, maximum ratio";
    const relative = document.createElement("textarea"); relative.rows = 3;
    relative.setAttribute("aria-label", "Relative angular-size samples");
    relative.value = (observations?.relative ?? []).map(s => `${s.frame},${s.referenceFrame},${s.minRatio},${s.maxRatio}`).join("\n");
    relative.style.cssText = samples.style.cssText; relativeLabel.append(relative); panel.append(relativeLabel);
    const message = document.createElement("div"); message.setAttribute("role", "alert"); message.style.color = "#ffb9ad"; panel.append(message);
    const buttons = document.createElement("div");
    const close = () => { overlay.remove(); previousFocus?.focus?.({preventScroll: true}); };
    overlay.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(); }
    });
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.onclick = close;
    const apply = document.createElement("button"); apply.type = "submit"; apply.textContent = allowFit ? "Apply / refit" : "Apply to results";
    buttons.append(cancel, apply); panel.append(buttons); overlay.append(panel); document.body.append(overlay);
    const readObservations = () => {
        const parse = (text, keys) => text.split(/\r?\n/).filter(s => s.trim()).map(line => {
            const values = line.split(",").map(s => s.trim());
            if (values.length !== keys.length || values.some(s => s === "" || !Number.isFinite(Number(s))))
                throw new Error(`Expected ${keys.length} comma-separated numbers per row.`);
            return Object.fromEntries(keys.map((k, i) => [k, Number(values[i])]));
        });
        const next = {source: "User-supplied angular-size bounds",
            samples: parse(samples.value, ["frame", "minDeg", "maxDeg"]),
            relative: parse(relative.value, ["frame", "referenceFrame", "minRatio", "maxRatio"])};
        for (const [input, frame] of [[initial, 0], [end, n - 1]]) if (input.value !== "") {
            const d = Number(input.value), e = Number(error.value) / 100;
            if (!(e >= 0 && e < 1)) throw new Error("Size error must be between 0% and less than 100%.");
            next.samples.push({frame, minDeg: d * (1 - e), maxDeg: d * (1 + e)});
        }
        if (variation.checked) next.relativeBound = {referenceFrame: Number(referenceFrame.value),
            startFrame: Number(startFrame.value), endFrame: Number(endFrame.value),
            minRatio: Number(min.value), maxRatio: Number(max.value)};
        return validateAngularSize(next, n);
    };
    const refresh = () => {
        try {
            const next = readObservations(), inventory = angularSizeInventory(next);
            availability.textContent = inventory.summary + "\nJudging: " + (judge.checked ? "on" : "off (default; bounds do not affect judging)")
                + (inventory.upperOnlyNote ? "\n" + inventory.upperOnlyNote : "");
            if (fit) {
                const reason = angularSizeFitUnavailableReason(next, {constantProjectedSize: constant.checked});
                fit.disabled = !!reason;
                if (reason) fit.checked = false;
                fitStatus.textContent = reason ? `Fitting unavailable: ${reason}` : "Size-change evidence is available for supported fits.";
            }
        } catch (e) {
            availability.textContent = `Check entries: ${e.message}`;
            if (fit) { fit.disabled = true; fitStatus.textContent = "Correct the entries before enabling size fitting."; }
        }
    };
    panel.addEventListener("input", refresh);
    panel.addEventListener("change", refresh);
    refresh();
    panel.onsubmit = event => {
        event.preventDefault();
        try {
            const next = readObservations();
            // Changing only options must preserve provenance and must not cause
            // a refit merely because the editor rebuilt the same measurements.
            const measurementKey = a => JSON.stringify([
                (a?.samples ?? []).map(s => [s.frame, s.minDeg, s.maxDeg]),
                (a?.relative ?? []).map(s => [s.frame, s.referenceFrame, s.minRatio, s.maxRatio]),
                a?.relativeBound ? [a.relativeBound.referenceFrame, a.relativeBound.startFrame,
                    a.relativeBound.endFrame, a.relativeBound.minRatio, a.relativeBound.maxRatio] : null]);
            const unchanged = measurementKey(observations) === measurementKey(next);
            onApply(unchanged ? observations : next, {...options, judge: judge.checked, constantProjectedSize: constant.checked,
                ...(fit ? {fit: fit.checked && !angularSizeFitUnavailableReason(next, {constantProjectedSize: constant.checked})} : {})});
            close();
        } catch (e) { message.textContent = e.message; }
    };
    cancel.focus();
    return overlay;
}
