import {CNodeVideoInfoUI} from "./CNodeVideoInfoUI";
import {Globals} from "../Globals";
import {t} from "../i18n";

// Sim Info Display: a date/time text overlay for the look view (or any non-video
// view it is attached to). It reuses ALL of CNodeVideoInfoUI's drawing, dragging
// and auto-positioning machinery, but exposes ONLY the simulation date/time
// readouts plus font size — no filename / frame number / offset / timecode /
// timestamp / OSD-data-series items, which are inherently video-specific.
//
// The node is attached with `overlayView: "lookView"` (NOT `relativeTo`), so
// `this.in.relativeTo` is undefined. That makes every video-specific code path
// in the base class (live zoom tracking, getVideoRect's source/dest transform,
// source-frame lookups, filename) short-circuit to the plain "percent of the
// canvas" overlay behaviour we want for a 3D view. Hence the small surface area
// of overrides below.
export class CNodeSimInfoUI extends CNodeVideoInfoUI {

    // Only the date/time items participate in vertical stacking / auto-positioning
    // and drag hit-testing. The video-only flags stay false and are never shown.
    getAllItemIds() {
        return ['dateLocal', 'timeLocal', 'dateTimeLocal', 'dateUTC', 'timeUTC', 'dateTimeUTC'];
    }

    // Visibility (and thus whether the overlay canvas draws at all) depends only
    // on the date/time items, not on filename/frame/timecode (always off here).
    hasAnyInfoItem() {
        return this.showDateLocal || this.showTimeLocal || this.showDateTimeLocal ||
            this.showDateUTC || this.showTimeUTC || this.showDateTimeUTC;
    }

    // OSD Data Series readouts are a video-analysis feature with no meaning on the
    // look view. Suppress both their contribution to visibility and their drawing
    // (the latter keeps this._osdDataSeriesBboxes empty so getElementBounds and
    // drag hit-testing only ever see the date/time items).
    hasAnyOSDDataSeries() {
        return false;
    }

    // The master "Show Sim Info" toggle is a GLOBAL (Globals.showSimInfo), like
    // the other Show-menu master toggles, rather than the per-node showInfo the
    // base class uses. So gate visibility on the global here.
    shouldBeVisible() {
        if (!Globals.showSimInfo) return false;
        return this.hasAnyInfoItem();
    }

    drawOSDDataSeries(c, widthPx, heightPx, padding) {
        // no-op for the sim info overlay
    }

    setupMenu(parentFolder) {
        const folder = parentFolder.addFolder(t("simInfo.folderTitle.label")).close()
            .tooltip(t("simInfo.folderTitle.tooltip"));

        if (Globals.showSimInfo === undefined) Globals.showSimInfo = true;
        folder.add(Globals, "showSimInfo").name(t("simInfo.showSimInfo.label"))
            .tooltip(t("simInfo.showSimInfo.tooltip"))
            .listen()
            .onChange(() => this.updateVisibility());

        // Date/time rows reuse the videoInfo i18n strings (identical labels).
        folder.add(this, "showDateLocal").name(t("videoInfo.dateLocal.label"))
            .tooltip(t("videoInfo.dateLocal.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateLocal'); this.updateVisibility(); });

        folder.add(this, "showTimeLocal").name(t("videoInfo.timeLocal.label"))
            .tooltip(t("videoInfo.timeLocal.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('timeLocal'); this.updateVisibility(); });

        folder.add(this, "showDateTimeLocal").name(t("videoInfo.dateTimeLocal.label"))
            .tooltip(t("videoInfo.dateTimeLocal.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateTimeLocal'); this.updateVisibility(); });

        folder.add(this, "showDateUTC").name(t("videoInfo.dateUTC.label"))
            .tooltip(t("videoInfo.dateUTC.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateUTC'); this.updateVisibility(); });

        folder.add(this, "showTimeUTC").name(t("videoInfo.timeUTC.label"))
            .tooltip(t("videoInfo.timeUTC.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('timeUTC'); this.updateVisibility(); });

        folder.add(this, "showDateTimeUTC").name(t("videoInfo.dateTimeUTC.label"))
            .tooltip(t("videoInfo.dateTimeUTC.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateTimeUTC'); this.updateVisibility(); });

        folder.add(this, "fontSize", 10, 80, 1).name(t("videoInfo.fontSize.label"))
            .tooltip(t("videoInfo.fontSize.tooltip"))
            .listen();

        return folder;
    }
}
