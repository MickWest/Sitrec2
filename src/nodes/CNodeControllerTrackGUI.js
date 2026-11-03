import {setRenderOne} from "../Globals";
import {CNode} from "./CNode";
import * as LAYERS from "../LayerMasks";
import {t} from "../i18n";


// Common GUI Elements for a CMetaTrack
export class CNodeTrackGUI extends CNode {
    constructor(v) {
        super(v);



        this.metaTrack = v.metaTrack;
        this.displayNode = this.metaTrack.trackDisplayNode;
        this.trackNode = this.displayNode.in.track;
        this.gui = v.gui ?? "contents";

//        console.log("CNodeTrackGUI constructor called for ", this.metaTrack.menuText);


        this.showTrackInLook = false;
        this.guiShowInLook = this.metaTrack.guiFolder.add(this, "showTrackInLook").listen().onChange(()=>{
            setRenderOne(true);
            // this.metaTrack has a trackDisplayNode and a trackDisplayDataNode and a displayTargetSphere
            // need to set their group mask bit corresponding to VIEW.LOOK
            this.setTrackVisibility(this.showTrackInLook);

            // the sphere is the object that is always displayed in the look window
            //this.metaTrack.displayTargetSphere.setLayerBit(LAYERS.LOOK, this.showTrackInLook);
    }).name(t("misc.showInLookView.label")).tooltip(t("misc.showInLookView.tooltip"))
        // It draws the line in the look view, so the track's title checkbox fades it.
        .fadeWhenFolderOff()

        this.addSimpleSerial("showTrackInLook");


    }

    setTrackVisibility(visiblity) {
        this.metaTrack.trackDisplayNode.setLayerBit(LAYERS.LOOK, visiblity);
        this.metaTrack.trackDisplayDataNode.setLayerBit(LAYERS.LOOK, visiblity);
    }

    dispose() {
      //  this.guiFolder.destroy();
        super.dispose()
    }




}
