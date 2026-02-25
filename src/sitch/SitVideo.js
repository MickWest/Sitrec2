import {GlobalURLParams, gui, guiMenus, Sit} from "../Globals";
import {setURLParameters} from "../utils";
import {CNodeVideoWebCodecView} from "../nodes/CNodeVideoWebCodecView";
import {CNodeVideoInfoUI} from "../nodes/CNodeVideoInfoUI";
import {DragDropHandler} from "../DragDropHandler";

export const SitVideo = {
    name: "video",
    menuName: "Video Viewer",
    isTextable: false,
    isTool: true,

    framesFromVideo: true,

    fps: 30,
    frames: 0,
    aFrame: 0,
//    bFrame: 0,



    setup: function() {

        this.selectableVideos = {
            "Aguadilla": "../sitrec-videos/public/Aquadilla High Quality Original.mp4",
            "FLIR1": "../sitrec-videos/public/f4-aspect-corrected-242x242-was-242x216.mp4",
            "Gimbal": "../sitrec-videos/public/2 - Gimbal-WMV2PRORES-CROP-428x428.mp4",
            "GofFast": "../sitrec-videos/public/3 - GOFAST CROP HQ - 01.mp4",
            "Chilean": "../sitrec-videos/public/Chilean Navy 13-51-55 from HD 1080p.mp4",
            "Jellyfish": "../sitrec-videos/private/Jellyfish 720p High.mov",
        }

        // the first one to load
//        this.file ="Aguadilla"
        this.file =""

        // patch in any modded video, to avaoid loading twice.
        if (Sit.Sit !== undefined && Sit.Sit.file !== undefined) {
            this.file = Sit.Sit.file;
        }

        let maybeVideo =  GlobalURLParams.get("video")
        if (maybeVideo) {
            // Check if it's a URL (http/https)
            if (maybeVideo.startsWith("http://") || maybeVideo.startsWith("https://")) {
                // Use the URL directly - add it as a selectable video with a derived name
                const urlName = decodeURIComponent(maybeVideo.split('/').pop().split('?')[0]) || "URL Video";
                this.selectableVideos[urlName] = maybeVideo;
                this.file = urlName;
            } else {
                // Match against preset video names (case-insensitive)
                const maybeVideoLower = maybeVideo.toLowerCase()
                for (const vid in this.selectableVideos) {
                    if (vid.toLowerCase() === maybeVideoLower) {
                        this.file = vid
                        break;
                    }
                }
            }
        } else {
            if (this.file !== "") {
                setURLParameters("&video=" + this.file)
            }
        }


        this.VideoNode = new CNodeVideoWebCodecView({id:"video",
                // inputs: {
                //     zoom: new CNodeGUIValue({
                //         value: 100, start: 100, end: 1000, step: 1,
                //         desc: "Video Zoom x"
                //     }, gui)
                // },

                visible: true,
                left: 0, top: 0, width: 1, height: 1,
                draggable: false, resizable: true,
                frames: Sit.frames,
                file: this.selectableVideos[this.file],
                background: "black",
                autoFill: true,
                dragDropVideo: true,
                alwaysReplace: true,
                doubleClickFullscreen: false,
            }
        )

        DragDropHandler.addDropArea();

        this.videoInfoNode = new CNodeVideoInfoUI({
            id: "videoInfo",
            relativeTo: "video",
            visible: true,
            passThrough: true,
        });
        this.setupVideoInfoMenu();

     //   guiMenus.view?.hide();
        guiMenus.objects?.hide();
        guiMenus.physics?.hide();
        guiMenus.showhide?.hide();
        guiMenus.lighting?.hide();
        guiMenus.contents?.hide();

        this.loadFile = function() {
            this.VideoNode.requestAndLoadFile()
        }
        gui.add(this, "loadFile").name("Load Video")

        gui.add(this, "file", this.selectableVideos).onChange(file => {
            this.VideoNode.newVideo(file)

            this.file = "error"
            for (const vid in this.selectableVideos) {
                if (this.selectableVideos[vid] === file) {
                    this.file = vid
                    break;
                }
            }

            setURLParameters("&video="+this.file)

        }).name("Preset Video")
    },

    setupVideoInfoMenu: function() {
        const videoInfo = this.videoInfoNode;
        if (!videoInfo) return;

        videoInfo.setupMenu(guiMenus.video);
    },
}


