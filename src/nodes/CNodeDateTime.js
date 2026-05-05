import {Globals, guiMenus, NodeMan, setRenderOne, setSitchEstablished, Sit} from "../Globals";
import {CNode} from "./CNode";
import {par} from "../par";
import {isKeyCodeHeld, isKeyHeld} from "../KeyBoardHandler";
import {forceUpdateUIText} from "./CNodeViewUI";
import {addOptionToGUIMenu, removeOptionFromGUIMenu} from "../lil-gui-extras";
import {assert} from "../assert";
import {calculateGST} from "../CelestialMath";
import {updateGUIFrames} from "../JetGUI";
import {updateFrameSlider} from "./CNodeFrameSlider";
import {getOffsetFromDateTimeString} from "../DateTimeUtils";
import {EventManager} from "../CEventManager";
import {t} from "../i18n";
import {showTimingAnalysis} from "../showTimingAnalysis";

const timeZoneOffsets = {
    "IDLW UTC-12": -12,     // International Date Line West
    "NT UTC-11": -11,       // Nome Time
    "HST UTC-10": -10,      // Hawaii Standard Time
    "HDT UTC-9": -9,        // Hawaii Daylight Time
    "AKST UTC-9": -9,       // Alaska Standard Time
    "PST UTC-8": -8,        // Pacific Standard Time
    "AKDT UTC-8": -8,       // Alaska Daylight Time
    "PDT UTC-7": -7,        // Pacific Daylight Time
    "MST UTC-7": -7,        // Mountain Standard Time
    "MDT UTC-6": -6,        // Mountain Daylight Time
    "CST UTC-6": -6,        // Central Standard Time
    "CDT UTC-5": -5,        // Central Daylight Time
    "EST UTC-5": -5,        // Eastern Standard Time
    "EDT UTC-4": -4,        // Eastern Daylight Time
    "AST UTC-4": -4,        // Atlantic Standard Time
    "ADT UTC-3": -3,        // Atlantic Daylight Time
    "FKST UTC-3": -3,       // Falkland Islands Summer Time
    "GST UTC-2": -2,        // South Georgia and the South Sandwich Islands
    "AZOT UTC-1": -1,       // Azores Standard Time
    "GMT UTC+0": 0,         // Greenwich Mean Time
    "AZOST UTC+0": 0,       // Azores Summer Time
    "BST UTC+1": 1,         // British Summer Time
    "CET UTC+1": 1,         // Central European Time
    "CEST UTC+2": 2,        // Central European Summer Time
    "EET UTC+2": 2,         // Eastern European Time
    "EEST UTC+3": 3,        // Eastern European Summer Time
    "MSK UTC+3": 3,         // Moscow Standard Time
    "IRST UTC+3.5": 3.5,    // Iran Standard Time
    "SAMT UTC+4": 4,        // Samara Time
    "AFT UTC+4.5": 4.5,     // Afghanistan Time
    "YEKT UTC+5": 5,        // Yekaterinburg Time
    "IST UTC+5.5": 5.5,     // Indian Standard Time
    "NPT UTC+5.75": 5.75,   // Nepal Time
    "OMST UTC+6": 6,        // Omsk Standard Time
    "MMT UTC+6.5": 6.5,      // Myanmar Time
    "KRAT UTC+7": 7,        // Krasnoyarsk Time
    "IRKT UTC+8": 8,        // Irkutsk Time
    "YAKT UTC+9": 9,        // Yakutsk Time
    "VLAT UTC+10": 10,      // Vladivostok Time
    "AEST UTC+10": 10,      // Australian Eastern Standard Time
    "ACST UTC+9.5": 9.5,    // Australian Central Standard Time
    "ACDT UTC+10.5": 10.5,  // Australian Central Daylight Time
    "AWST UTC+8": 8,        // Australian Western Standard Time
    "NZST UTC+12": 12,      // New Zealand Standard Time
    "NZDT UTC+13": 13,      // New Zealand Daylight Time
    "MAGT UTC+11": 11,      // Magadan Time
    "PETT UTC+12": 12,      // Kamchatka Time
    "LHST UTC+10.5": 10.5,  // Lord Howe Standard Time
    "LHDT UTC+11": 11       // Lord Howe Daylight Time
};

