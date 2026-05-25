const de = {
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "Auswahl von alten Sitches und Werkzeugen\nEinige ältere Sitches haben hier standardmäßig Steuerungen",
            noTooltip: "Kein Tooltip für diesen Sitch definiert",
            legacySitches: {
                label: "Ältere Sitches",
                tooltip: "Die älteren Sitches sind ältere eingebaute (fest codierte) Sitches, die vordefinierte Situationen darstellen und oft über einzigartigen Code und eigene Ressourcen verfügen. Wählen Sie einen aus, um ihn zu laden.",
            },
            legacyTools: {
                label: "Ältere Werkzeuge",
                tooltip: "Werkzeuge sind spezielle Sitches, die für benutzerdefinierte Konfigurationen wie Starlink oder mit Benutzer-Tracks verwendet werden, sowie für Tests, Debugging oder andere besondere Zwecke. Wählen Sie eines aus, um es zu laden.",
            },
            selectPlaceholder: "-Auswählen-",
        },
        file: {
            title: "Datei",
            tooltip: "Dateioperationen wie Speichern, Laden und Exportieren",
        },
        view: {
            title: "Ansicht",
            tooltip: "Verschiedene Ansichtssteuerungen\nWie alle Menüs kann dieses Menü von der Menüleiste abgelöst werden, um ein schwebendes Menü zu erstellen",
        },
        video: {
            title: "Video",
            tooltip: "Videoanpassung, Effekte und Analyse",
        },
        time: {
            title: "Zeit",
            tooltip: "Zeit- und Frame-Steuerungen\nWenn ein Zeitschieberegler über das Ende hinausgezogen wird, beeinflusst dies den darüberliegenden Schieberegler\nBeachten Sie, dass die Zeitschieberegler in UTC angegeben sind",
        },
        objects: {
            title: "Objekte",
            tooltip: "3D-Objekte und ihre Eigenschaften\nJeder Ordner ist ein Objekt. Das Traverse-Objekt ist dasjenige, das die Sichtlinien durchläuft – also das UAP, das uns interessiert",
            addObject: {
                label: "Objekt hinzufügen",
                tooltip: "Ein neues Objekt an den angegebenen Koordinaten erstellen",
                prompt: "Eingabe: [Name] Lat Lon [Höhe]\nBeispiele:\n  MeinObjekt 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Orientierungspunkt 37.7749 -122.4194",
                invalidInput: "Ungültige Eingabe. Bitte geben Sie Koordinaten im Format ein:\n[Name] Lat Lon [Höhe]",
            },
        },
        satellites: {
            title: "Satelliten",
            tooltip: "Laden und Steuern von Satelliten\nDie Satelliten.\nStarlink, ISS usw. Steuerungen für Horizontblitze und andere Satelliteneffekte",
        },
        terrain: {
            title: "Gelände",
            tooltip: "Geländesteuerungen\nDas Gelände ist das 3D-Modell des Bodens. Die 'Karte' ist das 2D-Bild des Bodens. Die 'Höhe' ist die Höhe des Bodens über dem Meeresspiegel",
        },
        physics: {
            title: "Physik",
            tooltip: "Physik-Steuerungen\nDie Physik der Situation, wie Windgeschwindigkeit und die Physik des Traverse-Objekts",
        },
        camera: {
            title: "Kamera",
            tooltip: "Kamerasteuerungen für die Blickansicht-Kamera\nDie Blickansicht befindet sich standardmäßig im unteren rechten Fenster und soll dem Video entsprechen.",
        },
        target: {
            title: "Ziel",
            tooltip: "Zielsteuerungen\nPosition und Eigenschaften des optionalen Zielobjekts",
        },
        traverse: {
            title: "Traverse",
            tooltip: "Traverse-Steuerungen\nDas Traverse-Objekt ist dasjenige, das die Sichtlinien durchläuft – also das UAP, das uns interessiert\nDieses Menü definiert, wie sich das Traverse-Objekt bewegt und verhält",
        },
        showHide: {
            title: "Ein-/Ausblenden",
            tooltip: "Ansichten, Objekte und andere Elemente anzeigen oder verbergen",
            views: {
                title: "Ansichten",
                tooltip: "Ansichten (Fenster) wie die Blickansicht, das Video, die Hauptansicht sowie Overlays wie die MQ9UI anzeigen oder verbergen",
            },
            graphs: {
                title: "Diagramme",
                tooltip: "Verschiedene Diagramme anzeigen oder verbergen",
            },
        },
        effects: {
            title: "Effekte",
            tooltip: "Spezialeffekte wie Unschärfe, Pixelung und Farbanpassungen, die auf das Endbild in der Blickansicht angewendet werden",
        },
        lighting: {
            title: "Beleuchtung",
            tooltip: "Die Beleuchtung der Szene, wie Sonne und Umgebungslicht",
        },
        contents: {
            title: "Inhalte",
            tooltip: "Die Inhalte der Szene, hauptsächlich für Tracks verwendet",
        },
        help: {
            title: "Hilfe",
            tooltip: "Links zur Dokumentation und anderen Hilferessourcen",
            whatsNew: "Neuigkeiten",
            documentation: {
                title: "Dokumentation",
                localTooltip: "Links zur Dokumentation (lokal)",
                githubTooltip: "Links zur Dokumentation auf Github",
                githubLinkLabel: "{{name}} (Github)",
                about: "Über Sitrec",
                whatsNew: "Neuigkeiten",
                whatsNewDetails: "Neuigkeiten (Details)",
                uiBasics: "Grundlagen der Benutzeroberfläche",
                savingLoading: "Sitches speichern und laden",
                customSitch: "Einen Sitch einrichten",
                tracks: "Tracks und Datenquellen",
                gis: "GIS und Kartierung",
                starlink: "Starlink-Flares untersuchen",
                customModels: "Objekte und 3D-Modelle (Flugzeuge)",
                cameraModes: "Kameramodi (Normal & Satellit)",
                thirdPartyNotices: "Drittanbieter-Hinweise",
                thirdPartyNoticesTooltip: "Open-Source-Lizenzhinweise für enthaltene Drittanbieter-Software",
                downloadBridge: "MCP Bridge herunterladen",
                downloadBridgeTooltip: "SitrecBridge MCP-Server + Chrome-Erweiterung herunterladen (keine Abhängigkeiten, nur Node.js erforderlich)",
            },
            externalLinks: {
                title: "Externe Links",
                tooltip: "Externe Hilfelinks",
            },
            exportDebugLog: {
                label: "Debug-Protokoll exportieren",
                tooltip: "Alle Konsolenausgaben (Log, Warnung, Fehler) als Textdatei zum Debuggen herunterladen",
            },
        },
        debug: {
            title: "Debug",
            tooltip: "Debug-Werkzeuge und Überwachung\nGPU-Speichernutzung, Leistungsmetriken und andere Debug-Informationen",
        },
    },
    file: {
        newSitch: {
            label: "Neuer Sitch",
            tooltip: "Einen neuen Sitch erstellen (lädt die Seite neu und setzt alles zurück)",
        },
        savingDisabled: "Speichern deaktiviert (zum Anmelden klicken)",
        importFile: {
            label: "Datei importieren",
            tooltip: "Eine Datei (oder Dateien) von Ihrem lokalen System importieren. Entspricht dem Ziehen und Ablegen einer Datei ins Browserfenster",
        },
        server: {
            open: "Öffnen",
            save: {
                label: "Speichern",
                tooltip: "Den aktuellen Sitch auf dem Server speichern",
            },
            saveAs: {
                label: "Speichern unter",
                tooltip: "Den aktuellen Sitch unter einem neuen Namen auf dem Server speichern",
            },
            versions: {
                label: "Versionen",
                tooltip: "Eine bestimmte Version des aktuell ausgewählten Sitches laden",
            },
            browseFeatured: "Vorgestellte Sitches durchsuchen",
            browseAll: "Alle gespeicherten Sitches in einer durchsuchbaren, sortierbaren Liste durchsuchen",
        },
        local: {
            title: "Lokal",
            titleWithFolder: "Lokal: {{name}}",
            titleReconnect: "Lokal: {{name}} (neu verbinden)",
            status: "Status",
            noFileSelected: "Keine lokale Datei ausgewählt",
            noFolderSelected: "Kein Ordner ausgewählt",
            currentFile: "Aktuelle Datei: {{name}}",
            statusDesktop: "Aktuelle lokale Desktop-Datei/Speicherstatus",
            statusFolder: "Aktueller lokaler Ordner/Speicherstatus",
            stateReady: "Bereit",
            stateReconnect: "Neuverbindung erforderlich",
            stateNoFolder: "Kein Ordner",
            statusLine: "{{state}} | Ordner: {{folder}} | Ziel: {{target}}",
            saveLocal: {
                label: "Lokal speichern",
                tooltipDesktop: "In der aktuellen lokalen Datei speichern oder bei Bedarf nach einem Dateinamen fragen",
                tooltipFolder: "Im Arbeitsordner speichern (oder nach einem Speicherort fragen, falls keiner festgelegt ist)",
                tooltipSaveBack: "Zurückspeichern in {{name}}",
                tooltipSaveBackInFolder: "Zurückspeichern in {{name}} im Ordner {{folder}}",
                tooltipSaveInto: "In {{folder}} speichern (fragt nach dem Sitch-Namen)",
                tooltipPrompt: "Eine lokale Sitch-Datei speichern (fragt nach Name/Speicherort)",
                tooltipSaveTo: "Den aktuellen Sitch in einer lokalen Datei speichern",
            },
            saveLocalAs: {
                label: "Lokal speichern unter...",
                tooltipDesktop: "Eine lokale Sitch-Datei unter einem neuen Pfad speichern",
                tooltipFolder: "Eine lokale Sitch-Datei speichern, Speicherort wählen",
                tooltipInFolder: "Mit neuem Dateinamen im aktuellen Arbeitsordner speichern",
                tooltipNewPath: "Den aktuellen Sitch unter einem neuen lokalen Dateipfad speichern",
            },
            openLocal: {
                label: "Lokalen Sitch öffnen",
                labelShort: "Lokal öffnen...",
                tooltipDesktop: "Eine lokale Sitch-Datei von der Festplatte öffnen",
                tooltipFolder: "Eine Sitch-Datei aus dem aktuellen Arbeitsordner öffnen",
                tooltipCurrent: "Eine andere lokale Sitch-Datei öffnen (aktuell: {{name}})",
                tooltipFromFolder: "Eine Sitch-Datei aus {{folder}} öffnen",
            },
            selectFolder: {
                label: "Lokalen Sitch-Ordner auswählen",
                tooltip: "Einen Arbeitsordner für lokale Speicher-/Ladevorgänge auswählen",
            },
            reconnectFolder: {
                label: "Ordner neu verbinden",
                tooltip: "Zugriff auf den zuvor verwendeten Arbeitsordner erneut gewähren",
            },
        },
        debug: {
            recalculateAll: "Debug: Alles neu berechnen",
            dumpNodes: "Debug: Knoten ausgeben",
            dumpNodesBackwards: "Debug: Knoten rückwärts ausgeben",
            dumpRoots: "Debug: Wurzelknoten ausgeben",
        },
    },
    videoExport: {
        notAvailable: "Videoexport nicht verfügbar",
        folder: {
            title: "Video-Rendering & Export",
            tooltip: "Optionen zum Rendern und Exportieren von Videodateien aus Sitrec-Ansichten oder dem gesamten Viewport",
        },
        renderView: {
            label: "Videoansicht rendern",
            tooltip: "Wählen Sie die Ansicht aus, die als Video exportiert werden soll",
        },
        renderSingleVideo: {
            label: "Einzelansicht-Video rendern",
            tooltip: "Die ausgewählte Ansicht als Videodatei mit allen Frames exportieren",
        },
        videoFormat: {
            label: "Videoformat",
            tooltip: "Ausgabevideoformat auswählen",
        },
        renderViewport: {
            label: "Viewport-Video rendern",
            tooltip: "Den gesamten Viewport als Videodatei mit allen Frames exportieren",
        },
        renderFullscreen: {
            label: "Vollbild-Video rendern",
            tooltip: "Den gesamten Viewport im Vollbildmodus als Videodatei mit allen Frames exportieren",
        },
        recordWindow: {
            label: "Browserfenster aufnehmen",
            tooltip: "Das gesamte Browserfenster (einschließlich Menüs und Benutzeroberfläche) als Video mit fester Bildrate aufnehmen",
        },
        retinaExport: {
            label: "HD/Retina-Export verwenden",
            tooltip: "In Retina/HiDPI-Auflösung exportieren (2x auf den meisten Bildschirmen)",
        },
        includeAudio: {
            label: "Audio einschließen",
            tooltip: "Audiospur aus dem Quellvideo einschließen, falls verfügbar",
        },
        waitForLoading: {
            label: "Auf Hintergrundladung warten",
            tooltip: "Wenn aktiviert, wartet das Rendering auf das Laden von Gelände/Gebäuden/Hintergründen, bevor jeder Frame erfasst wird",
        },
        exportFrame: {
            label: "Video-Frame exportieren",
            tooltip: "Den aktuellen Video-Frame wie angezeigt (mit Effekten) als PNG-Datei exportieren",
        },
    },
    tracking: {
        enable: {
            label: "Punkt-Track aktivieren",
            disableLabel: "Punkt-Track deaktivieren",
            tooltip: "Anzeige des Punkt-Track-Cursors auf dem Video umschalten",
        },
        start: {
            label: "Punkt-Track starten",
            stopLabel: "Punkt-Track stoppen",
            tooltip: "Das Objekt innerhalb des Cursors automatisch verfolgen, während das Video abgespielt wird",
        },
        clearFromHere: {
            label: "Ab hier löschen",
            tooltip: "Alle verfolgten Positionen vom aktuellen Frame bis zum Ende löschen",
        },
        clearTrack: {
            label: "Track löschen",
            tooltip: "Alle automatisch verfolgten Positionen löschen und neu beginnen",
        },
        stabilize: {
            label: "Stabilisieren",
            tooltip: "Automatisch verfolgte Positionen zur Stabilisierung des Videos anwenden",
        },
        stabilizeToggle: {
            enableLabel: "Stabilisierung aktivieren",
            disableLabel: "Stabilisierung deaktivieren",
            tooltip: "Videostabilisierung ein-/ausschalten",
        },
        stabilizeCenters: {
            label: "Mitten stabilisieren",
            tooltip: "Wenn aktiviert, wird der stabilisierte Punkt in der Ansichtsmitte fixiert. Wenn deaktiviert, bleibt er an seiner ursprünglichen Position.",
        },
        renderStabilized: {
            label: "Stabilisiertes Video rendern",
            tooltip: "Stabilisiertes Video in Originalgröße exportieren (verfolgter Punkt bleibt fixiert, Ränder können schwarz sein)",
        },
        renderStabilizedExpanded: {
            label: "Stabilisiert erweitert rendern",
            tooltip: "Stabilisiertes Video mit erweiterter Leinwand exportieren, damit keine Pixel verloren gehen",
        },
        trackRadius: {
            label: "Verfolgungsradius",
            tooltip: "Größe der abzugleichenden Vorlage (Objektgröße)",
        },
        searchRadius: {
            label: "Suchradius",
            tooltip: "Wie weit von der vorherigen Position gesucht wird (bei schneller Bewegung erhöhen)",
        },
        trackingMethod: {
            label: "Verfolgungsmethode",
            tooltip: "Vorlagenabgleich (OpenCV) oder Optischer Fluss (jsfeat Lucas-Kanade)",
        },
        centerOnBright: {
            label: "Auf helle Pixel zentrieren",
            tooltip: "Schwerpunkt heller Pixel verfolgen (besser für Sterne/Punktlichtquellen)",
        },
        centerOnDark: {
            label: "Auf dunkle Pixel zentrieren",
            tooltip: "Schwerpunkt dunkler Pixel verfolgen",
        },
        brightnessThreshold: {
            label: "Helligkeitsschwelle",
            tooltip: "Helligkeitsschwelle (0-255). Wird in den Modi 'Auf hell/dunkel zentrieren' verwendet",
        },
        status: {
            loadingJsfeat: "Lade jsfeat...",
            loadingOpenCv: "Lade OpenCV...",
            sam2Connecting: "SAM2: Verbindung wird hergestellt...",
            sam2Uploading: "SAM2: Hochladen...",
        },
    },
    trackManager: {
        removeTrack: "Track entfernen",
        createSpline: "Spline erstellen",
        editTrack: "Track bearbeiten",
        constantSpeed: "Konstante Geschwindigkeit",
        extrapolateTrack: "Track extrapolieren",
        curveType: "Kurventyp",
        altLockAGL: "Höhe fixieren AGL",
        deleteTrack: "Track löschen",
    },
    gpuMonitor: {
        enabled: "Überwachung aktiviert",
        total: "Gesamtspeicher",
        geometries: "Geometrien",
        textures: "Texturen",
        peak: "Spitzenspeicher",
        average: "Durchschnittsspeicher",
        reset: "Verlauf zurücksetzen",
    },
    situationSetup: {
        mainFov: {
            label: "Haupt-FOV",
            tooltip: "Sichtfeld der Hauptansicht-Kamera (VERTIKAL)",
        },
        lookCameraFov: "Blickkamera-FOV",
        azimuth: "Azimut",
        jetPitch: "Jet-Neigung",
    },
    featureManager: {
        labelText: "Beschriftung",
        latitude: "Breitengrad",
        longitude: "Längengrad",
        altitude: "Höhe (m)",
        arrowLength: "Pfeillänge",
        arrowColor: "Pfeilfarbe",
        textColor: "Textfarbe",
        deleteFeature: "Markierung löschen",
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "Blickpanorama exportieren",
            tooltip: "Ein Panoramabild aus der Blickansicht über alle Frames basierend auf der Hintergrundposition erstellen",
        },
    },
    dateTime: {
        liveMode: {
            label: "Live-Modus",
            tooltip: "Wenn der Live-Modus aktiv ist, wird die Wiedergabe immer mit der aktuellen Zeit synchronisiert.\nPausieren oder Verschieben der Zeit deaktiviert den Live-Modus",
        },
        startTime: {
            tooltip: "Die STARTZEIT des ersten Frames des Videos im UTC-Format",
        },
        currentTime: {
            tooltip: "Die AKTUELLE Zeit des Videos. Darauf beziehen sich das folgende Datum und die Uhrzeit",
        },
        year: { label: "Jahr", tooltip: "Jahr des aktuellen Frames" },
        month: { label: "Monat", tooltip: "Monat (1-12)" },
        day: { label: "Tag", tooltip: "Tag des Monats" },
        hour: { label: "Stunde", tooltip: "Stunde (0-23)" },
        minute: { label: "Minute", tooltip: "Minute (0-59)" },
        second: { label: "Sekunde", tooltip: "Sekunde (0-59)" },
        millisecond: { label: "ms", tooltip: "Millisekunde (0-999)" },
        useTimeZone: {
            label: "Zeitzone in Oberfläche verwenden",
            tooltip: "Die oben gewählte Zeitzone in der Oberfläche verwenden\nDadurch werden Datum und Uhrzeit in der ausgewählten Zeitzone anstelle von UTC angezeigt.\nDies ist nützlich, um Datum und Uhrzeit in einer bestimmten Zeitzone anzuzeigen, z. B. der lokalen Zeitzone des Videos oder des Standorts.",
        },
        timeZone: {
            label: "Zeitzone",
            tooltip: "Die Zeitzone, in der Datum und Uhrzeit in der Blickansicht angezeigt werden\nAuch in der Oberfläche, wenn 'Zeitzone in Oberfläche verwenden' aktiviert ist",
        },
        simSpeed: {
            label: "Simulationsgeschwindigkeit",
            tooltip: "Die Geschwindigkeit der Simulation; 1 ist Echtzeit, 2 ist doppelte Geschwindigkeit usw.\nDies ändert nicht die Video-Wiedergabegeschwindigkeit, sondern nur die Zeitberechnungen der Simulation.",
        },
        sitchFrames: {
            label: "Sitch-Frames",
            tooltip: "Die Anzahl der Frames im Sitch. Wenn ein Video vorhanden ist, entspricht dies der Anzahl der Frames im Video, aber Sie können dies ändern, wenn Sie mehr Frames hinzufügen oder den Sitch ohne Video verwenden möchten",
        },
        sitchDuration: {
            label: "Sitch-Dauer",
            tooltip: "Dauer des Sitches im Format HH:MM:SS.sss",
        },
        aFrame: {
            label: "A-Frame",
            tooltip: "Die Wiedergabe auf den Bereich zwischen A und B begrenzen, dargestellt als grün und rot auf dem Frame-Schieberegler",
        },
        bFrame: {
            label: "B-Frame",
            tooltip: "Die Wiedergabe auf den Bereich zwischen A und B begrenzen, dargestellt als grün und rot auf dem Frame-Schieberegler",
        },
        videoFps: {
            label: "Video-FPS",
            tooltip: "Die Bilder pro Sekunde des Videos. Dies ändert die Wiedergabegeschwindigkeit des Videos (z. B. 30 fps, 25 fps usw.). Es ändert auch die Dauer des Sitches (in Sekunden), da es beeinflusst, wie lang ein einzelner Frame ist\n Dies wird nach Möglichkeit aus dem Video abgeleitet, kann aber geändert werden, um das Video zu beschleunigen oder zu verlangsamen",
        },
        syncTimeTo: {
            label: "Zeit synchronisieren mit",
            tooltip: "Die Video-Startzeit mit der ursprünglichen Startzeit, der aktuellen Zeit oder der Startzeit eines Tracks synchronisieren (falls geladen)",
        },
    },
    jet: {
        frames: {
            time: {
                label: "Zeit (Sek.)",
                tooltip: "Aktuelle Zeit seit Videobeginn in Sekunden (Frame / fps)",
            },
            frame: {
                label: "Frame im Video",
                tooltip: "Aktuelle Frame-Nummer im Video",
            },
            paused: {
                label: "Pausiert",
                tooltip: "Pause-Zustand umschalten (auch Leertaste)",
            },
        },
        controls: {
            pingPong: "A-B Ping-Pong",
            podPitchPhysical: "Pod (Kugelkopf) Neigung",
            podRollPhysical: "Pod-Kopf-Rollen",
            deroFromGlare: "Derotation = Blendwinkel",
            jetPitch: "Jet-Neigung",
            lookFov: "Enges FOV",
            elevation: "Elevation",
            glareStartAngle: "Blend-Startwinkel",
            initialGlareRotation: "Initiale Blend-Rotation",
            scaleJetPitch: "Jet-Neigung mit Rollen skalieren",
            horizonMethod: "Horizontmethode",
            horizonMethodOptions: {
                humanHorizon: "Menschlicher Horizont",
                horizonAngle: "Horizontwinkel",
            },
            videoSpeed: "Videogeschwindigkeit",
            podWireframe: "[B]ack Pod-Drahtgitter",
            showVideo: "[V]ideo",
            showGraph: "[G]raph",
            showKeyboardShortcuts: "[K]Tastenkürzel",
            showPodHead: "[P]od-Kopf-Rollen",
            showPodsEye: "Pod-[E]ye-Ansichten m. Dero",
            showLookCam: "[N]AR-Ansicht m. Dero",
            showCueData: "[C]ue-Daten",
            showGlareGraph: "Blend-Graph an[z]eigen",
            showAzGraph: "A[Z]-Graph anzeigen",
            declutter: "[D]eclutter]",
            jetOffset: "Jet-Y-Versatz",
            tas: "TAS Wahre Fluggeschwindigkeit",
            integrate: "Integrationsschritte",
        },
    },
    motionAnalysis: {
        menu: {
            title: "Bewegungsanalyse",
            analyzeMotion: {
                label: "Bewegung analysieren",
                tooltip: "Echtzeit-Bewegungsanalyse-Overlay auf dem Video umschalten",
            },
            createTrack: {
                label: "Track aus Bewegung erstellen",
                tooltip: "Alle Frames analysieren und einen Boden-Track aus Bewegungsvektoren erstellen",
            },
            alignWithFlow: {
                label: "An Fluss ausrichten",
                tooltip: "Bild so drehen, dass die Bewegungsrichtung horizontal ist",
            },
            panorama: {
                title: "Panorama",
                exportImage: {
                    label: "Bewegungspanorama exportieren",
                    tooltip: "Ein Panoramabild aus Video-Frames mittels Bewegungsverfolgungsversätzen erstellen",
                },
                exportVideo: {
                    label: "Panorama-Video exportieren",
                    tooltip: "Ein 4K-Video erstellen, das das Panorama mit Video-Frame-Overlay zeigt",
                },
                stabilize: {
                    label: "Video stabilisieren",
                    disableLabel: "Stabilisierung deaktivieren",
                    tooltip: "Video mittels globaler Bewegungsanalyse stabilisieren (entfernt Kameraverwacklung)",
                },
                panoFrameStep: {
                    label: "Panorama-Frame-Schritt",
                    tooltip: "Wie viele Frames zwischen jedem Panorama-Frame übersprungen werden (1 = jeder Frame)",
                },
                crop: {
                    label: "Panorama-Beschnitt",
                    tooltip: "Pixel, die von jedem Rand der Video-Frames abgeschnitten werden",
                },
                useMask: {
                    label: "Maske im Panorama verwenden",
                    tooltip: "Bewegungsverfolgungsmaske als Transparenz beim Rendern des Panoramas anwenden",
                },
                analyzeWithEffects: {
                    label: "Mit Effekten analysieren",
                    tooltip: "Videoanpassungen (Kontrast usw.) auf Frames anwenden, die für die Bewegungsanalyse verwendet werden",
                },
                exportWithEffects: {
                    label: "Mit Effekten exportieren",
                    tooltip: "Videoanpassungen auf Panorama-Exporte anwenden",
                },
                removeOuterBlack: {
                    label: "Äußeres Schwarz entfernen",
                    tooltip: "Schwarze Pixel an den Rändern jeder Zeile transparent machen",
                },
            },
            trackingParameters: {
                title: "Verfolgungsparameter",
                technique: {
                    label: "Technik",
                    tooltip: "Algorithmus zur Bewegungsschätzung",
                },
                frameSkip: {
                    label: "Frame-Überspringung",
                    tooltip: "Frames zwischen Vergleichen (höher = langsamere Bewegung erkennen)",
                },
                trackletLength: {
                    label: "Tracklet-Länge",
                    tooltip: "Anzahl der Frames im Tracklet (länger = strengere Kohärenz)",
                },
                blurSize: {
                    label: "Unschärfegröße",
                    tooltip: "Gaußsche Unschärfe für Makromerkmale (ungerade Zahlen)",
                },
                minMotion: {
                    label: "Minimale Bewegung",
                    tooltip: "Minimale Bewegungsmagnitude (Pixel/Frame)",
                },
                maxMotion: {
                    label: "Maximale Bewegung",
                    tooltip: "Maximale Bewegungsmagnitude",
                },
                smoothing: {
                    label: "Glättung",
                    tooltip: "Richtungsglättung (höher = stärkere Glättung)",
                },
                minVectorCount: {
                    label: "Minimale Vektoranzahl",
                    tooltip: "Mindestanzahl von Bewegungsvektoren für einen gültigen Frame",
                },
                minConfidence: {
                    label: "Minimale Konfidenz",
                    tooltip: "Minimale Konsens-Konfidenz für einen gültigen Frame",
                },
                maxFeatures: {
                    label: "Maximale Merkmale",
                    tooltip: "Maximale Anzahl verfolgter Merkmale",
                },
                minDistance: {
                    label: "Minimaler Abstand",
                    tooltip: "Minimaler Abstand zwischen Merkmalen",
                },
                qualityLevel: {
                    label: "Qualitätsstufe",
                    tooltip: "Schwellenwert für die Merkmalserkennung",
                },
                maxTrackError: {
                    label: "Maximaler Verfolgungsfehler",
                    tooltip: "Maximaler Schwellenwert für den Verfolgungsfehler",
                },
                minQuality: {
                    label: "Minimale Qualität",
                    tooltip: "Mindestqualität zur Anzeige des Pfeils",
                },
                staticThreshold: {
                    label: "Statischer Schwellenwert",
                    tooltip: "Bewegung unterhalb dieses Werts wird als statisch (HUD) betrachtet",
                },
            },
        },
        status: {
            loadingOpenCv: "Lade OpenCV...",
            stopAnalysis: "Analyse stoppen",
            analyzingPercent: "Analysiere... {{pct}}%",
            creatingTrack: "Erstelle Track...",
            buildingPanorama: "Erstelle Panorama...",
            buildingPanoramaPercent: "Erstelle Panorama... {{pct}}%",
            loadingFrame: "Lade Frame {{frame}}... ({{current}}/{{total}})",
            loadingFrameSkipped: "Lade Frame {{frame}}... ({{current}}/{{total}}) ({{skipped}} übersprungen)",
            renderingPercent: "Rendern... {{pct}}%",
            panoPercent: "Panorama... {{pct}}%",
            renderingVideo: "Rendere Video...",
            videoPercent: "Video... {{pct}}%",
            saving: "Speichere...",
            buildingStabilization: "Erstelle Stabilisierung...",
            exportProgressTitle: "Exportiere Panorama-Video...",
        },
        errors: {
            noVideoView: "Keine Videoansicht gefunden.",
            noVideoData: "Keine Videodaten gefunden.",
            failedToLoadOpenCv: "OpenCV konnte nicht geladen werden: {{message}}",
            noOriginTrack: "Kein Ursprungs-Track gefunden. Ein Ziel- oder Kamera-Track wird benötigt, um die Startposition zu bestimmen.",
            videoEncodingUnsupported: "Videokodierung wird in diesem Browser nicht unterstützt",
            exportFailed: "Videoexport fehlgeschlagen: {{reason}}",
            panoVideoExportFailed: "Panorama-Videoexport fehlgeschlagen: {{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[BETA] Texterkennung",
            enable: {
                label: "Texterkennung aktivieren",
                disableLabel: "Texterkennung deaktivieren",
                tooltip: "Texterkennungsmodus auf dem Video umschalten",
            },
            addRegion: {
                label: "Region hinzufügen",
                drawingLabel: "Klicken und auf dem Video ziehen...",
                tooltip: "Auf dem Video klicken und ziehen, um eine Texterkennungsregion zu definieren",
            },
            removeRegion: {
                label: "Ausgewählte Region entfernen",
                tooltip: "Die aktuell ausgewählte Region entfernen",
            },
            clearRegions: {
                label: "Alle Regionen löschen",
                tooltip: "Alle Texterkennungsregionen entfernen",
            },
            startExtract: {
                label: "Erkennung starten",
                stopLabel: "Erkennung stoppen",
                tooltip: "OCR auf allen Regionen vom aktuellen Frame bis zum Ende ausführen",
            },
            fixedWidthFont: {
                label: "Festbreitenschrift",
                tooltip: "Zeichenweise Erkennung für Festbreitenschriften aktivieren (besser für FLIR/Sensor-Overlays)",
            },
            numChars: {
                label: "Anzahl Zeichen",
                tooltip: "Anzahl der Zeichen in der ausgewählten Region (teilt die Region gleichmäßig auf)",
            },
            learnTemplates: {
                label: "Vorlagen lernen",
                activeLabel: "Klicken Sie auf Zeichen zum Lernen...",
                tooltip: "Auf Zeichenzellen klicken, um deren Werte beizubringen (für Vorlagenabgleich)",
            },
            clearTemplates: {
                label: "Vorlagen löschen",
                tooltip: "Alle gelernten Zeichenvorlagen entfernen",
            },
            useTemplates: {
                label: "Vorlagen verwenden",
                tooltip: "Gelernte Vorlagen für den Abgleich verwenden (schneller und genauer nach Training)",
            },
        },
        prompts: {
            learnCharacter: "Zeichen für Zelle {{index}} eingeben:",
        },
        errors: {
            failedToLoadTesseract: "Tesseract.js konnte nicht geladen werden. Stellen Sie sicher, dass es installiert ist: npm install tesseract.js",
            noVideoView: "Texterkennung benötigt eine Videoansicht",
        },
    },
    custom: {
        settings: {
            title: "Einstellungen",
            tooltipLoggedIn: "Benutzerspezifische Einstellungen, auf dem Server gespeichert (mit Cookie-Sicherung)",
            tooltipAnonymous: "Benutzerspezifische Einstellungen, in Browser-Cookies gespeichert",
            language: { label: "Sprache", tooltip: "Oberflächensprache auswählen. Beim Ändern wird die Seite neu geladen. Sie verlieren nicht gespeicherte Arbeit, also speichern Sie zuerst!" },
            maxDetails: { label: "Maximale Details", tooltip: "Maximale Detailstufe für die Geländeunterteilung (5-30)" },
            fpsLimit: { label: "Bildratenbegrenzung", tooltip: "Maximale Bildrate festlegen (60, 30, 20 oder 15 fps)" },
            tileSegments: { label: "Kachelsegmente", tooltip: "Gitterauflösung für Geländekacheln. Höhere Werte = mehr Detail, aber langsamer" },
            maxResolution: { label: "Maximale Auflösung", tooltip: "Maximale Video-Frame-Auflösung (längste Seite). Reduziert GPU-Speicherverbrauch. Gilt für neu geladene Frames." },
            aiModel: { label: "KI-Modell", tooltip: "KI-Modell für den Chat-Assistenten auswählen" },
            centerSidebar: { label: "Mittlere Seitenleiste", tooltip: "Mittlere Seitenleiste zwischen geteilten Ansichten aktivieren (Menüs zur Trennlinie ziehen)" },
            showAttribution: { label: "Quellenangabe anzeigen", tooltip: "Quellenangabe für Karten- und Höhendaten als Overlay anzeigen" },
        },
        balloons: {
            count: { label: "Anzahl", tooltip: "Anzahl der zu importierenden nahegelegenen Stationen" },
            source: { label: "Quelle", tooltip: "uwyo = University of Wyoming (benötigt PHP-Proxy)\nigra2 = NOAA NCEI-Archiv (Direktdownload)" },
            getNearby: { label: "Nahegelegene Wetterballons abrufen", tooltip: "Die N nächstgelegenen Wetterballon-Sondierungen zur aktuellen Kameraposition importieren.\nVerwendet den letzten Start vor der Sitch-Startzeit + 1 Stunde." },
            importSounding: { label: "Sondierung importieren...", tooltip: "Manuelle Stationsauswahl: Station, Datum, Quelle wählen und eine bestimmte Sondierung importieren." },
        },
        showHide: {
            keyboardShortcuts: { label: "[K]Tastenkürzel", tooltip: "Tastenkürzel-Overlay anzeigen oder verbergen" },
            toggleExtendToGround: { label: "ALLE [E]rweiterungen zum Boden umschalten", tooltip: "‚Zum Boden erweitern' für alle Tracks umschalten\nSchaltet alle aus, wenn welche an sind\nSchaltet alle ein, wenn keine an sind" },
            showAllTracksInLook: { label: "Alle Tracks in Blickansicht anzeigen", tooltip: "Alle Flugzeug-Tracks in der Blick-/Kameraansicht anzeigen" },
            showCompassElevation: { label: "Kompasserhöhung anzeigen", tooltip: "Kompasserhöhung (Winkel über der lokalen Bodenebene) zusätzlich zur Peilung (Azimut) anzeigen" },
            filterTracks: { label: "Tracks filtern", tooltip: "Tracks basierend auf Höhe, Richtung oder Frustum-Schnittmenge anzeigen/verbergen" },
            removeAllTracks: { label: "Alle Tracks entfernen", tooltip: "Alle Tracks aus der Szene entfernen\nDies entfernt nicht die Objekte, nur die Tracks\nSie können sie später durch erneutes Ziehen und Ablegen der Dateien wieder hinzufügen" },
        },
        objects: {
            globalScale: { label: "Globaler Maßstab", tooltip: "Skalierungsfaktor für alle 3D-Objekte in der Szene – nützlich zum Finden von Dingen. Auf 1 zurücksetzen für reale Größe" },
        },
        admin: {
            dashboard: { label: "Admin-Dashboard", tooltip: "Das Admin-Dashboard öffnen" },
            validateAllSitches: { label: "Alle Sitches validieren", tooltip: "Alle gespeicherten Sitches mit lokalem Gelände laden, um nach Fehlern zu suchen" },
            testUserID: { label: "Test-Benutzer-ID", tooltip: "Als diese Benutzer-ID agieren (0 = deaktiviert, muss > 1 sein)" },
            addMissingScreenshots: { label: "Fehlende Screenshots hinzufügen", tooltip: "Jeden Sitch ohne Screenshot laden, rendern und einen Screenshot hochladen" },
            feature: { label: "Hervorheben", tooltip: "Hervorhebungsstatus für den aktuell geladenen Sitch umschalten" },
        },
        viewPreset: { label: "Ansichtsvorlage", tooltip: "Zwischen verschiedenen Ansichtsvorlagen wechseln\nNebeneinander, Oben und Unten usw." },
        subSitches: {
            folder: { tooltip: "Mehrere Kamera-/Ansichtskonfigurationen innerhalb dieses Sitches verwalten" },
            updateCurrent: { label: "Aktuellen Sub aktualisieren", tooltip: "Den aktuell ausgewählten Sub-Sitch mit den aktuellen Ansichtseinstellungen aktualisieren" },
            updateAndAddNew: { label: "Aktuellen aktualisieren und neuen hinzufügen", tooltip: "Aktuellen Sub-Sitch aktualisieren, dann in einen neuen Sub-Sitch duplizieren" },
            discardAndAddNew: { label: "Änderungen verwerfen und neuen hinzufügen", tooltip: "Änderungen am aktuellen Sub-Sitch verwerfen und einen neuen Sub-Sitch aus dem aktuellen Zustand erstellen" },
            renameCurrent: { label: "Aktuellen Sub umbenennen", tooltip: "Den aktuell ausgewählten Sub-Sitch umbenennen" },
            deleteCurrent: { label: "Aktuellen Sub löschen", tooltip: "Den aktuell ausgewählten Sub-Sitch löschen" },
            syncSaveDetails: { label: "Sub-Speicherdetails synchronisieren", tooltip: "Aus dem aktuellen Sub alle Knoten entfernen, die in den Sub-Speicherdetails nicht aktiviert sind" },
        },
        contextMenu: {
            setCameraAbove: "Kamera darüber setzen",
            setCameraOnGround: "Kamera auf den Boden setzen",
            setTargetAbove: "Ziel darüber setzen",
            setTargetOnGround: "Ziel auf den Boden setzen",
            dropPin: "Markierung setzen / Feature hinzufügen",
            createTrackWithObject: "Track mit Objekt erstellen",
            createTrackNoObject: "Track erstellen (ohne Objekt)",
            addBuilding: "Gebäude hinzufügen",
            addClouds: "Wolken hinzufügen",
            addGroundOverlay: "Boden-Overlay hinzufügen",
            centerTerrain: "Geländequadrat hier zentrieren",
            googleMapsHere: "Google Maps hier",
            googleEarthHere: "Google Earth hier",
            removeClosestPoint: "Nächsten Punkt entfernen",
            exitEditMode: "Bearbeitungsmodus verlassen",
        },
    },
    view3d: {
        northUp: { label: "Blickansicht nach Norden ausgerichtet", tooltip: "Die Blickansicht nach Norden ausrichten statt nach oben.\nFür Satellitenansichten und Ähnliches, mit Blick senkrecht nach unten.\nGilt nicht im PTZ-Modus" },
        atmosphere: { label: "Atmosphäre", tooltip: "Entfernungsabschwächung, die Gelände und 3D-Objekte zur aktuellen Himmelsfarbe hin überblended" },
        atmoVisibility: { label: "Atmosphärensicht (km)", tooltip: "Entfernung, bei der der atmosphärische Kontrast auf etwa 50 % fällt (kleiner = dickere Atmosphäre)" },
        atmoHDR: { label: "Atmosphäre HDR", tooltip: "Physikalisch basierter HDR-Nebel/Tone-Mapping für helle Sonnenreflexionen durch Dunst" },
        atmoExposure: { label: "Atmosphärenbelichtung", tooltip: "HDR-Atmosphäre Tone-Mapping-Belichtungsmultiplikator für Spitzlichter-Rolloff" },
        startXR: { label: "VR/XR starten", tooltip: "WebXR-Sitzung zum Testen starten (funktioniert mit dem Immersive Web Emulator)" },
        effects: { label: "Effekte", tooltip: "Alle Effekte aktivieren/deaktivieren" },
        focusTrack: { label: "Fokus-Track", tooltip: "Einen Track auswählen, auf den die Kamera blickt und um den sie rotiert" },
        lockTrack: { label: "Lock-Track", tooltip: "Einen Track auswählen, an den die Kamera gebunden wird, sodass sie sich mit dem Track bewegt" },
        debug: {
            clearBackground: "Hintergrund löschen", renderSky: "Himmel rendern", renderDaySky: "Tageshimmel rendern",
            renderMainScene: "Hauptszene rendern", renderEffects: "Effekte rendern", copyToScreen: "Auf Bildschirm kopieren",
            updateCameraMatrices: "Kameramatrizen aktualisieren", mainUseLookLayers: "Haupt: Blick-Ebenen verwenden",
            sRGBOutputEncoding: "sRGB-Ausgabekodierung", tileLoadDelay: "Kachelladezeit (s)",
            updateStarScales: "Sternskalierung aktualisieren", updateSatelliteScales: "Satellitenskalierung aktualisieren",
            renderNightSky: "Nachthimmel rendern", renderFullscreenQuad: "Vollbild-Quad rendern", renderSunSky: "Sonnenhimmel rendern",
        },
        celestial: {
            raHours: "RA (Stunden)", decDegrees: "Dek (Grad)", magnitude: "Helligkeit",
            noradNumber: "NORAD-Nummer", name: "Name",
        },
    },
    nightSky: {
        loadLEO: { label: "LEO-Satelliten für Datum laden", tooltip: "Die neuesten LEO-Satelliten-TLE-Daten für das eingestellte Simulationsdatum/-zeit abrufen. Dies lädt Daten aus dem Internet herunter und kann einige Sekunden dauern.\nDie Satelliten werden auch im Nachthimmel angezeigt." },
        loadStarlink: { label: "AKTUELLE Starlink laden", tooltip: "Die AKTUELLEN (nicht historischen, jetzt, in Echtzeit) Starlink-Satellitenpositionen abrufen. Dies lädt Daten aus dem Internet herunter und kann einige Sekunden dauern.\n" },
        loadActive: { label: "AKTIVE Satelliten laden", tooltip: "Die AKTUELLEN (nicht historischen, jetzt, in Echtzeit) AKTIVEN Satellitenpositionen abrufen. Dies lädt Daten aus dem Internet herunter und kann einige Sekunden dauern.\n" },
        loadSlow: { label: "(Experimentell) LANGSAME Satelliten laden", tooltip: "Die neuesten LANGSAMEN Satelliten-TLE-Daten für das eingestellte Simulationsdatum/-zeit abrufen. Dies lädt Daten aus dem Internet herunter und kann einige Sekunden dauern.\nDie Satelliten werden auch im Nachthimmel angezeigt. Kann bei aktuellen Daten zu einem Timeout führen" },
        loadAll: { label: "(Experimentell) ALLE Satelliten laden", tooltip: "Die neuesten Satelliten-TLE-Daten für ALLE Satelliten für das eingestellte Simulationsdatum/-zeit abrufen. Dies lädt Daten aus dem Internet herunter und kann einige Sekunden dauern.\nDie Satelliten werden auch im Nachthimmel angezeigt. Kann bei aktuellen Daten zu einem Timeout führen" },
        flareAngle: { label: "Flare-Winkelausbreitung", tooltip: "Maximaler Winkel des reflektierten Blickvektors, damit ein Flare sichtbar ist\nd. h. der Winkelbereich zwischen dem Vektor vom Satelliten zur Sonne und dem Vektor von der Kamera zum Satelliten, reflektiert an der Unterseite des Satelliten (die parallel zum Boden ist)" },
        penumbraDepth: { label: "Halbschatten-Tiefe der Erde", tooltip: "Vertikale Tiefe in Metern, über die ein Satellit ausblendet, wenn er in den Erdschatten eintritt" },
        sunAngleArrows: { label: "Sonnenwinkel-Pfeile", tooltip: "Wenn ein Flare erkannt wird, Pfeile von der Kamera zum Satelliten und dann vom Satelliten zur Sonne anzeigen" },
        celestialFolder: { tooltip: "Nachthimmelbezogene Elemente" },
        vectorsOnTraverse: { label: "Vektoren am Traverse-Objekt", tooltip: "Wenn aktiviert, werden die Vektoren relativ zum Traverse-Objekt angezeigt. Andernfalls werden sie relativ zur Blickkamera angezeigt." },
        vectorsInLookView: { label: "Vektoren in Blickansicht", tooltip: "Wenn aktiviert, werden die Vektoren in der Blickansicht angezeigt. Andernfalls nur in der Hauptansicht." },
        showSatellitesGlobal: { label: "Satelliten anzeigen (global)", tooltip: "Hauptschalter: alle Satelliten anzeigen oder verbergen" },
        showStarlink: { label: "Starlink", tooltip: "SpaceX Starlink-Satelliten anzeigen" },
        showISS: { label: "ISS", tooltip: "Die Internationale Raumstation anzeigen" },
        celestrackBrightest: { label: "Celestracks hellste", tooltip: "Celestracks Liste der hellsten Satelliten anzeigen" },
        otherSatellites: { label: "Andere Satelliten", tooltip: "Satelliten anzeigen, die nicht in den obigen Kategorien enthalten sind" },
        list: { label: "Liste", tooltip: "Eine Textliste sichtbarer Satelliten anzeigen" },
        satelliteArrows: { label: "Satellitenpfeile", tooltip: "Pfeile zur Anzeige von Satellitentrajektorien anzeigen" },
        flareLines: { label: "Flare-Linien", tooltip: "Linien anzeigen, die aufblitzende Satelliten mit der Kamera und der Sonne verbinden" },
        satelliteGroundArrows: { label: "Satelliten-Bodenpfeile", tooltip: "Pfeile zum Boden unter jedem Satelliten anzeigen" },
        satelliteLabelsLook: { label: "Satellitenlabels (Blickansicht)", tooltip: "Satellitennamen-Labels in der Blick-/Kameraansicht anzeigen" },
        satelliteLabelsMain: { label: "Satellitenlabels (Hauptansicht)", tooltip: "Satellitennamen-Labels in der 3D-Hauptansicht anzeigen" },
        labelFlaresOnly: { label: "Nur Flares beschriften", tooltip: "Nur Satelliten beschriften, die gerade aufblitzen" },
        labelLitOnly: { label: "Nur beleuchtete beschriften", tooltip: "Nur Satelliten beschriften, die sonnenbeleuchtet sind (nicht im Erdschatten)" },
        labelLookVisibleOnly: { label: "Nur in Blickansicht sichtbare beschriften", tooltip: "Nur Satelliten beschriften, die im Frustum der Blickkamera sichtbar sind" },
        flareRegion: { label: "Flare-Region", tooltip: "Die Himmelsregion anzeigen, in der Satellitenflares sichtbar sind" },
        flareBand: { label: "Flare-Band", tooltip: "Das Band auf dem Boden anzeigen, über das Flares eines Satellitentracks streichen" },
        filterTLEs: { label: "TLEs filtern", tooltip: "Sichtbare Satelliten nach Höhe, Position, Orbitalparametern oder Name filtern" },
        clearTLEFilter: { label: "TLE-Filter löschen", tooltip: "Alle räumlichen/orbitalen TLE-Filter entfernen und kategoriebasierte Sichtbarkeit wiederherstellen" },
        maxLabelsDisplayed: { label: "Maximale Labels angezeigt", tooltip: "Maximale Anzahl gleichzeitig gerendeter Satellitenlabels" },
        starBrightness: { label: "Sternhelligkeit", tooltip: "Skalierungsfaktor für die Helligkeit der Sterne. 1 ist normal, 0 ist unsichtbar, 2 ist doppelt so hell usw." },
        starLimit: { label: "Sternlimit", tooltip: "Helligkeitslimit für angezeigte Sterne" },
        planetBrightness: { label: "Planetenhelligkeit", tooltip: "Skalierungsfaktor für die Helligkeit der Planeten (außer Sonne und Mond). 1 ist normal, 0 ist unsichtbar, 2 ist doppelt so hell usw." },
        lockStarPlanetBrightness: { label: "Stern-/Planetenhelligkeit koppeln", tooltip: "Wenn aktiviert, sind die Schieberegler für Stern- und Planetenhelligkeit miteinander gekoppelt" },
        satBrightness: { label: "Satellitenhelligkeit", tooltip: "Skalierungsfaktor für die Helligkeit der Satelliten. 1 ist normal, 0 ist unsichtbar, 2 ist doppelt so hell usw." },
        flareBrightness: { label: "Flare-Helligkeit", tooltip: "Skalierungsfaktor für die zusätzliche Helligkeit aufblitzender Satelliten. 0 ist nichts" },
        satCutOff: { label: "Satelliten-Grenzwert", tooltip: "Satelliten, die auf dieses Niveau oder weniger abgedimmt sind, werden nicht angezeigt" },
        displayRange: { label: "Anzeigereichweite (km)", tooltip: "Satelliten jenseits dieser Entfernung werden ohne Namen oder Pfeile angezeigt" },
        equatorialGrid: { label: "Äquatorialgitter", tooltip: "Das himmlische Äquatorialkoordinatengitter anzeigen" },
        constellationLines: { label: "Sternbildlinien", tooltip: "Linien zwischen Sternen in Sternbildern anzeigen" },
        renderStars: { label: "Sterne rendern", tooltip: "Sterne am Nachthimmel anzeigen" },
        equatorialGridLook: { label: "Äquatorialgitter in Blickansicht", tooltip: "Das Äquatorialgitter in der Blick-/Kameraansicht anzeigen" },
        flareRegionLook: { label: "Flare-Region in Blickansicht", tooltip: "Den Flare-Regionskegel in der Blickkameraansicht anzeigen" },
        satelliteEphemeris: { label: "Satellitenephemeriden" },
        skyPlot: { label: "Himmelsdiagramm" },
        celestialVector: { label: "{{name}}-Vektor", tooltip: "Einen Richtungsvektor anzeigen, der auf {{name}} zeigt" },
    },
    synthClouds: {
        name: { label: "Name" },
        visible: { label: "Sichtbar" },
        editMode: { label: "Bearbeitungsmodus" },
        altitude: { label: "Höhe" },
        radius: { label: "Radius" },
        cloudSize: { label: "Wolkengröße" },
        density: { label: "Dichte" },
        opacity: { label: "Deckkraft" },
        brightness: { label: "Helligkeit" },
        depth: { label: "Tiefe" },
        edgeWiggle: { label: "Randwelligkeit" },
        edgeFrequency: { label: "Randfrequenz" },
        seed: { label: "Seed" },
        feather: { label: "Weiche Kante" },
        windMode: { label: "Windmodus" },
        windFrom: { label: "Wind aus (\u00b0)" },
        windKnots: { label: "Wind (Knoten)" },
        deleteClouds: { label: "Wolken löschen" },
    },
    synthBuilding: {
        name: { label: "Name" },
        visible: { label: "Sichtbar" },
        editMode: { label: "Bearbeitungsmodus" },
        roofEdgeHeight: { label: "Dachkantenhöhe" },
        ridgelineHeight: { label: "Firsthöhe" },
        ridgelineInset: { label: "Firsteinzug" },
        roofEaves: { label: "Dachtraufe" },
        type: { label: "Typ" },
        wallColor: { label: "Wandfarbe" },
        roofColor: { label: "Dachfarbe" },
        opacity: { label: "Deckkraft" },
        transparent: { label: "Transparent" },
        wireframe: { label: "Drahtgitter" },
        depthTest: { label: "Tiefentest" },
        deleteBuilding: { label: "Gebäude löschen" },
    },

    groundOverlay: {
        name: { label: "Name" },
        visible: { label: "Sichtbar" },
        editMode: { label: "Bearbeitungsmodus" },
        lockShape: { label: "Form sperren" },
        freeTransform: { label: "Frei transformieren" },
        showBorder: { label: "Rand anzeigen" },
        properties: { label: "Eigenschaften" },
        imageURL: { label: "Bild-URL" },
        rehostLocalImage: { label: "Lokales Bild neu hosten" },
        north: { label: "Norden" },
        south: { label: "Süden" },
        east: { label: "Osten" },
        west: { label: "Westen" },
        rotation: { label: "Rotation" },
        altitude: { label: "Höhe (ft)" },
        wireframe: { label: "Drahtgitter" },
        opacity: { label: "Deckkraft" },
        cloudExtraction: { label: "Wolkenextraktion" },
        extractClouds: { label: "Wolken extrahieren" },
        cloudColor: { label: "Wolkenfarbe" },
        fuzziness: { label: "Unschärfe" },
        feather: { label: "Weiche Kante" },
        gotoOverlay: { label: "Zum Overlay gehen" },
        deleteOverlay: { label: "Overlay löschen" },
    },

    videoView: {
        folders: {
            videoAdjustments: "Videoanpassungen",
            videoProcessing: "Videoverarbeitung",
            forensics: "Forensik",
            errorLevelAnalysis: "Fehlerstufenanalyse",
            noiseAnalysis: "Rauschanalyse",
            grid: "Gitter",
        },
        currentVideo: { label: "Aktuelles Video" },
        videoRotation: { label: "Videorotation" },
        setCameraToExifGps: { label: "Kamera auf EXIF-GPS setzen" },
        expandOutput: {
            label: "Ausgabe erweitern",
            tooltip: "Methode zur Erweiterung des dynamischen Bereichs der ELA-Ausgabe",
        },
        displayMode: {
            label: "Anzeigemodus",
            tooltip: "Wie die Ergebnisse der Rauschanalyse visualisiert werden",
        },
        convolutionFilter: {
            label: "Faltungsfilter",
            tooltip: "Typ des anzuwendenden räumlichen Faltungsfilters",
        },
        resetVideoAdjustments: {
            label: "Videoanpassungen zurücksetzen",
            tooltip: "Alle Videoanpassungen auf ihre Standardwerte zurücksetzen",
        },
        makeVideo: {
            label: "Video erstellen",
            tooltip: "Das verarbeitete Video mit allen aktuellen Effekten exportieren",
        },
        gridShow: {
            label: "Anzeigen",
            tooltip: "Ein Gitter-Overlay auf dem Video anzeigen",
        },
        gridSize: {
            label: "Größe",
            tooltip: "Gitterzellengröße in Pixeln",
        },
        gridSubdivisions: {
            label: "Unterteilungen",
            tooltip: "Anzahl der Unterteilungen innerhalb jeder Gitterzelle",
        },
        gridXOffset: {
            label: "X-Versatz",
            tooltip: "Horizontaler Versatz des Gitters in Pixeln",
        },
        gridYOffset: {
            label: "Y-Versatz",
            tooltip: "Vertikaler Versatz des Gitters in Pixeln",
        },
        gridColor: {
            label: "Farbe",
            tooltip: "Farbe der Gitterlinien",
        },
    },

    floodSim: {
        flood: {
            label: "Flut",
            tooltip: "Flut-Partikelsimulation aktivieren oder deaktivieren",
        },
        floodRate: {
            label: "Flutrate",
            tooltip: "Anzahl der pro Frame erzeugten Partikel",
        },
        sphereSize: {
            label: "Kugelgröße",
            tooltip: "Visueller Radius jedes Wasserpartikels",
        },
        dropRadius: {
            label: "Tropfenradius",
            tooltip: "Radius um den Abwurfpunkt, in dem Partikel erzeugt werden",
        },
        maxParticles: {
            label: "Maximale Partikel",
            tooltip: "Maximale Anzahl aktiver Wasserpartikel",
        },
        method: {
            label: "Methode",
            tooltip: "Simulationsmethode: HeightMap (Gitter), Fast (Partikel) oder PBF (positionsbasierte Fluide)",
        },
        waterSource: {
            label: "Wasserquelle",
            tooltip: "Regen: Wasser über die Zeit hinzufügen. Dammbruch: Wasserstand auf Zielhöhe innerhalb des Tropfenradius halten",
        },
        speed: {
            label: "Geschwindigkeit",
            tooltip: "Simulationsschritte pro Frame (1-20x)",
        },
        manningN: {
            label: "Mannings N",
            tooltip: "Sohlrauheit: 0,01=glatt, 0,03=natürliches Gerinne, 0,05=raue Überflutungsfläche, 0,1=dichte Vegetation",
        },
        edge: {
            label: "Rand",
            tooltip: "Blockierend: Wasser wird an Gitterkanten reflektiert. Abfließend: Wasser fließt ab und wird entfernt",
        },
        waterColor: {
            label: "Wasserfarbe",
            tooltip: "Farbe des Wassers",
        },
        reset: {
            label: "Zurücksetzen",
            tooltip: "Alle Partikel entfernen und die Simulation neu starten",
        },
    },

    flowOrbs: {
        number: {
            label: "Anzahl",
            tooltip: "Anzahl der anzuzeigenden Strömungskugeln. Mehr Kugeln können die Leistung beeinträchtigen.",
        },
        spreadMethod: {
            label: "Verteilungsmethode",
            tooltip: "Methode zur Verteilung der Kugeln entlang des Kamerablickvektors.\n'Bereich' verteilt Kugeln gleichmäßig entlang des Blickvektors zwischen naher und ferner Entfernung.\n'Höhe' verteilt Kugeln gleichmäßig entlang des Blickvektors zwischen der niedrigen und hohen absoluten Höhe (MSL)",
        },
        near: {
            label: "Nah (m)",
            tooltip: "Nächste Entfernung von der Kamera für die Kugelplatzierung",
        },
        far: {
            label: "Fern (m)",
            tooltip: "Fernste Entfernung von der Kamera für die Kugelplatzierung",
        },
        high: { label: "Hoch (m)" },
        low: { label: "Niedrig (m)" },
        colorMethod: {
            label: "Farbmethode",
            tooltip: "Methode zur Bestimmung der Farbe der Strömungskugeln.\n'Zufällig' weist jeder Kugel eine zufällige Farbe zu.\n'Benutzer' weist allen Kugeln eine vom Benutzer gewählte Farbe zu.\n'Farbton nach Höhe' weist eine Farbe basierend auf der Höhe der Kugel zu.\n'Farbton nach Entfernung' weist eine Farbe basierend auf der Entfernung der Kugel von der Kamera zu.",
        },
        userColor: {
            label: "Benutzerfarbe",
            tooltip: "Farbe für die Strömungskugeln auswählen, wenn die 'Farbmethode' auf 'Benutzer' eingestellt ist.",
        },
        hueRange: {
            label: "Farbtonbereich",
            tooltip: "Bereich, über den ein vollständiges Farbspektrum für die Farbmethode 'Farbton nach Höhe/Entfernung' erzeugt wird.",
        },
        windWhilePaused: {
            label: "Wind bei Pause",
            tooltip: "Wenn aktiviert, beeinflusst Wind die Strömungskugeln auch bei pausierter Simulation. Nützlich zur Visualisierung von Windmustern.",
        },
    },

    osdController: {
        seriesName: {
            label: "Name",
        },
        seriesType: {
            label: "Typ",
        },
        seriesShow: {
            label: "Anzeigen",
        },
        seriesLock: {
            label: "Sperren",
        },
        removeTrack: {
            label: "Track entfernen",
        },
        folderTitle: {
            label: "OSD-Tracker",
            tooltip: "On-Screen-Display-Textverfolger für benutzerdefinierte Pro-Frame-Texte",
        },
        addNewTrack: {
            label: "Neue OSD-Datenreihe hinzufügen",
            tooltip: "Eine neue OSD-Datenreihe für Pro-Frame-Text-Overlay erstellen",
        },
        makeTrack: {
            label: "Track erstellen",
            tooltip: "Einen Positions-Track aus sichtbaren/nicht gesperrten OSD-Datenreihen erstellen (MGRS oder Lat/Lon)",
        },
        showAll: {
            label: "Alle anzeigen",
            tooltip: "Sichtbarkeit aller OSD-Datenreihen umschalten",
        },
        exportAllData: {
            label: "Alle Daten exportieren",
            tooltip: "Alle OSD-Datenreihen als CSVs in einer ZIP-Datei exportieren",
        },
        graphShow: {
            label: "Anzeigen",
            tooltip: "Die OSD-Datengraph-Ansicht anzeigen oder verbergen",
        },
        xAxis: {
            label: "X-Achse",
            tooltip: "Datenreihe für die horizontale Achse",
        },
        y1Axis: {
            label: "Y1-Achse",
            tooltip: "Datenreihe für die linke vertikale Achse",
        },
        y2Axis: {
            label: "Y2-Achse",
            tooltip: "Datenreihe für die rechte vertikale Achse",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "Videoinformationen",
            tooltip: "Steuerungen für Videoinformationen wie Frame-Zähler, Timecode und Zeitstempel",
        },
        showVideoInfo: {
            label: "Videoinformationen anzeigen",
            tooltip: "Hauptschalter – alle Videoinformationen aktivieren oder deaktivieren",
        },
        frameCounter: {
            label: "Frame-Zähler",
            tooltip: "Die aktuelle Frame-Nummer anzeigen",
        },
        offsetFrame: {
            label: "Versetzter Frame",
            tooltip: "Die aktuelle Frame-Nummer plus einen Versatzwert anzeigen",
        },
        offsetValue: {
            label: "Versatzwert",
            tooltip: "Versatzwert, der zur aktuellen Frame-Nummer addiert wird",
        },
        timecode: {
            label: "Timecode",
            tooltip: "Timecode im Format HH:MM:SS:FF anzeigen",
        },
        timestamp: {
            label: "Zeitstempel",
            tooltip: "Zeitstempel im Format HH:MM:SS.SS anzeigen",
        },
        dateLocal: {
            label: "Datum (lokal)",
            tooltip: "Aktuelles Datum in der ausgewählten Zeitzone anzeigen",
        },
        timeLocal: {
            label: "Uhrzeit (lokal)",
            tooltip: "Aktuelle Uhrzeit in der ausgewählten Zeitzone anzeigen",
        },
        dateTimeLocal: {
            label: "Datum & Uhrzeit (lokal)",
            tooltip: "Vollständiges Datum und Uhrzeit in der ausgewählten Zeitzone anzeigen",
        },
        dateUTC: {
            label: "Datum (UTC)",
            tooltip: "Aktuelles Datum in UTC anzeigen",
        },
        timeUTC: {
            label: "Uhrzeit (UTC)",
            tooltip: "Aktuelle Uhrzeit in UTC anzeigen",
        },
        dateTimeUTC: {
            label: "Datum & Uhrzeit (UTC)",
            tooltip: "Vollständiges Datum und Uhrzeit in UTC anzeigen",
        },
        fontSize: {
            label: "Schriftgröße",
            tooltip: "Die Schriftgröße des Infotextes anpassen",
        },
    },

    terrainUI: {
        mapType: {
            label: "Kartentyp",
            tooltip: "Kartentyp für Geländetexturen (unabhängig von Höhendaten)",
        },
        elevationType: {
            label: "Höhentyp",
            tooltip: "Datenquelle für Geländehöhendaten",
        },
        lat: {
            tooltip: "Breitengrad des Geländezentrums",
        },
        lon: {
            tooltip: "Längengrad des Geländezentrums",
        },
        zoom: {
            tooltip: "Zoomstufe des Geländes. 2 ist die ganze Welt, 15 sind einige Häuserblöcke",
        },
        nTiles: {
            tooltip: "Anzahl der Kacheln im Gelände. Mehr Kacheln bedeuten mehr Detail, aber langsameres Laden. (NxN)",
        },
        refresh: {
            label: "Aktualisieren",
            tooltip: "Das Gelände mit den aktuellen Einstellungen aktualisieren. Nützlich bei Netzwerkproblemen, die zu einem fehlgeschlagenen Laden geführt haben könnten",
        },
        debugGrids: {
            label: "Debug-Gitter",
            tooltip: "Ein Gitter aus Bodentexturen (Grün) und Höhendaten (Blau) anzeigen",
        },
        elevationScale: {
            tooltip: "Skalierungsfaktor für die Höhendaten. 1 ist normal, 0,5 ist halbe Höhe, 2 ist doppelte Höhe",
        },
        terrainOpacity: {
            label: "Gelände-Deckkraft",
            tooltip: "Deckkraft des Geländes. 0 ist vollständig transparent, 1 ist vollständig deckend",
        },
        textureDetail: {
            tooltip: "Detailstufe für Texturunterteilung. Höhere Werte = mehr Detail. 1 ist normal, 0,5 ist weniger Detail, 2 ist mehr Detail",
        },
        elevationDetail: {
            tooltip: "Detailstufe für Höhenunterteilung. Höhere Werte = mehr Detail. 1 ist normal, 0,5 ist weniger Detail, 2 ist mehr Detail",
        },
        disableDynamicSubdivision: {
            label: "Dynamische Unterteilung deaktivieren",
            tooltip: "Dynamische Unterteilung von Geländekacheln deaktivieren. Friert das Gelände auf der aktuellen Detailstufe ein. Nützlich zum Debuggen.",
        },
        dynamicSubdivision: {
            label: "Dynamische Unterteilung",
            tooltip: "Kameraadaptive Kachelunterteilung für globale Ansicht verwenden",
        },
        showBuildings: {
            label: "3D-Gebäude",
            tooltip: "3D-Gebäudekacheln von Cesium Ion oder Google anzeigen",
        },
        buildingEdges: {
            label: "Gebäudekanten",
            tooltip: "Drahtgitterkanten auf 3D-Gebäudekacheln anzeigen",
        },
        oceanSurface: {
            label: "Meeresoberfläche (Beta)",
            tooltip: "Experimentell: Wasseroberfläche auf Meereshöhe (festes EGM96 MSL) rendern, während Google Photorealistic-Kacheln aktiv sind",
        },
        buildingsSource: {
            label: "Gebäudequelle",
            tooltip: "Datenquelle für 3D-Gebäudekacheln",
        },
        useEllipsoid: {
            label: "Ellipsoid-Erdmodell verwenden",
            tooltip: "Kugel: schnelles Legacy-Modell. Ellipsoid: genaue WGS84-Form (höhere Breitengrade profitieren am meisten).",
        },
        layer: {
            label: "Ebene",
            tooltip: "Ebene für die Geländetexturen des aktuellen Kartentyps",
        },
    },

    displayTrack: {
        visible: {
            tooltip: "Diesen Track anzeigen oder verbergen",
        },
        extendToGround: {
            label: "Zum Boden erweitern",
            tooltip: "Vertikale Linien vom Track zum Boden zeichnen",
        },
        displayStep: {
            label: "Anzeigeschritt",
            tooltip: "Frame-Schritt zwischen angezeigten Track-Punkten (1 = jeder Frame)",
        },
        contrail: {
            label: "Kondensstreifen",
            tooltip: "Einen Kondensstreifen hinter diesem Track anzeigen, angepasst an den Wind",
        },
        contrailSecs: {
            label: "Kondensstreifen Sek.",
            tooltip: "Dauer des Kondensstreifens in Sekunden",
        },
        contrailWidth: {
            label: "Kondensstreifen Breite m",
            tooltip: "Maximale Breite des Kondensstreifens in Metern",
        },
        contrailInitialWidth: {
            label: "Kondensstreifen Anfangsbreite m",
            tooltip: "Breite des Kondensstreifens am Austrittspunkt in Metern",
        },
        contrailRamp: {
            label: "Kondensstreifen Anstieg m",
            tooltip: "Strecke, über die die Kondensstreifenbreite in Metern ansteigt",
        },
        contrailSpread: {
            label: "Kondensstreifen Ausbreitung m/s",
            tooltip: "Rate, mit der sich der Kondensstreifen in m/s nach außen ausbreitet",
        },
        lineColor: {
            label: "Linienfarbe",
            tooltip: "Farbe der Track-Linie",
        },
        polyColor: {
            label: "Polygonfarbe",
            tooltip: "Farbe der vertikalen Bodenerweiterungspolygone",
        },
        altLockAGL: {
            label: "Höhe fixieren AGL",
        },
        gotoTrack: {
            label: "Zum Track gehen",
            tooltip: "Die Hauptkamera auf den Standort dieses Tracks zentrieren",
        },
    },

    ptzUI: {
        panAz: {
            label: "Schwenk (Az)",
            tooltip: "Kameraazimut / Schwenkwinkel in Grad",
        },
        tiltEl: {
            label: "Neigung (El)",
            tooltip: "Kameraerhöhung / Neigungswinkel in Grad",
        },
        zoomFov: {
            label: "Zoom (FOV)",
            tooltip: "Vertikales Kamerasichtfeld in Grad",
        },
        roll: {
            label: "Rollen",
            tooltip: "Kamerarollwinkel in Grad",
        },
        xOffset: {
            label: "X-Versatz",
            tooltip: "Horizontaler Versatz der Kamera von der Mitte",
        },
        yOffset: {
            label: "Y-Versatz",
            tooltip: "Vertikaler Versatz der Kamera von der Mitte",
        },
        nearPlane: {
            label: "Nahe Ebene (m)",
            tooltip: "Entfernung der nahen Clipping-Ebene der Kamera in Metern",
        },
        relative: {
            label: "Relativ",
            tooltip: "Relative statt absolute Winkel verwenden",
        },
        satellite: {
            label: "Satellit",
            tooltip: "Satellitenmodus: Bildschirmbasiertes Schwenken vom Nadir.\nRollen = Kurs, Az = links/rechts, El = oben/unten (-90 = Nadir)",
        },
        rotation: {
            label: "Rotation",
            tooltip: "Bildschirmbasierte Rotation um die Kamerablickachse",
        },
    },

    nodes3dObject: {
        modelOrGeometry: {
            label: "Modell oder Geometrie",
            tooltip: "Wählen Sie, ob ein 3D-Modell oder eine generierte Geometrie für dieses Objekt verwendet werden soll",
        },
        model: {
            label: "Modell",
            tooltip: "Ein 3D-Modell für dieses Objekt auswählen",
        },
        displayBoundingBox: {
            label: "Begrenzungsrahmen anzeigen",
            tooltip: "Den Begrenzungsrahmen des Objekts mit Abmessungen anzeigen",
        },
        forceAboveSurface: {
            label: "Über Oberfläche erzwingen",
            tooltip: "Das Objekt erzwingen, vollständig über der Bodenoberfläche zu sein",
        },
        exportToKML: {
            label: "Als KML exportieren",
            tooltip: "Dieses 3D-Objekt als KML-Datei für Google Earth exportieren",
        },
        startAnalysis: {
            label: "Analyse starten",
            tooltip: "Strahlen von der Kamera aussenden, um Reflexionsrichtungen zu finden",
        },
        gridSize: {
            label: "Gittergröße",
            tooltip: "Anzahl der Abtastpunkte pro Achse für das Reflexionsgitter",
        },
        cleanUp: {
            label: "Aufräumen",
            tooltip: "Alle Reflexionsanalyse-Pfeile aus der Szene entfernen",
        },
    },

    trackingOverlay: {
        showTracking: {
            label: "Verfolgung anzeigen",
            tooltip: "Verfolgungspunkte und Kurven-Overlay anzeigen oder verbergen",
        },
        reset: {
            label: "Zurücksetzen",
            tooltip: "Manuelle Verfolgung auf einen leeren Zustand zurücksetzen, alle Keyframes und ziehbare Elemente entfernen",
        },
        limitAB: {
            label: "AB begrenzen",
            tooltip: "Die A- und B-Frames auf den Bereich der Video-Tracking-Keyframes begrenzen. Dies verhindert Extrapolation über den ersten und letzten Keyframe hinaus, was nicht immer erwünscht ist.",
        },
        curveType: {
            label: "Kurventyp",
            tooltip: "Spline verwendet natürliche kubische Splines. Spline2 verwendet Not-a-Knot-Splines für glatteres Endverhalten. Linear verwendet gerade Liniensegmente. Perspektive erfordert genau 3 Keyframes und modelliert lineare Bewegung mit Perspektivprojektion.",
        },
        minimizeGroundSpeed: {
            label: "Bodengeschwindigkeit minimieren",
            tooltip: "Die Ziel-Startentfernung finden, die die am Boden zurückgelegte Strecke des Traverse-Pfads minimiert",
        },
        minimizeAirSpeed: {
            label: "Fluggeschwindigkeit minimieren",
            tooltip: "Die Ziel-Startentfernung finden, die die in der Luft zurückgelegte Strecke minimiert (unter Berücksichtigung des Zielwinds)",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "Frustum-Bodenquadrat",
            tooltip: "Den Schnittpunkt des Kamerafrustums mit dem Boden anzeigen",
        },
        videoInFrustum: {
            label: "Video im Frustum",
            tooltip: "Das Video auf die ferne Ebene des Kamerafrustums projizieren",
        },
        videoOnGround: {
            label: "Video auf dem Boden",
            tooltip: "Das Video auf den Boden projizieren",
        },
        groundVideoInLookView: {
            label: "Bodenvideo in Blickansicht",
            tooltip: "Das auf den Boden projizierte Video in der Blickansicht anzeigen",
        },
        matchVideoAspect: {
            label: "Video-Seitenverhältnis anpassen",
            tooltip: "Die Blickansicht auf das Seitenverhältnis des Videos zuschneiden und das Frustum entsprechend anpassen",
        },
        videoOpacity: {
            label: "Video-Deckkraft",
            tooltip: "Deckkraft des projizierten Video-Overlays",
        },
    },

    labels3d: {
        measurements: {
            label: "Messungen",
            tooltip: "Entfernungs- und Winkelmessungslabels und -pfeile anzeigen",
        },
        labelsInMain: {
            label: "Labels in Hauptansicht",
            tooltip: "Track-/Objektlabels in der 3D-Hauptansicht anzeigen",
        },
        labelsInLook: {
            label: "Labels in Blickansicht",
            tooltip: "Track-/Objektlabels in der Blick-/Kameraansicht anzeigen",
        },
        featuresInMain: {
            label: "Markierungen/Pins in Hauptansicht",
            tooltip: "Markierungen (Pins) in der 3D-Hauptansicht anzeigen",
        },
        featuresInLook: {
            label: "Markierungen in Blickansicht",
            tooltip: "Markierungen in der Blick-/Kameraansicht anzeigen",
        },
    },

    losFitPhysics: {
        folder: "Physik-Anpassungsergebnisse",
        model: {
            label: "Modell",
        },
        avgError: {
            label: "Durchschn. Fehler (rad)",
        },
        windSpeed: {
            label: "Windgeschwindigkeit (kt)",
        },
        windFrom: {
            label: "Wind aus (\u00B0)",
        },
    },

    misbData: {
        startTime: {
            label: "Startzeit",
            tooltip: "Startzeit überschreiben (z. B. '10:30', '15. Jan.', '2024-01-15T10:30:00Z'). Leer lassen für globale Startzeit.",
        },
        enableFilter: {
            label: "Filter aktivieren",
        },
        tryAltitudeFirst: {
            label: "Höhe zuerst versuchen",
        },
        maxG: {
            label: "Max. G",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "Über Bodenniveau",
            tooltip: "Höhe ist relativ zum Bodenniveau, nicht zum Meeresspiegel",
        },
        lookup: {
            label: "Suche",
            tooltip: "Einen Ortsnamen, Lat/Lon-Koordinaten oder MGRS eingeben, um dorthin zu navigieren",
        },
        geolocate: {
            label: "Vom Browser geolokalisieren",
            tooltip: "Die Geolokalisierungs-API des Browsers verwenden, um die aktuelle Position zu bestimmen",
        },
        goTo: {
            label: "Zur obigen Position gehen",
            tooltip: "Gelände und Kamera zur eingegebenen Breite/Länge/Höhe bewegen",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "Stoppen bei",
            tooltip: "Die Bewegung des Kameraziels bei diesem Frame stoppen, auch wenn der Zieltrack weitergeht. Dies ist nützlich, um den Verlust der Zielverfolgung auf ein sich bewegendes Ziel zu simulieren. Auf 0 setzen zum Deaktivieren.",
        },
        horizonMethod: {
            label: "Horizontmethode",
        },
        lookFOV: {
            label: "Blick-FOV",
        },
        celestialObject: {
            label: "Himmelskörper",
            tooltip: "Name des Himmelskörpers, den die Kamera verfolgt (z. B. Mond, Venus, Jupiter)",
        },
    },

    spriteGroup: {
        visible: {
            label: "Sichtbar",
            tooltip: "Strömungskugeln anzeigen oder verbergen",
        },
        size: {
            label: "Größe (m)",
            tooltip: "Durchmesser in Metern.",
        },
        viewSizeMultiplier: {
            label: "Ansichtsgrößen-Multiplikator",
            tooltip: "Passt die Größe der Strömungskugeln in der Hauptansicht an, ändert aber nicht die Größe in anderen Ansichten.",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "Bester Winkel, volle 180, verfeinert",
        },
        bestAngle5: {
            label: "Bester Winkel innerhalb 5\u00B0 des aktuellen",
        },
    },

    misc: {
        snapshotCamera: {
            label: "Kamera-Schnappschuss",
            tooltip: "Die aktuelle Kameraposition und -ausrichtung für 'Kamera zurücksetzen' speichern",
        },
        resetCamera: {
            label: "Kamera zurücksetzen",
            tooltip: "Die Kamera auf die Standardeinstellung oder die letzte gespeicherte Position und Ausrichtung zurücksetzen\nAuch Numpad-.",
        },
        showMoonShadow: {
            label: "Mondschatten anzeigen",
            tooltip: "Die Anzeige des Mondschattenkegels für die Sonnenfinsternisvisualisierung umschalten.",
        },
        shadowSegments: {
            label: "Schattensegmente",
            tooltip: "Anzahl der Segmente im Schattenkegel (mehr = glatter, aber langsamer)",
        },
        showEarthShadow: {
            label: "Erdschatten anzeigen",
            tooltip: "Die Anzeige des Erdschattenkegels am Nachthimmel umschalten.",
        },
        earthShadowAltitude: {
            label: "Erdschatten-Höhe",
            tooltip: "Entfernung vom Erdmittelpunkt zur Ebene, auf der der Erdschattenkegel gerendert wird (in Metern).",
        },
        exportTLE: {
            label: "TLE exportieren",
        },
        backgroundFlowIndicator: {
            label: "Hintergrundfluss-Indikator",
            tooltip: "Einen Pfeil anzeigen, der angibt, wie stark sich der Hintergrund im nächsten Frame bewegt.\nNützlich zur Synchronisation der Simulation mit dem Video (verwenden Sie Ansicht/Video-Overlay)",
        },
        defaultSnap: {
            label: "Standard-Einrasten",
            tooltip: "Wenn aktiviert, rasten Punkte beim Ziehen standardmäßig an der horizontalen Ausrichtung ein.\nHalten Sie Umschalt (beim Ziehen) für das Gegenteil",
        },
        recalcNodeGraph: {
            label: "Knotengraph neu berechnen",
        },
        downloadVideo: {
            label: "Video herunterladen",
        },
        banking: {
            label: "Schräglage",
            tooltip: "Wie sich das Objekt in Kurven neigt/kippt",
        },
        angularTraverse: {
            label: "Winkeldurchlauf",
        },
        smoothingMethod: {
            label: "Glättungsmethode",
            tooltip: "Algorithmus zur Glättung der Kamera-Track-Daten",
        },
        showInLookView: {
            label: "In Blickansicht anzeigen",
        },
        windFrom: {
            tooltip: "Wahre Richtung, aus der der Wind weht (0=Norden, 90=Osten)",
        },
        windKnots: {
            tooltip: "Windgeschwindigkeit in Knoten",
        },
        fetchWind: {
            tooltip: "Echte Winddaten von Wetterdiensten für diesen Standort und diese Zeit abrufen",
        },
        debugConsole: {
            label: "Debug-Konsole",
            tooltip: "Debug-Konsole",
        },
        aiAssistant: {
            label: "KI-Assistent",
        },
        hide: {
            label: "Verbergen",
            tooltip: "Diese Registerkartenansicht verbergen\nUm sie wieder anzuzeigen, verwenden Sie das Menü 'Anzeigen/Verbergen -> Ansichten'.",
        },
        notes: {
            label: "Notizen",
            tooltip: "Notiz-Editor anzeigen/verbergen. Notizen werden mit dem Sitch gespeichert und können anklickbare Hyperlinks enthalten.",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "Sichtlinien",
            tooltip: "Sichtlinien von der Kamera zum Ziel anzeigen (Umschalten: O)",
        },
        physicalPointer: {
            label: "Physischer Zeiger",
        },
        jet: {
            label: "[J]et",
        },
        horizonGrid: {
            label: "[H]orizontgitter",
        },
        wingPlaneGrid: {
            label: "[W]Tragflächenebenen-Gitter",
        },
        sphericalBoresightGrid: {
            label: "[S]phärisches Visiergitter",
        },
        azimuthElevationGrid: {
            label: "[A]zimut/Elevationsgitter",
        },
        frustumOfCamera: {
            label: "F[R]ustum der Kamera",
        },
        trackLine: {
            label: "[T]rack-Linie",
        },
        globe: {
            label: "[G]lobus",
        },
        showErrorCircle: {
            label: "Fehlerkreis anzeigen",
        },
        glareSprite: {
            label: "Blend-Spr[I]te",
        },
        cameraViewFrustum: {
            label: "Kamera-Sichtfrustum",
            tooltip: "Das Sichtfrustum der Kamera in der 3D-Szene anzeigen",
        },
        zaineTriangulation: {
            label: "Zaine-Triangulation",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "Umgebungslichtintensität",
            tooltip: "Umgebungslichtintensität. 0 ist kein Umgebungslicht, 1 ist normales Umgebungslicht, 2 ist doppeltes Umgebungslicht",
        },
        irAmbientIntensity: {
            label: "IR-Umgebungslichtintensität",
            tooltip: "IR-Umgebungslichtintensität (für IR-Viewports verwendet)",
        },
        sunIntensity: {
            label: "Sonnenlichtintensität",
            tooltip: "Sonnenlichtintensität. 0 ist kein Sonnenlicht, 1 ist normales volles Sonnenlicht, 2 ist doppeltes Sonnenlicht",
        },
        sunScattering: {
            label: "Sonnenstreuung",
            tooltip: "Stärke der Sonnenlichtstreuung",
        },
        sunBoost: {
            label: "Sonnenverstärkung (HDR)",
            tooltip: "Multiplikator für die Intensität des Sonnen-DirectionalLight (HDR). Erhöht die Spiegellichthelligkeit für realistische Sonnenreflexionen durch Nebel.",
        },
        sceneExposure: {
            label: "Szenenbelichtung (HDR)",
            tooltip: "Belichtungskorrektur für HDR-Tone-Mapping. Niedriger einstellen, um eine höhere Sonnenverstärkung zu kompensieren.",
        },
        ambientOnly: {
            label: "Nur Umgebungslicht",
            tooltip: "Wenn aktiviert, wird nur Umgebungslicht verwendet, kein Sonnenlicht",
        },
        daylightSky: {
            label: "Tageshimmel",
            tooltip: "Den (blauen) Tageshimmel rendern.\nAusschalten, um den Beitrag des Tageshimmels zu entfernen — nützlich, um Sterne bei Tageslicht zu sehen oder Nachthimmel-Objekte zu debuggen.",
        },
        noMainLighting: {
            label: "Keine Beleuchtung in Hauptansicht",
            tooltip: "Wenn aktiviert, wird keine Beleuchtung in der Hauptansicht verwendet.\nDies ist nützlich zum Debuggen, aber nicht für den normalen Gebrauch empfohlen",
        },
        noCityLights: {
            label: "Keine Stadtlichter auf Globus",
            tooltip: "Wenn aktiviert, werden keine Stadtlichter auf dem Globus gerendert.",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "ADSB-Wiedergabe für diese Zeit und diesen Ort",
            tooltip: "Einen Link zur ADSB Exchange-Wiedergabe erstellen",
        },
        googleMapsLink: {
            label: "Google Maps für diesen Standort",
            tooltip: "Einen Google Maps-Link zum aktuellen Standort erstellen",
        },
        inTheSkyLink: {
            label: "In-The-Sky für diese Zeit und diesen Ort",
            tooltip: "Einen In The Sky-Link zum aktuellen Standort erstellen",
        },
    },
    nodeLabels: {
        // Keys must match the node ID (property key in sitch data),
        // NOT the desc text. When no explicit id is set, desc becomes the id.
        focus: "Defokussierung",
        canvasResolution: "Auflösung",
        "Noise Amount": "Rauschmenge",
        "TV In Black": "TV Eingangs-Schwarz",
        "TV In White": "TV Eingangs-Weiß",
        "TV Gamma": "TV Gamma",
        "Tv Out Black": "TV Ausgangs-Schwarz",
        "Tv Out White": "TV Ausgangs-Weiß",
        "JPEG Artifacts": "JPEG-Artefakte",
        pixelZoom: "Pixel-Zoom %",
        videoBrightness: "Helligkeit",
        videoContrast: "Kontrast",
        videoBlur: "Unschärfemenge",
        videoSharpenAmount: "Schärfemenge",
        videoGreyscale: "Graustufen",
        videoHue: "Farbtonverschiebung",
        videoInvert: "Invertieren",
        videoSaturate: "Sättigung",
        startDistanceGUI: "Startentfernung",
        targetVCGUI: "Ziel-Vertikalgeschw.",
        targetSpeedGUI: "Zielgeschwindigkeit",
        lockWind: "Zielwind auf lokal fixieren",
        jetTAS: "TAS",
        turnRate: "Kurvenrate",
        totalTurn: "Gesamtkurve",
        jetHeadingManual: "Jet-Kurs",
        headingSmooth: "Kursglättung",
        turnRateControl: "Kurvenraten-Steuerung",
        cameraSmoothWindow: "Kameraglättungsfenster",
        targetSmoothWindow: "Zielglättungsfenster",
        cameraFOV: "Kamera-FOV",
        "Tgt Start Dist": "Ziel-Startentfernung",
        "Target Speed": "Zielgeschwindigkeit",
        "Tgt Relative Heading": "Ziel-Relativkurs",
        "KF Process": "KF-Prozess",
        "KF Noise": "KF-Rauschen",
        "MC Num Trials": "MC Anzahl Versuche",
        "MC LOS Uncertainty (deg)": "MC LOS-Unsicherheit (Grad)",
        "MC Polynomial Order": "MC Polynomordnung",
        "Physics Max Iterations": "Physik Max. Iterationen",
        "Physics Wind Speed (kt)": "Physik Windgeschwindigkeit (kt)",
        "Physics Wind From (°)": "Physik Wind aus (°)",
        "Physics Initial Range (m)": "Physik Anfangsreichweite (m)",
        "Tgt Start Altitude": "Ziel-Starthöhe",
        "Tgt Vert Spd": "Ziel-Vertikalgeschw.",
        "Cloud Altitude": "Wolkenhöhe",
    },
};

export default de;
