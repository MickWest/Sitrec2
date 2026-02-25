///////////////////////////////////////////////////////////////////////////////
// CNodeView is the base class of all the views (2D, text, 3D, and maybe more)
// it has a div, which can be resized with our modern drag/resize utilities
// canvas elements are in CNodeView3D
// take their size from the div.
//
import {CNode} from './CNode.js'
import {Globals, guiShowHideGraphs, guiShowHideViews, NodeMan} from "../Globals";
import {assert} from "../assert.js";
import {ViewMan} from "../CViewManager";
import {makeDraggable, makeResizable, removeDraggable, removeResizable} from "../DragResizeUtils";
import {isKeyHeld} from "../KeyBoardHandler";


const defaultCViewParams = {
    visible: true,
    background:null,
    up: [0,1,0],
    fov: 45,
    draggable: false,
    resizable: false,
    doubleClickResizes: false,
    doubleClickFullScreen: true,

}

// a view node is renderable node, usually a window
class CNodeView extends CNode {
    constructor (v) {
        assert(v.id !== undefined,"View Node Requires ID")
        super(v)

        this.nominalViewWidth = 2*948; // expected width of the look view in pixels, for scaling point sprites
        this.nominalViewHeight = 1080


        // optionally make the view relative to anohther view
        this.input("relativeTo", true);

        // merge defaults with the passed parameters
        // into this. We used to merge in all of v, but that's not a good idea
        // as it leads to unexpected behaviour.
        // Object.assign(this,defaultCViewParams,v)
        Object.assign(this,defaultCViewParams)

        // // Instead of merging, we just copy the parameters we want
        this.top = v.top ?? 0;
        this.left = v.left ?? 0;
        this.width = v.width ?? 1;
        this.height = v.height ?? 1;

        // in initial setup, move windows to not go outside screen
        // only on MetaQuest?
        if (Globals.onMetaQuest) {
            let w = this.width;
            let h = this.height;
            if (w < 0) w = -w * h;
            if (h < 0) h = -h * w;

            if (this.left + w > 0.99) {
                this.left = 0.99 - w;
            }

            if (this.top + h > 0.99) {
                this.top = 0.99 - h;
            }
        }


  //      if (v.visible !== undefined)
        this.visible = v.visible ?? true;

        // all views are display nodes, meaning they are counted to determine
        // if we need to recalculate any of their inputs that have
        this.isDisplayNode = true; // all view nodes are display nodes checkDisplayOutputs set to true


        this.background = v.background;
        this.up = v.up;
        this.fov = v.fov;
        this.draggable = v.draggable;
        this.resizable = v.resizable;
        this.doubleClickResizes = v.doubleClickResizes;
        if (v.doubleClickFullScreen !== undefined) this.doubleClickFullScreen = v.doubleClickFullScreen;
        this.shiftDrag = v.shiftDrag;
        this.dragKey = v.dragKey;
        this.freeAspect = v.freeAspect;
        //
        //

        this.passThrough = v.passThrough ?? false;

        // container defaults to the window, but could be something else
        // (not yet tested with anything else)
        if (this.container === undefined)
            this.container = ViewMan.container;   // was window

        this.updateWH(); //need to get the pixel dimension to set the div

        if (v.overlayView) {
            this.overlayView = NodeMan.get(v.overlayView); // might be an id, so get the object
            this.div = this.overlayView.div
            assert(this.div, "Overlay view does not have a div")
        } else {

            this.div = document.createElement('div')
            this.div.style.position = 'absolute';

            // was recommended to fix Occulus overflow resizing.
            // does not work
            // this.div.style.contain = "layout size";

            this.div.style.top = this.topPx + 'px';
            this.div.style.left = this.leftPx + 'px';
            this.div.style.width = this.widthPx + 'px'
            this.div.style.height = this.heightPx + 'px'
            this.div.style.zIndex = 1;

            this.div.style.pointerEvents = 'auto';
            if (this.passThrough) {
                this.div.style.pointerEvents = 'none';
            }

//            console.log("For node "+this.id+" INITIAL setting widthPx,heightPx and div.style to "+this.widthPx+","+this.heightPx)

            // setting border style of divs also needs a color setting
            //this.div.style.borderStyle = 'solid'
            //this.div.style.color = '#404040';



            if (this.container === window) {
                this.divParent = document.body;
            } else {
                this.divParent = this.container;
            }

            this.divParent.appendChild(this.div);

            if (this.draggable) {
                makeDraggable(this.div, {
                    handle: v.dragHandle,
                    viewInstance: this,
                    shiftKey: this.shiftDrag,
                    requiredKey: this.dragKey,
                    onDrag: (event, data) => {
                        const view = data.viewInstance;
                        if (!view.draggable) return false;
                        // If dragKey is set, use that instead of shiftDrag
                        if (view.dragKey) {
                            if (!isKeyHeld(view.dragKey)) return false;
                        } else if (view.shiftDrag && !event.shiftKey) {
                            return false;
                        }
                        view.setFromDiv(view.div);
                        ViewMan.iterate((id, v) => {
                            if (v.overlayView === view) {
                                v.inheritSize();
                            }
                            if (v.in.relativeTo === view) {
                                v.updateWH();
                            }
                        });
                        return true;
                    }
                });
            }
            
            if (this.resizable) {
                makeResizable(this.div, {
                    handles: 'all',
                    aspectRatio: !this.freeAspect,
                    viewInstance: this,
                    onResize: (event, data) => {
                        const view = data.viewInstance;
                        return true;
                    }
                });
            }

            const visibleToSet = this.visible;
            this.visible = undefined; // force update
            this.setVisible(visibleToSet)

        }

        assert(!ViewMan.exists(v.id),"Adding "+v.id+" to ViewMan twice")
        ViewMan.add(v.id,this)

        this.excludeFromViewsMenu = v.excludeFromViewsMenu ?? false;

        if (!this.overlayView && !this.excludeFromViewsMenu) {
            const name = v.menuName ?? this.id;
            this.showHideName = name;

            let menu = guiShowHideViews;
            // if it's derived from a graph view, then put it in the graph submenu
            if (v.isGraphView) {
                menu = guiShowHideGraphs;
            }

            // menu entry to show/hide this view
            menu.add(this, 'visible').listen().name(name).onChange(value => {
                this.visible = undefined; // force update
                this.setVisible(value);
                if (value) {
                    // if we are showing the view, then recaulcualte
                    // for things like graphs
                    this.recalculate();
                }
            })
                .tooltip("Show/Hide the view: " + name);
        }

        this.applyEarlyMods();
    }

