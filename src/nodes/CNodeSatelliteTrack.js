// A track node that can be used to track a satellite

import {CNodeTrack} from "./CNodeTrack";
import {GlobalDateTimeNode, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {EventManager} from "../CEventManager";
import {bestSat} from "../TLEUtils";
import {CNodeDisplayTrack} from "./CNodeDisplayTrack";

// TODO - consider flagging this as not smoothable for use as a camera track
// the TLE calculation should give a smooth curve, and the smoothing will shift the position slightly

export class CNodeSatelliteTrack extends CNodeTrack {
     constructor(v) {
         super(v);

         // all satellites use the same number of frames as the Sitch
         this.frames = Sit.frames;
         this.useSitFrames = true;

         this.satellite = v.satellite ?? 25544
         this.satelliteText = "ISS (ZARYA)";
         this.trackName = v.trackName ?? "Satellite";

         // adding time object as input for recalculation
         this.addInput("time", "dateTimeStart")

         const name = v.name ?? "Satellite To Track";

         guiMenus.satellites.add(this, "satelliteText").name(name).onFinishChange(v => {
             this.setSatelliteText(this.satelliteText);
         }).listen().tooltip("Name or NORAD number of satellite to track. \nStart of name is ok (i.e. ISS)");

         // Use event listeners to update the track when the satellite changes
         EventManager.addEventListener("tleLoaded", (event, data) => {
             this.newTLEDataLoaded()
         })

         this.addSimpleSerial("satellite");

         this.recalculate()
         this.updateUI();

     }


     // Set the tracked satellite from a name or NORAD number, exactly as if the user
     // had typed it into the "Satellite to Track" text field in the Satellites menu.
     // Called both by that field's onFinishChange and by the satellite context menu.
     setSatelliteText(nameOrNumber) {
         this.satelliteText = nameOrNumber;
         this.satellite = this.satelliteText;
         this.norad = null; // reset the norad number to force recalculation of the satellite data

         this.checkSatelliteTrackValid();

         if (this.norad === null) {
             if (this.satellite) {
                 this.satelliteText = this.satellite + " not found";
             } else {
                 this.satelliteText = "";
             }
         }
         this.updateUI();
         this.recalculateCascade();
         setRenderOne();
     }


     newTLEDataLoaded() {
         // check if we have a valid satellite number

         if (!this.checkSatelliteTrackValid()) {
             return;
         }

         this.visible = true;
         this.getDisplayTrack()?.show()
         this.recalculateCascade();
         this.updateUI();

     }

     // given a satellite name or number in s, convert it into a valid NORAD number that
     // exists in the TLE database
     // return null if it doesn't exist

     getSatelliteNumber(s) {

         // TODO - should this be an input node?
         // see if we have a night sky with any TLE data
         const nightSky = NodeMan.get("NightSkyNode", false)
         if (!nightSky) {
             console.warn("CNodeSatelliteTrack: no NightSkyNode found")
             return null
         }

         const tleData = nightSky.TLEData;
         if (tleData === undefined) {
//            console.warn("CNodeSatelliteTrack: no TLE data found")
             return null
         }
         return tleData.getNORAD(s);

     }

     // given a valid norad number, find the index of the satellite in the TLE database
     getSatelliteData(norad) {
         this.nightSky = NodeMan.get("NightSkyNode", false)
         const tleData = this.nightSky.TLEData;

         // const satDataArray = tleData.satData;
         // const numSatData = satDataArray.length;
         // let result = null;
         // for (let i = 0; i < numSatData; i++) {
         //     const satData = satDataArray[i]
         //     if (satData.number === norad) {
         //         result = satData;
         //         break;
         //     }
         // }
         //
         // assert (tleData.getRecordFromNORAD(norad) === result, "CNodeSatelliteTrack: getSatelliteData: TLEData.getRecordFromNORAD does not match the result");
         //
         // return result;

         return tleData.getRecordFromNORAD(norad);


     }


     modDeserialize(v) {
         super.modDeserialize(v);
         // we just force the satellite to be recalculated after all loading is done
         // with the call to NodeMan.recalculateAllRootFirst() that's done after loading
         this.norad = null;

         // But  need to do a recalculate here too to ensure
         // that the cameraTrackSwitch and targetTrackSwitch are set up for deserialization

         this.recalculate();
         this.updateUI();

     }


     checkSatelliteTrackValid() {
         // if we don't have a norad number, then try to get one from the TLE database
         // once we have a norad number, we won't need to do this again
         // as norad numbers should not change
         if (!this.norad) {
             this.norad = this.getSatelliteNumber(this.satellite);
             if (!this.norad) {
                 return false;
             }
         }
         return true;
     }


     getDisplayTrack() {
         // just find the output that's a display track, if any
         for (let outNode of this.outputs) {
             if (outNode instanceof CNodeDisplayTrack) {
                 return outNode;
             }
         }
         return null;
     }

     // and this assumes we use the id of the displaytrack in the contents menu

     getContentsFolder() {
         return guiMenus.contents.getFolder(this.getDisplayTrack()?.id);
     }


     updateUI() {
         if (!this.checkSatelliteTrackValid()) {
             this.getDisplayTrack()?.hide();
             this.getContentsFolder()?.hide();
             // make empty array for the track, so there's nothing to draw
             this.array = new Array(this.frames);

             console.log(`--- CNodeSatelliteTrack: updateUI: HIDING track and UI for invalid satellite ${this.satelliteText}`);

             // remove as an option for camera and target tracking
             const cameraTrackSwitch = NodeMan.get("cameraTrackSwitch", false);
             if (cameraTrackSwitch) {
                 cameraTrackSwitch.removeOption(this.trackName);
             }

             const targetTrackSwitch = NodeMan.get("targetTrackSwitch", false);
             if (targetTrackSwitch) {
                 targetTrackSwitch.removeOption(this.trackName);
             }

             const orbitTargetSwitch = NodeMan.get("orbitTargetSwitch", false);
             if (orbitTargetSwitch) {
                 orbitTargetSwitch.removeOption(this.trackName);
             }
         } else {
             console.log(`+++ CNodeSatelliteTrack: updateUI: SHOWING track and UI for valid satellite ${this.satelliteText}`);

             // make sure track and GUI folder are visible
             this.getDisplayTrack()?.show();
             this.getContentsFolder()?.show();

             // make sure it's in the switch
             const cameraTrackSwitch = NodeMan.get("cameraTrackSwitch", false);
             if (cameraTrackSwitch) {
                 cameraTrackSwitch.replaceOption(this.trackName, this);
             }

             const targetTrackSwitch = NodeMan.get("targetTrackSwitch", false);
             if (targetTrackSwitch) {
                 targetTrackSwitch.replaceOption(this.trackName, this);
             }

             const orbitTargetSwitch = NodeMan.get("orbitTargetSwitch", false);
             if (orbitTargetSwitch) {
                 orbitTargetSwitch.replaceOption(this.trackName, this);
             }
         }
     }

     recalculate() {

         if (!this.checkSatelliteTrackValid()) {
             return;
         }

         // now we have a norad number, so we can get the satellite data

         // in case the the TLE data has changed, we need to recalculate the satellite data object
         // using the current norad number
         // norad numbers should not change over a session (probably never)
         this.satData = this.getSatelliteData(this.norad);

         // However, it's possible the user has REMOVED the satallite by loading
         // a new TLE file, so we need to check if we have a valid satellite data object
         if (!this.satData) {
             console.warn(`CNodeSatelliteTrack:recalculate no satellite data found for ${this.norad}`);
             this.norad = null; // reset norad to force recheck next time
             return;
         }

         // update GUI text when we have a valid satellite
         this.satelliteText = this.satData.name;



         // make empty array for the track
         this.array = new Array(this.frames);


         // get get the best satellite from the TLE data
         // based on the time of the first frame
         const startTime = GlobalDateTimeNode.frameToDate(0);
         const satrec = bestSat(this.satData.satrecs, startTime);


         // fill the array with the ECEF positions of the satellite
         // for the correct time at each frame
         for (let i = 0; i < this.frames; i++) {
             const datetime = GlobalDateTimeNode.frameToDate(i);

             const pos = this.nightSky.calcSatECEF(satrec, datetime);
             this.array[i] = {
                 position: pos,
             };
         }


     }
}