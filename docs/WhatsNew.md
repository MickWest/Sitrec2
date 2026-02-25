# What's New in Sitrec

<!--
## AI Instructions for Updating This Document

IMPORTANT: Always check what the last documented version is, and update ALL missing versions up to the current version.

CRITICAL - DO NOT HALLUCINATE:
- ONLY document features that are explicitly mentioned in git commit messages
- NEVER invent, guess, or assume features that might exist
- If a commit message is unclear, examine the actual code changes
- If you cannot verify a feature from commits, DO NOT include it
- It is better to have a sparse changelog than an inaccurate one

When updating this changelog:

1. **Check last documented version**: Look at the first version heading below these instructions
2. **Get version tags**: Run `git tag -l "2.*" --sort=-version:refname --format='%(refname:short)|%(creatordate:short)' | head -20`
3. **Get commits between versions**: Run `git log [old_tag]..[new_tag] --pretty=format:"%s"` for each missing version
   - To find the previous tag, list all tags and find the one before: `git tag -l "2.*" --sort=-version:refname`
4. **Get commits since last tag**: Run `git log [latest_tag]..HEAD --pretty=format:"%s"` for unreleased changes
5. **Verify each entry**: Every changelog entry MUST correspond to an actual commit message
6. **Categorize entries**:
   - **New Features**: New functionality, UI additions, new file format support
   - **Improvements**: Enhancements to existing features, performance, UX improvements
   - **Bug Fixes**: Entries starting with "Fixed", "Fix", corrections to existing behavior
7. **Write clean descriptions**: Convert commit messages to user-friendly descriptions. Look at actual code changes if the commit message is unclear.
8. **Format**: Use present tense, focus on user benefit, be concise
9. **Add new versions at the top** of the document, below these instructions
10. **Include the date** with each version heading
11. **Omit empty sections**: If a version has no New Features, don't include that heading

Example entry format:
## Version X.Y.Z (YYYY-MM-DD)

### New Features
- Feature description focusing on what users can now do

### Improvements  
- Enhancement description

### Bug Fixes
- Fixed issue description
-->

---

## Unreleased

### New Features
- **3D Buildings**: Basic 3D building rendering with Google Maps PBR tiles (admin only)
- **Ellipsoid Earth Model**: Framework for WGS84 ellipsoid earth model with sphere/ellipsoid toggle in terrain options
- **3D Tile Renderer**: Per-viewport 3D tile rendering with lighting
- **EGM96 Geoid Correction**: Terrarium elevation corrected from EGM96 geoid to WGS84 altitude

### Improvements
- Full ECEF coordinate system transition replacing Y-up EUS assumptions with local tangent vectors
- Ellipsoid model enabled by default in Starlink live mode
- Gimbal cloud speed matching updated for ECEF coordinates
- Moon and Earth shadow calculations corrected for ECEF
- Eclipse umbra sizing fixed with geocentric Sun/Moon vectors
- Fixed lighting on Google Maps PBR tiles with gamma correction
- MSL/HAE altitude handling clarified and corrected throughout
- Removed legacy radius parameters (earth radius is now fixed, no longer variable for refraction simulation)
- Converted legacy local frame EUS camera start positions to LLA
- Globe updates when changing globe model; Agua spline recalculates accordingly
- Per-user tracking and limits for 3D buildings API usage
- Updated npm packages

### Bug Fixes
- Fixed SplineEditor breaking linear tracks (SitJellyfish, SitPorterville)
- Fixed getLocalUp for ellipsoid mode
- Fixed editing buildings
- Fixed crashing when switching from 3D to 2D tiles
- Fixed hardcoded MSL elevation values that need conversion to HAE
- Fixed projectHorizontal for ECEF and replaced clockwiseZX with cross product
- Fixed CNodeTrackFromVelocity.getGroundPoint for ECEF coordinates
- Fixed ECEF camera issues related to assuming local EUS

---

## Version 2.29.0 (2026-02-22)

### Improvements
- Tile coverage caching with dirty parent tracking for faster tile iteration
- Skip GPU usage calculation in dev mode when the GPU usage menu is not visible
- Don't display bad data filter for serialized sitches
- CORS header for getsitches.php

### Security
- Fixed reflected XSS in proxy.php error output
- Fixed path traversal in chatbot.php getHelpDocContent
- Fixed open redirect and reflected XSS in cachemaps.php
- XSS hardening across server-side code
- Restricted unsafe file extensions (like .php)
- Clarified example keys to avoid false security triggers

### Bug Fixes
- Fixed CNodeSpecificFrame using passed frame instead of its own specificFrame
- Fixed getLST returning negative values for western longitudes
- Fixed LLAToECEFVD returning NaN from array-indexing a Vector3
- Fixed ECEFToLLA longitude using atan2 instead of atan
- Fixed event listener leak in PointEditor
- Fixed off-by-one day in tleEpochToDate
- Fixed addInput duplicate-key assert checking literal "key" instead of dynamic key
- Dispose render targets, shader materials, and geometry in CNodeView3D to prevent memory leaks
- Disabled unused CNodeCode.js

