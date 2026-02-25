import {par} from "../par";
import {GlobalDateTimeNode, NodeMan, setRenderOne, Sit} from "../Globals";
import {CNode} from "./CNode";
import {getControlsContainer} from "../PageStructure";
import {EventManager} from "../CEventManager";

export class CNodeFrameSlider extends CNode {
    constructor(v) {
        super(v);
        this.sliderContainer = null;
        this.sliderDiv = null;
        this.sliderInput = null;
        this.playPauseButton = null;
        this.startButton = null;
        this.endButton = null;
        this.frameAdvanceButton = null;
        this.frameBackButton = null;
        this.fastForwardButton = null;
        this.fastRewindButton = null;
        this.pinButton = null;
        this.audioButton = null;
        this.frameDisplayBox = null;

        this.pinned = false;
        this.advanceHeld = false;
        this.backHeld = false;
        this.advanceHoldFrames = 0;
        this.backHoldFrames = 0;
        this.holdThreshold = 10; // Number of frames the button needs to be held before starting repeated actions
        this.fadeOutTimer = null;

        // Dragging state for A and B limits
        this.draggingALimit = false;
        this.draggingBLimit = false;
        this.hoveringALimit = false;
        this.hoveringBLimit = false;
        this.dragThreshold = 10; // Pixels within which we can grab a limit line

        // Hover state for continuous frame display updates
        this.isHoveringSlider = false;
        this.lastDisplayedFrame = null;

        // Track state for canvas redraw optimization
        this.lastCanvasWidth = 0;
        this.lastCanvasHeight = 0;
        this.lastAFrame = -1;
        this.lastBFrame = -1;
        this.lastHoveringALimit = false;
        this.lastHoveringBLimit = false;
        this.lastDraggingALimit = false;
        this.lastDraggingBLimit = false;
        this.needsCanvasRedraw = true;

        this.statusOverlay = null;
        this.statusOverlayOffset = 2;
        this.lastStatusOverlay = null;
        this.groupOverlay = null;

        this.setupFrameSlider();
    }