// Create a new object where both keys and values are the keys from timeZoneOffsets
const timeZoneKeys = [];



for (const key in timeZoneOffsets) {
    if (timeZoneOffsets.hasOwnProperty(key)) {
        timeZoneKeys.push(key)
    }
}

// given a start time in ms, calculate the current "now" time based on the frame and the simSpeed and fps
function startToNowMS(startMS) {
    const nowMS = (Math.round(startMS + par.frame * 1000 * (Sit.simSpeed??1)/ Sit.fps))
    return nowMS;
}

// reverse of the above, given a "now" time, calculate the start time
function nowToStartMS(nowMS) {
    const startMS = (Math.round(nowMS - par.frame * 1000 * (Sit.simSpeed??1)/ Sit.fps))
    return startMS;
}

function startToNowDateTime(startDateTime) {
    // given a dateTime Object, convert to ms, then convert to now time
    // and then back to a dateTime object
    const start = startDateTime.valueOf();
    const now = startToNowMS(start);
    return new Date(now);
}

function nowToStartDateTime(nowDateTime) {
    // given a dateTime Object, convert to ms, then convert to start time
    // and then back to a dateTime object
    const now = nowDateTime.valueOf();
    const start = nowToStartMS(now);
    return new Date(start);
}

// A UI node for the Date and Time at the start of the video/sitch
// also updates the current time (nowDate) based on Sit settings.
// and calculates common intermediate values, like Greenwitch SideReal Time, and Julian Date
export class CNodeDateTime extends CNode {
    constructor(v) {

        console.log("CNodeDateTime - par.frame = "+par.frame+" Sit.fps = "+Sit.fps+" Sit.simSpeed = "+Sit.simSpeed+" Sit.startTime = "+Sit.startTime)

        super (v)

        
        this.refreshingUI = false;

        this.dateTimeFolder = guiMenus.time;

        this.useTimeZone = true;

        this.dateTime = {
            // year: 2022,
            // month: 1,
            // day: 15,
            // hour: 12,
            // minute: 30,
            // second: 0,
            // millisecond: 0,
        }

        let startTime = Sit.startTime;
        //use the current time if the start time is not set
        // of if the start time is "current" (e.g. SitStarlink.js)
        if (startTime === undefined || startTime === "current") {
            // if the start time is not set, then we use the current time
            this.dateStart = new Date();
            this.originalPopulatedStartTime = new Date();
            startTime = this.dateStart.toISOString();
        }

        this.populateStartTimeFromUTCString(startTime);
        this.dateNow = startToNowDateTime(this.dateStart);


        this.liveMode = (Sit.startLive === true);
        Sit.startLive = false; // only start in live mode once, we can't serialize live mode,  as it only applies to the local user, Saving a sitch with live mode will save at that time.

        this.dateTimeFolder.add( this, "liveMode").name(t("dateTime.liveMode.label")).listen().onChange(v=>{
            if (this.liveMode === true) {
                par.paused = true;
            }
            setRenderOne(true);
        })
            .tooltip(t("dateTime.liveMode.tooltip"))


        // var for the menu to sync the time to the start time or the now time or a track
        // not currently used, but the UI needs the variable.
        this.syncMethod = null;
        this.addSyncSwitch();

        // test the start2now and now2start functions, ensure they go back and forth with no changes
        for (var i = 0; i < 100000; i++) {
            const start = this.dateNow.valueOf() + i;
            const now = startToNowMS(start);
            const start2 = nowToStartMS(now);
            assert(start === start2, "start2now now2start error at i = "+i+" start = "+start+" now = "+now+" start2 = "+start2);
        }


        this.dateTimeFolder.add(Sit, "startTime").listen()
            .tooltip(t("dateTime.startTime.tooltip"))
        this.dateTimeFolder.add(Sit, "nowTime").listen()
            .tooltip(t("dateTime.currentTime.tooltip"))

        let fiveYearsFromNow = new Date();
        fiveYearsFromNow.setFullYear(fiveYearsFromNow.getFullYear() + 5);

      // The UI will update the dateNow member, and then we will update the dateStart member
        const guiYear = this.dateTimeFolder.add(this.dateTime, "year", 1947, fiveYearsFromNow.getFullYear(), 1).listen().onChange(v => this.updateDateTime(v)).name(t("dateTime.year.label")).tooltip(t("dateTime.year.tooltip"))
        const guiMonth = this.dateTimeFolder.add(this.dateTime, "month", 1, 12, 1).listen().onChange(v => this.updateDateTime(v)).wrap(guiYear).name(t("dateTime.month.label")).tooltip(t("dateTime.month.tooltip"))
        this.guiDay = this.dateTimeFolder.add(this.dateTime, "day", 1, 31, 1).listen().onChange(v => this.updateDateTime(v)).wrap(guiMonth).name(t("dateTime.day.label")).tooltip(t("dateTime.day.tooltip"))
        const guiHour =  this.dateTimeFolder.add(this.dateTime, "hour", 0, 23, 1).listen().onChange(v => this.updateDateTime(v)).wrap(this.guiDay).name(t("dateTime.hour.label")).tooltip(t("dateTime.hour.tooltip"))
        const guiMinute = this.dateTimeFolder.add(this.dateTime, "minute", 0, 59, 1).listen().onChange(v => this.updateDateTime(v)).wrap(guiHour).name(t("dateTime.minute.label")).tooltip(t("dateTime.minute.tooltip"))
        const guiSecond = this.dateTimeFolder.add(this.dateTime, "second", 0, 59, 1).listen().onChange(v => this.updateDateTime(v)).wrap(guiMinute).name(t("dateTime.second.label")).tooltip(t("dateTime.second.tooltip"))
        const guiMillisecond = this.dateTimeFolder.add(this.dateTime, "millisecond", 0, 999, 1).listen().onChange(v => this.updateDateTime(v)).wrap(guiSecond).name(t("dateTime.millisecond.label")).tooltip(t("dateTime.millisecond.tooltip"))

        this.adjustGUIForTimezone();

        this.adjustDaysInMonth();

        const options = { timeZoneName: 'short' };
        const timeZone = Sit.timeZone ?? new Date().toLocaleTimeString('en-us', options).split(' ')[2];

        this.timeZoneName = "PDT UTC-7";
        for (let tz of timeZoneKeys) {
            if (tz.startsWith(timeZone)) {
                this.timeZoneName = tz;
                this.timeZoneOffset = timeZoneOffsets[tz];
            }
        }

        // get the time zone offset from a new Date object
        const offset = new Date().getTimezoneOffset() / -60; // getTimezoneOffset returns in minutes, so divide by -60 to get hours
        this.setTimeZoneNameFromOffset(offset);


        // add the time zon flag
        this.dateTimeFolder.add( this, "useTimeZone").name(t("dateTime.useTimeZone.label")).listen().onChange(v=>{
            this.adjustGUIForTimezone();
            this.populate();
            forceUpdateUIText();
            setRenderOne(true);
        })
        .tooltip(t("dateTime.useTimeZone.tooltip"));


        this.dateTimeFolder.add(this, "timeZoneName", timeZoneKeys).name(t("dateTime.timeZone.label")).listen().onChange(
            v => {
                console.log("Timezone "+v)
                this.populate();
                forceUpdateUIText();
                setRenderOne(true);
            }
        )
            .tooltip(t("dateTime.timeZone.tooltip"));

        this.oldSimSpeed = Sit.simSpeed;

        this.dateTimeFolder.add(Sit, 'simSpeed', 0.01, 120, 0.01).name(t("dateTime.simSpeed.label")).listen().onChange(
            v => {
                // if the simSpeed changes, we need to update the start time
                // but we want the nowTime to remain the same, so we need to calculate
                // the new start time relative to that with the new simSpeed
                this.setNowDateTime(this.dateNow); // this will update the dateStart member
                this.recalculateCascade();
            }
        )
            .tooltip(t("dateTime.simSpeed.tooltip"))


        /// these are duplicate of the "Sync Time to" menu
        // this.dateTimeFolder.add(this, "resetStartTime").name("Reset Start Time");
        // this.dateTimeFolder.add(this, "resetNowTimeToCurrent").name("Sync to Current Time");

        this.addedSyncToTrack = false;

        if (Sit.showDateTime) {
            this.dateTimeFolder.open();
        } else {
            this.dateTimeFolder.close();
        }

        this.guiSitchFrames = this.dateTimeFolder.add(Sit, "frames",1,2000,1).name(t("dateTime.sitchFrames.label")).listen().elastic()
            .onChange((v) => {
                this.sitchDuration = this.framesToDuration(Sit.frames);
            })
            .onFinishChange((v) => {
                this.changedFrames();
            })
            .tooltip(t("dateTime.sitchFrames.tooltip"))

        this.sitchDuration = this.framesToDuration(Sit.frames);
        this.guiSitchDuration = this.dateTimeFolder.add(this, "sitchDuration").name(t("dateTime.sitchDuration.label")).listen().onFinishChange((v) => {
            const frames = this.durationToFrames(v);
            if (frames !== null && frames !== Sit.frames) {
                Sit.frames = frames;
                if (Sit.frames > this.guiSitchFrames._max) {
                    this.guiSitchFrames._elasticMax = Math.max(this.guiSitchFrames._elasticMax, Sit.frames);
                    while (Sit.frames > this.guiSitchFrames._max && this.guiSitchFrames._max < this.guiSitchFrames._elasticMax) {
                        this.guiSitchFrames._max = Math.min(this.guiSitchFrames._max * 2, this.guiSitchFrames._elasticMax);
                    }
                    this.guiSitchFrames.updateElasticStep();
                }
                this.changedFrames();
            }
        })
            .tooltip(t("dateTime.sitchDuration.tooltip"))

        this.guiAFrame = this.dateTimeFolder.add(Sit, "aFrame",1,Sit.frames,1).name(t("dateTime.aFrame.label")).listen().onChange((v) => {

            if (Sit.aFrame > Sit.bFrame) Sit.bFrame = Sit.aFrame
            updateFrameSlider();
            NodeMan.recalculateAllRootFirst(); // really just need to redraw things..

        }).onFinishChange(() => {
            EventManager.dispatchEvent("abFrameChanged");
        })
            .tooltip(t("dateTime.aFrame.tooltip"))

        if (Sit.bFrame === undefined) {
            Sit.bFrame = Sit.frames-1
        }

        this.guiBFrame = this.dateTimeFolder.add(Sit, "bFrame",1,Sit.frames,1).name(t("dateTime.bFrame.label")).listen().onChange((v) => {
            if (Sit.bFrame < Sit.aFrame) Sit.aFrame = Sit.bFrame
            updateFrameSlider();
            NodeMan.recalculateAllRootFirst();


        }).onFinishChange(() => {
            EventManager.dispatchEvent("abFrameChanged");
        })
            .tooltip(t("dateTime.bFrame.tooltip"))


        this.dateTimeFolder.add(Sit, "fps",1,120,0.01).name(t("dateTime.videoFps.label")).listen().onFinishChange((v) => {
            this.changedFrames()
        })
            .tooltip(t("dateTime.videoFps.tooltip"))

        // Timing Analysis button — generates a detailed report of video PTS,
        // KLV intervals, gaps, drift, and GPS-velocity consistency. Only
        // useful when there's a MISB data node in the sitch; the handler
        // looks one up at click time so the button appears regardless and
        // shows a helpful message if no MISB is present.
        this._runTimingAnalysis = () => this._timingAnalysisAction();
        this.dateTimeFolder.add(this, "_runTimingAnalysis").name("Timing Analysis...");

        this.update(0);

        this.lastFrames = Sit.frames;

    }