---

## Version 2.28.8 (2026-02-21)

### New Features
- **G-Force Track Filtering**: Auto-detect bad tracks with spurious data and apply g-force based filtering
- **Multiple Tracks in CSV Files**: Support multiple tracks in a single CSV file, matching JSON multi-track behavior

### Improvements
- Confirmation dialog before removing a track
- "Try Altitude First" option for track filtering, as altitude is often noisier
- Smoothing parameter visibility updates on folder open and menu mirror
- Clean handling of missing sitches with user-friendly error

### Bug Fixes
- Fixed banking menu after loading sitches
- Fixed invisible tracks being selectable with right-click

---

## Version 2.28.7 (2026-02-21)

### Improvements
- Selectable smoothing types and bank angle for tracks

### Bug Fixes
- Fixed disposing of unused controllers with inputs (e.g., tilt controller)
- Fixed loading a sitch after being in full-screen mode
- Fixed TLE loading with initial blank lines, now stores multiple entries per satellite and chooses the best one

---

## Version 2.28.6 (2026-02-20)

### New Features
- **Gradient Material**: Gradient material for 3D objects with leading edge direction control
- **Export All OSD Data**: Export all OSD data series at once

### Improvements
- Object editing menu stays open even when clicking outside it

---

## Version 2.28.5 (2026-02-19)

### Bug Fixes
- Fixed EPS (Google Earth Studio) exporting

---

## Version 2.28.4 (2026-02-19)

### New Features
- **IR Balloon Thermal Simulator**: Standalone tool for simulating balloon thermal signatures with HDR bloom rendering
- **FOV Curve Editor Y-Range Slider**: Vertical slider on the curve editor for direct visual control of the Y-axis range

### Improvements
- Starlink sitch correctly sets video layout in live mode and clears live mode when any video is dragged in
- Reset live mode when setting time
- Cleaned up export buttons for legacy sitch "reinterpret" functionality

### Bug Fixes
- Fixed relative camera controller
- Fixed ambient temperature calculation in IR balloon simulator (no emissive cooling)

---

## Version 2.28.3 (2026-02-16)

### Bug Fixes
- Fixed terrain not-loaded check
- Fixed deferred track locking during deserialization

---

## Version 2.28.2 (2026-02-16)

### New Features
- **Reflection Analysis**: Analyze surface reflections on 3D objects with configurable grid size and debug arrows

### Improvements
- Refactored view visibility system, separating user intent from computed state to fix fullscreen exit permanently hiding views
- Fixed compositing of overlays and relative views (compass, MQ9UI) when rendering video exports
- Caching AGL positions for jet track and positionLLA so terrain resolution changes don't degrade tracks
- Fix for sky rendering with effects (removed workaround patch)
- More robust tile checks in quadtrees

### Bug Fixes
- Fixed rotation of objects in reflection analysis

---

## Version 2.28.1 (2026-02-16)

### New Features
- **Video Grid Overlay**: Configurable grid overlay on video views with size, subdivisions, offset, and color controls
- **Video Menu**: New consolidated "Video" menu grouping video-related controls (current video selector, rotation, adjustments)

### Improvements
- Grid overlay fades as you zoom out, with default 64px grid and 4 subdivisions
- Slider max values preserved as maxMax, with 300 maxMax enforced for Tgt Start distance
- Allow celestial controller updates during video exporting and panorama rendering

### Bug Fixes
- Fixed feature/pin double deserialization issue (not being disposed on cleanup)
- Fixed grid serialization

---

## Version 2.28.0 (2026-02-15)

### New Features
- **A-B Echo Overlay**: Accumulated video frame echo between A and B markers, with Min and Max echo effects
- **Record Browser Window**: Record the browser window directly
- **Environment Map Material**: Environment mapping for 3D objects with IR mode white sky support
- **Zoom to Point**: Zoom to a specific point in main view
- **Near Plane Slider**: Adjustable near plane distance for fine-tuning 3D rendering

### Improvements
- Improved caching logic for echo groups with detailed caching status display
- More robust handling of corrupt H.264 files, GPU config errors, and open-GOP B-frame decoding
- Selectable display interval for OSD tracks, Page Up/Down navigates to prev/next keyframe
- OSD tracks support altitude lock with both AGL (default) and MSL options
- Spacebar now always toggles pause/unpause instead of toggling GUI
- Moving A and B sliders now keeps main frame slider in the same position
- Effect states are now serialized and restored
- More meaningful file export prefixes
- Ground overlay syncing with quadtrees more robust
- Forcing object above surface is now optional

