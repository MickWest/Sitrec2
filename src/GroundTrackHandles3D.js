// The 3D half of the Ground Track editor: keyframes placed ON THE GROUND by clicking where the
// object appears, in the look view or on the map in the main view.
//
// The widget, the gesture and the cross-view behaviour are shared with "Fit Camera to Points" and
// live in TerrainHandles3D.js. What is only true HERE is what the points mean. A fit's control
// points are landmarks — one set, all at one frame. A ground track's are keyframes: each one
// belongs to a frame, they are all editable at any time, and between them the track is
// interpolated. So the editing grammar is the manual tracking overlay's, not the fit's:
//
//   Ctrl+click            place (or move) the keyframe for the CURRENT frame
//   click an unselected   select it: go to the frame it describes, and move nothing
//   click the selected    grab it, and drag it over the ground
//   Alt+click             delete the handle under the cursor
//   drag empty space      orbit, exactly as if the editor were off
//
// Selecting and moving are two presses, deliberately. A point describes ONE frame, so reaching for
// it almost always means "show me that moment" — and a single press that both travelled there and
// grabbed the point meant every attempt to look at a keyframe risked nudging it. The first press
// only travels; the second, now that the point is the one on screen, moves it.
//
// Ctrl is what makes the whole thing coexist with a 3D view instead of fighting it. A plain click
// cannot mean "place a point" here: in a 3D view a press is the start of an orbit, and the view has
// already begun one by the time this overlay hears about it. The fit never needed a placing gesture
// in 3D at all — its points are born on the video — which is why only this editor has one.

import {setRenderOne} from "./Globals";
import {par} from "./par";
import {mouseToCanvas} from "./ViewUtils";
import {projectToCanvas} from "./FitSurfacePick";
import {drawFitHandle} from "./FitHandleDraw";
import {CTerrainHandleOverlay, TerrainHandles3D} from "./TerrainHandles3D";

/** The interpolated path between keyframes, and the keyframes themselves. */
const TRACK_COLOR = "#00FF80";
/** The selected keyframe: the one the playhead is on, and so the only one a click can move. */
const SELECTED_KEYFRAME_COLOR = "#FF4040";
/** Where the track is right now: the far end of the line of sight being built. */
const CURSOR_COLOR = "#FFFF00";

/**
 * One overlay per 3D view: draws that view's ground track and owns editing in it.
 */
class CGroundTrackOverlay extends CTerrainHandleOverlay {
    interactionProfile = "groundTrack";
    /** Canvas position of every keyframe in this view, as [{frame, index, cx, cy}]. */
    projected() {
        return this.projectPoints(this.owner.getKeyframes());
    }

    /**
     * A point is SELECTED when the playhead is on the frame it describes.
     *
     * No separate selection state, because there is nowhere for the two to disagree: selecting a
     * point is DEFINED as going to its frame. It also means the red handle the user can already
     * see is exactly the one that will move — the highlight stops being decoration and becomes
     * the affordance. One predicate, used by both the drawing and the hit handling, so those two
     * cannot drift apart.
     */
    isSelected(frame) {
        return frame === Math.round(par.frame);
    }

    renderCanvas(frame) {
        super.renderCanvas(frame);
        if (!this.ctx) return;
        // The path is drawn whenever the track is shown, editing or not; the handles ARE the
        // editing affordance, so they follow `enabled`.
        if (this.owner.showTrack) {
            this.drawPath();
            this.drawCursor();
        }
        if (!this.owner.enabled) return;
        for (const h of this.projected()) {
            const selected = this.isSelected(h.frame);
            drawFitHandle(this.ctx, h.cx, h.cy,
                          selected ? SELECTED_KEYFRAME_COLOR : TRACK_COLOR,
                          selected ? String(h.frame) : "", 1, this.handleState(h.frame));
        }
    }

    /**
     * The interpolated ground path, as a polyline on this view's canvas.
     *
     * Drawn on the overlay rather than as a line in the scene, for the same reason the handles
     * are: a track being placed against terrain is exactly the thing that must stay visible when
     * a ridge is in the way. It also sidesteps the z-fighting a ground-hugging 3D line invites.
     *
     * The line breaks wherever projectToCanvas declines — behind the camera, or off the world —
     * rather than being joined across the gap, which would draw a chord through the viewer.
     */
    drawPath() {
        const host = this.host;
        const samples = this.owner.getPathSamples();
        if (!host || samples.length < 2) return;

        const ctx = this.ctx;
        const stroke = () => {
            ctx.beginPath();
            let pen = false;
            for (const s of samples) {
                const at = projectToCanvas(host, s);
                if (at === null) {
                    pen = false;
                    continue;
                }
                if (pen) ctx.lineTo(at[0], at[1]);
                else ctx.moveTo(at[0], at[1]);
                pen = true;
            }
            ctx.stroke();
        };

        ctx.save();
        // Twice, dark then colored — the same halo the handles use, and for the same reason:
        // a hairline of any one color disappears over half the terrain it is drawn on.
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 3.5;
        stroke();
        ctx.strokeStyle = TRACK_COLOR;
        ctx.lineWidth = 1.5;
        stroke();
        ctx.restore();
    }