    adjustGUIForTimezone() {
        // change the color year, month, day, hour, minute, second and millisecond
        // labels to pink if the time zone is being used

        let color = "white";
        if (this.useTimeZone) {
            color = "pink";
        }
        this.dateTimeFolder.controllers.forEach(controller => {
            if (['useTimeZone', 'year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'].includes(controller.property)) {
                controller.setLabelColor(color);
            }
        });

    }


    adjustDaysInMonth() {
        if (this.guiDay === undefined) return;
        let days = 31;
        if (this.dateTime.month === 2) {
            days = 28;
            if (this.dateTime.year % 4 === 0) {
                days = 29;
            }
        } else if ([4, 6, 9, 11].includes(this.dateTime.month)) {
            days = 30;
        }
        this.guiDay.max(days);
    }
    
    framesToDuration(frames) {
        const totalSeconds = frames / Sit.fps;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const wholeSeconds = Math.floor(seconds);
        const milliseconds = Math.round((seconds - wholeSeconds) * 1000);
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${wholeSeconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
    }

    durationToFrames(durationStr) {
        let hours = 0, minutes = 0, seconds = 0, milliseconds = 0;
        
        const fullMatch = durationStr.match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
        if (fullMatch) {
            hours = parseInt(fullMatch[1], 10);
            minutes = parseInt(fullMatch[2], 10);
            seconds = parseInt(fullMatch[3], 10);
            milliseconds = fullMatch[4] ? parseInt(fullMatch[4].padEnd(3, '0').substring(0, 3), 10) : 0;
        } else {
            const mmssMatch = durationStr.match(/^(\d+):(\d+)(?:\.(\d+))?$/);
            if (mmssMatch) {
                minutes = parseInt(mmssMatch[1], 10);
                seconds = parseInt(mmssMatch[2], 10);
                milliseconds = mmssMatch[3] ? parseInt(mmssMatch[3].padEnd(3, '0').substring(0, 3), 10) : 0;
            } else {
                const ssMatch = durationStr.match(/^(\d+)(?:\.(\d+))?$/);
                if (ssMatch) {
                    seconds = parseInt(ssMatch[1], 10);
                    milliseconds = ssMatch[2] ? parseInt(ssMatch[2].padEnd(3, '0').substring(0, 3), 10) : 0;
                } else {
                    return null;
                }
            }
        }
        
        const totalSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
        return Math.round(totalSeconds * Sit.fps);
    }

    // Click handler for the "Timing Analysis..." button. Walks NodeMan to
    // find a CNodeMISBDataTrack, asks it to generate the report, and shows
    // it in a modal with Copy/Download buttons.
    _timingAnalysisAction() {
        // Collect every MISB data node so multi-stream KLV (e.g. async + sync
        // PES variants on different PIDs) shows up in the report. Prefer the
        // one with PES PTS data for the full analysis since that one carries
        // the MISB ST 0604 sync anchor.
        const misbNodes = [];
        NodeMan.iterate((k, n) => {
            if (n.constructor && n.constructor.name === "CNodeMISBDataTrack") {
                misbNodes.push(n);
            }
        });
        if (misbNodes.length === 0) {
            showTimingAnalysis(
                "No MISB data node loaded in this sitch.\n\n" +
                "The Timing Analysis report requires a MISB/KLV data source.\n" +
                "Load a sitch with a .ts file or KLV-bearing .mp4 to enable it."
            );
            return;
        }
        const withPES = misbNodes.find(n => typeof n.hasRecordPTS === "function" && n.hasRecordPTS());
        const misbNode = withPES || misbNodes[0];

        // Build a sibling summary so the report names every loaded MISB
        // stream and which one was analyzed — important when multiple KLV
        // PIDs exist and only one has PES PTS.
        let prelude = "";
        if (misbNodes.length > 1) {
            prelude += "MULTIPLE MISB DATA NODES LOADED\n";
            prelude += "─".repeat(60) + "\n";
            for (const n of misbNodes) {
                const has = (typeof n.hasRecordPTS === "function" && n.hasRecordPTS()) ? "yes" : "no";
                const len = (n.misb && n.misb.length) ? n.misb.length : 0;
                const tag = (n === misbNode) ? "  ← ANALYZED" : "";
                prelude += `  ${n.id}\n`;
                prelude += `    records: ${len}, hasRecordPTS: ${has}${tag}\n`;
            }
            prelude += "\n  The node with PES PTS (sync-mode KLV) is preferred when\n";
            prelude += "  available. Other nodes are loaded but not analyzed here.\n\n";
        }

        const report = prelude + misbNode.generateTimingAnalysis();
        const safeName = (Sit.name || "sitch").replace(/[^a-z0-9_-]/gi, "_");
        showTimingAnalysis(report, `sitrec-timing-${safeName}.txt`);
    }

    changedFrames() {
        Sit.frames = Math.round(Sit.frames);
        par.frames = Sit.frames;
        updateGUIFrames();
        updateFrameSlider();

        this.sitchDuration = this.framesToDuration(Sit.frames);

        // new maximum values for the aFrame and bFrame sliders
        this.guiAFrame.max(Sit.frames-1);
        this.guiBFrame.max(Sit.frames-1);

        // clamp the bFrame to the new Sit.frames if it was there before
        // so draggin up the Sit.frames will also drag up the bFrame
        if (Sit.bFrame === this.lastFrames - 1) {
            Sit.bFrame = Sit.frames - 1;
        } else {
            // we've adjusted bFrame, so use the smaller of the two
            Sit.bFrame = Math.min(Sit.bFrame, Sit.frames - 1);
        }

        // if aFrame is greater than bFrame, then set it to zero
        if (Sit.aFrame > Sit.bFrame) Sit.aFrame = 0;

        this.lastFrames = Sit.frames;

        NodeMan.updateSitFramesChanged();


    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            startDateTime: this.getStartTimeString(),
            timeZoneName: this.timeZoneName,
            simSpeed: Sit.simSpeed,
            useTimeZone: this.useTimeZone,
        }
    }