### Bug Fixes
- Fixed excessive CPU usage from ground overlays
- Fixed wiggle from smoothed tracks
- Fixed exported videos not matching screen
- Fixed overlay visibility issues
- Fixed overlay duplicate display in wireframe
- Fixed importing of FOV CSV files
- Fixed web worker buffer issue for H.264
- Fixed video frame ordering and open-GOP B-frame decoding
- Fixed view visibility logic

---

## Version 2.27.0 (2026-02-10)

### New Features
- **OSD Data Graphing**: Graph OSD data series with scatter plots, separate Y axes, and A-B range selection
- **OSD Track Editing**: Create and edit tracks derived from OSD data with keyframe editing and tab-cycling between tracks
- **KML Track Exporting**: Export tracks in KML format
- **Google Earth Pin Export**: Export Google Earth pins from context menu
- **Crosshair Display**: Press "/" in video view to show crosshair overlay, click to fix position
- **Video Info Display**: Frame numbers, datetime, and video metadata shown in video viewer
- **"Stop At" Parameter**: Track-to-track targets can specify a stop point
- **TARGET/GROUND Modes**: MQ9UI supports switching between target and ground display modes

### Improvements
- Elevation data cached and serialized at highest available level, making synth and OSD tracks load faster without degrading when zooming out
- Multiple OSD data series tracks with serialization, renamed from "Tracks" to "DataSeries" for clarity
- Better OSD value interpolation and keyframe color consistency
- Simplified image and video loading in video viewer
- Corrected overlay borders and dragging for terrain altitude
- Increased blur range to 200

### Bug Fixes
- Fixed AB range
- Fixed scatterplot OSD interpolation
- Fixed full-screen offset in menu bar
- Fixed video info display in video viewer sitch

---

## Version 2.26.9 (2026-02-07)

### New Features
- **Celestial Lock Camera Mode**: Lock camera to celestial objects like "moon", "sirius", etc.
- **EPS Exporting**: Experimental EPS (Google Earth Studio) file exporting

### Improvements
- Added datetime and frame number information to video info display
- Better moon libration application
- Moon parallax adjustment for observer position
- Restored view menu in video viewer

### Bug Fixes
- Fixed context menu when zoomed in on Moon

---

## Version 2.26.8 (2026-02-06)

### New Features
- **3D Lit Moon**: Realistic 3D moon rendering with correct size, phases, and texture
- **Spline from Data Track**: Create splines from existing data tracks
- **Elevation Indicator**: Added elevation indicator to MQ9UI

### Improvements
- Stars now render behind the moon for correct occlusion
- Auto-load latest version of sitch when none specified
- Tests now stop if an assertion fires

### Bug Fixes
- Fixed moon daylight color
- Fixed specular color in Phong shading
- Fixed error caused by unexportable empty arrays in GoFast

---

## Version 2.26.7 (2026-02-05)

### Bug Fixes
- Fixed track edit menu auto-closing and exiting edit mode

---

## Version 2.26.6 (2026-02-04)

### New Features
- **Compass Graticule**: Compass line overlay for azimuth reference in views
- **MQ9 UI Display**: Enhanced MQ9 HUD with distances, positions, display units, and video-matched layout
- **Google Maps Link**: "Google Maps Here" option in ground right-click context menu
- **MGRS Coordinate Support**: Accept Military Grid Reference System coordinates in CSV imports

### Improvements
- Wind incorporated into airframe heading and camera azimuth calculations
- Broader range of coordinate format support including MGRS
- Better moving and rotating of free-transform overlays
- Banking objects use local up instead of EUS up for more correct behavior

### Bug Fixes
- Fixed click-and-drag on look view with MQ9UI
- Fixed backward camera vector causing azimuth graticule position and value to be flipped
- Fixed GUI elements that may have changed parents
- Fixed deserializing lat/lon with new handling

---

## Version 2.26.5 (2026-02-03)

### New Features
- **FlightClub Import**: Drop a .json FlightClub file to create separate tracks for each stage (e.g., filename-Stage_1.csv), with mission info displayed in notes
- **Alt-Az File Import**: Import Alt-Az files exported from FlightClub
- **User-Defined Start Times**: Allow user-defined start times for relative time tracks
- **New Tracking Algorithm**: Added new tracking algorithm with improved base "Template Match" algorithm

### Improvements
- **Notes Shortcut**: Press "N" to toggle notes, Shift-N to pseudo-dock notes on right side
- **Date/Time Parsing**: Parsing date/time with chrono-node for simplified relative time calculations
- **Manual Tracking**: "Limit AB" off by default with updated tooltip
- **Building Edit Mode**: Maintain sidebar status for edit menus, closing edit menu exits edit mode
- **Cloud Properties**: Use correct small units for all cloud properties
- **Mirrored Menus**: Open sub-menus on mirrored menus by default
- **MISB Export**: Export missing sensor roll column for MISB-compliant LOS export
- **Double-Sided Roof Material**: Eaves now look better with double-sided material

