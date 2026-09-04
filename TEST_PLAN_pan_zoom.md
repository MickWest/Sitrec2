# Pan+Zoom Feature Test Plan

**Status:** The pan-and-zoom feature is implemented. This file is the retained manual
regression checklist; it is not an active implementation plan. Section 12 remains a possible
future enhancement rather than current behavior.

## Changes Summary
Added `panOffsetX`/`panOffsetY` to CNodeVideoView to support panning alongside the existing videoZoom system. The lookView syncs pan via `camera.setViewOffset()`. Mirror video and UI overlays also sync pan state.

### Files Modified
- `src/nodes/CNodeVideoView.js` - panOffset properties, getSourceAndDestCoords, mouse handlers, clamp, serialize
- `src/nodes/CNodeView3D.js` - setViewOffset pan sync in lookView rendering
- `src/nodes/CNodeMirrorVideoView.js` - sync panOffset from mirrored view
- `src/nodes/CNodeViewUI.js` - px()/py() shifted by panOffset for HUD positioning

---

## 1. Backward Compatibility (CRITICAL)

### 1.1 Video sitch with no pan (panOffset = 0,0)
- Load a standard video sitch (Gimbal, GoFast, Aguadilla, FLIR1)
- Verify video displays identically to before (no visual difference)
- Verify lookView 3D content matches (no shift, no zoom change)
- Verify mirrorVideo overlay on lookView renders correctly
- Verify frame scrubbing (right-drag) still works

### 1.2 videoZoom slider
- Use the Video Zoom % slider in the GUI
- Verify it still zooms to center when panOffset is 0
- Verify lookView syncs zoom correctly (camera.zoom matches)

### 1.3 No zoom input path
- If a sitch has no videoZoom connected (unlikely in standard sitches but possible):
  - Verify pos-based zoom/pan still works (mouse wheel + drag)
  - Verify double-click resets

---

## 2. Pan Functionality