    modDeserialize(v) {
        // for historical, useTimeZone is false by default
        this.useTimeZone =(v.useTimeZone !== undefined) ? v.useTimeZone : false;

        super.modDeserialize(v);
        this.populateStartTimeFromUTCString(v.startDateTime);
        this.timeZoneName = v.timeZoneName;


        Sit.simSpeed = v.simSpeed;
        this.populate();
        this.update(0);
    }


    get date() {
        assert(0, "CNodeDateTime - date is deprecated")
    }

    getTimeZoneName() {
        return this.timeZoneName;
    }

    getTimeZoneOffset() {
        // if the time zone name is not in the array than we just return the current time zone offset
        if (this.timeZoneName === undefined || !timeZoneOffsets.hasOwnProperty(this.timeZoneName)) {
            console.warn("CNodeDateTime - getTimeZoneOffset called with unknown time zone name: " + this.timeZoneName);
            return this.timeZoneOffset;
        }

        return(timeZoneOffsets[this.timeZoneName])
    }

    // add a select node that has the start time
    addSyncSwitch() {

        this.syncSwitch = this.dateTimeFolder.add(this, "syncMethod", ["-","Start Time", "Now Time"]).name(t("dateTime.syncTimeTo.label"))
            .onChange( v => {
                if (v === "-") {
                    // do nothing
                } else if (v === "Start Time") {
                    this.resetStartTime(); }
                else if (v === "Now Time") {
                    this.resetNowTimeToCurrent();
                } else {
                    // it the name of a track
                    console.log(v)
                    this.syncToTrack(v)
                }
                this.populate();
                setRenderOne(true)

                // reset it back to the default
                // so we can select the same thing again
                this.syncMethod = "-";
                this.syncSwitch.updateDisplay();


            }
        )
            .tooltip(t("dateTime.syncTimeTo.tooltip"));
    }