### Bug Fixes
- Fixed notes view shrinking due to event handlers not being cleaned up on dispose
- Fixed mirroring of controls that use onFinishChange, not just onChange
- Fixed unit change now affects mirrored controllers as well as the original
- Fixed mirrored controller updating when value is altered by a third different controller
- Fixed edit mode and edit menus show/hide/enable/disable logic with buildings
- Fixed small graph canvas size crash on mobile
- Added test to ensure app starts up for mobile screen size

---

## Version 2.26.4 (2026-01-31)

### New Features
- **Render Stabilized Video**: Export stabilized video at original size from Auto Tracking menu
- **Render Stabilized Expanded**: Export stabilized video with expanded canvas so no pixels are lost during stabilization shifts
- **Notes Panel**: Add and edit notes within the application
- **V-B Measure from Look View**: Set camera, target, and V-B measure positions directly from the look view
- **Undo/Redo for Camera and Target**: Full undo/redo support for camera and target positioning
- **Undo/Redo for V-B Measure**: Full undo/redo support for V-B measurement tool
- **Lock Altitude to Ground**: Track editor can now lock altitude relative to the ground
- **Delete Key Support**: Delete selected objects using the Delete key

### Improvements
- **Video Export Memory Fix**: Added backpressure to video encoder to prevent unbounded memory growth and long "flushing encoder" delays during video export
- **Auto Tracking Enhancements**: Keyframe editing, threshold preview, "Clear from Here" option, "Continue Tracking" feature
- **Snapping Windows**: Windows now snap to edges and other windows when dragging
- **All Views Draggable**: All viewport views can now be dragged and repositioned
- **Z-ordering for Viewports**: Proper layering of overlapping viewports
- **Cmd-S Shortcut**: Save with Cmd-S (Mac) or Ctrl-S (Windows), with smart detection of changes
- **Spline Precision**: Splines use local coordinates to avoid precision jittering
- **Updated Keyboard Shortcuts**: Refreshed keyboard shortcut documentation

### Bug Fixes
- Fixed deleting buildings (broke with local origin changes)
- Fixed caching of incorrect frames when stabilizing video
- Fixed sidebar mouse interaction issues
- Fixed Q-drag of video views

---

## Version 2.26.3 (2026-01-27)

### Improvements
- **Optimized Settings Saving**: Only save settings when actually changed, avoiding unnecessary server calls
- **Robust Error Handling**: More graceful handling of errors during loading
- **Model Loading**: More robust handling of model loading errors
- **Admin Panel**: Additional admin panel information

### Bug Fixes
- Fixed handling of missing .ts files

---

## Version 2.26.2 (2026-01-26)

### Bug Fixes
- Fixed tiles not subdividing when their center is behind the frustum, which led to low resolution tiles near the camera
- Fixed mouse coordinates and other view/screen transforms when sidebar is active

---

## Version 2.26.0 (2026-01-26)

### New Features
- **Sidebar Docking**: Dock menus in left and right sidebars for a customizable workspace
- **Drop Indicator for Sidebar**: Visual indicator shows where menus will dock when dragging
- **Convolution Filters at Source Level**: Image convolution filters now applied at source image level for better quality
- **Video URL Support**: Load videos directly from URLs
- **Video Viewer Electron App**: Basic video viewer extracted to standalone Electron application

### Improvements
- **Sidebar Serialization**: Sidebar configurations are saved and restored between sessions

### Bug Fixes
- Fixed drift when mouse dragging menus
- Fixed spurious scrollbar appearing when dragging a menu into the right dock

---

## Version 2.25.10 (2026-01-26)

### New Features
- **Help Menu Search**: Search box in the Help menu allows searching all menu items across all menus. Type to filter, hover or use arrow keys to preview items in their menus with highlighting, click or press Enter to select. Tooltips are shown for items that have them.
- **Video in Frustum**: Display video texture directly on the camera frustum
- **Video on Ground**: Display video texture on the ground plane with correct aspect ratio
- **Slider Settings Menu**: Right-click on any slider to adjust min, max, and step values for more precision
- **Free Transform for Overlays**: More flexible positioning of ground overlays

### Improvements
- Better TIFF support for files without geolocation data
- Deterministic flash offset based on light ID for consistent strobe timing
- Server-side rate limiting for improved security

### Bug Fixes
- Fixed JSON parsing of sitch file names returning numbers instead of strings
- Fixed feature marker text color not applying correctly
- Fixed FOV calculation issues
- Fixed ground video aspect ratio and visibility in look view

---

## Version 2.25.9 (2026-01-24)