    /** Where the track is at the frame on screen: the ground end of the current line of sight. */
    drawCursor() {
        const host = this.host;
        const p = this.owner.getCurrentPoint();
        if (!host || !p) return;
        const at = projectToCanvas(host, p);
        if (at === null) return;

        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 3.5;
        this.cursorPath(at[0], at[1]);
        ctx.strokeStyle = CURSOR_COLOR;
        ctx.lineWidth = 1.5;
        this.cursorPath(at[0], at[1]);
        ctx.restore();
    }

    cursorPath(cx, cy) {
        const r = 6;
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
        ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
        ctx.stroke();
    }

    getInteractionIntent(e, mouseX, mouseY) {
        const hit = super.getInteractionIntent(e, mouseX, mouseY);
        if (hit) return hit;
        if (!this.owner.enabled || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return null;
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        return this.groundUnder(cx, cy) ? {kind: "drag", priority: 70} : null;
    }

    onMouseDown(e, mouseX, mouseY) {
        this.draggingId = null;
        if (!this.owner.enabled || e.button !== 0) return false;

        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const hit = this.pick(cx, cy, this.projected());

        if (hit && e.altKey) {
            this.owner.deletePoint(hit.frame);
            setRenderOne(true);
            return true;                        // claimed, so the view does not also orbit
        }

        if (hit) {
            // Asked BEFORE the playhead moves, which is the whole point: this press must not
            // also grab the handle just because its own effect makes the point selected by the
            // time the button comes up.
            if (!this.isSelected(hit.frame)) {
                // Travel to the frame this point describes, and nothing else. Editing it from
                // any other frame would be editing one frame's answer while looking at
                // another's, so arriving there is a precondition for moving it, not a
                // side effect of moving it.
                par.frame = hit.frame;
                par.paused = true;
                setRenderOne(true);
                // Claimed, so the view does not orbit under a press the user aimed at a handle.
                // Nothing is dragging, so a mouse move now does nothing at all.
                return true;
            }
            this.owner.onBeginEdit();
            this.beginDrag(hit.frame);
            return true;
        }

        if (!(e.ctrlKey || e.metaKey)) return false;   // plain press on empty space: orbit

        const ground = this.groundUnder(cx, cy);
        // Aimed at the sky or past the horizon. Decline rather than inventing a point at some
        // arbitrary range — there is no ground under that pixel to be behind anything.
        if (!ground) return false;

        // Placed and then immediately dragged, so one Ctrl gesture both creates the point and
        // pushes it into position.
        const frame = Math.round(par.frame);
        this.owner.onBeginEdit();
        this.owner.setPoint(frame, ground);
        this.beginDrag(frame);
        setRenderOne(true);
        return true;
    }

    // The point id is a FRAME here — a ground track keyframe is identified by the frame it
    // describes, and there can only ever be one per frame.
    movePoint(frame, position) {
        this.owner.setPoint(frame, position);
    }

    endDrag(frame) {
        this.owner.onEndEdit("Move ground track point");
        // The base has already cleared draggingId, so a mode that stands itself down during a
        // drag is free to do its full work now.
        this.owner.onCommit();
    }
}

/**
 * Owns one ground-track overlay per 3D view.
 *
 * @param {object} v
 * @param {object} v.owner  the CNodeGroundTrack. Read for `enabled` and `showTrack`, and called
 *                          back for the geometry and the edits:
 *                          getKeyframes()   => [{frame, position: Vector3}]
 *                          getPathSamples() => [Vector3]
 *                          getCurrentPoint()=> Vector3|null
 *                          getUseTiles()    => boolean
 *                          getUseObjects()  => boolean
 *                          setPoint(frame, Vector3)
 *                          deletePoint(frame)
 *                          onBeginEdit() / onEndEdit(description)
 */
export class GroundTrackHandles3D extends TerrainHandles3D {
    constructor(v) {
        super({owner: v.owner, overlayClass: CGroundTrackOverlay, idPrefix: "groundTrackHandles"});
    }
}