    addSyncToTrack(timedTrack) {
        if (!this.addedSyncToTrack) {
          //  this.dateTimeFolder.add(this, "syncStartTimeTrack").name("Sync to "+timedTrack);

            removeOptionFromGUIMenu(this.syncSwitch, timedTrack);
            addOptionToGUIMenu(     this.syncSwitch, timedTrack, timedTrack)

        }
        this.syncTrack = timedTrack;
    }

    // Remove a track from the "Sync Time to" dropdown when its underlying data node
    // is disposed. If the user currently has that option selected, reset the switch
    // back to "-" so the GUI does not retain a dead reference.
    removeSyncToTrack(timedTrack) {
        if (!this.syncSwitch || !timedTrack) {
            return;
        }

        removeOptionFromGUIMenu(this.syncSwitch, timedTrack);

        if (this.syncTrack === timedTrack) {
            this.syncTrack = null;
        }

        if (this.syncMethod === timedTrack) {
            this.syncMethod = "-";
            this.syncSwitch.updateDisplay();
        }
    }

    // meu callback funtion for the sync button (deprecated)
    syncStartTimeTrack(recalculating = true) {
        this.syncToTrack(this.syncTrack, recalculating)
    }

    // sync the start time to the start time of a track given by trackID
    syncToTrack(trackID, recalculating = true) {
        par.frame = 0;
        const timedTrackNode = NodeMan.get(trackID);
        const startTime = timedTrackNode.getTrackStartTime();
//        console.log(">>>"+startTime)

        this.setStartDateTime(new Date(startTime));

        // rebuild all nodes that depend on the start time (all tracks, not just the synced one)
        if (recalculating) {
            this.recalculateCascade(0);
        }
    }