### New Features
- **Customizable Aircraft Strobe Offset**: Random or user-defined strobe offset so aircraft lights can flash at different times
- **Camera Offset Control**: Added customizable camera offset ±10°
- **Elevated Overlays**: Overlays can now be elevated for use as clouds
- **Cloud Extraction**: Extract cloud overlays from ground overlays
- **Context Menu for Overlays**: Right-click on overlay to edit or exit edit mode

### Improvements
- **QuickFetch with Chunked Downloads**: Improved loading of larger S3 files with DB caching
- Improved loading manager
- Highlight borders around overlays to help finding them on the map
- Full GeoTIFF location format support via proj4-fully-loaded
- Rendering camera detached from pod head for better custom code compatibility
- Added terrain to SitGimbal with customization options
- Legacy sitch compatibility patches
- Short names for overlays with cloud feathering
- Auto-lock overlay when dragging in KMZ or GeoTIFF
- Exit one edit mode when starting another
- Navigate to overlay when drag and dropped

### Bug Fixes
- Fixed menu mirroring issues
- Fixed GeoTIFF and overlay handling
- Don't create control points when locked

---

## Version 2.25.8 (2026-01-22)

### Bug Fixes
- Fixed visibility of object3D labels, measurement labels, and feature labels with new overlay label system

---

## Version 2.25.7 (2026-01-22)

### New Features
- **3D Object Labels**: Labels for planes and other 3D objects
- **Label Toggle**: Toggle labels visibility in look and main views

### Improvements
- Undo/Redo support for more operations

---

## Version 2.25.6 (2026-01-22)

### Improvements
- Satellite arrows now use same visibility settings as labels

### Bug Fixes
- Fixed satellite visibility rendering in look view

---

## Version 2.25.5 (2026-01-22)

### New Features
- **Lit Only filter** for satellite labels to show only sun-illuminated satellites
- **Look View Visible Only filter** for main view satellite labels

### Improvements
- Satellite arrows now use same visibility settings as labels
- Backwards compatibility patch for satellite display range in older saves

### Bug Fixes
- Fixed overlay memory leak
- Fixed satellite visibility rendering in look view

---

## Version 2.25.4 (2026-01-22)

### Improvements
- **Replaced sprite text with overlay text** for labels - higher resolution and simpler rendering
- Increased default ambient lighting from 0.2 to 0.3

### Bug Fixes
- Fixed labeled arrows displaying at wrong end for celestial objects

---

## Version 2.25.3 (2026-01-21)

### Improvements
- Satellite display range now defaults to 100,000m
- Ignore satellites with TLE data more than 90 days out of date

### Bug Fixes
- Fixed satellite cutoff value to match previous behavior
- Fixed interpolation continuing when paused

---

## Version 2.25.2 (2026-01-21)

### Improvements
- **Improved satellite rendering** with refactored point light cloud system
- Satellite labels now limited to N closest satellites per view to prevent browser crashes
- Better satellite brightness range in main view
- Main view satellites size-attenuated by distance while remaining visible when zoomed out
- Separated brightness calculation (sun illumination) from view-specific size attenuation
- Stars rendered without subpixel flickering using minimum size and alpha blending
- Saved sitches now correctly restore exact camera orientation via local up vector serialization

### Bug Fixes
- Fixed right-click context menu on satellites and stars
- Fixed jerky satellite motion when playing at 20x+ speed
- Fixed stand-alone video viewer issues

---

## Version 2.24.2 (2026-01-20)

### New Features
- **HEVC/H.265 video support** with improved error handling
- **Rotated video support** for properly oriented playback

### Improvements
- Stand-alone LOS view now supports drag-and-drop
- Admin debug dashboard improvements

---

## Version 2.24.1 (2026-01-19)

### New Features
- **Version history menu** for loading previous saves of a sitch
- **Spline2 spline type** for manual tracking curves

### Improvements
- Improved default spline parameters
- Sitches in load menu now sorted by last save date instead of creation date
- File content hash calculation moved client-side to work with S3 presigned URLs

---

## Version 2.24.0 (2026-01-19)

### New Features
- **SubSitches** for saving and restoring sub-states within a sitch
- **Multi-video handling** with support for multiple video files
- **Video loading manager** displaying loading status of videos

### Improvements
- Improved shift-dragging to rotate camera (prevents glitching at zenith, avoids going underground)
- Double-click Sub triggers rename
- SubSitch details for selecting what is saved and restored
- Saving more metadata with file types including original origin from KML overlays
- Dialog for choosing between video image or image overlay

### Bug Fixes
- Fixed issues with async loading of multiple videos/images
- Fixed ground overlay corner dragging
- Skip "video/image is already loaded" dialog when loading TS file from sitch

---

## Version 2.23.0 (2026-01-17)

