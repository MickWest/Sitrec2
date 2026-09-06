import {setRenderOne} from "./Globals";
import {SITREC_APP} from "./configUtils";
import {asyncOperationRegistry} from "./AsyncOperationRegistry";

export const MQ9_FONT = '"Sitrec OSD", sans-serif';
export const WESCAM_FONT = 'Arial, Helvetica, sans-serif';

let mq9FontReady;

// The bundled face is shared by all HUDs and registered with the export gate, so
// the first recorded frame uses the same face and metrics as later frames.
export function ensureMQ9FontLoaded() {
    if (!mq9FontReady && typeof FontFace !== "undefined" && document.fonts) {
        const face = new FontFace("Sitrec OSD", `url("${SITREC_APP}data/fonts/SitrecOSD.ttf")`);
        document.fonts.add(face);
        mq9FontReady = face.load().then(() => {
            setRenderOne(true);
            return true;
        }).catch(error => {
            console.warn("MQ9 HUD font unavailable; using sans-serif", error);
            return false;
        });
        asyncOperationRegistry.registerPromise(mq9FontReady, "font", "MQ9 HUD font");
    }
    return mq9FontReady ?? Promise.resolve(false);
}

// Outline just the glyphs, not the crosshair or other HUD geometry. The stroke
// scales with the text: about half a pixel outside each edge at SD size, and
// about one pixel on HD feeds. Preserve each label's alignment and HUD colour.
export function drawHUDText(ctx, text, x, y, fontSize) {
    ctx.save();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = fontSize / 14;
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
    ctx.restore();
    ctx.fillText(text, x, y);
}