    setTimeZoneNameFromOffset(offset) {

        // we only use this if we can't find the time zone name in the timeZoneOffsets object
        this.timeZoneOffset = offset;

        if (offset === undefined || offset === null) {
            console.warn("CNodeDateTime - setTimeZoneNameFromOffset called with undefined or null offset");
            this.timeZoneName = "???"
            assert(0, "CNodeDateTime - setTimeZoneNameFromOffset called with undefined or null offset");
            return;
        }

        // set the time zone name based on the offset
        // e.g. -7 becomes "PDT UTC-7"
        for (const [key, value] of Object.entries(timeZoneOffsets)) {
            if (value === offset) {
                this.timeZoneName = key;
                return;
            }
        }

        // if we didn't find a match, then set it to plus (or minus) the offset
        this.timeZoneName = "UTC" + (offset >= 0 ? "+" : "-") + Math.abs(offset).toFixed(2);
    }

    // get the start time from a string in ISO 8601 format
    // or from a Date object
    setStartDateTime(dateTime, skipLiveModeReset = false) {
        this.dateStart = new Date(dateTime);

        if (typeof dateTime === 'string') {
            this.setTimeZoneNameFromOffset(getOffsetFromDateTimeString(dateTime));
        }

        this.dateNow = startToNowDateTime(this.dateStart);
        this.populate(skipLiveModeReset);
        setRenderOne(true);
    }