### New Features
- **GeoTiff support** for loading GeoTiff image files
- **Image ground overlays** integrated with tile system
- **KMZ file support** with embedded images (e.g., from NASA Worldview/EODIS)
- **Zaine Triangulation** for Gimbal analysis (in Show/Hide menu)
- **Admin DAG view** for node tree visualization

### Bug Fixes
- Fixed z-fighting with custom z-bias for overlay seams
- Fixed async visibility issue
- Fixed initial rotation handles
- Improved overlay visibility

---

## Version 2.22.2 (2026-01-16)

### New Features
- **PBA track importing** for Pico Balloon Archive data

### Improvements
- Great circle interpolation for display of large missing track chunks
- PBA tracks use "balloon_callsign" if available
- Exporting legacy tracks (e.g. Gimbal) as MISB compliant
- Increased video load timeout to 2 minutes

### Bug Fixes
- Fixed missing settings with server sanitization validation

---

## Version 2.22.1 (2026-01-16)

### Improvements
- Updated documentation

---

## Version 2.22.0 (2026-01-16)

### New Features
- **Cloud layers** with sprite-based rendering, proper lighting, and wind-driven animation
- **Feathered cloud edges** with randomized wiggled borders for realistic appearance
- **Cloud drag handles** for intuitive positioning and scaling in the scene

### Improvements
- Clouds conform to earth curvature creating realistic "cloud horizon" for flat cloud banks
- Optimized cloud rendering with comb sort for proper transparency ordering
- Optimized cloud mesh generation for better performance
- Panorama export now starts motion analysis automatically
- Cloud GUI matches building controls for consistency

---

## Version 2.21.0 (2026-01-14)

### New Features
- **Depth velocity traversal** using manual tracking with optimization for ground speed vs air speed
- **Multiple manual curve types** with linear segmented curves for testing
- **MISB track exporting** for minimally-compliant tracks that can be reimported
- **Compass tool** for mobile devices
- **Align with Flow** option to rotate overlays based on motion direction
- **Remove Outer Black** video processing option
- **Speed overlay** display
- **Flowgen tool** to generate scrolling fuzzy backgrounds for testing motion analysis

### Improvements
- Optimized flow orbs by reusing Three.js vectors
- Increased max satellite brightness to 50 (was 6)
- Force settings to default for visual regression tests
- Video resize now uses original dimensions for consistency across users
- Resample audio to 48K if not a common format (48K or 44.1K)
- Flow orbs working in Legacy Gimbal sitch with different camera matrix
- Legacy gimbal sphere visible in look view for better visibility

### Bug Fixes
- Fixed focus issues with GUI mousing out of input boxes
- Fixed typo (choise → choice) preventing early return optimization
- Fixed exporting of Gimbal viewport
- Fixed viewport resizing when changing presets

---

## Version 2.20.1 (2026-01-06)

### Improvements
- Panorama frame step control for more precise panorama creation
- Improved subpixel tracking for slow movement (panning)
- Using actual values (not smoothed) for panorama motion
- Using effects in panorama rendering
- Code consolidation with DRY utility functions

### Bug Fixes
- Fixed mouse scroll wheel leaking through GUI to video zoom
- Fixed skipping frames on panorama export
- Fixed multiple Masking menus bug
- Fixed OpenCV loading issue

---

## Version 2.20.0 (2026-01-04)

### New Features
- **Animated panorama exporting** for video-based 360-degree views
- **Auto masking** for motion analysis regions
- **Multiple motion analysis techniques** with selectable methods
- **Motion analysis cache status indicator** with automatic frame advance until cache is full
- **Automatic encoding fallback** to software encoding when hardware encoding fails
- **Chatbot documentation access** allowing AI assistant to reference docs

### Improvements
- Renamed "Pano Video" to "Animated Pano" for clarity
- Better interpolating over gaps and smoothing with incomplete data
- Much more accurate linear tracklet method for motion tracking
- Using last-known-good frame to handle frames with no tracking data
- Prefer software WebM encoding on Firefox for better compatibility
- Added **Sitch Duration** field in Time menu showing duration as HH:MM:SS.sss
- Elastic GUI sliders now expand their range when typing a value outside the current range
- Basic panorama exporting for 360-degree views

### Bug Fixes
- Fixed motion analysis menu loading on older sitches
- Fixed startup frame issues
- Fixed motion tracking using incorrect frames if frame not yet loaded
- Fixed motion tracking arrows not redrawing when paused and resizing
- Fixed WebM exporter
- Fixed panorama creation using video playback correctly
- Fixed menu position jumping in legacy sitches when hiding empty menus

---

## Version 2.19.6 (2026-01-01)

### New Features
- **MP4 video export** using native browser encoding via MediaBunny
- **4K video export** support (if browser supports it)
- **OpenCV integration** for video motion analysis with background direction detection
- **Motion analysis mask editing** with brush tools for defining analysis regions
- Video export now includes motion analysis overlays
- Added **Enough/Abort button** during video rendering
- Added **watermark** with version and build date to exported videos
- Export videos now render the A-to-B frame range
- Full-screen video export option