### 2.1 Drag to pan
- Open any video/image sitch
- Zoom in with mouse wheel (at least 2x)
- Left-drag to pan: verify image moves in drag direction
- Verify pan is clamped to image bounds (can't pan past edge)
- At 1x zoom: verify pan has no effect (clamped to 0)

### 2.2 Zoom around cursor
- Place cursor at the RIGHT edge of the video, scroll to zoom in
- Verify the zoom centers on the cursor (right side stays visible)
- Place cursor at the TOP-LEFT corner, zoom in
- Verify the top-left region is what's shown when zoomed
- Verify this works smoothly across many zoom increments

### 2.3 Center-drag zoom
- Middle-button drag left/right to zoom
- Verify zoom works (zooms around center since no cursor tracking for center-drag)

### 2.4 Double-click reset
- Zoom in and pan to an off-center position
- Double-click on the video view
- Verify both zoom resets to 100% AND pan resets to center (0,0)

---

## 3. LookView Sync

### 3.1 Zoom sync
- Zoom in on the video view
- Verify lookView 3D content narrows to match the zoomed region
- Verify terrain/objects visible in the zoomed video match what's visible in lookView

### 3.2 Pan sync
- Zoom in, then pan the video view
- Verify lookView 3D scene shifts to match: if you pan the video right, the lookView should also show the right portion of the scene
- Verify mirrorVideo overlay on lookView moves in sync with both the 3D content and the main video

### 3.3 Combined zoom+pan
- Zoom in significantly (5x+), pan to a corner
- Verify lookView shows the matching 3D region
- Slowly zoom back out while panning - verify smooth, consistent sync

### 3.4 Reset sync
- After zoom+pan, double-click to reset
- Verify lookView returns to its default (centered, 1x zoom) state

---

## 4. Coordinate Conversions

### 4.1 canvasToVideoCoords / videoToCanvasCoords
- These are used by tracking overlays and are tested implicitly:
- Zoom in and pan on a sitch with tracking (e.g., Gimbal with object tracking)
- Click to add/move a tracking keyframe while zoomed+panned
- Verify the keyframe appears at the correct position on the video
- Verify the keyframe stays at the correct video position when zooming/panning further

### 4.2 canvasToVideoCoordsOriginal / videoToCanvasCoordsOriginal
- Used by CNodeTrackingOverlay for resolution-independent tracking
- Add keyframes at original resolution, zoom in, verify they render at correct positions
- Change video resolution (if applicable), verify keyframes scale correctly

---

## 5. Tracking Overlays

### 5.1 CNodeTrackingOverlay
- Load a sitch with manual tracking (e.g., custom sitch with tracking overlay)
- Add keyframes at various positions
- Zoom in and pan - verify keyframe markers move correctly with the video content
- Drag a keyframe while zoomed+panned - verify it stays under the cursor
- Verify LOS (line of sight) calculations from tracking points are unaffected

### 5.2 CObjectTracking
- Similar to above but for automated/semi-automated tracking
- Verify tracking boxes render at correct positions when zoomed+panned

---

## 6. Mirror Video Overlay

### 6.1 Content sync
- Verify mirrorVideo on lookView shows EXACTLY the same content as the main video view
- When zoomed in and panned, the mirrorVideo crop should match
- Overlay transparency should work as before

### 6.2 Mouse passthrough
- mirrorVideo has `ignoreMouseEvents()` - verify mouse events still pass through to lookView's orbit controls when applicable

---

## 7. UI Overlays (CNodeViewUI)

### 7.1 HUD text with syncVideoZoom
- Load FLIR1 or Gimbal (has ATFLIR UI overlay with syncVideoZoom)
- Zoom in using videoZoom slider or mouse wheel
- Verify HUD text elements scale with zoom (existing behavior)
- Pan while zoomed - verify HUD text elements shift to match the pan
- Verify compass, heading, and other HUD elements remain correctly positioned relative to the video content

### 7.2 HUD without syncVideoZoom
- UI overlays that don't sync with videoZoom should be completely unaffected
- Verify no visual changes in overlays that don't have `syncVideoZoom: true`

---

## 8. Effects and Filters

### 8.1 Video effects while panned
- Enable brightness/contrast/blur/etc. effects
- Zoom in and pan - verify effects still apply correctly to the visible region
- The effects are applied to `sourceImage` before `drawImage`, so they should work regardless of pan

### 8.2 ELA overlay while panned
- If ELA overlay is available, enable it
- Zoom in and pan - verify the ELA overlay aligns with the video content

### 8.3 Noise overlay while panned
- Similar to ELA - verify noise analysis overlay aligns when panned

---

## 9. Serialization

### 9.1 Save/restore pan state
- Zoom in and pan to a specific position
- Serialize the state (save settings)
- Reload/deserialize
- Verify the pan position and zoom level are restored exactly

### 9.2 Default values
- On fresh load, verify panOffsetX and panOffsetY are 0
- Verify no regression from adding these to the serialization list

---

## 10. Edge Cases

### 10.1 Zoom to 1x (no zoom)
- At exactly 100% zoom, panOffset should be clamped to 0
- Verify no visual artifacts when transitioning through 1x

### 10.2 Very high zoom (20x+)
- Zoom in very far on a large image
- Pan around - verify smooth performance, no jittering
- Verify lookView sync remains accurate at extreme zoom levels

### 10.3 Aspect ratio variations
- Test with a wider-than-tall video (letterboxed)
- Test with a taller-than-wide video (pillarboxed)
- Verify pan works correctly in both letterbox and pillarbox modes
- Verify pan doesn't allow scrolling into the letterbox/pillarbox black bars

### 10.4 Window resize while zoomed+panned
- Zoom in and pan
- Resize the browser window
- Verify the pan/zoom state is preserved and rendering adapts correctly

### 10.5 Video switch while zoomed+panned
- Zoom in and pan on one video
- Switch to a different video (multi-video support)
- Verify pan state resets or adapts correctly for the new video dimensions

### 10.6 Image rotation
- Load an image and apply 90/180/270 rotation
- Zoom in and pan - verify pan direction is correct relative to the rotated image

---

## 11. Sky/Star Overlay (CNodeDisplaySkyOverlay)

### 11.1 Star labels while panned
- If a sitch has star overlays on the lookView, verify star labels remain positioned correctly when the video is zoomed+panned
- The sky overlay uses `applyCameraOffset()` for PTZ but doesn't yet have explicit pan offset support from the video view. setViewOffset on the camera should handle this automatically since the sky overlay reads camera state.

---

## 12. Pixel-Perfect Zoom (Future Enhancement)

### 12.1 When to verify
- Not yet implemented - this is a future enhancement
- When zoom level is high enough that video pixels map 1:1 to lookView pixels, image smoothing should be disabled for crisp pixel rendering
- The threshold would be: `zoom >= videoWidth / lookViewWidth`

---

## 13. Performance

### 13.1 Rendering performance
- Verify no noticeable performance regression in normal (un-zoomed) operation
- clampPanOffset() and getSourceAndDestCoords() are called frequently - verify they don't add measurable overhead
- setViewOffset/clearViewOffset in CNodeView3D adds per-frame overhead for lookView - verify it's negligible

### 13.2 Memory
- No new buffers or textures are allocated - verify memory usage is unchanged
