import {CNodeTrack} from "./CNodeTrack";
import {EventManager} from "../CEventManager";
import {Globals, guiMenus, markSitchDirty, TrackManager} from "../Globals";
import {misbRangeSources, rangeSamplesForFrames} from "../MISBRange";

export class CNodeLOSTraverseUseRange extends CNodeTrack {
    constructor(v, gui = guiMenus.traverse) {
        super(v);
        this.input("LOS");
        this.frames = this.in.LOS.frames;
        this.rangeSource = v.rangeSource ?? "";
        this.simpleSerials.push("rangeSource");
        this.sources = [];
        this.rangeStatus = "";
        this.heldFrames = 0;
        this._pendingRangeSource = null;
        this.refreshSources(false);
        if (gui) {
            this.rangeSourceController = gui.add(this, "rangeSource", this.sourceOptions())
                .name("Range Source")
                .tooltip("Use this MISB field, in metres, as distance along the current LOS. " +
                    "Ground Range is also applied directly; it is not converted to slant range. " +
                    "Missing readings hold the previous valid range (the first valid range for a leading gap).")
                .listen().onChange(() => this.selectRangeSource(this.rangeSource));
            this.rangeStatusController = gui.add(this, "rangeStatus").name("Range Data").listen().disable();
            this.show(this.visible);
        }
        this._onTracksChanged = () => {
            if (!Globals.disposing) this.refreshSources();
            return false;
        };
        EventManager.addEventListener("tracksChanged", this._onTracksChanged);
    }

    sourceOptions() {
        return this.sources.length
            ? Object.fromEntries(this.sources.map(s => [s.label, s.key]))
            : {"No range data loaded": ""};
    }

    // A missing range cannot define a traverse. Offer the method only while
    // a usable loaded column exists; CNodeSwitch defers saved choices until
    // async imports add the option, and chooses another method on removal.
    bindTraverseSwitch(node) {
        this.traverseSwitch = node;
        this.syncTraverseOption();
    }

    syncTraverseOption() {
        const menu = this.traverseSwitch;
        if (!menu) return;
        if (this.sources.length) {
            if (!menu.inputs["Use Range"]) menu.addOption("Use Range", this);
        } else if (menu.inputs["Use Range"]) {
            menu.removeOption("Use Range");
        }
        // Runtime addOption does not run choiceChanged unless restoring a
        // pending choice. Keep the source control local to the chosen method.
        this.show(menu.inputs[menu.choice] === this);
    }

    refreshSources(cascade = true) {
        const tracks = [];
        TrackManager?.iterate((id, track) => tracks.push(track));
        this.sources = misbRangeSources(tracks);
        if (this._pendingRangeSource && this.sources.some(s => s.key === this._pendingRangeSource)) {
            this.rangeSource = this._pendingRangeSource;
            this._pendingRangeSource = null;
        }
        if (!this.sources.some(s => s.key === this.rangeSource)) {
            this.rangeSource = this.sources[0]?.key ?? "";
        }
        if (this.rangeSourceController) {
            this.rangeSourceController = this.rangeSourceController.options(this.sourceOptions())
                .name("Range Source")
                .tooltip("Distance in metres along the current LOS. Ground Range is used directly, without conversion. " +
                    "Missing readings hold the previous valid range; leading gaps hold the first valid range.")
                .listen().onChange(() => this.selectRangeSource(this.rangeSource));
            this.rangeSourceController.show(this.visible);
        }
        this.bindSource();
        this.syncTraverseOption();
        if (cascade) this.recalculateCascade();
    }

    bindSource() {
        this.source = this.sources.find(s => s.key === this.rangeSource);
        const track = this.source?.trackNode;
        if (this.in.rangeTrack !== track) {
            if (this.in.rangeTrack) this.removeInput("rangeTrack");
            if (track) this.addInput("rangeTrack", track);
        }
        this._needsRecalculate = true;
    }

    selectRangeSource(key) {
        this._pendingRangeSource = null;
        this.rangeSource = key;
        this.bindSource();
        this.recalculateCascade();
        markSitchDirty();
    }

    recalculate() {
        this.frames = this.in.LOS.frames;
        const track = this.in.rangeTrack;
        track?.ensureRecalculated?.();
        const entries = track?.sourceArray ?? track?.array ?? [];
        const samples = this.source && track
            ? rangeSamplesForFrames(entries, this.source.column, this.frames, this.source.firstRange)
            : null;
        this.heldFrames = samples?.filter(s => s.held).length ?? 0;
        this.rangeStatus = samples ? `${this.heldFrames} held frame${this.heldFrames === 1 ? "" : "s"}` : "No range data loaded";
        this.array = Array.from({length: this.frames}, (_, f) => {
            const los = this.in.LOS.v(f);
            const range = samples?.[f].range;
            return {
                // The unselectable empty node still needs finite placeholders
                // during whole-graph recalculations and scene construction.
                position: los.position.clone().addScaledVector(los.heading.clone().normalize(), range ?? 0),
                range: range ?? null,
                rangeHeld: samples?.[f].held ?? false,
            };
        });
        this._needsRecalculate = false;
        this.show(this.visible);
    }

    modSerialize() {
        return {...super.modSerialize(), rangeSource: this._pendingRangeSource ?? this.rangeSource};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this._pendingRangeSource = v.rangeSource || null;
        this.refreshSources(false);
    }

    show(visible = true) {
        super.show(visible);
        this.rangeSourceController?.show(visible);
        this.rangeStatusController?.show(visible && this.heldFrames > 0);
    }

    dispose() {
        EventManager.removeEventListener("tracksChanged", this._onTracksChanged);
        this.rangeSourceController?.destroy();
        this.rangeStatusController?.destroy();
        super.dispose();
    }
}