    setNowDateTime(dateTime, skipLiveModeReset = false) {
        this.dateNow = new Date(dateTime);
        this.dateStart = nowToStartDateTime(this.dateNow);
        this.populate(skipLiveModeReset);
    }

    resetStartTime() {
        this.setStartDateTime( this.originalPopulatedStartTime);
        this.updateDateTime()
    }

    resetNowTimeToCurrent() {
        this.setNowDateTime(new Date());
        this.updateDateTime()
    }

    populate(skipLiveModeReset = false) {

        // if we are populating the time, then clear the live mode, as they are manually setting the time,
        // so we don't want to override it later in the update function

        if (!skipLiveModeReset && this.liveMode) {
            console.log("CNodeDateTime - populate - resetting live mode to false")
            this.liveMode = false;
        }


        let dateNow = this.dateNow;

        if (this.useTimeZone) {
            // dateNow is in UTC, so we need to convert it to the local time zone
            dateNow = new Date(dateNow.getTime() + (this.getTimeZoneOffset() * 60*60000));

        }

        this.dateTime.year   = dateNow.getUTCFullYear();
        this.dateTime.month  = dateNow.getUTCMonth() + 1; // Months are 0-indexed in JavaScript
        this.dateTime.day    = dateNow.getUTCDate();
        this.dateTime.hour   = dateNow.getUTCHours();
        this.dateTime.minute = dateNow.getUTCMinutes();
        this.dateTime.second = dateNow.getUTCSeconds();
        this.dateTime.millisecond = this.dateNow.getUTCMilliseconds();

        Sit.startTime = this.dateStart.toISOString();
        Sit.nowTime   = this.dateNow.toISOString();

        this.adjustDaysInMonth();

    }

    populateStartTimeFromUTCString(utcString, skipLiveModeReset = false) {
        // make a copy of the the original start time, so we can reset to it later with a UI button
        this.originalPopulatedStartTime = new Date(utcString);
        this.setStartDateTime(new Date(utcString), skipLiveModeReset);
    }


    // toUTCString() {
    //      // Return the UTC string representation
    //      return this.dateNow.toISOString();
    //  }
    //
    // toLocalString() {
    //     return this.dateNow.toLocalString();
    // }

