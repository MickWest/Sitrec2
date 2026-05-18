const en = {
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "Selecting legacy sitches and tools\nSome legacy sitches have controls here by default",
            noTooltip: "No tooltip defined for this sitch",
            legacySitches: {
                label: "Legacy Sitches",
                tooltip: "The Legacy Sitches are older built-in (hard-coded) sitches are predefined situations that often have unique code and assets. Select one to load it.",
            },
            legacyTools: {
                label: "Legacy Tools",
                tooltip: "Tools are special sitches that are used for custom setups like Starlink or with user tracks, and for testing, debugging, or other special purposes. Select one to load it.",
            },
            selectPlaceholder: "-Select-",
        },
        file: {
            title: "File",
            tooltip: "File operations like saving,loading, and exporting",
        },
        view: {
            title: "View",
            tooltip: "Miscellaneous view controls\nLike all menus, this menu can be dragged off the menu bar to make it a floating menu",
        },
        video: {
            title: "Video",
            tooltip: "Video adjustment, effects, and analysis",
        },
        time: {
            title: "Time",
            tooltip: "Time and frame controls\nDragging one time slider past the end will affect the above slider\nNote that the time sliders are UTC",
        },
        objects: {
            title: "Objects",
            tooltip: "3D Objects and their properties\nEach folder is one object. The traverseObject is the object that traverses the lines of sight - i.e. the UAP we are interested in",
            addObject: {
                label: "Add Object",
                tooltip: "Create a new object at specified coordinates",
                prompt: "Enter: [Name] Lat Lon [Alt]\nExamples:\n  MyObject 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Landmark 37.7749 -122.4194",
                invalidInput: "Invalid input. Please enter coordinates in the format:\n[Name] Lat Lon [Alt]",
            },
        },
        satellites: {
            title: "Satellites",
            tooltip: "Loading and controlling satellites\nThe satellites.\nStarlink, ISS, etc. Controlls for Horizon flares and other satellite effects",
        },
        terrain: {
            title: "Terrain",
            tooltip: "Terrain controls\nThe terrain is the 3D model of the ground. The 'Map' is the 2D image of the ground. The 'Elevation' is the height of the ground above sea level",
        },
        physics: {
            title: "Physics",
            tooltip: "Physics controls\nThe physics of the situation, like wind speed and the physics of the traverse object",
        },
        camera: {
            title: "Camera",
            tooltip: "Camera controls for the look view camera\nThe look view defaults to the lower right window, and is intended to match the video.",
        },
        target: {
            title: "Target",
            tooltip: "Target controls\nPosition and properties of the optional target object",
        },
        traverse: {
            title: "Traverse",
            tooltip: "Traverse controls\nThe traverse object is the object that traverses the lines of sight - i.e. the UAP we are interested in\nThis menu defined how the traverse object moves and behaves",
        },
        showHide: {
            title: "Show/Hide",
            tooltip: "Showing or hiding views, object and other elements",
            views: {
                title: "Views",
                tooltip: "Show or hide views (windows) like the look view, the video, the main view, as well as overlays like the MQ9UI",
            },
            graphs: {
                title: "Graphs",
                tooltip: "Show or hide various graphs",
            },
        },
        effects: {
            title: "Effects",
            tooltip: "Special effects like blur, pixelation, and color adjustments that are applied to the final image in the look view",
        },
        lighting: {
            title: "Lighting",
            tooltip: "The lighting of the scene, like the sun and the ambient light",
        },
        contents: {
            title: "Contents",
            tooltip: "The contents of the scene, mostly used for tracks",
        },
        help: {
            title: "Help",
            tooltip: "Links to the documentation and other help resources",
            documentation: {
                title: "Documentation",
                localTooltip: "Links to the documentation (local)",
                githubTooltip: "Links to the documentation on Github",
                githubLinkLabel: "{{name}} (Github)",
                about: "About Sitrec",
                whatsNew: "What's New",
                uiBasics: "User Interface Basics",
                savingLoading: "Saving and Loading Sitches",
                customSitch: "How to set up a sitch",
                tracks: "Tracks and Data Sources",
                gis: "GIS and Mapping",
                starlink: "How to Investigate Starlink Flares",
                customModels: "Objects and 3D Models (Planes)",
                cameraModes: "Camera Modes (Normal & Satellite)",
                wind: "Wind",
                traverseMethods: "Traverse Methods",
                gimbalRecreate: "Recreating Gimbal Step-by-Step",
                thirdPartyNotices: "Third-Party Notices",
                thirdPartyNoticesTooltip: "Open-source license attributions for bundled third-party software",
                downloadBridge: "Download MCP Bridge",
                downloadBridgeTooltip: "Download the SitrecBridge MCP server + Chrome extension (zero dependencies, just needs Node.js)",
            },
            externalLinks: {
                title: "External Links",
                tooltip: "External help links",
            },
            exportDebugLog: {
                label: "Export Debug Log",
                tooltip: "Download all console output (log, warn, error) as a text file for debugging",
            },
        },
        debug: {
            title: "Debug",
            tooltip: "Debug tools and monitoring\nGPU memory usage, performance metrics, and other debugging information",
        },
    },
    file: {
        newSitch: {
            label: "New Sitch",
            tooltip: "Create a new sitch (will reload this page, resetting everything)",
        },
        savingDisabled: "Saving Disabled (click to log in)",
        importFile: {
            label: "Import File",
            tooltip: "Import a file (or files) from your local system. Same as dragging and dropping a file into the browser window",
        },
        server: {
            open: "Open",
            save: {
                label: "Save",
                tooltip: "Save the current sitch to the server",
            },
            saveAs: {
                label: "Save As",
                tooltip: "Save the current sitch to the server with a new name",
            },
            versions: {
                label: "Versions",
                tooltip: "Load a specific version of the currently selected sitch",
            },
            browseFeatured: "Browse featured sitches",
            browseAll: "Browse all your saved sitches in a searchable, sortable list",
        },
        local: {
            title: "Local",
            titleWithFolder: "Local: {{name}}",
            titleReconnect: "Local: {{name}} (reconnect)",
            status: "Status",
            noFileSelected: "No local file selected",
            noFolderSelected: "No folder selected",
            currentFile: "Current file: {{name}}",
            statusDesktop: "Current local desktop file/save state",
            statusFolder: "Current local folder/save state",
            stateReady: "Ready",
            stateReconnect: "Needs reconnect",
            stateNoFolder: "No folder",
            statusLine: "{{state}} | Folder: {{folder}} | Target: {{target}}",
            saveLocal: {
                label: "Save Local",
                tooltipDesktop: "Save to the current local file, or prompt for a filename if needed",
                tooltipFolder: "Save into the working folder (or prompts for a location if none is set)",
                tooltipSaveBack: "Save back to {{name}}",
                tooltipSaveBackInFolder: "Save back to {{name}} in {{folder}}",
                tooltipSaveInto: "Save into {{folder}} (prompts for sitch name)",
                tooltipPrompt: "Save a local sitch file (prompts for name/location)",
                tooltipSaveTo: "Save the current sitch to a local file",
            },
            saveLocalAs: {
                label: "Save Local As...",
                tooltipDesktop: "Save a local sitch file to a new path",
                tooltipFolder: "Save a local sitch file, choosing the location",
                tooltipInFolder: "Save with a new filename in the current working folder",
                tooltipNewPath: "Save the current sitch to a new local file path",
            },
            openLocal: {
                label: "Open Local Sitch",
                labelShort: "Open Local...",
                tooltipDesktop: "Open a local sitch file from disk",
                tooltipFolder: "Open a sitch file from the current working folder",
                tooltipCurrent: "Open a different local sitch file (current: {{name}})",
                tooltipFromFolder: "Open a sitch file from {{folder}}",
            },
            selectFolder: {
                label: "Select Local Sitch Folder",
                tooltip: "Select a working folder for local save/load operations",
            },
            reconnectFolder: {
                label: "Reconnect Folder",
                tooltip: "Re-grant access to the previously used working folder",
            },
        },
        debug: {
            recalculateAll: "debug recalculate all",
            dumpNodes: "debug dump nodes",
            dumpNodesBackwards: "debug dump nodes backwards",
            dumpRoots: "debug dump Root notes",
        },
    },
    videoExport: {
        notAvailable: "Video Export Not Available",
        folder: {
            title: "Video Render & Export",
            tooltip: "Options for rendering and exporting video files from Sitrec views or full viewport",
        },
        renderView: {
            label: "Render Video View",
            tooltip: "Select which view to export as video",
        },
        renderSingleVideo: {
            label: "Render Single View Video",
            tooltip: "Export the selected view as a video file with all frames",
        },
        videoFormat: {
            label: "Video Format",
            tooltip: "Select the output video format",
        },
        renderViewport: {
            label: "Render Viewport Video",
            tooltip: "Export the entire viewport as a video file with all frames",
        },
        renderFullscreen: {
            label: "Render Fullscreen Video",
            tooltip: "Export the entire viewport in fullscreen mode as a video file with all frames",
        },
        recordWindow: {
            label: "Record Browser Window",
            tooltip: "Record the entire browser window (including menus and UI) as a video with locked framerate",
        },
        retinaExport: {
            label: "Use HD/Retina Export",
            tooltip: "Export at retina/HiDPI resolution (2x on most displays)",
        },
        includeAudio: {
            label: "Include Audio",
            tooltip: "Include audio track from source video if available",
        },
        waitForLoading: {
            label: "Wait for background loading",
            tooltip: "When enabled, rendering waits for terrain/building/background loads before capturing each frame",
        },
        exportFrame: {
            label: "Export Video Frame",
            tooltip: "Export the current video frame as displayed (with effects) as a PNG file",
        },
    },
    tracking: {
        enable: {
            label: "Enable Auto Tracking",
            disableLabel: "Disable Auto Tracking",
            tooltip: "Toggle display of the auto tracking cursor on video",
        },
        start: {
            label: "Start Auto Tracking",
            stopLabel: "Stop Auto Tracking",
            tooltip: "Automatically track the object inside the cursor as video plays",
        },
        clearFromHere: {
            label: "Clear from Here",
            tooltip: "Clear all tracked positions from current frame to end",
        },
        clearTrack: {
            label: "Clear Track",
            tooltip: "Clear all auto-tracked positions and start fresh",
        },
        stabilize: {
            label: "Stabilize",
            tooltip: "Apply auto-tracked positions to stabilize the video",
        },
        stabilizeToggle: {
            enableLabel: "Enable Stabilization",
            disableLabel: "Disable Stabilization",
            tooltip: "Toggle video stabilization on/off",
        },
        stabilizeCenters: {
            label: "Stabilize Centers",
            tooltip: "When checked, the stabilized point is fixed at the center of the view. When unchecked, it stays at its initial position.",
        },
        renderStabilized: {
            label: "Render Stabilized Video",
            tooltip: "Export stabilized video at original size (tracked point stays fixed, edges may show black)",
        },
        renderStabilizedExpanded: {
            label: "Render Stabilized Expanded",
            tooltip: "Export stabilized video with expanded canvas so no pixels are lost",
        },
        trackRadius: {
            label: "Track Radius",
            tooltip: "Size of the template to match (object size)",
        },
        searchRadius: {
            label: "Search Radius",
            tooltip: "How far from previous position to search (increase for fast motion)",
        },
        trackingMethod: {
            label: "Tracking Method",
            tooltip: "Template Match (OpenCV) or Optical Flow (jsfeat Lucas-Kanade)",
        },
        centerOnBright: {
            label: "Center on Bright",
            tooltip: "Track centroid of bright pixels (better for stars/point lights)",
        },
        centerOnDark: {
            label: "Center on Dark",
            tooltip: "Track centroid of dark pixels",
        },
        brightnessThreshold: {
            label: "Brightness Threshold",
            tooltip: "Brightness threshold (0-255). Used in Center on Bright/Dark modes",
        },
        trackingColor: {
            label: "Tracking Color",
            tooltip: "Target color for Center on Color mode. Pixels within Color Distance of this color contribute to the centroid",
        },
        colorDistance: {
            label: "Color Distance",
            tooltip: "Max RGB Euclidean distance (0-442) a pixel may be from Tracking Color and still contribute. Used in Center on Color mode",
        },
        status: {
            loadingJsfeat: "Loading jsfeat...",
            loadingOpenCv: "Loading OpenCV...",
            sam2Connecting: "SAM2: Connecting...",
            sam2Uploading: "SAM2: Uploading...",
        },
    },
    trackManager: {
        removeTrack: "Remove Track",
        createSpline: "Create Spline",
        editTrack: "Edit Track",
        constantSpeed: "Constant Speed",
        extrapolateTrack: "Extrapolate Track",
        curveType: "Curve Type",
        altLockAGL: "Alt Lock AGL",
        deleteTrack: "Delete Track",
    },
    gpuMonitor: {
        enabled: "Monitor Enabled",
        total: "Total Memory",
        geometries: "Geometries",
        textures: "Textures",
        peak: "Peak Memory",
        average: "Average Memory",
        reset: "Reset History",
    },
    situationSetup: {
        mainFov: {
            label: "Main FOV",
            tooltip: "Field of View of the main view's camera (VERTICAL)",
        },
        lookCameraFov: "Look Camera FOV",
        azimuth: "azimuth",
        jetPitch: "Jet Pitch",
    },
    featureManager: {
        labelText: "Label Text",
        latitude: "Latitude",
        longitude: "Longitude",
        altitude: "Altitude (m)",
        arrowLength: "Arrow Length",
        arrowColor: "Arrow Color",
        textColor: "Text Color",
        deleteFeature: "Delete Feature",
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "Export Look Panorama",
            tooltip: "Create a panorama image from lookView across all frames based on background position",
        },
    },
    dateTime: {
        liveMode: {
            label: "Live Mode",
            tooltip: "If Live Mode is on, then the playback will always be synced to the current time.\nPausing or scrubbing the time will disable live mode",
        },
        startTime: {
            tooltip: "The START time of first frame of the video, in UTC format",
        },
        currentTime: {
            tooltip: "The CURRENT time of the video. This is what the below date and time refer to",
        },
        year: { label: "Year", tooltip: "Year of the current frame" },
        month: { label: "Month", tooltip: "Month (1-12)" },
        day: { label: "Day", tooltip: "Day of month" },
        hour: { label: "Hour", tooltip: "Hour (0-23)" },
        minute: { label: "Minute", tooltip: "Minute (0-59)" },
        second: { label: "Second", tooltip: "Second (0-59)" },
        millisecond: { label: "ms", tooltip: "Millisecond (0-999)" },
        useTimeZone: {
            label: "Use Time Zone in UI",
            tooltip: "Use the time zone in the UI above\nThis will change the date and time to be in the selected time zone, rather than UTC.\nThis is useful for displaying the date and time in a specific time zone, such as the local time zone of the video or the location.",
        },
        timeZone: {
            label: "Time Zone",
            tooltip: "The time zone to display the date and time in in the look view\nAlso in the UI if the 'Use Time Zone in UI' is checked",
        },
        simSpeed: {
            label: "Simulation Speed",
            tooltip: "The speed of the simulation, 1 is real time, 2 is twice as fast, etc\nThis does not change the video replay speed, just the time calculations for the simulation.",
        },
        sitchFrames: {
            label: "Sitch Frames",
            tooltip: "The number of frames in the sitch. If there's a video then this will be the number of frames in the video, but you can change it if you want to add more frames to the sitch, or if you want to use the sitch without a video",
        },
        sitchDuration: {
            label: "Sitch Duration",
            tooltip: "Duration of the sitch in HH:MM:SS.sss format",
        },
        aFrame: {
            label: "A Frame",
            tooltip: "limited the playback to between A and B, displayed as green and red on the frame slider",
        },
        bFrame: {
            label: "B Frame",
            tooltip: "limited the playback to between A and B, displayed as green and red on the frame slider",
        },
        videoFps: {
            label: "Video FPS",
            tooltip: "The frames per second of the video. This will change the playback speed of the video (e.g. 30 fps, 25 fps, etc). It will also change the duration of the sitch (in secods) as it changes how long an individual frame is\n This is derived from the video were possible, but you can change it if you want to speed up or slow down the video",
        },
        syncTimeTo: {
            label: "Sync Time to",
            tooltip: "Sync the video start time to the original start time, the current time, or the start time of a track track (if loaded)",
        },
    },
    jet: {
        frames: {
            time: {
                label: "Time (sec)",
                tooltip: "Current time from the start of the video in seconds (frame / fps)",
            },
            frame: {
                label: "Frame in Video",
                tooltip: "Current frame number in the video",
            },
            paused: {
                label: "Paused",
                tooltip: "Toggle the paused state (also spacebar)",
            },
        },
        controls: {
            pingPong: "A-B Ping-Pong",
            podPitchPhysical: "Pod (Ball) Pitch",
            podRollPhysical: "Pod Head Roll",
            deroFromGlare: "Derotation = Glare Angle",
            jetPitch: "Jet Pitch",
            lookFov: "Narrow FOV",
            elevation: "elevation",
            glareStartAngle: "Glare Start Angle",
            initialGlareRotation: "Glare Initial Rotation",
            scaleJetPitch: "Scale Jet Pitch with Roll",
            horizonMethod: "Horizon Method",
            horizonMethodOptions: {
                humanHorizon: "Human Horizon",
                horizonAngle: "Horizon Angle",
            },
            videoSpeed: "Video Speed",
            podWireframe: "[B]ack Pod Wireframe",
            showVideo: "[V]ideo",
            showGraph: "[G]raph",
            showKeyboardShortcuts: "[K]eyboard Shortcuts",
            showPodHead: "[P]od Head Roll",
            showPodsEye: "Pod's [E]ye views w' dero",
            showLookCam: "[N]AR view w' dero",
            showCueData: "[C]ue Data",
            showGlareGraph: "Sh[o]w Glare Graph",
            showAzGraph: "Show A[Z] Graph",
            declutter: "[D]eclutter]",
            jetOffset: "Jet Y offset",
            tas: "TAS True Airspeed",
            integrate: "Integration Steps",
        },
    },
    motionAnalysis: {
        menu: {
            title: "Motion Analysis",
            analyzeMotion: {
                label: "Analyze Motion",
                tooltip: "Toggle real-time motion analysis overlay on video",
            },
            createTrack: {
                label: "Create Track from Motion",
                tooltip: "Analyze all frames and create a ground track from motion vectors",
            },
            exportMotion: {
                label: "Export Motion",
                tooltip: "Export per-frame motion as CSV (frame, angle, magnitude, time, UTC)",
            },
            alignWithFlow: {
                label: "Align with Flow",
                tooltip: "Rotate image so motion direction is horizontal",
            },
            panorama: {
                title: "Panorama",
                exportImage: {
                    label: "Export Motion Panorama",
                    tooltip: "Create a panorama image from video frames using motion tracking offsets",
                },
                exportVideo: {
                    label: "Export Pano Video",
                    tooltip: "Create a 4K video showing the panorama with video frame overlay",
                },
                stabilize: {
                    label: "Stabilize Video",
                    disableLabel: "Disable Stabilization",
                    tooltip: "Stabilize video using global motion analysis (removes camera shake)",
                },
                panoFrameStep: {
                    label: "Pano Frame Step",
                    tooltip: "How many frames to step between each panorama frame (1 = every frame)",
                },
                crop: {
                    label: "Panorama Crop",
                    tooltip: "Pixels to crop from each edge of video frames",
                },
                useMask: {
                    label: "Use Mask in Pano",
                    tooltip: "Apply motion tracking mask as transparency when rendering panorama",
                },
                analyzeWithEffects: {
                    label: "Analyze With Effects",
                    tooltip: "Apply video adjustments (contrast, etc.) to frames used for motion analysis",
                },
                exportWithEffects: {
                    label: "Export With Effects",
                    tooltip: "Apply video adjustments to panorama exports",
                },
                removeOuterBlack: {
                    label: "Remove Outer Black",
                    tooltip: "Make black pixels at the edges of each row transparent",
                },
            },
            trackingParameters: {
                title: "Tracking Parameters",
                technique: {
                    label: "Technique",
                    tooltip: "Motion estimation algorithm",
                },
                frameSkip: {
                    label: "Frame Skip",
                    tooltip: "Frames between comparisons (higher = detect slower motion)",
                },
                trackletLength: {
                    label: "Tracklet Length",
                    tooltip: "Number of frames in tracklet (longer = stricter coherence)",
                },
                blurSize: {
                    label: "Blur Size",
                    tooltip: "Gaussian blur for macro features (odd numbers)",
                },
                minMotion: {
                    label: "Min Motion",
                    tooltip: "Minimum motion magnitude (pixels/frame)",
                },
                maxMotion: {
                    label: "Max Motion",
                    tooltip: "Maximum motion magnitude",
                },
                smoothing: {
                    label: "Smoothing",
                    tooltip: "Direction smoothing (higher = more smoothing)",
                },
                minVectorCount: {
                    label: "Min Vector Count",
                    tooltip: "Minimum number of motion vectors for a valid frame",
                },
                minConfidence: {
                    label: "Min Confidence",
                    tooltip: "Minimum consensus confidence for a valid frame",
                },
                maxFeatures: {
                    label: "Max Features",
                    tooltip: "Maximum tracked features",
                },
                minDistance: {
                    label: "Min Distance",
                    tooltip: "Minimum distance between features",
                },
                qualityLevel: {
                    label: "Quality Level",
                    tooltip: "Feature detection quality threshold",
                },
                maxTrackError: {
                    label: "Max Track Error",
                    tooltip: "Maximum tracking error threshold",
                },
                minQuality: {
                    label: "Min Quality",
                    tooltip: "Minimum quality to display arrow",
                },
                staticThreshold: {
                    label: "Static Threshold",
                    tooltip: "Motion below this is considered static (HUD)",
                },
            },
        },
        status: {
            loadingOpenCv: "Loading OpenCV...",
            stopAnalysis: "Stop Analysis",
            analyzingPercent: "Analyzing... {{pct}}%",
            creatingTrack: "Creating track...",
            buildingPanorama: "Building panorama...",
            buildingPanoramaPercent: "Building panorama... {{pct}}%",
            loadingFrame: "Loading frame {{frame}}... ({{current}}/{{total}})",
            loadingFrameSkipped: "Loading frame {{frame}}... ({{current}}/{{total}}) ({{skipped}} skipped)",
            renderingPercent: "Rendering... {{pct}}%",
            panoPercent: "Pano... {{pct}}%",
            renderingVideo: "Rendering video...",
            videoPercent: "Video... {{pct}}%",
            saving: "Saving...",
            buildingStabilization: "Building stabilization...",
            exportProgressTitle: "Exporting pano video...",
        },
        errors: {
            noVideoView: "No video view found.",
            noVideoData: "No video data found.",
            failedToLoadOpenCv: "Failed to load OpenCV: {{message}}",
            noOriginTrack: "No origin track found. Need a target or camera track to determine start position.",
            videoEncodingUnsupported: "Video encoding not supported in this browser",
            exportFailed: "Video export failed: {{reason}}",
            panoVideoExportFailed: "Pano video export failed: {{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[BETA] Text Extraction",
            enable: {
                label: "Enable Text Extraction",
                disableLabel: "Disable Text Extraction",
                tooltip: "Toggle text extraction mode on video",
            },
            addRegion: {
                label: "Add Region",
                drawingLabel: "Click and drag on video...",
                tooltip: "Click and drag on video to define a text extraction region",
            },
            removeRegion: {
                label: "Remove Selected Region",
                tooltip: "Remove the currently selected region",
            },
            clearRegions: {
                label: "Clear All Regions",
                tooltip: "Remove all text extraction regions",
            },
            startExtract: {
                label: "Start Extract",
                stopLabel: "Stop Extraction",
                tooltip: "Run OCR on all regions from current frame to end",
            },
            fixedWidthFont: {
                label: "Fixed Width Font",
                tooltip: "Enable character-by-character detection for fixed-width fonts (better for FLIR/sensor overlays)",
            },
            numChars: {
                label: "Num Characters",
                tooltip: "Number of characters in the selected region (divides region evenly)",
            },
            learnTemplates: {
                label: "Learn Templates",
                activeLabel: "Click characters to learn...",
                tooltip: "Click character cells to teach their values (for template matching)",
            },
            clearTemplates: {
                label: "Clear Templates",
                tooltip: "Remove all learned character templates",
            },
            useTemplates: {
                label: "Use Templates",
                tooltip: "Use learned templates for matching (faster & more accurate when trained)",
            },
        },
        prompts: {
            learnCharacter: "Enter character for cell {{index}}:",
        },
        errors: {
            failedToLoadTesseract: "Failed to load Tesseract.js. Make sure it's installed: npm install tesseract.js",
            noVideoView: "Text extraction requires a video view",
        },
    },
    custom: {
        settings: {
            title: "Settings",
            tooltipLoggedIn: "Per-user settings saved to server (with cookie backup)",
            tooltipAnonymous: "Per-user settings saved in browser cookies",
            language: { label: "Language", tooltip: "Select interface language. Changing this reloads the page. You will lose any unsaved work, so save first!" },
            maxDetails: { label: "Max Details", tooltip: "Maximum level of detail for terrain subdivision (5-30)" },
            fpsLimit: { label: "Frame Rate Limit", tooltip: "Set maximum frame rate (60, 30, 20, or 15 fps)" },
            tileSegments: { label: "Tile Segments", tooltip: "Mesh resolution for terrain tiles. Higher values = more detail but slower" },
            maxResolution: { label: "Max Resolution", tooltip: "Maximum video frame resolution (longer side). Reduces GPU memory usage. Applies to newly loaded frames." },
            renderScale: { label: "Render Scale", tooltip: "Scales the offscreen render resolution. 50% renders 1/4 of the pixels - the single biggest perf knob on hi-DPI laptops. Lower = faster but blurrier." },
            msaaSamples: { label: "Antialiasing (MSAA)", tooltip: "Multisample antialiasing on the 3D viewport. Off = fastest, removes the multisample resolve pass. Higher = smoother edges but slower." },
            performancePreset: { label: "Performance Preset", tooltip: "One-click performance presets. Quality = native res + 4x MSAA. Fast/Potato cut render scale, MSAA, terrain detail and fps cap for low-spec laptops. Switches to Custom when you tweak any sub-setting." },
            aiModel: { label: "AI Model", tooltip: "Select the AI model for the chat assistant" },
            centerSidebar: { label: "Center Sidebar", tooltip: "Enable center sidebar between split views (drag menus to the divider line)" },
            showAttribution: { label: "Show Attribution", tooltip: "Show map and elevation data source attribution overlay" },
        },
        balloons: {
            count: { label: "Count", tooltip: "Number of nearby stations to import" },
            source: { label: "Source", tooltip: "uwyo = University of Wyoming (needs PHP proxy)\nigra2 = NOAA NCEI archive (direct download)" },
            getNearby: { label: "Get Nearby Weather Balloons", tooltip: "Import the N closest weather balloon soundings to the current camera position.\nUses the most recent launch before the sitch start time + 1 hour." },
            importSounding: { label: "Import Sounding...", tooltip: "Manual station picker: choose station, date, source, and import a specific sounding." },
        },
        showHide: {
            keyboardShortcuts: { label: "[K]eyboard Shortcuts", tooltip: "Show or hide the keyboard shortcuts overlay" },
            toggleExtendToGround: { label: "Toggle ALL [E]xtend To Ground", tooltip: "Toggle 'Extend to Ground' for all tracks\nWill set all off if any are on\nWill set all on if none are on" },
            showAllTracksInLook: { label: "Show All Tracks in Look View", tooltip: "Display all aircraft tracks in the look/camera view" },
            showCompassElevation: { label: "Show Compass Elevation", tooltip: "Show compass elevation (angle above the local ground plane) in addition to bearing (azimuth)" },
            filterTracks: { label: "Filter Tracks", tooltip: "Show/hide tracks based on altitude, direction, or frustum intersection" },
            removeAllTracks: { label: "Remove All Tracks", tooltip: "Remove all tracks from the scene\nThis will not remove the objects, just the tracks\nYou can add them back later by dragging and dropping the files again" },
            addTrackFromCameraLOS: { label: "Track from Camera LOS", tooltip: "Create a two-point synthetic track along the current camera's line of sight.\nFirst point is at the camera, second point is where the LOS hits the ground,\nor 300 miles along the LOS if it does not hit the ground." },
        },
        objects: {
            globalScale: { label: "Global Scale", tooltip: "Scale factor applied to all 3D objects in the scene - useful for finding things. Set back to 1 for real size" },
            removeAllBuildings: { label: "Remove all Buildings", tooltip: "Delete every synthetic building from the scene.\nClouds and ground overlays are not affected." },
        },
        admin: {
            dashboard: { label: "Admin Dashboard", tooltip: "Open the admin dashboard" },
            validateAllSitches: { label: "Validate All Sitches", tooltip: "Load all saved sitches with local terrain to check for errors" },
            testUserID: { label: "Test User ID", tooltip: "Operate as this user ID (0 = disabled, must be > 1)" },
            addMissingScreenshots: { label: "Add Missing Screenshots", tooltip: "Load each sitch that has no screenshot, render it, and upload a screenshot" },
            feature: { label: "Feature", tooltip: "Toggle Featured status for the currently loaded sitch" },
        },
        viewPreset: { label: "View Preset", tooltip: "Switch between different view presets\nSide-by-side, Top and Bottom, etc." },
        subSitches: {
            folder: { tooltip: "Manage multiple camera/view configurations within this sitch" },
            updateCurrent: { label: "Update Current Sub", tooltip: "Update the currently selected Sub Sitch with the current view settings" },
            updateAndAddNew: { label: "Update Current and Add New Sub", tooltip: "Update current Sub Sitch, then duplicate it into a new Sub Sitch" },
            discardAndAddNew: { label: "Discard Changes and Add New", tooltip: "Discard changes to current Sub Sitch, and invoke a new Sub Sitch from current state" },
            renameCurrent: { label: "Rename Current Sub", tooltip: "Rename the currently selected Sub Sitch" },
            deleteCurrent: { label: "Delete Current Sub", tooltip: "Delete the currently selected Sub Sitch" },
            syncSaveDetails: { label: "Sync Sub Save Details", tooltip: "Remove from current sub any nodes not enabled in Sub Saving Details" },
        },
        contextMenu: {
            setCameraAbove: "Set Camera Above",
            setCameraOnGround: "Set Camera on Ground",
            setTargetAbove: "Set Target Above",
            setTargetOnGround: "Set Target on Ground",
            dropPin: "Drop Pin / Add Feature",
            createTrackWithObject: "Create Track with Object",
            createTrackNoObject: "Create Track (No Object)",
            addBuilding: "Add Building",
            addClouds: "Add Clouds",
            addGroundOverlay: "Add Ground Overlay",
            centerTerrain: "Center Terrain square here",
            googleMapsHere: "Google Maps Here",
            googleEarthHere: "Google Earth Here",
            removeClosestPoint: "Remove Closest Point",
            exitEditMode: "Exit Edit Mode",
        },
    },
    view3d: {
        northUp: { label: "Look View North Up", tooltip: "Set the look view to be north up, instead of world up.\nfor Satellite views and similar, looking straight down.\nDoes not apply in PTZ mode" },
        atmosphere: { label: "Atmosphere", tooltip: "Distance attenuation that blends terrain and 3D objects toward the current sky color" },
        atmoVisibility: { label: "Atmo Visibility (km)", tooltip: "Distance where atmospheric contrast drops to about 50% (smaller = thicker atmosphere)" },
        atmoHDR: { label: "Atmo HDR", tooltip: "Physically-based HDR fog/tone mapping for bright sun reflections through haze" },
        atmoExposure: { label: "Atmo Exposure", tooltip: "HDR atmosphere tone-mapping exposure multiplier for highlight rolloff" },
        startXR: { label: "Start VR/XR", tooltip: "Start WebXR session for testing (works with Immersive Web Emulator)" },
        effects: { label: "Effects", tooltip: "Enable/Disable All Effects" },
        focusTrack: { label: "Focus Track", tooltip: "Select a track to make the camera look at it and rotate around it" },
        lockTrack: { label: "Lock Track", tooltip: "Select a track to lock the camera to it, so it moves with the track" },
        debug: {
            clearBackground: "Clear Background", renderSky: "Render Sky", renderDaySky: "Render Day Sky",
            renderMainScene: "Render Main Scene", renderEffects: "Render Effects", copyToScreen: "Copy To Screen",
            updateCameraMatrices: "Update Camera Matrices", mainUseLookLayers: "Main Use Look Layers",
            sRGBOutputEncoding: "sRGB Output Encoding", tileLoadDelay: "Tile Load Delay (s)",
            updateStarScales: "Update Star Scales", updateSatelliteScales: "Update Satellite Scales",
            renderNightSky: "Render Night Sky", renderFullscreenQuad: "Render Fullscreen Quad", renderSunSky: "Render Sun Sky",
        },
        celestial: {
            raHours: "RA (hours)", decDegrees: "Dec (degrees)", magnitude: "Magnitude",
            noradNumber: "NORAD Number", name: "Name",
        },
    },
    nightSky: {
        loadLEO: { label: "Load LEO Satellites For Date", tooltip: "Get the latest LEO Satellite TLE data for the set simulator date/time. This will download the data from the internet, so it may take a few seconds.\nWill also enable the satellites to be displayed in the night sky." },
        loadStarlink: { label: "Load CURRENT Starlink", tooltip: "Get the CURRENT (not historical, now, real time) Starlink satellite positions. This will download the data from the internet, so it may take a few seconds.\n" },
        loadActive: { label: "Load ACTIVE Satellites", tooltip: "Get the CURRENT (not historical, now, real time) ACTIVE satellite positions. This will download the data from the internet, so it may take a few seconds.\n" },
        loadSlow: { label: "(Experimental) Load SLOW Satellites", tooltip: "Get the latest SLOW Satellite TLE data for the set simulator date/time. This will download the data from the internet, so it may take a few seconds.\nWill also enable the satellites to be displayed in the night sky. Might time-out for recent dates" },
        loadAll: { label: "(Experimental) Load ALL Satellites", tooltip: "Get the latest Satellite TLE data for ALL the satellites for the set simulator date/time. This will download the data from the internet, so it may take a few seconds.\nWill also enable the satellites to be displayed in the night sky. Might time-out for recent dates" },
        flareAngle: { label: "Flare Angle Spread", tooltip: "Maximum angle of the reflected view vector for a flare to be visible\ni.e. the range of angles between the vector from the satellite to the sun and the vector from the camera to the satellite reflected off the bottom of the satellite (which is parallel to the ground)" },
        flareModel: { label: "Flare Model", tooltip: "How the satellite 'down' direction is calculated for the reflecting surface normal.\nGeocentric Nadir: vector from Earth center to satellite (standard LVLH convention used in attitude control)\nGeodetic Nadir: perpendicular to WGS84 ellipsoid (used by Earth-observation satellites for precision pointing)\nMax difference ~0.18° at 45° latitude" },
        penumbraDepth: { label: "Earth's Penumbra Depth", tooltip: "Vertical depth in meters over which a satellite fades out as it enters the Earth's shadow" },
        sunAngleArrows: { label: "Sun Angle Arrows", tooltip: "When glare is detected, show arrows from camera to satellite, and then satellite to sun" },
        celestialFolder: { tooltip: "night sky related things" },
        vectorsOnTraverse: { label: "Vectors On Traverse", tooltip: "If checked, the vectors are shown relative to the traverse object. Otherwise they are shown relative to the look camera." },
        vectorsInLookView: { label: "Vectors in Look View", tooltip: "If checked, the vectors are shown in the Look View Otherwise just the main view." },
        showSatellitesGlobal: { label: "Show Satellites (Global)", tooltip: "Master toggle: show or hide all satellites" },
        showStarlink: { label: "Starlink", tooltip: "Show SpaceX Starlink satellites" },
        showISS: { label: "ISS", tooltip: "Show the International Space Station" },
        celestrackBrightest: { label: "Celestrack's Brightest", tooltip: "Show Celestrack's list of brightest satellites" },
        otherSatellites: { label: "Other Satellites", tooltip: "Show satellites not in the above categories" },
        list: { label: "List", tooltip: "Show a text list of visible satellites" },
        satelliteArrows: { label: "Satellite Arrows", tooltip: "Show arrows indicating satellite trajectories" },
        flareLines: { label: "Flare Lines", tooltip: "Show lines connecting flaring satellites to the camera and the Sun" },
        satelliteGroundArrows: { label: "Satellite Ground Arrows", tooltip: "Show arrows to the ground below each satellite" },
        satelliteLabelsLook: { label: "Satellite Labels (Look View)", tooltip: "Show satellite name labels in the look/camera view" },
        satelliteLabelsMain: { label: "Satellite Labels (Main View)", tooltip: "Show satellite name labels in the main 3D view" },
        labelFlaresOnly: { label: "Label Flares Only", tooltip: "Only label satellites that are currently flaring" },
        labelLitOnly: { label: "Label Lit Only", tooltip: "Only label satellites that are sunlit (not in Earth's shadow)" },
        labelLookVisibleOnly: { label: "Label Look Visible Only", tooltip: "Only label satellites visible in the look view camera frustum" },
        flareRegion: { label: "Flare Region", tooltip: "Show the sky region where satellite flares are visible" },
        flareBand: { label: "Flare Band", tooltip: "Show the band on the ground where flares from a satellite track sweep" },
        filterTLEs: { label: "Filter TLEs", tooltip: "Filter visible satellites by altitude, position, orbital parameters, or name" },
        clearTLEFilter: { label: "Clear TLE Filter", tooltip: "Remove all TLE spatial/orbital filters, restoring category-based visibility" },
        maxLabelsDisplayed: { label: "Max Labels Displayed", tooltip: "Maximum number of satellite labels to render at once" },
        starBrightness: { label: "Star Brightness", tooltip: "Scale factor for the brightness of the stars. 1 is normal, 0 is invisible, 2 is twice as bright, etc." },
        starLimit: { label: "Star Limit", tooltip: "Brightness limit for stars to be displayed" },
        planetBrightness: { label: "Planet Brightness", tooltip: "Scale factor for the brightness of the planets (except Sun and Moon). 1 is normal, 0 is invisible, 2 is twice as bright, etc." },
        lockStarPlanetBrightness: { label: "Lock Star Planet Brightness", tooltip: "When checked, the Star Brightness and Planet Brightness sliders are locked together" },
        satBrightness: { label: "Sat Brightness", tooltip: "Scale factor for the brightness of the satellites. 1 is normal, 0 is invisible, 2 is twice as bright, etc." },
        flareBrightness: { label: "Flare Brightness", tooltip: "Scale factor for the additional brightness of flaring satellites. 0 is nothing" },
        satCutOff: { label: "Sat Cut-Off", tooltip: "Satellites dimmed to this level or less will not be displayed" },
        displayRange: { label: "Display Range (km)", tooltip: "Satellites beyond this distance will not have their names or arrows displayed" },
        equatorialGrid: { label: "Equatorial Grid", tooltip: "Show the celestial equatorial coordinate grid" },
        constellationLines: { label: "Constellation Lines", tooltip: "Show lines connecting stars in constellations" },
        constellationStyle: {
            label: "Asterism Style",
            tooltip: "Which set of stick-figure lines to draw between stars",
            optionD3: "d3-celestial (default)",
            optionAstrometry: "Astrometry.net",
        },
        renderStars: { label: "Render Stars", tooltip: "Show stars in the night sky" },
        equatorialGridLook: { label: "Equatorial Grid in Look View", tooltip: "Show the equatorial grid in the look/camera view" },
        flareRegionLook: { label: "Flare Region in Look View", tooltip: "Show the flare region cone in the look camera view" },
        satelliteEphemeris: { label: "Satellite Ephemeris" },
        skyPlot: { label: "Sky Plot" },
        celestialVector: { label: "{{name}} Vector", tooltip: "Show a direction vector pointing toward {{name}}" },
    },
    synthClouds: {
        name: { label: "Name" },
        visible: { label: "Visible" },
        editMode: { label: "Edit Mode" },
        altitude: { label: "Altitude" },
        radius: { label: "Radius" },
        cloudSize: { label: "Cloud Size" },
        density: { label: "Density" },
        opacity: { label: "Opacity" },
        brightness: { label: "Brightness" },
        depth: { label: "Depth" },
        edgeWiggle: { label: "Edge Wiggle" },
        edgeFrequency: { label: "Edge Frequency" },
        seed: { label: "Seed" },
        feather: { label: "Feather" },
        windMode: { label: "Wind Mode" },
        windFrom: { label: "Wind From (\u00b0)" },
        windKnots: { label: "Wind (knots)" },
        deleteClouds: { label: "Delete Clouds" },
    },
    synthBuilding: {
        name: { label: "Name" },
        visible: { label: "Visible" },
        editMode: { label: "Edit Mode" },
        roofEdgeHeight: { label: "Roof Edge Height" },
        ridgelineHeight: { label: "Ridgeline Height" },
        ridgelineInset: { label: "Ridgeline Inset" },
        roofEaves: { label: "Roof Eaves" },
        type: { label: "Type" },
        wallColor: { label: "Wall Color" },
        roofColor: { label: "Roof Color" },
        opacity: { label: "Opacity" },
        transparent: { label: "Transparent" },
        wireframe: { label: "Wireframe" },
        depthTest: { label: "Depth Test" },
        deleteBuilding: { label: "Delete Building" },
    },

    groundOverlay: {
        name: { label: "Name" },
        visible: { label: "Visible" },
        editMode: { label: "Edit Mode" },
        lockShape: { label: "Lock Shape" },
        freeTransform: { label: "Free Transform" },
        showBorder: { label: "Show Border" },
        properties: { label: "Properties" },
        imageURL: { label: "Image URL" },
        rehostLocalImage: { label: "Rehost Local Image" },
        north: { label: "North" },
        south: { label: "South" },
        east: { label: "East" },
        west: { label: "West" },
        rotation: { label: "Rotation" },
        altitude: { label: "Altitude (ft)" },
        wireframe: { label: "Wireframe" },
        opacity: { label: "Opacity" },
        cloudExtraction: { label: "Cloud Extraction" },
        extractClouds: { label: "Extract Clouds" },
        cloudColor: { label: "Cloud Color" },
        fuzziness: { label: "Fuzziness" },
        feather: { label: "Feather" },
        gotoOverlay: { label: "Go to Overlay" },
        deleteOverlay: { label: "Delete Overlay" },
    },

    videoView: {
        folders: {
            videoAdjustments: "Video Adjustments",
            videoProcessing: "Video Processing",
            forensics: "Forensics",
            errorLevelAnalysis: "Error Level Analysis",
            noiseAnalysis: "Noise Analysis",
            grid: "Grid",
        },
        currentVideo: { label: "Current Video" },
        videoRotation: { label: "Video Rotation" },
        setCameraToExifGps: { label: "Set Camera To EXIF GPS" },
        expandOutput: {
            label: "Expand Output",
            tooltip: "Method to expand the ELA output dynamic range",
        },
        displayMode: {
            label: "Display Mode",
            tooltip: "How to visualize the noise analysis results",
        },
        convolutionFilter: {
            label: "Convolution Filter",
            tooltip: "Spatial convolution filter type to apply",
        },
        resetVideoAdjustments: {
            label: "Reset Video Adjustments",
            tooltip: "Reset all video adjustments to their default values",
        },
        makeVideo: {
            label: "Make Video",
            tooltip: "Export the processed video with all current effects applied",
        },
        gridShow: {
            label: "Show",
            tooltip: "Show a grid overlay on the video",
        },
        gridSize: {
            label: "Size",
            tooltip: "Grid cell size in pixels",
        },
        gridSubdivisions: {
            label: "Subdivisions",
            tooltip: "Number of subdivisions within each grid cell",
        },
        gridXOffset: {
            label: "X Offset",
            tooltip: "Horizontal offset of the grid in pixels",
        },
        gridYOffset: {
            label: "Y Offset",
            tooltip: "Vertical offset of the grid in pixels",
        },
        gridColor: {
            label: "Color",
            tooltip: "Color of the grid lines",
        },
    },

    floodSim: {
        flood: {
            label: "Flood",
            tooltip: "Enable or disable the flood particle simulation",
        },
        floodRate: {
            label: "Flood Rate",
            tooltip: "Number of particles spawned per frame",
        },
        sphereSize: {
            label: "Sphere Size",
            tooltip: "Visual radius of each water particle",
        },
        dropRadius: {
            label: "Drop Radius",
            tooltip: "Radius around the drop point where particles spawn",
        },
        maxParticles: {
            label: "Max Particles",
            tooltip: "Maximum number of active water particles",
        },
        method: {
            label: "Method",
            tooltip: "Simulation method: HeightMap (grid), Fast (particles), or PBF (position-based fluids)",
        },
        waterSource: {
            label: "Water Source",
            tooltip: "Rain: add water over time. DamBurst: maintain water level at target altitude within drop radius",
        },
        speed: {
            label: "Speed",
            tooltip: "Simulation steps per frame (1-20x)",
        },
        manningN: {
            label: "Manning's N",
            tooltip: "Bed roughness: 0.01=smooth, 0.03=natural channel, 0.05=rough floodplain, 0.1=dense vegetation",
        },
        edge: {
            label: "Edge",
            tooltip: "Blocking: water reflects at grid edges. Draining: water flows out and is removed",
        },
        waterColor: {
            label: "Water Color",
            tooltip: "Color of the water",
        },
        reset: {
            label: "Reset",
            tooltip: "Remove all particles and restart the simulation",
        },
    },

    flowOrbs: {
        number: {
            label: "Number",
            tooltip: "Number of flow orbs to display. More orbs may impact performance.",
        },
        spreadMethod: {
            label: "Spread Method",
            tooltip: "Method to spread orbs along the camera look vector. \n'Range' spreads orbs evenly along the look vector between near and far distances. \n'Altitude' spreads orbs evenly along the look vector, between the low and high absolute altitudes (MSL)",
        },
        near: {
            label: "Near (m)",
            tooltip: "Nearest distance from camera for orb placement",
        },
        far: {
            label: "Far (m)",
            tooltip: "Farthest distance from camera for orb placement",
        },
        high: { label: "High (m)" },
        low: { label: "Low (m)" },
        colorMethod: {
            label: "Color Method",
            tooltip: "Method to determine the color of the flow orbs. \n'Random' assigns a random color to each orb. \n'User' assigns a user-selected color to all orbs. \n'Hue From Altitude' assigns a color based on the altitude of the orb. \n'Hue From Distance' assigns a color based on the distance of the orb from the camera.",
        },
        userColor: {
            label: "User Color",
            tooltip: "Select a color for the flow orbs when 'Color Method' is set to 'User'.",
        },
        hueRange: {
            label: "Hue Range",
            tooltip: "Range over which you get a full spectrum of colors for the 'Hue From Altitude/Range' color method.",
        },
        windWhilePaused: {
            label: "Wind While Paused",
            tooltip: "If checked, wind will still affect the flow orbs even when the simulation is paused. Useful for visualizing wind patterns.",
        },
    },

    osdController: {
        seriesName: {
            label: "Name",
        },
        seriesType: {
            label: "Type",
        },
        seriesShow: {
            label: "Show",
        },
        seriesLock: {
            label: "Lock",
        },
        removeTrack: {
            label: "Remove Track",
        },
        folderTitle: {
            label: "OSD Tracker",
            tooltip: "On-Screen Display text tracker for user-defined per-frame text",
        },
        addNewTrack: {
            label: "Add New OSD Data Series",
            tooltip: "Create a new OSD data series for per-frame text overlay",
        },
        makeTrack: {
            label: "Make Track",
            tooltip: "Create a position track from visible/unlocked OSD data series (MGRS or Lat/Lon)",
        },
        showAll: {
            label: "Show All",
            tooltip: "Toggle visibility of all OSD data series",
        },
        exportAllData: {
            label: "Export All Data",
            tooltip: "Export all OSD data series as CSVs in a ZIP file",
        },
        graphShow: {
            label: "Show",
            tooltip: "Show or hide the OSD data graph view",
        },
        xAxis: {
            label: "X Axis",
            tooltip: "Data series for the horizontal axis",
        },
        y1Axis: {
            label: "Y1 Axis",
            tooltip: "Data series for the left vertical axis",
        },
        y2Axis: {
            label: "Y2 Axis",
            tooltip: "Data series for the right vertical axis",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "Video Info Display",
            tooltip: "Video info display controls for frame counter, timecode, and timestamp",
        },
        showVideoInfo: {
            label: "Show Video Info",
            tooltip: "Master toggle - enable or disable all video info displays",
        },
        frameCounter: {
            label: "Frame Number",
            tooltip: "Show the current frame number (virtual frame when video is patched)",
        },
        sourceFrame: {
            label: "Source Frame Number",
            tooltip: "Show the underlying decoded source frame number (differs from Frame Number during held bursts when video is patched)",
        },
        offsetFrame: {
            label: "Offset Frame",
            tooltip: "Show the current frame number plus an offset value",
        },
        offsetValue: {
            label: "Offset Value",
            tooltip: "Offset value added to the current frame number",
        },
        timecode: {
            label: "Timecode",
            tooltip: "Show timecode in HH:MM:SS:FF format",
        },
        timestamp: {
            label: "Timestamp",
            tooltip: "Show timestamp in HH:MM:SS.SS format",
        },
        dateLocal: {
            label: "Date (Local)",
            tooltip: "Show current date in selected timezone",
        },
        timeLocal: {
            label: "Time (Local)",
            tooltip: "Show current time in selected timezone",
        },
        dateTimeLocal: {
            label: "DateTime (Local)",
            tooltip: "Show full date and time in selected timezone",
        },
        dateUTC: {
            label: "Date (UTC)",
            tooltip: "Show current date in UTC",
        },
        timeUTC: {
            label: "Time (UTC)",
            tooltip: "Show current time in UTC",
        },
        dateTimeUTC: {
            label: "DateTime (UTC)",
            tooltip: "Show full date and time in UTC",
        },
        fontSize: {
            label: "Font Size",
            tooltip: "Adjust the font size of the info text",
        },
    },

    terrainUI: {
        mapType: {
            label: "Map Type",
            tooltip: "Map type for terrain textures (separate from elevation data)",
        },
        elevationType: {
            label: "Elevation Type",
            tooltip: "Elevation data source for terrain height data",
        },
        lat: {
            tooltip: "Latitude of the center of the terrain",
        },
        lon: {
            tooltip: "Longitude of the center of the terrain",
        },
        zoom: {
            tooltip: "Zoom level of the terrain. 2 is the whole world, 15 is few city blocks",
        },
        nTiles: {
            tooltip: "Number of tiles in the terrain. More tiles means more detail, but slower loading. (NxN)",
        },
        refresh: {
            label: "Refresh",
            tooltip: "Refresh the terrain with the current settings. Use for network glitches that might have caused a failed load",
        },
        debugGrids: {
            label: "Debug Grids",
            tooltip: "Show a grid of ground textures (Green) and elevation data (Blue)",
        },
        elevationScale: {
            tooltip: "Scale factor for the elevation data. 1 is normal, 0.5 is half height, 2 is double height",
        },
        terrainOpacity: {
            label: "Terrain Opacity",
            tooltip: "Opacity of the terrain. 0 is fully transparent, 1 is fully opaque",
        },
        textureDetail: {
            tooltip: "Detail level for texture subdivision. Higher values = more detail. 1 is normal, 0.5 is less detail, 2 is more detail",
        },
        elevationDetail: {
            tooltip: "Detail level for elevation subdivision. Higher values = more detail. 1 is normal, 0.5 is less detail, 2 is more detail",
        },
        disableDynamicSubdivision: {
            label: "Disable Dynamic Subdivision",
            tooltip: "Disable dynamic subdivision of terrain tiles. Freezes the terrain at the current level of detail. Useful for debugging.",
        },
        dynamicSubdivision: {
            label: "Dynamic Subdivision",
            tooltip: "Use camera-adaptive tile subdivision for globe-scale viewing",
        },
        showBuildings: {
            label: "3D Buildings",
            tooltip: "Show 3D building tiles from Cesium Ion or Google",
        },
        buildingEdges: {
            label: "Building Edges",
            tooltip: "Show wireframe edges on 3D building tiles",
        },
        oceanSurface: {
            label: "Ocean Surface (Beta)",
            tooltip: "Experimental: render sea-level water surface (fixed EGM96 MSL) while Google Photorealistic tiles are active",
        },
        buildingsSource: {
            label: "Buildings Source",
            tooltip: "Data source for 3D building tiles",
        },
        useEllipsoid: {
            label: "Use Ellipsoid Earth Model",
            tooltip: "Sphere: fast legacy model. Ellipsoid: accurate WGS84 shape (higher latitudes benefit most).",
        },
        layer: {
            label: "Layer",
            tooltip: "Layer for the current map type's terrain textures",
        },
    },

    displayTrack: {
        visible: {
            tooltip: "Show or hide this track",
        },
        extendToGround: {
            label: "Extend To Ground",
            tooltip: "Draw vertical lines from track to ground",
        },
        displayStep: {
            label: "Display Step",
            tooltip: "Frame step between displayed track points (1 = every frame)",
        },
        contrail: {
            label: "Contrail",
            tooltip: "Show a contrail ribbon behind this track, adjusted for wind",
        },
        contrailSecs: {
            label: "Contrail Secs",
            tooltip: "Duration of the contrail in seconds",
        },
        contrailWidth: {
            label: "Contrail Width m",
            tooltip: "Maximum width of the contrail ribbon in meters",
        },
        contrailInitialWidth: {
            label: "Contrail Initial Width m",
            tooltip: "Width of the contrail at the exhaust point in meters",
        },
        contrailRamp: {
            label: "Contrail Ramp m",
            tooltip: "Distance over which the contrail width ramps up in meters",
        },
        contrailSpread: {
            label: "Contrail Spread m/s",
            tooltip: "Rate at which the contrail spreads outward in m/s",
        },
        lineColor: {
            label: "Line Color",
            tooltip: "Color of the track line",
        },
        polyColor: {
            label: "Poly Color",
            tooltip: "Color of the vertical ground extension polygons",
        },
        altLockAGL: {
            label: "Alt Lock AGL",
        },
        gotoTrack: {
            label: "Go to track",
            tooltip: "Center the main camera on this track's location",
        },
    },

    ptzUI: {
        panAz: {
            label: "Pan (Az)",
            tooltip: "Camera azimuth / pan angle in degrees",
        },
        tiltEl: {
            label: "Tilt (El)",
            tooltip: "Camera elevation / tilt angle in degrees",
        },
        zoomFov: {
            label: "Zoom (fov)",
            tooltip: "Camera vertical field of view in degrees",
        },
        roll: {
            label: "Roll",
            tooltip: "Camera roll angle in degrees",
        },
        xOffset: {
            label: "xOffset",
            tooltip: "Horizontal offset of the camera from center",
        },
        yOffset: {
            label: "yOffset",
            tooltip: "Vertical offset of the camera from center",
        },
        nearPlane: {
            label: "Near Plane (m)",
            tooltip: "Camera near clipping plane distance in meters",
        },
        relative: {
            label: "Relative",
            tooltip: "Use relative angles instead of absolute",
        },
        satellite: {
            label: "Satellite",
            tooltip: "Satellite mode: screen-space panning from nadir.\nRoll = heading, Az = left/right, El = up/down (-90 = nadir)",
        },
        rotation: {
            label: "Rotation",
            tooltip: "Screen-space rotation around the camera look axis",
        },
    },

    nodes3dObject: {
        modelOrGeometry: {
            label: "Model or Geometry",
            tooltip: "Select whether to use a 3D Model or a generated geometry for this object",
        },
        model: {
            label: "Model",
            tooltip: "Select a 3D Model to use for this object",
        },
        displayBoundingBox: {
            label: "Display Bounding Box",
            tooltip: "Display the bounding box of the object with dimensions",
        },
        forceAboveSurface: {
            label: "Force Above Surface",
            tooltip: "Force the object to be fully above the ground surface",
        },
        exportToKML: {
            label: "Export to KML",
            tooltip: "Export this 3D object as a KML file for Google Earth",
        },
        startAnalysis: {
            label: "Start Analysis",
            tooltip: "Cast rays from the camera to find reflection directions",
        },
        gridSize: {
            label: "Grid Size",
            tooltip: "Number of sample points per axis for the reflection grid",
        },
        cleanUp: {
            label: "Clean Up",
            tooltip: "Remove all reflection analysis arrows from the scene",
        },
    },

    trackingOverlay: {
        showTracking: {
            label: "Show Tracking",
            tooltip: "Show or hide the tracking points and curve overlay",
        },
        reset: {
            label: "Reset",
            tooltip: "Reset manual tracking to an empty state, removing all keyframes and draggable items",
        },
        limitAB: {
            label: "Limit AB",
            tooltip: "Limit the A and B frames to the range of the video tracking keyframes. This will prevent extrapolation beyond the first and last keyframes, which is not always desired.",
        },
        curveType: {
            label: "Curve Type",
            tooltip: "Spline uses natural cubic spline. Spline2 uses not-a-knot spline for smoother end behavior. Linear uses straight line segments. Perspective requires exactly 3 keyframes and models linear motion with perspective projection.",
        },
        minimizeGroundSpeed: {
            label: "Minimize Ground Speed",
            tooltip: "Find the Tgt Start Dist that minimizes the ground distance traveled by the traverse path",
        },
        minimizeAirSpeed: {
            label: "Minimize Air Speed",
            tooltip: "Find the Tgt Start Dist that minimizes the air distance traveled (accounting for target wind)",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "Frustum Ground Quad",
            tooltip: "Show the camera frustum intersection with the ground",
        },
        videoInFrustum: {
            label: "Video in Frustum",
            tooltip: "Project the video onto the camera frustum far plane",
        },
        videoOnGround: {
            label: "Video on Ground",
            tooltip: "Project the video onto the ground",
        },
        groundVideoInLookView: {
            label: "Ground Video in Look View",
            tooltip: "Show the ground-projected video in the look view",
        },
        matchVideoAspect: {
            label: "Match Video Aspect",
            tooltip: "Crop the look view to match the video's aspect ratio, and adjust the frustum accordingly",
        },
        videoOpacity: {
            label: "Video Opacity",
            tooltip: "Opacity of the projected video overlay",
        },
    },

    labels3d: {
        measurements: {
            label: "Measurements",
            tooltip: "Show distance and angle measurement labels and arrows",
        },
        labelsInMain: {
            label: "Labels in Main",
            tooltip: "Show track/object labels in the main 3D view",
        },
        labelsInLook: {
            label: "Labels in Look",
            tooltip: "Show track/object labels in the look/camera view",
        },
        featuresInMain: {
            label: "Features/Pins in Main",
            tooltip: "Show feature markers (pins) in the main 3D view",
        },
        featuresInLook: {
            label: "Features in Look",
            tooltip: "Show feature markers in the look/camera view",
        },
    },

    losFitPhysics: {
        folder: "Physics Fit Results",
        model: {
            label: "Model",
        },
        avgError: {
            label: "Avg Error (rad)",
        },
        windSpeed: {
            label: "Wind Speed (kt)",
        },
        windFrom: {
            label: "Wind From (\u00B0)",
        },
    },

    misbData: {
        startTime: {
            label: "Start Time",
            tooltip: "Override start time (e.g., '10:30', 'Jan 15', '2024-01-15T10:30:00Z'). Leave blank for global start time.",
        },
        enableFilter: {
            label: "Enable Filter",
        },
        tryAltitudeFirst: {
            label: "Try Altitude First",
        },
        maxG: {
            label: "Max G",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "Above Ground Level",
            tooltip: "Altitude is relative to ground level, not sea level",
        },
        lookup: {
            label: "Lookup",
            tooltip: "Enter a place name, lat,lon coordinates, or MGRS to move to",
        },
        geolocate: {
            label: "Geolocate from browser",
            tooltip: "Use the browser's geolocation API to set your current position",
        },
        goTo: {
            label: "Go To the above position",
            tooltip: "Move terrain and camera to the entered latitude/longitude/altitude",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "Stop At",
            tooltip: "Stop the camera target movement at this frame, even if the target track continues. This is useful for simulating the loss of lock on a moving target. Set to 0 to disable.",
        },
        horizonMethod: {
            label: "Horizon Method",
        },
        lookFOV: {
            label: "Look FOV",
        },
        celestialObject: {
            label: "Celestial Object",
            tooltip: "Name of the celestial body the camera tracks (e.g. Moon, Venus, Jupiter)",
        },
    },

    spriteGroup: {
        visible: {
            label: "Visible",
            tooltip: "Show or hide the flow orbs",
        },
        size: {
            label: "Size (m)",
            tooltip: "Diameter in meters.",
        },
        viewSizeMultiplier: {
            label: "View Size Multiplier",
            tooltip: "Adjusts the size of the flow orbs in the main view, but does not change the size in other views.",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "Best Angle, full 180, refined",
        },
        bestAngle5: {
            label: "Best angle within 5\u00B0 of current",
        },
    },

    misc: {
        snapshotCamera: {
            label: "Snapshot Camera",
            tooltip: "Save the current camera position and heading for use with 'Reset Camera'",
        },
        resetCamera: {
            label: "Reset Camera",
            tooltip: "Reset the camera to the default, or to last snapshot position and heading\nAlso Numpad-.",
        },
        showMoonShadow: {
            label: "Show Moon's Shadow",
            tooltip: "Toggle the display of Moon's shadow cone for eclipse visualization.",
        },
        shadowSegments: {
            label: "Shadow Segments",
            tooltip: "Number of segments in the shadow cone (more = smoother but slower)",
        },
        showEarthShadow: {
            label: "Show Earth's Shadow",
            tooltip: "Toggle the display of Earth's shadow cone in the night sky.",
        },
        earthShadowAltitude: {
            label: "Earth's Shadow Altitude",
            tooltip: "Distance from Earth's center to the plane at which to render Earth's shadow cone (in meters).",
        },
        exportTLE: {
            label: "Export TLE",
        },
        backgroundFlowIndicator: {
            label: "Background Flow Indicator",
            tooltip: "Display an arrow indicating how much the background will move in the next frame.\nUseful for syncing the sim with video (use View/Vid Overlay)",
        },
        defaultSnap: {
            label: "Default Snap",
            tooltip: "When enabled, points will snap to horizontal alignment by default while dragging.\nHold Shift (while dragging) to do the opposite",
        },
        recalcNodeGraph: {
            label: "Recalc Node Graph",
        },
        downloadVideo: {
            label: "Download Video",
        },
        banking: {
            label: "Banking",
            tooltip: "How the object banks/tilts during turns",
        },
        angularTraverse: {
            label: "Angular Traverse",
        },
        smoothingMethod: {
            label: "Smoothing Method",
            tooltip: "Algorithm used to smooth the camera track data",
        },
        showInLookView: {
            label: "Show in look view",
        },
        windFrom: {
            tooltip: "True heading the wind blows FROM (0=North, 90=East)",
        },
        windKnots: {
            tooltip: "Wind speed in knots",
        },
        fetchWind: {
            tooltip: "Fetch real wind data from weather services for this location and time",
        },
        debugConsole: {
            label: "Debug Console",
            tooltip: "Debug Console",
        },
        aiAssistant: {
            label: "AI Assistant",
        },
        hide: {
            label: "Hide",
            tooltip: "Hide this tabbed canvas view\nTo show it again, use the 'Show/Hide -> Views' menu.",
        },
        notes: {
            label: "Notes",
            tooltip: "Show/Hide the notes editor. Notes are saved with the sitch and can contain clickable hyperlinks.",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "Lines of Sight",
            tooltip: "Show lines of sight from camera to target (toggle: O)",
        },
        physicalPointer: {
            label: "Physical Pointer",
        },
        jet: {
            label: "[J]et",
        },
        horizonGrid: {
            label: "[H]orizon Grid",
        },
        wingPlaneGrid: {
            label: "[W]ing Plane Grid",
        },
        sphericalBoresightGrid: {
            label: "[S]pherical Boresight Grid",
        },
        azimuthElevationGrid: {
            label: "[A]zimuth/Elevation Grid",
        },
        frustumOfCamera: {
            label: "F[R]ustum of camera",
        },
        trackLine: {
            label: "[T]rack line",
        },
        globe: {
            label: "[G]lobe",
        },
        showErrorCircle: {
            label: "showErrorCircle",
        },
        glareSprite: {
            label: "Glare Spr[I]te",
        },
        cameraViewFrustum: {
            label: "Camera View Frustum",
            tooltip: "Show the camera's viewing frustum in the 3D scene",
        },
        zaineTriangulation: {
            label: "Zaine Triangulation",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "Ambient Intensity",
            tooltip: "Ambient light intensity. 0 is no ambient light, 1 is normal ambient light, 2 is double ambient light",
        },
        irAmbientIntensity: {
            label: "IR Ambient Intensity",
            tooltip: "IR Ambient light intensity (used for IR viewports)",
        },
        sunIntensity: {
            label: "Sun Intensity",
            tooltip: "Sunlight intensity. 0 is no sunlight, 1 is normal full sunlight, 2 is double sunlight",
        },
        sunScattering: {
            label: "Sun Scattering",
            tooltip: "Sunlight scattering amount",
        },
        sunBoost: {
            label: "Sun Boost (HDR)",
            tooltip: "Multiplier for sun DirectionalLight intensity (HDR). Increases specular highlight brightness for realistic sun reflections through fog.",
        },
        sceneExposure: {
            label: "Scene Exposure (HDR)",
            tooltip: "Exposure compensation for HDR tone mapping. Lower to compensate for higher sun boost.",
        },
        ambientOnly: {
            label: "Ambient Only",
            tooltip: "If true, then only ambient light is used, no sunlight",
        },
        atmosphere: {
            label: "Atmosphere",
            tooltip: "If true, then the atmosphere is rendered.\nSet to false to see the stars in daytime",
        },
        noMainLighting: {
            label: "No Lighting in Main View",
            tooltip: "If true, then no lighting is used in the main view.\nThis is useful for debugging, but not recommended for normal use",
        },
        noCityLights: {
            label: "No City Lights on Globe",
            tooltip: "If true, then don't render the city lights on the globe.",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "ADSB Replay for this time and location",
            tooltip: "Generate a link to ADSB Exchange Replay",
        },
        googleMapsLink: {
            label: "Google Maps for this location",
            tooltip: "Create a Google Maps link to the current location",
        },
        inTheSkyLink: {
            label: "In-The-Sky for this time and location",
            tooltip: "Create an In The Sky link to the current location",
        },
    },
    nodeLabels: {
        // Keys must match the node ID (property key in sitch data),
        // NOT the desc text. When no explicit id is set, desc becomes the id.
        focus: "Defocus",
        canvasResolution: "Resolution",
        "Noise Amount": "Noise Amount",
        "TV In Black": "TV In Black",
        "TV In White": "TV In White",
        "TV Gamma": "TV Gamma",
        "Tv Out Black": "Tv Out Black",
        "Tv Out White": "Tv Out White",
        "JPEG Artifacts": "JPEG Artifacts",
        pixelZoom: "Pixel Zoom %",
        videoBrightness: "Brightness",
        videoContrast: "Contrast",
        videoBlur: "Blur Amount",
        videoSharpenAmount: "Sharpen Amount",
        videoGreyscale: "Greyscale",
        videoHue: "Hue Shift",
        videoInvert: "Invert",
        videoSaturate: "Saturation",
        startDistanceGUI: "Start Distance",
        targetVCGUI: "Target Vert. Speed",
        targetSpeedGUI: "Target Speed",
        lockWind: "Lock Target Wind to Local",
        jetTAS: "TAS",
        turnRate: "Turn Rate",
        totalTurn: "Total Turn",
        jetHeadingManual: "Jet Heading",
        headingSmooth: "Heading Smooth",
        turnRateControl: "Turn Rate Control",
        cameraSmoothWindow: "Camera Smooth Window",
        targetSmoothWindow: "Target Smooth Window",
        cameraFOV: "Camera FOV",
        "Tgt Start Dist": "Tgt Start Distance",
        "Target Speed": "Target Speed",
        "Tgt Relative Heading": "Tgt Relative Heading",
        "KF Process": "KF Process",
        "KF Noise": "KF Noise",
        "MC Num Trials": "MC Num Trials",
        "MC LOS Uncertainty (deg)": "MC LOS Uncertainty (deg)",
        "MC Polynomial Order": "MC Polynomial Order",
        "Physics Max Iterations": "Physics Max Iterations",
        "Physics Wind Speed (kt)": "Physics Wind Speed (kt)",
        "Physics Wind From (°)": "Physics Wind From (°)",
        "Physics Initial Range (m)": "Physics Initial Range (m)",
        "Tgt Start Altitude": "Tgt Start Altitude",
        "Tgt Vert Spd": "Tgt Vert Speed",
        "Cloud Altitude": "Cloud Altitude",
    },
};

export default en;