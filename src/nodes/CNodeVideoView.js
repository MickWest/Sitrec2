// loading and storing video frames
import {CNodeViewCanvas2D} from "./CNodeViewCanvas";
import {par} from "../par";
import {quickToggle} from "../KeyBoardHandler";
import {CNodeGUIValue} from "./CNodeGUIValue";
import {guiTweaks, NodeMan, setRenderOne, Sit} from "../Globals";
import {CMouseHandler} from "../CMouseHandler";
import {CNodeViewUI} from "./CNodeViewUI";
import {CVideoWebCodecDataRaw} from "../CVideoWebCodecDataRaw";
import {CVideoImageData} from "../CVideoImageData";
import {assert} from "../assert";
import {EventManager} from "../CEventManager";


export class CNodeVideoView extends CNodeViewCanvas2D {
    constructor(v) {
        super(v);
        // this.canvas.addEventListener( 'wheel', e => this.handleMouseWheel(e) );

        // these no longer work with the new rendering pipeline
        // TODO: reimplement them as effects?
        // this.optionalInputs(["brightness", "contrast", "blur", "greyscale"])
        //
        // if (this.overlayView !== undefined)
        //     addFiltersToVideoNode(this)

        this.positioned = false;
        this.autoFill = v.autoFill ?? true; // default to autofill
        this.shiftDrag = true;

        this.imageWidth = 0;
        this.imageHeight = 0;
        this.scrubFrame = 0; // storing fractiona accumulation of frames while scrubbing

        this.autoClear = (v.autoClear !== undefined)? v.autoClear : false;

        this.input("zoom", true); // zoom input is optional

        this.videoSpeed = v.videoSpeed ?? 1; // default to 1x speed

        this.setupMouseHandler();

        // if it's an overlay view then we don't need to add the overlay UI view
        if (!v.overlayView) {
            // Add an overlay view to show status (mostly errors)
            this.overlay = new CNodeViewUI({id: this.id+"_videoOverlay", overlayView: this})
            this.overlay.ignoreMouseEvents();
        }

        v.id = v.id + "_data"

        if (v.file !== undefined) {
            this.newVideo(v.file, false); // don't clear Sit.frames as legacy code sets it when passing in a video filename this way
        }


    }

    newVideo(fileName, clearFrames = true) {
        if (clearFrames) {
            Sit.frames = undefined; // need to recalculate this
        }
        this.fileName = fileName;
        this.disposeVideoData()
        this.videoData = new CVideoWebCodecDataRaw({id: this.id + "_data", file: fileName, videoSpeed: this.videoSpeed},
            this.loadedCallback.bind(this), this.errorCallback.bind(this))

        // loaded from a URL, so we can set the staticURL
        this.staticURL = this.fileName;

        this.positioned = false;
        par.frame = 0;
        par.paused = false; // unpause, otherwise we see nothing.
        this.addLoadingMessage()
        this.addDownloadButton()


    }

    addLoadingMessage() {
        if (this.overlay)
            this.overlay.addText("videoLoading", "LOADING", 50, 50, 5, "#f0f000")
    }


    removeText() {
        if (this.overlay) {
            this.overlay.removeText("videoLoading")
            this.overlay.removeText("videoError")
            this.overlay.removeText("videoErrorName")
            this.overlay.removeText("videoNo")
        }
    }


    stopStreaming() {
        this.removeText()
        par.frame = 0
        par.paused = false;
        if (this.videoData) {
            this.videoData.stopStreaming()
        }
        this.positioned = false;
    }



    loadedCallback() {
        this.removeText();

        // Setting image Width and Height
        // this will get overwritten later if the frames decode to a different size
        // however this should be the correct size for the video now
        this.imageWidth = this.videoData.imageWidth;
        this.imageHeight = this.videoData.imageHeight;

        // if we loaded from a mod or custom
        // then we might want to set the frame nubmer
        if (Sit.pars !== undefined && Sit.pars.frame !== undefined) {
            par.frame = Sit.pars.frame;
        }


    }