    // virtual functions for mouseMouveView.js onDocumentMouseMove
    onMouseMove(event, x, y, dx, dy) {
   //      console.log("UNIMPLEMENTED Mouse Move in view "+this.id)
    }

    onMouseDrag(event, x, y, dx, dy) {
   //      console.log("UNIMPLEMENTED Mouse Drag in view "+this.id)
    }

    // debug_v() {
    //     if (!this.done_debug_v) {
    //         this.done_debug_v = true;
    //         // list the elements that are in v but not in this
    //         for (const key in this.v_for_debug) {
    //             // check if it's unchanged, and not an input
    //             if (this[key] !== this.v_for_debug[key] && this.inputs[key] !== undefined) {
    //                 console.warn(this.constructor.name + ": v." + key + " differs in this " + this.id + " values are: " + this.v_for_debug[key] + " and " + this[key])
    //             }
    //         }
    //     }
    // }

    toSerialCNodeView = ["left","top","width","height","visible","doubled","preDoubledLeft","preDoubledTop","preDoubledWidth","preDoubledHeight"];



    modSerialize() {
        return {
            ...super.modSerialize(),
            ...this.simpleSerialize(this.toSerialCNodeView)
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.simpleDeserialize(v,this.toSerialCNodeView)
        this.updateWH();
        this.visible = !v.visible; // ensure we toggle the visibility
        this.setVisible(v.visible);
        // Restore fullscreen state if this view was doubled with fullscreen
        if (this.doubled && this.doubleClickFullScreen) {
            ViewMan.fullscreenView = this;
        }
    }

    dispose() {
        console.log("Disposing CNodeView: "+this.id)

        // if it's an overlay view, then we don't want to remove the div
        if (this.overlayView === undefined && this.div) {
            // Clean up draggable and resizable functionality
            if (this.draggable) {
                removeDraggable(this.div);
            }
            
            if (this.resizable) {
                removeResizable(this.div);
            }

            this.divParent.removeChild(this.div);
        }
        
        super.dispose()

        // views are stored in two managers, the node manager and the view manager
        // so we need to remove from both
        ViewMan.remove(this.id);
    }


    containerWidth() {
        if (this.in.relativeTo)
            return this.in.relativeTo.widthPx
        return ViewMan.widthPx;
    }
    containerHeight() {
        if (this.in.relativeTo)
            return this.in.relativeTo.heightPx
        return ViewMan.heightPx;
    }

    containerTop() {
        if (this.in.relativeTo)
            return this.in.relativeTo.topPx
        return ViewMan.topPx;
    }

    containerLeft() {
        if (this.in.relativeTo)
            return this.in.relativeTo.leftPx
        return ViewMan.leftPx;
    }

    dumpPosition() {
        console.log("left:"+this.left.toPrecision(5)+
            ", top:"+this.top.toPrecision(5)+
            ", width:"+this.width.toPrecision(5)+
            ",height:"+this.height.toPrecision(5)+",")
    }



    inheritSize() {
        if (this.overlayView) {
            this.widthPx = this.div.clientWidth
            this.heightPx = this.div.clientHeight
            this.topPx = this.div.offsetTop
            this.leftPx = this.div.offsetLeft
            this.width = this.overlayView.width
            this.height = this.overlayView.height
            this.top = this.overlayView.top
            this.left = this.overlayView.left
        }
    }

    preRenderCameraUpdate() {
        const newAspect = this.widthPx / this.heightPx;
        
        // Ensure WebGL canvas backing store matches the intended dimensions before rendering.
        // This fixes a race condition when view presets change rapidly:
        // - widthPx/heightPx update immediately when preset changes
        // - But changedSize() uses a 100ms debounce before calling renderer.setSize()
        //   (the debounce prevents flickering during continuous window resize drag)
        // - If presets change faster than 100ms, the canvas has stale dimensions
        // - Result: camera aspect is correct but canvas backing store is wrong size,
        //   causing CSS to scale the mismatched canvas and distort the view
        // Solution: Check dimensions before render and fix any mismatch immediately.
        // Note: Skip this for canvasWidth mode where dimensions intentionally differ.
        if (this.renderer && !this.in.canvasWidth) {
            const pixelRatio = this.renderer.getPixelRatio();
            const canvasW = this.renderer.domElement.width;
            const canvasH = this.renderer.domElement.height;
            const expectedW = Math.floor(this.widthPx * pixelRatio);
            const expectedH = Math.floor(this.heightPx * pixelRatio);
            if (canvasW !== expectedW || canvasH !== expectedH) {
                this.renderer.setSize(this.widthPx, this.heightPx);
                this._lastRendererWidth = this.widthPx;
                this._lastRendererHeight = this.heightPx;
            }
        }
        
        this.camera.aspect = newAspect;
        this.camera.updateProjectionMatrix();

        // do any custom projection modifications

        // Sync the zoom on this camera to the video zoom
        // check if it's flagged, and we actually have a videoZoom UI control
        if (NodeMan.exists("videoZoom")) {
            if (this.effectsEnabled && this.syncPixelZoomWithVideo && NodeMan.get("pixelZoomNode").enabled) {
                this.camera.zoom = 1; // i.e. render it noramally, and then zoom up the pixels
                // these are CNodeGUI objects
                // that we need to sync
                var videoZoom = NodeMan.get("videoZoom")
                var pixelZoom = NodeMan.get("pixelZoom");

                pixelZoom.value = videoZoom.v0;
            }
            else if (this.syncVideoZoom) {
                var videoZoom = NodeMan.get("videoZoom")
                this.camera.zoom = videoZoom.v0 / 100;
            }
        }
    }

    renderCanvas(frame) {
        assert(frame !== undefined, "Undefined frame in "+this.id)

        // if an overlay view, then inherit the parent's size
        this.inheritSize()

    }

    // given a div, modify the CView's pixel pos/size and the fractional pos/size
    // so they match the div (accounting for this.containerWidth()/windowSize)
    setFromDiv(div) {

        if (div.clientWidth === 0 || div.clientHeight === 0) {
            // div is not visible, so don't do anything
//            console.warn("Div has no size in "+this.id+" possibly hidden or not in DOM")
            return;
        }

        assert(div.clientWidth !== 0, "Div has no width in "+this.id+" possibly hidden or ot in DOM")

        if (this.widthPx !== div.clientWidth ||
            this.heightPx !== div.clientHeight ||
            this.leftPx !== div.offsetLeft ||
            this.topPx !== div.offsetTop
        ) {
            this.widthPx = div.clientWidth
            this.heightPx = div.clientHeight

            this.leftPx = div.offsetLeft;
            this.topPx = div.offsetTop;

            if (this.freeAspect) {
                if (this.width < 0 ) this.width = this.widthPx / this.heightPx;
                if (this.height < 0) this.height = this.heightPx / this.widthPx;
            }


            if (this.width>0) this.width = this.widthPx / this.containerWidth()
            if (this.height>0) this.height = this.heightPx / this.containerHeight()


            this.left = (this.leftPx-this.containerLeft()) / this.containerWidth()
            this.top = (this.topPx-this.containerTop()) / this.containerHeight()
        }

        this.widthDiv = div.clientWidth
        this.heightDiv = div.clientHeight

    }

    // Updates the Pixel and Div values from the fractional and window values
    updateWH() {
        this.leftPx = Math.floor(this.containerLeft() + this.containerWidth()  * this.left);
        this.topPx  = Math.floor(this.containerTop()  + this.containerHeight() * this.top);

        let oldWidth = this.widthPx;
        let oldHeight = this.heightPx;

        var widthFraction = this.width
        var heightFraction = this.height

        if (heightFraction < 0)
        {
            // height is a multiple of width pixels
            // keeping constant aspect ratio
            this.widthPx = Math.floor(this.containerWidth() * widthFraction);
            this.heightPx = Math.floor(this.containerWidth() * widthFraction * -heightFraction);
        } else if (widthFraction < 0) {
            this.heightPx = Math.floor(this.containerHeight() * heightFraction);
            this.widthPx = Math.floor(this.containerHeight() * heightFraction * -widthFraction);
        }
        else {
            this.widthPx = Math.floor(this.containerWidth() * widthFraction);
            this.heightPx = Math.floor(this.containerHeight() * heightFraction);
        }

        if (this.div && !this.overlayView) {
            // and finally set the div
            this.div.style.top = this.topPx + 'px';
            this.div.style.left = this.leftPx + 'px';
            this.div.style.width = this.widthPx + 'px'
            this.div.style.height = this.heightPx + 'px'
        }

        // this check is now internal to changedSize
     //   if (oldHeight !== this.heightPx || oldWidth !== this.widthPx) {
            this.changedSize();
     //   }


    }

    changedSize() {
        if (this.renderer) {
            // For WebGL renderers: debounce renderer.setSize() to avoid flickering
            // Problem: During window resize drag gestures, widthPx/heightPx change 1-2 pixels every frame
            // Without debounce: renderer.setSize() called dozens of times/sec, clearing canvas each time -> flicker
            // Solution: Defer the actual resize 100ms, accumulating changes until gesture settles
            if (this._resizeTimeout) {
                clearTimeout(this._resizeTimeout);
            }
            this._resizeTimeout = setTimeout(() => {
                this.deferredResizeWebGL();
                this._resizeTimeout = null;
            }, 100);
        } else if (this.canvas) {
            // For 2D canvas: just mark pending, will be applied in renderCanvas() before drawing
            // This ensures dimensions are correct before rendering without extra debounce delay
            this._pendingCanvasResize = true;
        }
    }

    deferredResizeWebGL() {
        if (!this.renderer) return;
        
        // Called via 100ms debounce after resize gesture settles
        // Calculates final renderer dimensions and applies resize with deduping to avoid redundant calls
        
        if (this.in.canvasWidth) {
            // Custom canvas resolution mode: scale proportionally to maintain aspect ratio
            let long = Math.floor(this.in.canvasWidth.v0);

            if (this.widthPx > this.heightPx) {
                var width = long;
                var height = Math.floor(long * this.heightPx / this.widthPx);
            } else {
                var height = long;
                var width = Math.floor(long * this.widthPx / this.heightPx);
            }

            // Only call setSize() if dimensions actually changed (avoids redundant WebGL calls)
            if (width !== this._lastRendererWidth || height !== this._lastRendererHeight) {
                this.renderer.setSize(width, height, false);
                this._lastRendererWidth = width;
                this._lastRendererHeight = height;
            }
        } else {
            // Normal mode: resize to match container dimensions
            const width = this.widthPx;
            const height = this.heightPx;
            
            if (width !== this._lastRendererWidth || height !== this._lastRendererHeight) {
                this.renderer.setSize(width, height);
                this._lastRendererWidth = width;
                this._lastRendererHeight = height;
            }
        }
    }

    getRenderTargetHeight() {
        if (!this.in.canvasWidth) {
            return this.heightPx;
        }
        
        const long = this.in.canvasWidth.v0;
        let width = this.widthPx;
        let height = this.heightPx;
        
        let rtHeight;
        if (width > height) {
            rtHeight = Math.floor(long * height / width);
        } else {
            rtHeight = long;
        }
        
        if (ViewMan.isSideBySideMode()) {
            const sideBySideResolutionScale = 0.7;
            rtHeight = Math.floor(rtHeight * sideBySideResolutionScale);
        }
        
        return rtHeight;
    }

    adjustPointScale(scale)  {

        const view = this;
        const camera = view.camera;

        // infoDiv.innerHTML += "view.id = "+view.id+"<br>";
        // infoDiv.innerHTML += " - view.widthPx = "+view.widthPx+",  view.heightPx = "+view.heightPx+"<br>";
        // infoDiv.innerHTML += " - view.div.clientWidth = "+view.div.clientWidth+", view.div.clientHeight = "+view.div.clientHeight+"<br>";
        // infoDiv.innerHTML += " - view.canvas.width = "+view.canvas.width+", view.canvas.height = "+view.canvas.height+"<br>";
        // infoDiv.innerHTML += " - this.nominalViewWidth = "+this.nominalViewWidth+"<br>";
        // infoDiv.innerHTML += " - input Scale = "+scale+"<br>";
        // infoDiv.innerHTML += " - view.in.canvasWidth = "+view.in.canvasWidth+"<br>";
        // infoDiv.innerHTML += " - window.devicePixelRatio = "+window.devicePixelRatio+"<br>";
        // infoDiv.innerHTML += " - view.canvas.width/view.widthPx = "+(view.canvas.width/view.widthPx)+"<br>";

        // camera.fov is in degrees, and is the vertical FOV of the camera in this viewpoirt
        // view.widthPx is the width of the viewport in screen-space pixels The size of the containing div
        // view.heightPx is the height of the viewport in screen-space pixels
        // if (!this.in.canvasWidth) i.e. no custom canvas width set
        //    view.canvas.width is the width of the canvas in device pixels
        //    view.canvas.height is the height of the canvas in device pixels
        // else
        //    view.canvas.width is the width of an off-screen canvas in device pixels
        //    view.canvas.height is the height of an off-screen canvas in device pixels
        //    this off-screen canvas is used to render the view, and then the result is drawn to the screen
        // end if
        // widonew.devicePixelRatio is the ratio of device pixels to screen pixels (usually 2 for retina displays)
        //
        //

        // we are rending sprites as point sprites, so we need to scale them
        // by the size of the viewport in screen pixels, and the FOV of the camera
        // accounting for the device pixel ratio
        // and the

        // firsgure out how many canvas pixels high the viewport is
        // we know that's one FOV height
        // for angular size is proportional to that
        let veticalCanvasPx;

        if (view.in.canvasWidth) {
            veticalCanvasPx = view.getRenderTargetHeight();
        } else {
            veticalCanvasPx = view.heightPx;
        }

        scale *= (veticalCanvasPx / view.nominalViewHeight)
        scale *= 45/view.camera.fov; // 45 is the default FOV, so we scale by that

        // calculations here:
        // infoDiv.innerHTML += " - Adjusted Scale = "+scale+"<br>";

        return scale / 2;
    }



    snapInsidePx(l,t,w,h) {
        //  debugger
        if (this.leftPx < l)
            this.leftPx = l;
        if (this.topPx < t)
            this.leftPx = t;
        if (this.topPx+this.heightPx > t+h)
            this.topPx = t+h-this.heightPx
        if (this.leftPx+this.heightPx > l+w)
            this.leftPx = l+w-this.widthPx
        this.left = this.leftPx/this.containerWidth()
        this.top = this.topPx/this.containerHeight()
        this.updateWH()
    }

    doubleClick() {
        if (this.visible && (this.doubleClickResizes || this.doubleClickFullScreen)) {
            if (!this.doubled) {
                this.doubled = true;
                this.preDoubledLeft = this.left;
                this.preDoubledTop = this.top;
                this.preDoubledWidth = this.width;
                this.preDoubledHeight = this.height;

                if (this.doubleClickResizes) {
                    if (this.width > 0) {
                        this.width *= 2;
                    }
                    if (this.height > 0) {
                        this.height *= 2;
                    }
                } else {
                    this.width = 1;
                    this.height = 1;
                    this.left = 0;
                    this.top = 0;
                }

                if (this.width > 1) this.width = 1;
                if (this.height > 1) this.height = 1;

                this.updateWH();
                this.snapInsidePx(0, 0, this.containerWidth(), this.containerHeight());

                if (this.doubleClickFullScreen) {
                    ViewMan.fullscreenView = this;
                }

            } else {
                this.doubled = false;
                this.left = this.preDoubledLeft;
                this.top = this.preDoubledTop;
                if (this.width > 0) this.width = this.preDoubledWidth;
                if (this.height > 0) this.height = this.preDoubledHeight;
                this.updateWH();

                if (this.doubleClickFullScreen) {
                    ViewMan.fullscreenView = null;
                }
            }
        }
    }

    setVisible(visible) {
        if (this.visible === visible)
            return;

        this.visible = visible;

        // Immediate DOM update for responsiveness.
        // Central DOM updates happen in ViewMan.updateDOMVisibility() each frame.
        this._updateOwnDOM();
    }

    // Update this view's own DOM elements based on this.visible (user intent)
    _updateOwnDOM() {
        if (!this.overlayView) {
            if (this.div) {
                this.div.style.display = this.visible ? 'block' : 'none';
            }
        } else if (this.separateVisibility) {
            if (this.canvas) {
                this.canvas.style.visibility = this.visible ? 'visible' : 'hidden';
            }
        }
        // Non-separateVisibility overlays: DOM controlled by parent's div
    }

    show(visible = true) {
        this.setVisible(visible)
    }

    hide() {
        this.show(false)
    }

}

// example CUIText being added to a CUIView
//         this.addText("az", "35° L", 47, 7).listen(par, "az", function (value) {
//             this.text = (floor(0.499999+abs(value))) + "° " + (value > 0 ? "R" : "L");
//         })
// Note the callback to .listen is options

// position and size are specified as percentages
// and stored as fractions (ie. /100)
class CUIText {
    constructor (text,x,y,size,color,align, font) {
        this.text = text;
        this.x = x/100;
        this.y = y/100;
        this.size = size/100;
        this.color = color
        this.font = font;
        this.align = align;
        this.boxed = false;
        this.boxGap = 2;  // gap between text BBox and display BBox
        this.alwaysUpdate = false;

    }

    getValue() {
        return this.object[ this.property ];
    }

    setPosition(x,y) {
        this.x = x/100
        this.y = y/100
    }

    listen (object, property, callback) {
        this.object = object;
        this.property = property
        this.callback = callback;
        this.initialValue = this.getValue()
        return this;
    }

    update (callback) {
        this.callback = callback;
        this.alwaysUpdate = true;
        return this;
    }

    checkListener() {
        if (this.object !== undefined) {
            const v = this.getValue()
            if (v != this.initialValue) {
                if (this.callback === undefined) {
                    this.text = String(v)
                } else {
                    this.callback.call(this, v)
                }
                this.initialValue = v;
            }
        }

        if (this.alwaysUpdate) {
            this.callback.call(this)
        }
    }
}

export {CNodeView, CUIText}


export function VG(id){
    return ViewMan.get(id)
}