    // update the start and now date members from the dateTime member
    // i.e. takes all the UI entires, and sets the now time, which will set the start time
    updateDateTime(v) {
        if (!this.refreshingUI) {
            this.liveMode = false;

            // if they set the time, don't auto set it later
            setSitchEstablished(true);

            this.adjustDaysInMonth();

            let newDate = new Date(Date.UTC(
                this.dateTime.year,
                this.dateTime.month - 1, // Months are 0-indexed in JavaScript
                this.dateTime.day,
                this.dateTime.hour,
                this.dateTime.minute,
                this.dateTime.second,
                this.dateTime.millisecond,
            ));

            // if the time zone is set, then we adjust FROM the local time to UTC
            if (this.useTimeZone) {
                // adjust the newDate to UTC by subtracting the time zone offset
                newDate = new Date(newDate.getTime() - (this.getTimeZoneOffset() * 60*60000));
            }


            this.setNowDateTime(newDate)
            Globals.debugCascade = true;
            Globals.debugCounter = 0;
            this.recalculateCascade()
//            console.log("Did a time change recalc debugCounter = "+Globals.debugCounter)
            Globals.debugCascade = false;
            setRenderOne(true);
            setSitchEstablished(true);
        }
    }

    // ms since the start of the epoch
    getStartTimeValue() {
        return this.dateStart.valueOf()
    }

    getStartTimeString() {
        return this.dateStart.toISOString()
    }


    timeWithTimeZone(date) {
        // ISO string with the time zone offset applied and included, like
        // 2025-07-19T15:30:00-07:00
        const adjustedDate = new Date(date.getTime() + (this.getTimeZoneOffset() * 60*60000));
        return adjustedDate.toISOString().replace('Z', this.getTimeZoneOffset() >= 0 ? '+' : '-') + String(Math.abs(this.getTimeZoneOffset())).padStart(2, '0') + ':00';
    }

    getStartTimeWithTimeZone() {
        let date = new Date(this.getStartTimeValue());
        return this.timeWithTimeZone(date);
    }

    // adjust start time by t seconds, for example when the user presses a key, like [ or ]
    AdjustStartTime(t) {
        var time = this.getStartTimeValue()
        time += t
        this.setStartDateTime(new Date(time))
        this.populate()
        // some done twice here, look into tidying up
        this.updateDateTime()
    }


// given a frame number then return the time in ms since the start of the epoch
    frameToMS(frame) {
        const startMS = this.dateStart.valueOf();
        const MS = (Math.round(startMS + frame * 1000 * (Sit.simSpeed??1)/ Sit.fps))
        return MS;
    }

// as above, but return a date object
    frameToDate(frame) {
        const MS = this.frameToMS(frame);
        return new Date(MS);
    }

    update(frame) {

        // first check for live mode
        if (this.liveMode) {
            // we lock the frame to the center of the slider
            par.frame = Math.floor(Sit.frames / 2);
            const currentTime = new Date();
            this.setNowDateTime(currentTime, true);
        }

        this.frame = frame
        this.dateNow = startToNowDateTime(this.dateStart);

        if (!this.liveMode) {
            this.refreshingUI = true;
            this.populate();
            this.refreshingUI = false;
        }

        var speedscale = 1;
        if (isKeyHeld('shift'))
            speedscale *= 10
        if (isKeyHeld('control'))
            speedscale *= 100
        if (isKeyHeld('alt'))
            speedscale *= 1000
        if (isKeyHeld('meta'))
            speedscale *= 10000

        if (isKeyCodeHeld('Semicolon')) {
            this.AdjustStartTime(-1000*speedscale)
        }
        if (isKeyCodeHeld('Quote')) {
            this.AdjustStartTime(1000*speedscale)
        }

        // if (isKeyCodeHeld('BracketLeft')) {
        //     this.AdjustStartTime(-3000*speedscale)
        // }
        // if (isKeyCodeHeld('BracketRight')) {
        //     this.AdjustStartTime(3000*speedscale)
        // }


        this.nowGST = calculateGST(this.dateNow)
    }

    // getDateNow(frame) {
    //     return this.dateNow;
    //     }

}