### Improvements
- H.264 encoding starts at level 4.1 for maximum compatibility
- Better video render export progress indication
- Reorganized video rendering menu

### Bug Fixes
- Fixed frame slider going one past the end of the video
- Fixed jittery labels on video export
- Fixed OpenCV crash
- Removed sliders from Lat/Lon inputs
- Fixed resize handles appearing when editing video analysis mask
- Fixed fullscreen video issues
- Fixed WebM encoding for fractional framerates
- Fixed video creator changing visibility of separate overlays

---

## Version 2.19.5 (2026-01-01)

### New Features
- **Export Look View Video** option for recording the camera view
- Optional Retina resolution export for higher quality videos
- Select between Main View or Look View for video export

### Improvements
- Better check for pending video frames for more deterministic regression tests

### Bug Fixes
- Fixed jerky Gimbal video recording
- Fixed double numbers appearing in speed graph

---

## Version 2.19.4 (2026-01-01)

### Improvements
- Retrying space-track if recent TLEs fail to load, with progress indicator
- Admin validation of all saved sitches

---

## Version 2.19.3 (2025-12-29)

### New Features
- **Local NLU parsing** for common chatbot requests with fuzzy typo correction using Levenshtein distance
- Basic usage tracking for tiles and AI features

### Improvements
- More robust JSON parsing
- More secure example getUserIDCustom

### Bug Fixes
- Fixed sitch name validation issues

---

## Version 2.19.2 (2025-12-29)

### Improvements
- Removed unused vendor files and replaced with node modules
- Updated dependencies: jest 29.7.0 to 30.2.0, express 4.22.0 to 5.2.1, mathjs 14.6.0 to 15.1.0, three.js 0.181.2 to 0.182.0, webpack 5.101.3 to 5.104.1

### Bug Fixes
- Fixed GUI menus blocking keyboard input to the application

---

## Version 2.19.1 (2025-12-28)

### New Features
- **STANAG 4676 file importing** with correct camera and target tracks
- **MISB/KLV file support** improvements with CSV variant support

### Improvements
- Track file importing refactored for better multi-track support
- More robust getSitches handling for simultaneous requests
- Additional unit tests for file loading (KML, GeoJSON, SRT, STANAG)

### Bug Fixes
- Fixed "to-target" setting for multi-track imports

---

## Version 2.15.1 (2025-12-09)

### Improvements
- Removed right-click deletion of spline editor points to prevent accidental deletions
- Smoothing for synthetic tracks
- Expanded track time offset range to 600 seconds (10 minutes)

### Bug Fixes
- Fixed orientation controller for synthetic objects
- Fixed distorted MQ9 models at long distances from origin

---

## Version 2.15.0 (2025-12-08)

### New Features
- **Terrain transparency slider** for adjusting terrain opacity
- Configurable sources for Starlink and active satellite data

### Improvements
- More accurate raycasting for LLA positioning to prevent camera going underground
- Changed Draco web workers from CDN to local hosting for better server compatibility
- Restructured documentation with CSS styling for local HTML docs

---

## Version 2.14.2 (2025-12-08)

### New Features
- **Human Horizon controller** for GoFast analysis
- **Sky plot** for celestial view
- **Ephemeris view** with aligned columns
- **ACTIVE satellite source** from Celestrak
- **Export TLE button** for saving satellite data

### Improvements
- Better event calculations for celestial objects
- VIS/etc calculations for visual ephemeris

---

## Version 2.14.1 (2025-12-08)

### New Features
- Save and load terrain layers (e.g., for NRL WMTS)
- Handle serializing sitches with local folder .TS video files

### Bug Fixes
- Fixed various .TS file rehosting issues

---

## Version 2.14.0 (2025-12-03)

### New Features
- **XML STANAG 4676 file parsing** framework
- Basic XML position track loading
- KML track loading encapsulation

### Improvements
- Restructured track file import logic for more source formats
- Only set terrain material transparency when opacity < 1 to avoid render overhead

---

## Version 2.13.0 (2025-11-28)

### New Features
- **WebXR VR support** for desktop VR headsets via navigator.xr.isSessionSupported()

### Improvements
- Correctly snap to ground with keyboard shortcuts when position mode is AGL
- VR emulator excluded from production builds

### Bug Fixes
- Fixed background flow indicator on GoFast

---

## Version 2.12.0 (2025-11-25)

### Improvements
- S3 presigned multipart uploading support

---

## Version 2.11.0 (2025-11-17)

### New Features
- **Audio file support**: Play audio-only files (mp3, wav, ogg, flac, webm, aac, aif, m4a) with visualization
- **Elevation pseudo-color**: Map type showing elevation with color coding
- **Ridgeline inset** display option