    errorCallback() {
        this.videoData.error = false;
        if (this.overlay) {
            this.overlay.removeText("videoLoading")
            this.overlay.addText("videoError", "Error Loading", 50, 45, 5, "#f0f000", "center")
            this.overlay.addText("videoErrorName", this.fileName, 50, 55, 1.5, "#f0f000", "center")
        }
    }

    onMouseWheel(e) {

        if (this.overlayView !== undefined) {
            // if this is an overlay view, then we don't want to zoom
            // as the overlay view is not zoomable
            // so we just pass the event to the overlaid view
            if (this.overlayView.onMouseWheel !== undefined) {
                this.overlayView.onMouseWheel(e);
            }
            return;
        }

        var scale = 0.90;  // zoom in/out by 10% on mouse wheel up/down
        if (e.deltaY < 0) {
            scale = 1 / scale
        }

        const videoZoom = NodeMan.get("videoZoom", false);
        if (videoZoom !== undefined) {
            let v = videoZoom.value;
            v *= scale;
            videoZoom.setValue(v);
        }
    }


    setupMouseHandler() {
        this.mouse = new CMouseHandler(this, {

            wheel: (e) => {

//                console.log(e.deltaY)
                var scale = 0.90;
                if (e.deltaY > 0) {
//                    this.in.zoom.value *= 0.6666
                } else {
//                    this.in.zoom.value *= 1 / 0.6666
                    scale = 1 / scale
                }

                this.zoomView(scale)

            },

            drag: (e) => {
                const moveX = this.mouse.dx / this.widthPx; // px = mouse move as a fraction of the screen width
                const moveY = this.mouse.dy / this.widthPx
                this.posLeft += moveX
                this.posRight += moveX
                this.posTop += moveY
                this.posBot += moveY

            },


            rightDrag: (e) => {
                this.scrubFrame += this.mouse.dx / 4
                if (this.scrubFrame >= 1.0 || this.scrubFrame <= -1.0) {
                    const whole = Math.floor(this.scrubFrame)
                    par.frame += whole
                    this.scrubFrame -= whole;
                }

                setRenderOne(true);
            },


            centerDrag: (e) => {
                this.zoomView(100/(100-this.mouse.dx))
            },

            dblClick: (e) => {
                this.defaultPosition();
            }

        })
    }

    toSerializeCNodeVideoView = ["posLeft", "posRight", "posTop", "posBot"]

    modSerialize() {
            return {
                ...super.modSerialize(),
                ...this.simpleSerialize(this.toSerializeCNodeVideoView)

            }
    }

    modDeserialize(v) {
        super.modDeserialize(v)
        this.simpleDeserialize(v, this.toSerializeCNodeVideoView)
        this.positioned = true;
    }

    disposeVideoData() {
        if (this.videoData) {
            this.videoData.stopStreaming()
            this.videoData.dispose();
            this.videoData = null;
        }
        this.staticURL = undefined; // clear the static URL, so we will rehost any dropped file
    }


    makeImageVideo(filename, img, deleteAfterUsing = false) {

        this.fileName = filename;

        this.disposeVideoData()
        this.videoData = new CVideoImageData({
                id: this.id + "_data",
                filename:filename,
                img: img,
                deleteAfterUsing: deleteAfterUsing
            },
            this.loadedCallback.bind(this), this.errorCallback.bind(this))
        this.positioned = false;
        par.frame = 0;
        par.paused = false; // unpause, otherwise we see nothing.
        // this.addLoadingMessage()
        // this.addDownloadButton()
        EventManager.dispatchEvent("videoLoaded", {
            width: img.width, height: img.height,
            videoData: this});
    }