    setupFrameSlider() {
        this.sliderContainer = document.createElement('div');

        // Set up the slider container - now positioned relative within ControlsBottom
        this.sliderContainer.style.position = 'relative';
        this.sliderContainer.style.height = '100%';
        this.sliderContainer.style.width = '100%';
        this.sliderContainer.style.zIndex = '1001'; // Needed to get mouse events when over other windows
        this.sliderContainer.style.display = 'flex';
        this.sliderContainer.style.alignItems = 'center';
        this.sliderContainer.style.touchAction = 'none'; // Prevent browser default touch behaviors

        // Prevent double click behavior on the slider container
        this.sliderContainer.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });

        // Create control buttons container
        this.controlContainer = document.createElement('div');
        this.controlContainer.style.display = 'flex';
        this.controlContainer.style.marginRight = '5px';
        this.controlContainer.style.marginTop = '2px'; // Move buttons down 2px
        // Responsive width: larger on mobile for bigger buttons
        const isMobile = window.innerWidth <= 768 || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        const containerWidth = isMobile ? '396px' : '315px'; // 9 buttons * 44px + gaps for mobile, 315px for desktop
        this.controlContainer.style.width = containerWidth;

        // Create Buttons
        this.pinButton = this.createButton(
            this.controlContainer,
            spriteLocations.pin.row,
            spriteLocations.pin.col,
            this.togglePin.bind(this),
            'Pin/Unpin'
        );

        this.togglePin();

        this.playPauseButton = this.createButton(
            this.controlContainer,
            spriteLocations.play.row,
            spriteLocations.play.col,
            this.togglePlayPause.bind(this),
            'Play/Pause'
        );
        this.updatePlayPauseButton();

        this.frameBackButton = this.createButton(
            this.controlContainer,
            spriteLocations.frameBack.row,
            spriteLocations.frameBack.col,
            this.backOneFrame.bind(this),
            'Step Back',
            () => {
                this.backHeld = true;
                this.backHoldFrames = 0; // Reset the hold count on mouse down
            },
            () => {
                this.backHeld = false;
                this.backHoldFrames = 0; // Clear the hold count on mouse up
            }
        );

        this.frameAdvanceButton = this.createButton(
            this.controlContainer,
            spriteLocations.frameAdvance.row,
            spriteLocations.frameAdvance.col,
            this.advanceOneFrame.bind(this),
            'Step Forward',
            () => {
                this.advanceHeld = true;
                this.advanceHoldFrames = 0; // Reset the hold count on mouse down
            },
            () => {
                this.advanceHeld = false;
                this.advanceHoldFrames = 0; // Clear the hold count on mouse up
            }
        );

        this.fastRewindButton = this.createButton(
            this.controlContainer,
            spriteLocations.fastRewind.row,
            spriteLocations.fastRewind.col,
            () => {},
            'Fast Rewind',
            () => {
                this.fastRewindButton.held = true;
                par.paused = true;
                this.updatePlayPauseButton();
            },
            () => {
                this.fastRewindButton.held = false;
            }
        );

        this.fastForwardButton = this.createButton(
            this.controlContainer,
            spriteLocations.fastForward.row,
            spriteLocations.fastForward.col,
            () => {},
            'Fast Forward',
            () => {
                this.fastForwardButton.held = true;
                par.paused = true;
                this.updatePlayPauseButton();
            },
            () => {
                this.fastForwardButton.held = false;
            }
        );

        this.startButton = this.createButton(
            this.controlContainer,
            spriteLocations.start.row,
            spriteLocations.start.col,
            () => this.setFrame(0),
            'Jump to Start'
        );

        this.endButton = this.createButton(
            this.controlContainer,
            spriteLocations.end.row,
            spriteLocations.end.col,
            () => this.setFrame(parseInt(this.sliderInput.max, 10)),
            'Jump to End'
        );

        this.audioButton = this.createButton(
            this.controlContainer,
            spriteLocations.audio.row,
            spriteLocations.audio.col,
            this.toggleAudioMute.bind(this),
            'Audio/Mute'
        );
        this.audioButton.style.display = 'none';

        this.controlContainer.style.opacity = "0"; // Initially hidden
        this.sliderContainer.appendChild(this.controlContainer);

        // Create the slider input element
        this.sliderInput = document.createElement('input');
        this.sliderInput.type = "range";
        this.sliderInput.className = "flat-slider";
        this.sliderInput.style.position = 'absolute';
        this.sliderInput.style.top = '0';
        this.sliderInput.style.left = '0';
        this.sliderInput.style.width = '100%';
        this.sliderInput.style.height = '100%';
        this.sliderInput.style.outline = 'none'; // Remove focus outline
        this.sliderInput.style.touchAction = 'none'; // Critical for proper touch dragging
        this.sliderInput.tabIndex = -1; // Prevent keyboard focus
        this.sliderInput.min = "0";
        this.sliderInput.max = "100"; // Initial max, can be updated later
        this.sliderInput.value = "0";

        let sliderDragging = false;
        let sliderFade = false;
        let lastMouseX = 0;
        let isTouchDragging = false; // Track touch dragging separately

        const newFrame = (frame) => {
            par.frame = frame;
            GlobalDateTimeNode.liveMode = false;
            setRenderOne(true);
        };

        const getFrameFromSlider = () => {
            const frame = parseInt(this.sliderInput.value, 10);
            newFrame(frame);
        };

        // create a div to hold the slider
        this.sliderDiv = document.createElement('div');
        this.sliderDiv.style.width = '100%';
        this.sliderDiv.style.height = '100%'; // Fill the container height (28px)
        this.sliderDiv.style.display = 'flex';
        this.sliderDiv.style.alignItems = 'center';
        this.sliderDiv.style.justifyContent = 'center';
        this.sliderDiv.style.position = 'relative';
        this.sliderDiv.style.zIndex = '1002';
        this.sliderDiv.style.opacity = "0"; // Initially hidden
        this.sliderDiv.style.transition = "opacity 0.2s";
        this.sliderDiv.style.marginRight = '5px'; // Reduced spacing
        this.sliderDiv.style.backgroundColor = '#000000'; // Black background


        this.sliderDiv.appendChild(this.sliderInput);
        this.sliderContainer.appendChild(this.sliderDiv);
        
        // Append to the ControlsBottom container instead of document.body
        const controlsContainer = getControlsContainer();
        if (controlsContainer) {
            controlsContainer.appendChild(this.sliderContainer);
        } else {
            // Fallback to document.body if ControlsBottom doesn't exist (shouldn't happen)
            console.warn("ControlsBottom container not found, appending to body");
            document.body.appendChild(this.sliderContainer);
        }

        // add a canvas to the slider div
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.zIndex = '1003'; // Ensure it overlays the input
        this.canvas.style.pointerEvents = 'none'; // Initially allow events to pass through
        this.sliderDiv.appendChild(this.canvas);

        // Add ResizeObserver to redraw canvas when it's resized
        this.resizeObserver = new ResizeObserver(() => {
            // Mark for redraw on resize
            this.needsCanvasRedraw = true;
        });
        this.resizeObserver.observe(this.canvas);

        // Create frame display box
        this.frameDisplayBox = document.createElement('div');
        this.frameDisplayBox.style.position = 'absolute';
        this.frameDisplayBox.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
        this.frameDisplayBox.style.color = 'white';
        this.frameDisplayBox.style.padding = '4px 8px';
        this.frameDisplayBox.style.borderRadius = '4px';
        this.frameDisplayBox.style.fontSize = '12px';
        this.frameDisplayBox.style.fontFamily = 'monospace';
        this.frameDisplayBox.style.zIndex = '1004';
        this.frameDisplayBox.style.pointerEvents = 'none';
        this.frameDisplayBox.style.display = 'none'; // Initially hidden
        this.frameDisplayBox.style.transform = 'translateX(-50%)'; // Center horizontally
        this.frameDisplayBox.style.bottom = '45px'; // Position above the slider
        document.body.appendChild(this.frameDisplayBox);

        // Add mouse event handlers for dragging A and B limits
        this.setupLimitDragging();

        // Add mouse move listener to the slider container to manage pointer events
        this.sliderContainer.addEventListener('mousemove', (event) => {
            if (!this.draggingALimit && !this.draggingBLimit) {
                const rect = this.canvas.getBoundingClientRect();
                const mouseX = event.clientX - rect.left;
                const mouseY = event.clientY - rect.top;
                
                // Helper functions (duplicated here for scope)
                const frameToPixel = (frame) => {
                    return (frame / Sit.frames) * this.canvas.offsetWidth;
                };
                
                const getNearLimit = (mouseX, mouseY) => {
                    const aPixel = frameToPixel(Sit.aFrame);
                    const bPixel = frameToPixel(Sit.bFrame);
                    const currentFramePixel = frameToPixel(par.frame);
                    
                    // Define slider thumb area (prioritize this over A/B limits)
                    const thumbWidth = 14; // Approximate width of slider thumb (scaled down)
                    const thumbArea = {
                        left: currentFramePixel - thumbWidth / 2,
                        right: currentFramePixel + thumbWidth / 2,
                        top: 7, // Allow A/B dragging above the slider track
                        bottom: 28 // Full height of slider container (reduced from 40)
                    };
                    
                    // If mouse is in the slider thumb area, don't allow A/B limit dragging
                    if (mouseX >= thumbArea.left && mouseX <= thumbArea.right && 
                        mouseY >= thumbArea.top && mouseY <= thumbArea.bottom) {
                        return null;
                    }
                    
                    // Check if near A limit line or handle
                    if (Math.abs(mouseX - aPixel) <= this.dragThreshold) {
                        return 'A';
                    }
                    // Check if near A handle circle (top of line) - prioritize this area
                    if (Math.abs(mouseX - aPixel) <= 6 && mouseY >= 0 && mouseY <= 12) {
                        return 'A';
                    }
                    
                    // Check if near B limit line or handle
                    if (Math.abs(mouseX - bPixel) <= this.dragThreshold) {
                        return 'B';
                    }
                    // Check if near B handle circle (top of line) - prioritize this area
                    if (Math.abs(mouseX - bPixel) <= 6 && mouseY >= 0 && mouseY <= 12) {
                        return 'B';
                    }
                    
                    return null;
                };
                
                const nearLimit = getNearLimit(mouseX, mouseY);
                
                // Enable pointer events on canvas only when near a limit
                if (nearLimit) {
                    this.canvas.style.pointerEvents = 'auto';
                } else {
                    this.canvas.style.pointerEvents = 'none';
                }
            }
        });


        // Event listeners for slider interactions
        this.sliderInput.addEventListener('mousedown', (event) => {
            const frame = parseInt(this.sliderInput.value, 10);
            lastMouseX = event.clientX;
            this.showFrameDisplay(frame, event.clientX);
        });

        this.sliderInput.addEventListener('input', () => {
            const frame = parseInt(this.sliderInput.value, 10);
            newFrame(frame);
            sliderDragging = true;
            par.paused = true;
            this.updateFrameDisplay(frame, lastMouseX);
        });

        this.sliderInput.addEventListener('change', () => {
            if (sliderFade) {
                this.sliderInput.style.opacity = "1";
                setTimeout(() => { this.sliderInput.style.opacity = "0"; }, 200); // fade out
                sliderFade = false;
            }
            sliderDragging = false;
            this.hideFrameDisplay();
        });

        this.sliderInput.addEventListener('mouseup', () => {
            this.hideFrameDisplay();
        });

        this.sliderInput.addEventListener('mouseenter', () => {
            this.isHoveringSlider = true;
        });

        this.sliderInput.addEventListener('mouseleave', () => {
            this.isHoveringSlider = false;
            this.lastDisplayedFrame = null;
            this.hideFrameDisplay();
        });

        // Touch event support for mobile devices (improved for better responsiveness)
        this.sliderInput.addEventListener('touchstart', (event) => {
            isTouchDragging = true;
            const touch = event.touches[0];
            lastMouseX = touch.clientX;
            
            // Calculate frame from touch position
            const rect = this.sliderInput.getBoundingClientRect();
            const x = touch.clientX - rect.left;
            const frame = Math.max(0, Math.min(Sit.frames, Math.round((x / rect.width) * this.sliderInput.max)));
            
            this.sliderInput.value = frame;
            newFrame(frame);
            sliderDragging = true;
            par.paused = true;
            this.showFrameDisplay(frame, touch.clientX);
            
            event.preventDefault();
        }, {passive: false});

        this.sliderInput.addEventListener('touchmove', (event) => {
            if (isTouchDragging) {
                const touch = event.touches[0];
                lastMouseX = touch.clientX;
                
                // Calculate frame from touch position
                const rect = this.sliderInput.getBoundingClientRect();
                const x = touch.clientX - rect.left;
                const frame = Math.max(0, Math.min(Sit.frames, Math.round((x / rect.width) * this.sliderInput.max)));
                
                this.sliderInput.value = frame;
                newFrame(frame);
                this.updateFrameDisplay(frame, touch.clientX);
                
                event.preventDefault();
            }
        }, {passive: false});

        this.sliderInput.addEventListener('touchend', (event) => {
            isTouchDragging = false;
            sliderDragging = false;
            this.hideFrameDisplay();
            event.preventDefault();
        }, {passive: false});

        // Track mouse movement for frame display positioning
        this.sliderInput.addEventListener('mousemove', (event) => {
            lastMouseX = event.clientX;
            if (sliderDragging) {
                const frame = parseInt(this.sliderInput.value, 10);
                this.updateFrameDisplay(frame, event.clientX);
            } else {
                // Show frame info for current frame when hovering (not dragging)
                const currentFrame = parseInt(this.sliderInput.value, 10);
                this.showFrameDisplay(currentFrame, event.clientX);
            }
        });

        this.sliderInput.style.opacity = "0"; // Initially hidden

        this.sliderContainer.addEventListener('mouseenter', () => {
            console.log("Hover Start");
            if (!sliderDragging) {
                setTimeout(() => { this.sliderDiv.style.opacity = "1"; }, 200); // fade in
                setTimeout(() => { this.sliderInput.style.opacity = "1"; }, 200); // fade in
                setTimeout(() => { this.controlContainer.style.opacity = "1"; }, 200); // fade in
                this.sliderFadeOutCounter = undefined; // Reset fade counter on mouse enter
            }
            sliderFade = false;
            // Clear any existing fade out timer
            if (this.fadeOutTimer) {
                clearTimeout(this.fadeOutTimer);
                this.fadeOutTimer = null;
            }
        });

        this.sliderContainer.addEventListener('mouseleave', () => {
            if (sliderDragging) {
                sliderFade = true;
            } else {
                // Start fade out timer (2 seconds delay, then 0.5 second fade)
                this.fadeOutTimer = setTimeout(() => {
                    this.startFadeOut();
                }, 2000);
            }
        });
        
        // Initial draw of the canvas to ensure A/B limits are visible immediately
        // Use requestAnimationFrame to ensure the canvas has proper dimensions
        requestAnimationFrame(() => {
            this.update(par.frame);
        });
    }

    setupLimitDragging() {
        let isDragging = false;
        let dragStartX = 0;

        // Helper function to get mouse/touch position relative to canvas
        const getMousePos = (event) => {
            const rect = this.canvas.getBoundingClientRect();
            // Support both mouse and touch events
            const clientX = event.clientX !== undefined ? event.clientX : (event.touches && event.touches[0] ? event.touches[0].clientX : 0);
            const clientY = event.clientY !== undefined ? event.clientY : (event.touches && event.touches[0] ? event.touches[0].clientY : 0);
            return {
                x: clientX - rect.left,
                y: clientY - rect.top
            };
        };

        // Helper function to convert pixel position to frame number
        const pixelToFrame = (x) => {
            const padding = 5; // Must match the padding used in drawing
            const drawableWidth = this.canvas.offsetWidth - (2 * padding);
            const adjustedX = Math.max(0, Math.min(drawableWidth, x - padding));
            return Math.round((adjustedX / drawableWidth) * Sit.frames);
        };

        // Helper function to get pixel position of a frame
        const frameToPixel = (frame) => {
            const padding = 5; // Must match the padding used in drawing
            const drawableWidth = this.canvas.offsetWidth - (2 * padding);
            return padding + (drawableWidth * frame / Sit.frames);
        };

        // Helper function to check if mouse is near a limit line or handle
        const getNearLimit = (mouseX, mouseY) => {
            const aPixel = frameToPixel(Sit.aFrame);
            const bPixel = frameToPixel(Sit.bFrame);
            const currentFramePixel = frameToPixel(par.frame);
            
            // Define slider thumb area (prioritize this over A/B limits)
            const thumbWidth = 14; // Approximate width of slider thumb (scaled down)
            const thumbArea = {
                left: currentFramePixel - thumbWidth / 2,
                right: currentFramePixel + thumbWidth / 2,
                top: 7, // Allow A/B dragging above the slider track
                bottom: 28 // Full height of slider container (reduced from 40)
            };
            
            // If mouse is in the slider thumb area, don't allow A/B limit dragging
            if (mouseX >= thumbArea.left && mouseX <= thumbArea.right && 
                mouseY >= thumbArea.top && mouseY <= thumbArea.bottom) {
                return null;
            }
            
            // Check if near A limit line or handle
            if (Math.abs(mouseX - aPixel) <= this.dragThreshold) {
                return 'A';
            }
            // Check if near A handle circle (top of line) - prioritize this area
            if (Math.abs(mouseX - aPixel) <= 6 && mouseY >= 0 && mouseY <= 12) {
                return 'A';
            }
            
            // Check if near B limit line or handle
            if (Math.abs(mouseX - bPixel) <= this.dragThreshold) {
                return 'B';
            }
            // Check if near B handle circle (top of line) - prioritize this area
            if (Math.abs(mouseX - bPixel) <= 6 && mouseY >= 0 && mouseY <= 12) {
                return 'B';
            }
            
            return null;
        };

        // Mouse down event
        this.canvas.addEventListener('mousedown', (event) => {
            const mousePos = getMousePos(event);
            const nearLimit = getNearLimit(mousePos.x, mousePos.y);
            
            if (nearLimit === 'A') {
                this.draggingALimit = true;
                isDragging = true;
                dragStartX = mousePos.x;
                this.canvas.style.cursor = 'ew-resize';
                
                // Show frame display for A limit
                this.showFrameDisplay(Sit.aFrame, event.clientX);
                
                // Add global event listeners for dragging
                document.addEventListener('mousemove', globalMouseMove);
                document.addEventListener('mouseup', globalMouseUp);
                
                event.preventDefault();
                event.stopPropagation();
            } else if (nearLimit === 'B') {
                this.draggingBLimit = true;
                isDragging = true;
                dragStartX = mousePos.x;
                this.canvas.style.cursor = 'ew-resize';
                
                // Show frame display for B limit
                this.showFrameDisplay(Sit.bFrame, event.clientX);
                
                // Add global event listeners for dragging
                document.addEventListener('mousemove', globalMouseMove);
                document.addEventListener('mouseup', globalMouseUp);
                
                event.preventDefault();
                event.stopPropagation();
            }
        });

        // Mouse move event on canvas (for hover detection when not dragging)
        this.canvas.addEventListener('mousemove', (event) => {
            if (!isDragging) {
                const mousePos = getMousePos(event);
                // Update cursor and hover state based on proximity to limits
                const nearLimit = getNearLimit(mousePos.x, mousePos.y);
                const newHoveringA = (nearLimit === 'A');
                const newHoveringB = (nearLimit === 'B');
                
                // Mark for redraw if hover state changed
                if (newHoveringA !== this.hoveringALimit || newHoveringB !== this.hoveringBLimit) {
                    this.needsCanvasRedraw = true;
                }
                
                this.hoveringALimit = newHoveringA;
                this.hoveringBLimit = newHoveringB;
                
                if (nearLimit) {
                    this.canvas.style.cursor = 'ew-resize';
                } else {
                    this.canvas.style.cursor = 'default';
                }
            }
        });

        // Global mouse move event for dragging (allows vertical movement outside canvas)
        const globalMouseMove = (event) => {
            if (isDragging) {
                const mousePos = getMousePos(event);
                const newFrame = Math.max(0, Math.min(Sit.frames - 1, pixelToFrame(mousePos.x)));
                
                if (this.draggingALimit) {
                    const clampedFrame = Math.min(newFrame, Sit.bFrame - 1);
                    Sit.aFrame = clampedFrame;
                    par._frameOverride = clampedFrame;
                    GlobalDateTimeNode.liveMode = false;
                    this.needsCanvasRedraw = true;
                    setRenderOne(true);
                    this.updateFrameDisplay(clampedFrame, event.clientX);
                } else if (this.draggingBLimit) {
                    const clampedFrame = Math.max(newFrame, Sit.aFrame + 1);
                    Sit.bFrame = clampedFrame;
                    par._frameOverride = clampedFrame;
                    GlobalDateTimeNode.liveMode = false;
                    this.needsCanvasRedraw = true;
                    setRenderOne(true);
                    this.updateFrameDisplay(clampedFrame, event.clientX);
                }
            }
        };

        // Global mouse up event for dragging
        const globalMouseUp = (event) => {
            if (isDragging) {
                const wasAOrB = this.draggingALimit || this.draggingBLimit;
                this.draggingALimit = false;
                this.draggingBLimit = false;
                isDragging = false;
                this.canvas.style.cursor = 'default';
                // Reset pointer events to allow normal slider interaction
                this.canvas.style.pointerEvents = 'none';

                // Clear the frame override so rendering resumes at par._frame
                par._frameOverride = undefined;
                setRenderOne(true);

                // Hide frame display when dragging ends
                this.hideFrameDisplay();

                if (wasAOrB) {
                    EventManager.dispatchEvent("abFrameChanged");
                }

                // Remove global event listeners
                document.removeEventListener('mousemove', globalMouseMove);
                document.removeEventListener('mouseup', globalMouseUp);
            }
        };

        // Mouse leave event (only reset hover states, don't stop dragging)
        this.canvas.addEventListener('mouseleave', (event) => {
            if (this.hoveringALimit || this.hoveringBLimit) {
                this.needsCanvasRedraw = true;
            }
            this.hoveringALimit = false;
            this.hoveringBLimit = false;
            // Don't stop dragging on mouse leave - let global mouse up handle it
        });

        // Touch event support for A/B limit dragging (mobile)
        this.canvas.addEventListener('touchstart', (event) => {
            const touch = event.touches[0];
            const touchEvent = {
                clientX: touch.clientX,
                clientY: touch.clientY,
                touches: event.touches
            };
            const mousePos = getMousePos(touchEvent);
            const nearLimit = getNearLimit(mousePos.x, mousePos.y);
            
            if (nearLimit === 'A') {
                this.draggingALimit = true;
                isDragging = true;
                dragStartX = mousePos.x;
                this.canvas.style.cursor = 'ew-resize';
                
                // Show frame display for A limit
                this.showFrameDisplay(Sit.aFrame, touch.clientX);
                
                // Add global touch event listeners for dragging
                document.addEventListener('touchmove', globalTouchMove, {passive: false});
                document.addEventListener('touchend', globalTouchUp, {passive: false});
                
                event.preventDefault();
                event.stopPropagation();
            } else if (nearLimit === 'B') {
                this.draggingBLimit = true;
                isDragging = true;
                dragStartX = mousePos.x;
                this.canvas.style.cursor = 'ew-resize';
                
                // Show frame display for B limit
                this.showFrameDisplay(Sit.bFrame, touch.clientX);
                
                // Add global touch event listeners for dragging
                document.addEventListener('touchmove', globalTouchMove, {passive: false});
                document.addEventListener('touchend', globalTouchUp, {passive: false});
                
                event.preventDefault();
                event.stopPropagation();
            }
        }, {passive: false});

        // Global touch move event for dragging
        const globalTouchMove = (event) => {
            if (isDragging && event.touches.length > 0) {
                const touch = event.touches[0];
                const touchEvent = {
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                    touches: event.touches
                };
                const mousePos = getMousePos(touchEvent);
                const newFrame = Math.max(0, Math.min(Sit.frames - 1, pixelToFrame(mousePos.x)));
                
                if (this.draggingALimit) {
                    const clampedFrame = Math.min(newFrame, Sit.bFrame - 1);
                    Sit.aFrame = clampedFrame;
                    par._frameOverride = clampedFrame;
                    GlobalDateTimeNode.liveMode = false;
                    this.needsCanvasRedraw = true;
                    setRenderOne(true);
                    this.updateFrameDisplay(clampedFrame, touch.clientX);
                } else if (this.draggingBLimit) {
                    const clampedFrame = Math.max(newFrame, Sit.aFrame + 1);
                    Sit.bFrame = clampedFrame;
                    par._frameOverride = clampedFrame;
                    GlobalDateTimeNode.liveMode = false;
                    this.needsCanvasRedraw = true;
                    setRenderOne(true);
                    this.updateFrameDisplay(clampedFrame, touch.clientX);
                }
                
                event.preventDefault();
            }
        };

        // Global touch up event for dragging
        const globalTouchUp = (event) => {
            if (isDragging) {
                const wasAOrB = this.draggingALimit || this.draggingBLimit;
                this.draggingALimit = false;
                this.draggingBLimit = false;
                isDragging = false;
                this.canvas.style.cursor = 'default';
                this.canvas.style.pointerEvents = 'none';

                // Clear the frame override so rendering resumes at par._frame
                par._frameOverride = undefined;
                setRenderOne(true);

                this.hideFrameDisplay();

                if (wasAOrB) {
                    EventManager.dispatchEvent("abFrameChanged");
                }

                // Remove global touch event listeners
                document.removeEventListener('touchmove', globalTouchMove);
                document.removeEventListener('touchend', globalTouchUp);
            }
            event.preventDefault();
        };
    }

    dispose() {
        super.dispose()
        // Disconnect the ResizeObserver
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        // Remove the entire slider container (which contains sliderDiv, controlContainer, etc.)
        if (this.sliderContainer) {
            this.sliderContainer.remove();
            this.sliderContainer = null;
        }
        // Remove the frame display box
        if (this.frameDisplayBox) {
            this.frameDisplayBox.remove();
            this.frameDisplayBox = null;
        }
        // Clear any pending fade out timer
        if (this.fadeOutTimer) {
            clearTimeout(this.fadeOutTimer);
            this.fadeOutTimer = null;
        }
    }

    startFadeOut() {
        if (this.pinned) return; // Don't fade out if pinned
        
        // Use CSS transition for smooth fade out
        this.sliderDiv.style.transition = "opacity 0.5s";
        this.sliderInput.style.transition = "opacity 0.5s";
        this.controlContainer.style.transition = "opacity 0.5s";
        
        this.sliderDiv.style.opacity = "0";
        this.sliderInput.style.opacity = "0";
        this.controlContainer.style.opacity = "0";
        
        this.fadeOutTimer = null;
    }

    createButton(container, row, column, clickHandler, title, mouseDownHandler = null, mouseUpHandler = null) {
        const buttonContainer = this.createButtonContainer();
        const button = this.createSpriteDiv(row, column, clickHandler);
        button.title = title;
        buttonContainer.appendChild(button);
        container.appendChild(buttonContainer);

        if (mouseDownHandler) {
            button.addEventListener('mousedown', mouseDownHandler);
            // Also add touch start handler for mobile
            button.addEventListener('touchstart', (event) => {
                event.preventDefault();
                mouseDownHandler(event);
                // Visual feedback
                button.style.opacity = '0.7';
            }, {passive: false});
        }
        if (mouseUpHandler) {
            button.addEventListener('mouseup', mouseUpHandler);
            // Also add touch end handler for mobile
            button.addEventListener('touchend', (event) => {
                event.preventDefault();
                mouseUpHandler(event);
                // Remove visual feedback
                button.style.opacity = '1';
            }, {passive: false});
        }
        
        // Add touch event handlers for click-style buttons
        button.addEventListener('touchstart', (event) => {
            event.preventDefault();
            button.style.opacity = '0.7';
        }, {passive: false});
        
        button.addEventListener('touchend', (event) => {
            event.preventDefault();
            button.style.opacity = '1';
            clickHandler(event);
        }, {passive: false});

        return button;
    }

    update(frame) {
        // Update audio button visibility and state
        this.updateAudioButton();

        // If pinned, ensure the bar stays visible
        if (this.pinned) {
            this.sliderDiv.style.opacity = "1";
            this.sliderInput.style.opacity = "1";
            this.controlContainer.style.opacity = "1";
            // Clear any pending fade out timer when pinned
            if (this.fadeOutTimer) {
                clearTimeout(this.fadeOutTimer);
                this.fadeOutTimer = null;
            }
        }

        // Continuously update frame display when hovering over slider
        if (this.isHoveringSlider && this.frameDisplayBox && this.frameDisplayBox.style.display === 'block') {
            const currentFrame = parseInt(this.sliderInput.value, 10);
            // Only update if the frame has changed to avoid unnecessary DOM updates
            if (currentFrame !== this.lastDisplayedFrame) {
                this.lastDisplayedFrame = currentFrame;
                this.frameDisplayBox.textContent = this.getFrameDisplayText(currentFrame);
                
                // Update position based on current frame
                const sliderRect = this.sliderDiv.getBoundingClientRect();
                const framePosition = this.getFramePixelPosition(currentFrame);
                this.frameDisplayBox.style.left = (sliderRect.left + framePosition) + 'px';
            }
        }

        if (this.advanceHeld) {
            this.advanceHoldFrames++;
            if (this.advanceHoldFrames > this.holdThreshold) {
                this.advanceOneFrame();
            }
        }

        if (this.backHeld) {
            this.backHoldFrames++;
            if (this.backHoldFrames > this.holdThreshold) {
                this.backOneFrame();
            }
        }

        if (this.fastForwardButton && this.fastForwardButton.held) {
            par.frame = Math.min(parseInt(par.frame, 10) + 10, parseInt(this.sliderInput.max, 10));
            GlobalDateTimeNode.liveMode = false;

        }

        if (this.fastRewindButton && this.fastRewindButton.held) {
            par.frame = Math.max(parseInt(par.frame, 10) - 10, 0);
            GlobalDateTimeNode.liveMode = false;

        }

        // Check if canvas needs to be redrawn
        const currentWidth = this.canvas.offsetWidth;
        const currentHeight = this.canvas.offsetHeight;
        const sizeChanged = (currentWidth !== this.lastCanvasWidth || currentHeight !== this.lastCanvasHeight);
        const aFrameChanged = (Sit.aFrame !== this.lastAFrame);
        const bFrameChanged = (Sit.bFrame !== this.lastBFrame);
        const hoverStateChanged = (
            this.hoveringALimit !== this.lastHoveringALimit ||
            this.hoveringBLimit !== this.lastHoveringBLimit
        );
        const dragStateChanged = (
            this.draggingALimit !== this.lastDraggingALimit ||
            this.draggingBLimit !== this.lastDraggingBLimit
        );

        // Only redraw if something changed or explicitly marked for redraw
        if (!this.needsCanvasRedraw && !sizeChanged && !aFrameChanged && !bFrameChanged && 
            !hoverStateChanged && !dragStateChanged) {
            return; // Skip expensive canvas operations
        }

        // Update tracked state
        this.lastCanvasWidth = currentWidth;
        this.lastCanvasHeight = currentHeight;
        this.lastAFrame = Sit.aFrame;
        this.lastBFrame = Sit.bFrame;
        this.lastHoveringALimit = this.hoveringALimit;
        this.lastHoveringBLimit = this.hoveringBLimit;
        this.lastDraggingALimit = this.draggingALimit;
        this.lastDraggingBLimit = this.draggingBLimit;
        this.needsCanvasRedraw = false;

        // resize the canvas to the actualy pixels of the div
        const ctx = this.canvas.getContext('2d');
        this.canvas.width = currentWidth;
        this.canvas.height = currentHeight;

        // Add padding to ensure handles are visible at the edges
        const padding = 5; // pixels of padding on each side
        const drawableWidth = this.canvas.width - (2 * padding);

        // Draw status overlay if set
        if (this.statusOverlay && this.statusOverlay.length > 0) {
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 2;
            ctx.beginPath();
            let inSegment = false;
            let segmentStartX = 0;
            for (let i = 0; i < this.statusOverlay.length; i++) {
                const x = padding + (drawableWidth * i / Sit.frames);
                if (this.statusOverlay[i]) {
                    if (!inSegment) {
                        ctx.moveTo(x, this.statusOverlayOffset);
                        segmentStartX = x;
                        inSegment = true;
                    } else {
                        ctx.lineTo(x, this.statusOverlayOffset);
                    }
                } else {
                    if (inSegment) {
                        ctx.lineTo(Math.max(x, segmentStartX + 1), this.statusOverlayOffset);
                        ctx.stroke();
                        ctx.beginPath();
                        inSegment = false;
                    }
                }
            }
            if (inSegment) {
                const lastX = padding + drawableWidth;
                ctx.lineTo(Math.max(lastX, segmentStartX + 1), this.statusOverlayOffset);
                ctx.stroke();
            }
        }

        if (this.groupOverlay && this.groupOverlay.length > 0) {
            const groupY = this.statusOverlayOffset + 4;
            ctx.lineWidth = 3;
            for (const entry of this.groupOverlay) {
                const x0 = padding + (drawableWidth * entry.start / Sit.frames);
                const x1 = padding + (drawableWidth * entry.end / Sit.frames);
                if (entry.status === 'cached') {
                    ctx.strokeStyle = '#0088ff';
                } else if (entry.status === 'partial') {
                    ctx.strokeStyle = '#ffcc00';
                } else if (entry.status === 'requested') {
                    ctx.strokeStyle = '#ff0000';
                } else {
                    continue;
                }
                ctx.beginPath();
                ctx.moveTo(x0, groupY);
                ctx.lineTo(Math.max(x1, x0 + 1), groupY);
                ctx.stroke();
            }
        }

        // Draw A limit line (green)
        const aPixel = padding + (drawableWidth * Sit.aFrame / Sit.frames);
        let aColor = '#008000'; // Default green
        let aLineWidth = 1.5;
        let aHandleRadius = 3;
        
        if (this.draggingALimit) {
            aColor = '#00ff00'; // Bright green when dragging
            aLineWidth = 2;
            aHandleRadius = 3.5;
        } else if (this.hoveringALimit) {
            aColor = '#00cc00'; // Medium green when hovering
            aLineWidth = 1.75;
            aHandleRadius = 3.25;
        }
        
        ctx.strokeStyle = aColor;
        ctx.lineWidth = aLineWidth;
        ctx.beginPath();
        ctx.moveTo(aPixel, 0);
        ctx.lineTo(aPixel, this.canvas.height);
        ctx.stroke();

        // Draw A limit handle (small circle at top)
        ctx.fillStyle = aColor;
        ctx.beginPath();
        ctx.arc(aPixel, 6, aHandleRadius, 0, 2 * Math.PI);
        ctx.fill();

        // Draw B limit line (red)
        const bPixel = padding + (drawableWidth * Sit.bFrame / Sit.frames);
        let bColor = '#800000'; // Default red
        let bLineWidth = 1.5;
        let bHandleRadius = 3;
        
        if (this.draggingBLimit) {
            bColor = '#ff0000'; // Bright red when dragging
            bLineWidth = 2;
            bHandleRadius = 3.5;
        } else if (this.hoveringBLimit) {
            bColor = '#cc0000'; // Medium red when hovering
            bLineWidth = 1.75;
            bHandleRadius = 3.25;
        }
        
        ctx.strokeStyle = bColor;
        ctx.lineWidth = bLineWidth;
        ctx.beginPath();
        ctx.moveTo(bPixel, 0);
        ctx.lineTo(bPixel, this.canvas.height);
        ctx.stroke();

        // Draw B limit handle (small circle at top)
        ctx.fillStyle = bColor;
        ctx.beginPath();
        ctx.arc(bPixel, 6, bHandleRadius, 0, 2 * Math.PI);
        ctx.fill();


    }

    updateFrameSlider() {
        if (this.sliderInput.style.opacity === "1") {
            // Use par._frame directly so the slider thumb stays at the real frame
            // position even when _frameOverride is active (during A/B limit dragging)
            const currentValue = parseInt(this.sliderInput.value, 10);
            if (currentValue !== par._frame) {
                this.sliderInput.value = par._frame;
            }

            const max = parseInt(this.sliderInput.max, 10);
            if (max !== Sit.frames) {
                this.sliderInput.max = Sit.frames;
            }
        }
    }

    // Utility function to create a div using a sprite from a sprite sheet
    createSpriteDiv(row, column, onClickHandler) {
        const div = document.createElement('div');
        // Responsive sprite size
        const isMobile = window.innerWidth <= 768 || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        const buttonSize = isMobile ? 44 : 28; // 44px for mobile, 28px for desktop
        const spriteSize = 40; // Original sprite size
        const scaleFactor = buttonSize / spriteSize;
        
        div.style.width = buttonSize + 'px';
        div.style.height = buttonSize + 'px';
        div.style.backgroundImage = 'url(./data/images/video-sprites-40px-5x3-dark.png?v=2)';
        div.style.backgroundSize = `${200 * scaleFactor}px ${120 * scaleFactor}px`; // Scale sprite sheet
        div.style.backgroundPosition = `-${column * spriteSize * scaleFactor}px -${row * spriteSize * scaleFactor}px`;
        div.style.backgroundRepeat = 'no-repeat';
        div.style.cursor = 'pointer';
        div.style.userSelect = 'none'; // Prevent text selection on long press
        div.style.WebkitUserSelect = 'none';  // iOS compatibility
        div.addEventListener('click', onClickHandler);
        return div;
    }

    // Utility function to create a button container
    createButtonContainer() {
        const container = document.createElement('div');
        // Responsive button size: larger on mobile, smaller on desktop
        const isMobile = window.innerWidth <= 768 || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        const buttonSize = isMobile ? 44 : 28; // 44px for mobile touch targets, 28px for desktop
        container.style.width = buttonSize + 'px';
        container.style.height = buttonSize + 'px';
        container.style.display = 'flex';
        container.style.alignItems = 'center';
        container.style.justifyContent = 'center';
        container.style.padding = isMobile ? '4px' : '0px'; // Add padding for easier touch
        return container;
    }

    // Function to update the play/pause button based on the state of par.paused
    updatePlayPauseButton() {
        // only do it if state changes, as it's surprisingly expensive
        if (par.paused !== this.lastParPaused) {
            this.lastParPaused = par.paused;
            const isMobile = window.innerWidth <= 768 || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
            const buttonSize = isMobile ? 44 : 28; // 44px for mobile, 28px for desktop
            const spriteSize = 40;
            const scaleFactor = buttonSize / spriteSize;
            if (par.paused) {
                this.playPauseButton.style.backgroundPosition = `-${spriteLocations.play.col * spriteSize * scaleFactor}px -${spriteLocations.play.row * spriteSize * scaleFactor}px`;
            } else {
                this.playPauseButton.style.backgroundPosition = `-${spriteLocations.pause.col * spriteSize * scaleFactor}px -${spriteLocations.pause.row * spriteSize * scaleFactor}px`;
            }
        }
    }

    // Play/Pause toggle function
    togglePlayPause() {
        par.paused = !par.paused;
        this.updatePlayPauseButton();
    }

    // Pin/Unpin toggle function
    togglePin() {
        this.pinned = !this.pinned;
        const isMobile = window.innerWidth <= 768 || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        const buttonSize = isMobile ? 44 : 28; // 44px for mobile, 28px for desktop
        const spriteSize = 40;
        const scaleFactor = buttonSize / spriteSize;
        this.pinButton.style.backgroundPosition = this.pinned ? 
            `-${spriteLocations.unpin.col * spriteSize * scaleFactor}px -${spriteLocations.unpin.row * spriteSize * scaleFactor}px` : 
            `-${spriteLocations.pin.col * spriteSize * scaleFactor}px -${spriteLocations.pin.row * spriteSize * scaleFactor}px`;
    }

    toggleAudioMute() {
        const videoNode = NodeMan.get("video", false);
        if (videoNode && videoNode.videoData && videoNode.videoData.audioHandler) {
            const audioHandler = videoNode.videoData.audioHandler;
            const newMutedState = !audioHandler.getMuted();
            audioHandler.setMuted(newMutedState);
            this.updateAudioButton();
        }
    }

    updateAudioButton() {
        const videoNode = NodeMan.get("video", false);
        if (!videoNode || !videoNode.videoData || !videoNode.videoData.audioHandler) {
            this.audioButton.style.display = 'none';
            return;
        }

        const audioHandler = videoNode.videoData.audioHandler;
        if (!audioHandler.isInitialized) {
            this.audioButton.style.display = 'none';
            return;
        }

        this.audioButton.style.display = '';

        const isMobile = window.innerWidth <= 768 || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        const buttonSize = isMobile ? 44 : 28;
        const spriteSize = 40;
        const scaleFactor = buttonSize / spriteSize;

        const isMuted = audioHandler.getMuted();
        const location = isMuted ? spriteLocations.muted : spriteLocations.audio;
        this.audioButton.style.backgroundPosition = 
            `-${location.col * spriteSize * scaleFactor}px -${location.row * spriteSize * scaleFactor}px`;
        this.audioButton.title = isMuted ? 'Unmute Audio' : 'Mute Audio';
    }

    // Advance a single frame function
    advanceOneFrame() {
        par.paused = true;
        this.updatePlayPauseButton()
        let currentFrame = parseInt(this.sliderInput.value, 10);
        if (currentFrame < parseInt(this.sliderInput.max, 10)) {
            this.setFrame(currentFrame + 1);
        }
    }

    // Back a single frame function
    backOneFrame() {
        par.paused = true;
        this.updatePlayPauseButton()
        let currentFrame = parseInt(this.sliderInput.value, 10);
        if (currentFrame > 0) {
            this.setFrame(currentFrame - 1);
        }
    }

    // Set frame helper function
    setFrame(frame) {
        this.sliderInput.value = frame;
        par.frame = frame;
    }

    setStatusOverlay(statusArray, verticalOffset = 2) {
        this.statusOverlay = statusArray;
        this.statusOverlayOffset = verticalOffset;
        this.needsCanvasRedraw = true;
    }

    clearStatusOverlay() {
        this.statusOverlay = null;
        this.needsCanvasRedraw = true;
    }

    // Helper function to format time in timezone (HH:MM:SS.xx)
    formatTimeInTimeZone(date, offsetHours) {
        // Convert the offset to milliseconds
        const offsetMilliseconds = offsetHours * 60 * 60 * 1000;
        
        // Apply the offset
        const localTime = date.getTime();
        const localOffset = date.getTimezoneOffset() * 60000; // getTimezoneOffset returns in minutes
        const utc = localTime + localOffset;
        const targetTime = new Date(utc + offsetMilliseconds);
        
        // Format the time as HH:MM:SS.xx
        const pad = num => num.toString().padStart(2, '0');
        const hours = pad(targetTime.getHours());
        const minutes = pad(targetTime.getMinutes());
        const seconds = pad(targetTime.getSeconds());
        const centiseconds = Math.floor(targetTime.getMilliseconds() / 10).toString().padStart(2, '0');
        
        return `${hours}:${minutes}:${seconds}.${centiseconds}`;
    }

    // Get frame display text with frame number, video time, and timezone time
    getFrameDisplayText(frame) {
        // Line 1: Frame number and video time
        const videoTime = (frame / Sit.fps).toFixed(2);
        const line1 = `${frame} ${videoTime}s`;
        
        // Line 2: Time in designated timezone
        let line2 = '';
        if (GlobalDateTimeNode && GlobalDateTimeNode.dateNow) {
            const nowDate = GlobalDateTimeNode.dateNow;
            const timeInTZ = this.formatTimeInTimeZone(nowDate, GlobalDateTimeNode.getTimeZoneOffset());
            const tzName = GlobalDateTimeNode.getTimeZoneName();
            line2 = `${timeInTZ}`;
        }
        
        return line1 + '\n' + line2;
    }

    // Show frame display box
    showFrameDisplay(frame, mouseX) {
        if (this.frameDisplayBox) {
            this.frameDisplayBox.textContent = this.getFrameDisplayText(frame);
            this.frameDisplayBox.style.display = 'block';
            this.frameDisplayBox.style.whiteSpace = 'pre'; // Preserve line breaks
            
            // Calculate position based on frame position on slider, not mouse position
            const sliderRect = this.sliderDiv.getBoundingClientRect();
            const framePosition = this.getFramePixelPosition(frame);
            this.frameDisplayBox.style.left = (sliderRect.left + framePosition) + 'px';
        }
    }

    // Hide frame display box
    hideFrameDisplay() {
        if (this.frameDisplayBox) {
            this.frameDisplayBox.style.display = 'none';
        }
    }

    // Update frame display position and content
    updateFrameDisplay(frame, mouseX) {
        if (this.frameDisplayBox && this.frameDisplayBox.style.display === 'block') {
            this.frameDisplayBox.textContent = this.getFrameDisplayText(frame);
            
            // Calculate position based on frame position on slider, not mouse position
            const sliderRect = this.sliderDiv.getBoundingClientRect();
            const framePosition = this.getFramePixelPosition(frame);
            this.frameDisplayBox.style.left = (sliderRect.left + framePosition) + 'px';
        }
    }

    // Helper method to get pixel position of a frame on the slider
    getFramePixelPosition(frame) {
        if (!this.sliderInput || !Sit.frames) return 0;
        
        // Calculate the percentage position of the frame
        const percentage = frame / Sit.frames;
        
        // For HTML range inputs, the thumb position is calculated as:
        // position = (value - min) / (max - min) * (width - thumbWidth) + thumbWidth/2
        const sliderRect = this.sliderInput.getBoundingClientRect();
        const min = parseFloat(this.sliderInput.min);
        const max = parseFloat(this.sliderInput.max);
        const thumbWidth = 20; // Standard thumb width for range inputs
        
        // Calculate the actual thumb center position
        const range = max - min;
        const valuePosition = (frame - min) / range;
        const trackWidth = sliderRect.width - thumbWidth;
        
        return valuePosition * trackWidth + (thumbWidth / 2);
    }
}

// Define the sprite locations by button name
const spriteLocations = {
    play: { row: 0, col: 0 }, // Play button
    pause: { row: 0, col: 1 }, // Pause button
    frameBack: { row: 1, col: 3 }, // Step one frame back
    frameAdvance: { row: 1, col: 2 }, // Step one frame forward
    start: { row: 1, col: 1 }, // Jump to start
    end: { row: 1, col: 0 }, // Jump to end
    fastRewind: { row: 2, col: 1 }, // Fast rewind
    fastForward: { row: 2, col: 0 }, // Fast forward
    pin: { row: 2, col: 2 }, // Pin button
    unpin: { row: 2, col: 3 }, // Unpin button
    audio: { row: 0, col: 4 }, // Audio button
    muted: { row: 1, col: 4 }, // Muted button
};

// Exported function to create an instance of CNodeFrameSlider
export function SetupFrameSlider() {
    return new CNodeFrameSlider({ id: "FrameSlider" });
}

// Updated function to update the frame slider UI
// it does NOT change par.frame, it just updates the slider to match par.frame, and updates the play/pause button
export function updateFrameSlider() {
    const slider = NodeMan.get("FrameSlider");
    slider.updateFrameSlider();
    slider.updatePlayPauseButton();
}