### Improvements
- Support for changing playback framerate for audio
- Audio/video cleanup on dispose
- Support for iPhone .mov files with multiple audio streams

### Bug Fixes
- Fixed Ocean surface display in Elevation Pseudo-Color map type

---

## Version 2.10.0 (2025-11-12)

### New Features
- **FOV Editor**: Visual editor for field of view with max slider

### Improvements
- Additional video effects and convolution filters
- Improved track point editing widget
- Restored brightness/contrast controls to video view

### Bug Fixes
- Fixed issues with dragging a view while over its tab menu
- Fixed object tracker and pointer events
- Fixed synth track deletion

---

## Version 2.9.0 (2025-11-04)

### New Features
- **AR Mode**: Long press on compass to activate augmented reality mode on mobile devices

### Improvements
- Compass testbed improvements
- Ensure custom menus are on-screen when created

### Bug Fixes
- Fixed satellite menu visibility and showing/hiding track based on valid satellite names
- Fixed issue with saved rotation for buildings
- Fixed issue where neighboring points were not being moved in the horizontal plane when dragging a corner
- Fixed fiddly rotation handles
- Removed unused code for dragging roof vertices

---

## Version 2.8.0 (2025-11-02)

### New Features
- **Building editor**: Create and edit 3D buildings with rooflines
- **WASD controls** for camera movement
- **Feature labels**: 3D labels from CSV with arrows
- **Earth shadow display**: Show location of Earth's shadow at given altitude
- **Mobile support**: Pinch controls, touch camera controls, mobile file loading

### Improvements
- Double-click on menu tab to close
- Undo/redo support for building editor
- Better conforming buildings to ground elevation
- Adaptive frame rate for performance
- VB measure (renamed from AB measure)

### Bug Fixes
- Fixed flare region display
- Fixed satellite arrows cleanup with large time jumps
- Fixed planet brightness GUI error

---

## Version 2.7.0 (2025-10-11)

### New Features
- **Settings menu**: Added to Sitrec menu with terrain max details slider
- **LOS exporting**: Export Line of Sight data with uncertainty values
- **LOS viewer tool**: Standalone viewer for exported ENU LOS data

### Improvements
- Subdivision maps on by default
- Docker development environment improvements
- Terrain tile handling improvements with minZoom support
- Time offset for tracks (up to 30 seconds)
- Covering holes at poles with grey sphere

### Bug Fixes
- Fixed Docker volume mount issues
- Fixed race condition in map loading and cleanup

---

## Version 2.6.0 (2025-10-02)

### New Features
- **Context menus**: Right-click on planets, satellites, tracks, and ground for context-sensitive options
- **Aircraft model lights**: Strobing nav lights with configurable timing

### Improvements
- More robust MISB/KLV file parsing with better error handling
- Improved light timing for 737 model
- TS file validation and improved parsing
- Suppressing context menus when right-clicking on a menu

### Bug Fixes
- Fixed timing of short duration lights

---

## Version 2.5.0 (2025-09-08)

### Improvements
- **Build system updates**: Brought up to date for external builds
- Standalone server support for quick install tests
- Made chatbot install optional
- Moved custom URL functions into config.js

### Bug Fixes
- Fixed circular dependency checking for multiple runs
- Fixed keyboard shortcuts display

---

## Version 2.4.0 (2025-07-20)

### New Features
- **AI Assistant chatbot**: Natural language scene control with persistent chat history
- **Camera pointing via RA/Dec**: Look at static celestial objects like stars and constellations
- **Auto time zone detection** from client

### Improvements
- Dark and light themes for chat interface (defaults to dark)
- Better handling of time zones with +/- format
- Draggable chat window with close button

### Bug Fixes
- Fixed button presses and double clicks getting through chat window
- Fixed paragraphs in chat display

---

## Version 2.3.0 (2025-07-14)

### Improvements
- **IP-based geolocation**: More reliable than browser-based geolocation
- Improved startup experience for Starlink sitch

---

## Version 2.2.0 (2025-07-13)

### New Features
- **3D model lights**: Basic 3D lights with support for extracting lights from GLTF files
- **Time zone display** in UI elements

### Improvements
- Expanded flare band to better match actual reflections
- Non-Starlink satellites now displayed in bluish white

---

## Version 2.1.0 (2025-07-01)

### Improvements
- Better perceptual scaling of stars and satellites
- Track management with per-track smoothing controls
- Video time display now in top right corner
- Flow orb improvements
- Dynamic subdivision now a menu option
- Global object scale and sim speed up to 500
- Added "Show in look view" to Contents menu

### Bug Fixes
- Fixed point sprite scaling when viewport changes size
- Fixed camera up vector after dragging long distance
- Fixed speed graphs for sitches not near the origin
- Fixed aspect ratios on render targets