    renderCanvas(frame = 0) {
        super.renderCanvas(frame); // needed for setting window size

        if (!this.visible) return;

        // if no video file, this is just a drop target for now
        if (!this.videoData) return;
        this.videoData.update()
        const image = this.videoData.getImage(frame);
        if (image) {

            const ctx = this.canvas.getContext("2d");

           //  ctx.fillstyle = "#FF00FFFF"
           //  ctx.fillRect(0, 0, this.canvas.width/3, this.canvas.height);

            // image width might change, for example, with the tiny images used by the old Gimbal video
            if (this.imageWidth !== image.width) {
                console.log("Image width changed from " + this.imageWidth + " to " + image.width)
                this.imageWidth = image.width;
                this.imageHeight = image.height;
            }

            if (!this.positioned) {
                this.defaultPosition()
            }
            // positions are a PERCENTAGE OF THE WIDTH

            if (quickToggle("Smooth", false, guiTweaks) === false)
                ctx.imageSmoothingEnabled = false;

                var filter = ''
                if (this.in.contrast){
                    filter += "contrast("+this.in.contrast.v0+") "
                }
                if (this.in.brightness){
                    filter += "brightness("+this.in.brightness.v0+") "
                }
                if (this.in.blur && this.in.blur.v0 !== 0){
                 filter += "blur("+this.in.blur.v0+"px) "
                }

            if (filter != "") ctx.filter = filter;

            const sourceW = this.imageWidth;
            const sourceH = this.imageHeight
            // rendering fill the view in at least one direction
            const aspectSource = sourceW / sourceH
            const aspectView = this.widthPx / this.heightPx


            // TODO - combine this zoom input with the mouse zoom
            if (this.in.zoom != undefined) {

                this.getSourceAndDestCoords();
                ctx.drawImage(image,this.sx, this.sy, this.sWidth, this.sHeight,
                    this.dx, this.dy, this.dWidth, this.dHeight);

            } else {
                // Here the zoom is being controlled by zoomView
                // which zooming in and out around the mouse
                ctx.drawImage(image,
                    0, 0, this.imageWidth, this.imageHeight,
                    this.widthPx*(0.5+this.posLeft), this.heightPx*0.5+this.widthPx*this.posTop,
                    this.widthPx*(this.posRight-this.posLeft), this.widthPx*(this.posBot-this.posTop))
                ctx.imageSmoothingEnabled = true;

            }


            ctx.filter = '';


        }
    }


    // so we need to account for the mouse position, in this fractional system
    zoomView(scale) {
        var offX = (this.mouse.anchorX - this.widthPx / 2) / this.widthPx;
        var offY = (this.mouse.anchorY - this.heightPx / 2) / this.widthPx;

        this.posLeft -= offX;
        this.posRight -= offX;
        this.posTop -= offY;
        this.posBot -= offY;

        this.posLeft *= scale;
        this.posRight *= scale;
        this.posTop *= scale;
        this.posBot *= scale;

        this.posLeft += offX;
        this.posRight += offX;
        this.posTop += offY;
        this.posBot += offY;

        setRenderOne(true);
    }

    defaultPosition() {
        const sourceW = this.imageWidth;
        const sourceH = this.imageHeight
        // rendering fill the view in at least one direction
        const aspectSource = sourceW / sourceH
        const aspectView = this.widthPx / this.heightPx

        if (aspectSource > aspectView) {
            // fill for width
            this.posLeft = -0.5;
            this.posTop = this.posLeft / aspectSource;
        } else {
            // fill to height
            //this.posTop = -0.5;
            //this.posLeft = -0.5*sourceW/sourceH;

            // we want to distance to the top as a percentage of the width
            this.posTop = -0.5 / aspectView

            this.posLeft = this.posTop * aspectSource;

        }
        this.posRight = -this.posLeft;
        this.posBot = -this.posTop;
        this.positioned = true;
        setRenderOne(true);
    }


    // as per https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage

    getSourceAndDestCoords() {
        assert(this.in.zoom !== undefined, "canvasToVideoCoords requires zoom input to be defined");

//        assert(this.imageWidth > 0 && this.imageHeight > 0, "canvasToVideoCoords requires imageWidth and imageHeight to be set, this="+this.id);


        // imageWidth and imageHeight are the original video dimensions
        let sourceW = this.imageWidth;
        let sourceH = this.imageHeight

        if (sourceW <= 0 || sourceH <= 0) {
            // if the sourceW or sourceH is not set, then we can't calculate the coordinates
            console.error("CNodeVideoView.getSourceAndDestCoords called with invalid image dimensions, video not loaded? this="+this.id+", sourceW="+sourceW+", sourceH="+sourceH);
            sourceW = this.widthPx;
            sourceH = this.heightPx;
        }


        const aspectSource = sourceW / sourceH

        // the view is the canvas size, widthPx and heightPx
        const aspectView = this.widthPx / this.heightPx

        // magnification factor, it's a percentage, and we convert it to a decimal
        // if 1, then the video will fill the view in the direction of smallest dimension
        const zoom = this.in.zoom.v0 / 100;


        // there offsets are relative to the source image, not the view
        // they will be the virtual start corner of the video
        const offsetW = (sourceW - sourceW / zoom) / 2;
        const offsetH = (sourceH - sourceH / zoom) / 2;

        // as if we are doing
        // ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)

        this.sx = offsetW;
        this.sy = offsetH;
        this.sWidth = sourceW / zoom;
        this.sHeight = sourceH / zoom;


        if (aspectSource > aspectView) {
            // Source video is WIDER than the view, so we scale to fit width
            // and adjust from top
            this.fovCoverage = (this.widthPx / aspectSource) / this.heightPx;
            this.dx = 0;
            this.dy = (this.heightPx - this.widthPx / aspectSource) / 2;
            this.dWidth = this.widthPx;
            this.dHeight = this.widthPx / aspectSource;
        } else {
            // Source is TALLER than the view, so we scale to fit height
            // and adjust from left

            this.fovCoverage = 1;

            this.dx  = (this.widthPx - this.heightPx * aspectSource) / 2;
            this.dy = 0;
            this.dWidth = this.heightPx * aspectSource;
            this.dHeight = this.heightPx;
        }
        assert(!isNaN(this.dWidth) && !isNaN(this.dHeight), "getSourceAndDestCoords returned NaN for dWidth or dHeight, this="+this.id+", zoom="+this.in.zoom.v0);

    }

    /**
     * Convert a canvas x,y point to relative video coordinates vX, vY
     * Returns values that can be outside [0,1]
     */
    canvasToVideoCoords(x, y) {
        this.getSourceAndDestCoords()

        // we have the source and destination coordinates s and d
        // as in // ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
        // so we can calculate the relative video coordinates
        const vX = (x - this.dx) / this.dWidth * this.sWidth + this.sx;
        const vY = (y - this.dy) / this.dHeight * this.sHeight + this.sy;
        // return as video pixels, not canvas pixels
        return [vX, vY];


    }

    // and the inverse, convert video coordinates to canvas coordinates
    videoToCanvasCoords(vX, vY) {
        this.getSourceAndDestCoords()

        // we have the source and destination coordinates s and d
        // as in // ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
        // so we can calculate the relative video coordinates
        const cX = (vX - this.sx) / this.sWidth * this.dWidth + this.dx;
        const cY = (vY - this.sy) / this.sHeight * this.dHeight + this.dy;
        // return as canvas pixels
        return [cX, cY];
    }





}


export function addFiltersToVideoNode(videoNode) {
    videoNode.addMoreInputs({
        brightness: new CNodeGUIValue({id: videoNode.id+"videoBrightness", value: 1, start: 0, end: 5, step: 0.01, desc: "Brightness"}, guiTweaks),
        contrast: new CNodeGUIValue({id: videoNode.id+"videoContrast", value: 1, start: 0, end: 5, step: 0.01, desc: "Contrast"}, guiTweaks),
        blur: new CNodeGUIValue({id: videoNode.id+"videoBlur", value: 0, start: 0, end: 20, step: 1, desc: "Blur Px"}, guiTweaks),
    });

    const reset = {
        resetFilters: () => {
            videoNode.inputs.brightness.value = 1;
            videoNode.inputs.contrast.value = 1;
            videoNode.inputs.blur.value = 0;
            setRenderOne(true);
        }
    }

    guiTweaks.add(reset, "resetFilters").name("Reset Filters")
}