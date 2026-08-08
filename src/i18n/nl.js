const nl = {
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "Selectie van oudere sitches en hulpmiddelen\nSommige oudere sitches hebben hier standaard besturingselementen",
            noTooltip: "Geen tooltip gedefinieerd voor deze sitch",
            legacySitches: {
                label: "Oudere Sitches",
                tooltip: "De oudere sitches zijn oudere ingebouwde (hardgecodeerde) sitches die vooraf gedefinieerde situaties zijn en vaak unieke code en bronnen hebben. Selecteer er een om deze te laden.",
            },
            legacyTools: {
                label: "Oudere Hulpmiddelen",
                tooltip: "Hulpmiddelen zijn speciale sitches die worden gebruikt voor aangepaste configuraties zoals Starlink of met gebruikerstracks, en voor testen, debuggen of andere speciale doeleinden. Selecteer er een om te laden.",
            },
            selectPlaceholder: "-Selecteer-",
        },
        file: {
            title: "Bestand",
            tooltip: "Bestandsbewerkingen zoals opslaan, laden en exporteren",
        },
        view: {
            title: "Beeld",
            tooltip: "Diverse weergavebesturingen\nZoals alle menu's kan dit menu van de menubalk worden losgemaakt om een zwevend menu te maken",
        },
        video: {
            title: "Video",
            tooltip: "Video-aanpassing, effecten en analyse",
        },
        time: {
            title: "Tijd",
            tooltip: "Tijd- en framebesturingen\nAls een tijdschuifregelaar voorbij het einde wordt gesleept, beïnvloedt dit de bovenliggende schuifregelaar\nDe tijdschuifregelaars zijn in UTC",
        },
        objects: {
            title: "Objecten",
            tooltip: "3D-objecten en hun eigenschappen\nElke map is één object. Het traverse-object is het object dat de zichtlijnen doorloopt – d.w.z. het UAP waarin we geïnteresseerd zijn",
            addObject: {
                label: "Object toevoegen",
                tooltip: "Een nieuw object op opgegeven coördinaten aanmaken",
                prompt: "Invoer: [Naam] Lat Lon [Hoogte]\nVoorbeelden:\n  MijnObject 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Oriëntatiepunt 37.7749 -122.4194",
                invalidInput: "Ongeldige invoer. Voer coördinaten in het volgende formaat in:\n[Naam] Lat Lon [Hoogte]",
            },
        },
        satellites: {
            title: "Satellieten",
            tooltip: "Laden en besturen van satellieten\nDe satellieten.\nStarlink, ISS, enz. Besturingselementen voor horizonflares en andere satellieteffecten",
        },
        terrain: {
            title: "Terrein",
            tooltip: "Terreinbesturingen\nHet terrein is het 3D-model van de grond. De 'Kaart' is het 2D-beeld van de grond. De 'Hoogte' is de hoogte van de grond boven zeeniveau",
        },
        physics: {
            title: "Fysica",
            tooltip: "Fysicabesturingen\nDe fysica van de situatie, zoals windsnelheid en de fysica van het traverse-object",
        },
        camera: {
            title: "Camera",
            tooltip: "Camerabesturingen voor de kijkweergavecamera\nDe kijkweergave staat standaard in het rechterondervenster en is bedoeld om overeen te komen met de video.",
        },
        target: {
            title: "Doel",
            tooltip: "Doelbesturingen\nPositie en eigenschappen van het optionele doelobject",
        },
        traverse: {
            title: "Traverse",
            tooltip: "Traverse-besturingen\nHet traverse-object is het object dat de zichtlijnen doorloopt – d.w.z. het UAP waarin we geïnteresseerd zijn\nDit menu definieert hoe het traverse-object beweegt en zich gedraagt",
        },
        showHide: {
            title: "Zichtbaarheid",
            tooltip: "Weergaven, objecten en andere elementen tonen of verbergen",
            views: {
                title: "Weergaven",
                tooltip: "Weergaven (vensters) zoals de kijkweergave, de video, de hoofdweergave en overlays zoals de MQ9UI tonen of verbergen",
            },
            graphs: {
                title: "Grafieken",
                tooltip: "Diverse grafieken tonen of verbergen",
            },
        },
        effects: {
            title: "Effecten",
            tooltip: "Speciale effecten zoals vervaging, pixelvorming en kleuraanpassingen die worden toegepast op het uiteindelijke beeld in de kijkweergave",
        },
        lighting: {
            title: "Belichting",
            tooltip: "De belichting van de scène, zoals de zon en het omgevingslicht",
        },
        contents: {
            title: "Inhoud",
            tooltip: "De inhoud van de scène, voornamelijk gebruikt voor tracks",
        },
        help: {
            title: "Help",
            tooltip: "Links naar documentatie en andere hulpbronnen",
            whatsNew: "Wat is er nieuw",
            documentation: {
                title: "Documentatie",
                localTooltip: "Links naar de documentatie (lokaal)",
                githubTooltip: "Links naar de documentatie op Github",
                githubLinkLabel: "{{name}} (Github)",
                about: "Over Sitrec",
                whatsNew: "Wat is er nieuw",
                whatsNewDetails: "Wat is er nieuw (Details)",
                uiBasics: "Basisprincipes van de interface",
                savingLoading: "Sitches opslaan en laden",
                customSitch: "Een sitch instellen",
                tracks: "Tracks en gegevensbronnen",
                gis: "GIS en kaarten",
                starlink: "Starlink-flares onderzoeken",
                customModels: "Objecten en 3D-modellen (vliegtuigen)",
                cameraModes: "Cameramodi (Normaal & Satelliet)",
                thirdPartyNotices: "Kennisgevingen van derden",
                thirdPartyNoticesTooltip: "Open-source licentievermeldingen voor meegeleverde software van derden",
                downloadBridge: "MCP Bridge downloaden",
                downloadBridgeTooltip: "SitrecBridge MCP-server + Chrome-extensie downloaden (geen afhankelijkheden, alleen Node.js nodig)",
            },
            externalLinks: {
                title: "Externe Links",
                tooltip: "Externe hulplinks",
            },
            exportDebugLog: {
                label: "Debug-logboek exporteren",
                tooltip: "Alle console-uitvoer (log, waarschuwing, fout) als tekstbestand downloaden voor debugging",
            },
        },
        debug: {
            title: "Debug",
            tooltip: "Debug-hulpmiddelen en monitoring\nGPU-geheugengebruik, prestatiemetingen en andere debug-informatie",
        },
    },
    file: {
        newSitch: {
            label: "Nieuwe Sitch",
            tooltip: "Een nieuwe sitch aanmaken (laadt de pagina opnieuw en reset alles)",
        },
        savingDisabled: "Opslaan uitgeschakeld (klik om in te loggen)",
        importFile: {
            label: "Bestand importeren",
            tooltip: "Een bestand (of bestanden) importeren van uw lokale systeem. Hetzelfde als een bestand naar het browservenster slepen",
        },
        server: {
            open: "Openen",
            save: {
                label: "Opslaan",
                tooltip: "De huidige sitch op de server opslaan",
            },
            saveAs: {
                label: "Opslaan als",
                tooltip: "De huidige sitch met een nieuwe naam op de server opslaan",
            },
            versions: {
                label: "Versies",
                tooltip: "Een specifieke versie van de huidig geselecteerde sitch laden",
            },
            browseFeatured: "Uitgelichte sitches doorbladeren",
            browseAll: "Al uw opgeslagen sitches in een doorzoekbare, sorteerbare lijst doorbladeren",
        },
        local: {
            title: "Lokaal",
            titleWithFolder: "Lokaal: {{name}}",
            titleReconnect: "Lokaal: {{name}} (opnieuw verbinden)",
            status: "Status",
            noFileSelected: "Geen lokaal bestand geselecteerd",
            noFolderSelected: "Geen map geselecteerd",
            currentFile: "Huidig bestand: {{name}}",
            statusDesktop: "Huidig lokaal desktopbestand/opslagstatus",
            statusFolder: "Huidige lokale map/opslagstatus",
            stateReady: "Gereed",
            stateReconnect: "Opnieuw verbinden nodig",
            stateNoFolder: "Geen map",
            statusLine: "{{state}} | Map: {{folder}} | Doel: {{target}}",
            saveLocal: {
                label: "Lokaal opslaan",
                tooltipDesktop: "Opslaan in het huidige lokale bestand, of om een bestandsnaam vragen indien nodig",
                tooltipFolder: "Opslaan in de werkmap (of vraagt om een locatie als er geen is ingesteld)",
                tooltipSaveBack: "Terugopslaan in {{name}}",
                tooltipSaveBackInFolder: "Terugopslaan in {{name}} in {{folder}}",
                tooltipSaveInto: "Opslaan in {{folder}} (vraagt om sitch-naam)",
                tooltipPrompt: "Een lokaal sitch-bestand opslaan (vraagt om naam/locatie)",
                tooltipSaveTo: "De huidige sitch opslaan in een lokaal bestand",
            },
            saveLocalAs: {
                label: "Lokaal opslaan als...",
                tooltipDesktop: "Een lokaal sitch-bestand opslaan op een nieuw pad",
                tooltipFolder: "Een lokaal sitch-bestand opslaan, locatie kiezen",
                tooltipInFolder: "Met een nieuwe bestandsnaam opslaan in de huidige werkmap",
                tooltipNewPath: "De huidige sitch opslaan op een nieuw lokaal bestandspad",
            },
            openLocal: {
                label: "Lokale Sitch openen",
                labelShort: "Lokaal openen...",
                tooltipDesktop: "Een lokaal sitch-bestand van schijf openen",
                tooltipFolder: "Een sitch-bestand uit de huidige werkmap openen",
                tooltipCurrent: "Een ander lokaal sitch-bestand openen (huidig: {{name}})",
                tooltipFromFolder: "Een sitch-bestand uit {{folder}} openen",
            },
            selectFolder: {
                label: "Lokale Sitch-map selecteren",
                tooltip: "Een werkmap selecteren voor lokale opsla-/laadbewerkingen",
            },
            reconnectFolder: {
                label: "Map opnieuw verbinden",
                tooltip: "Opnieuw toegang verlenen tot de eerder gebruikte werkmap",
            },
        },
        debug: {
            recalculateAll: "debug alles herberekenen",
            dumpNodes: "debug nodes dumpen",
            dumpNodesBackwards: "debug nodes achterwaarts dumpen",
            dumpRoots: "debug wortelknooppunten dumpen",
        },
    },
    videoExport: {
        notAvailable: "Video-export niet beschikbaar",
        folder: {
            title: "Video renderen & exporteren",
            tooltip: "Opties voor het renderen en exporteren van videobestanden vanuit Sitrec-weergaven of het volledige viewport",
        },
        renderView: {
            label: "Videoweergave renderen",
            tooltip: "Selecteer welke weergave als video geëxporteerd moet worden",
        },
        renderSingleVideo: {
            label: "Enkele weergave-video renderen",
            tooltip: "De geselecteerde weergave als videobestand met alle frames exporteren",
        },
        videoFormat: {
            label: "Videoformaat",
            tooltip: "Uitgangvideoformaat selecteren",
        },
        renderViewport: {
            label: "Viewport-video renderen",
            tooltip: "Het volledige viewport als videobestand met alle frames exporteren",
        },
        renderFullscreen: {
            label: "Volledig scherm-video renderen",
            tooltip: "Het volledige viewport in volledig schermmodus als videobestand met alle frames exporteren",
        },
        recordWindow: {
            label: "Browservenster opnemen",
            tooltip: "Het volledige browservenster (inclusief menu's en interface) als video met vaste framesnelheid opnemen",
        },
        retinaExport: {
            label: "HD/Retina-export gebruiken",
            tooltip: "Exporteren op retina/HiDPI-resolutie (2x op de meeste schermen)",
        },
        includeAudio: {
            label: "Audio opnemen",
            tooltip: "Audiospoor van bronvideo opnemen indien beschikbaar",
        },
        waitForLoading: {
            label: "Wachten op laden op achtergrond",
            tooltip: "Indien ingeschakeld, wacht het renderen op het laden van terrein/gebouwen/achtergronden voordat elk frame wordt vastgelegd",
        },
        exportFrame: {
            label: "Videoframe exporteren",
            tooltip: "Het huidige videoframe zoals weergegeven (met effecten) als PNG-bestand exporteren",
        },
    },
    tracking: {
        enable: {
            label: "Automatische tracking inschakelen",
            disableLabel: "Automatische tracking uitschakelen",
            tooltip: "Weergave van de automatische trackingcursor op video in-/uitschakelen",
        },
        start: {
            label: "Automatische tracking starten",
            stopLabel: "Automatische tracking stoppen",
            tooltip: "Het object binnen de cursor automatisch volgen terwijl de video wordt afgespeeld",
        },
        clearFromHere: {
            label: "Vanaf hier wissen",
            tooltip: "Alle gevolgde posities van het huidige frame tot het einde wissen",
        },
        clearTrack: {
            label: "Track wissen",
            tooltip: "Alle automatisch gevolgde posities wissen en opnieuw beginnen",
        },
        stabilize: {
            label: "Stabiliseren",
            tooltip: "Automatisch gevolgde posities toepassen om de video te stabiliseren",
        },
        stabilizeToggle: {
            enableLabel: "Stabilisatie inschakelen",
            disableLabel: "Stabilisatie uitschakelen",
            tooltip: "Videostabilisatie in-/uitschakelen",
        },
        stabilizeCenters: {
            label: "Middelpunten stabiliseren",
            tooltip: "Indien ingeschakeld, wordt het gestabiliseerde punt in het midden van de weergave gefixeerd. Indien uitgeschakeld, blijft het op zijn oorspronkelijke positie.",
        },
        renderStabilized: {
            label: "Gestabiliseerde video renderen",
            tooltip: "Gestabiliseerde video op originele grootte exporteren (gevolgd punt blijft vast, randen kunnen zwart zijn)",
        },
        renderStabilizedExpanded: {
            label: "Gestabiliseerd uitgebreid renderen",
            tooltip: "Gestabiliseerde video met uitgebreid canvas exporteren zodat geen pixels verloren gaan",
        },
        trackRadius: {
            label: "Trackradius",
            tooltip: "Grootte van het sjabloon om te matchen (objectgrootte)",
        },
        searchRadius: {
            label: "Zoekradius",
            tooltip: "Hoe ver er van de vorige positie gezocht wordt (verhogen bij snelle beweging)",
        },
        trackingMethod: {
            label: "Trackingmethode",
            tooltip: "Sjabloonmatching (OpenCV) of Optische stroom (jsfeat Lucas-Kanade)",
        },
        centerOnBright: {
            label: "Centreren op helder",
            tooltip: "Zwaartepunt van heldere pixels volgen (beter voor sterren/puntlichtbronnen)",
        },
        centerOnDark: {
            label: "Centreren op donker",
            tooltip: "Zwaartepunt van donkere pixels volgen",
        },
        brightnessThreshold: {
            label: "Helderheidsdrempel",
            tooltip: "Helderheidsdrempel (0-255). Gebruikt in de modi Centreren op helder/donker",
        },
        status: {
            loadingJsfeat: "jsfeat laden...",
            loadingOpenCv: "OpenCV laden...",
            sam2Connecting: "SAM2: Verbinding maken...",
            sam2Uploading: "SAM2: Uploaden...",
        },
    },
    trackManager: {
        removeTrack: "Track verwijderen",
        createSpline: "Spline aanmaken",
        editTrack: "Track bewerken",
        constantSpeed: "Constante snelheid",
        extrapolateTrack: "Track extrapoleren",
        curveType: "Curvetype",
        altLockAGL: "Hoogte vergrendelen AGL",
        deleteTrack: "Track verwijderen",
    },
    gpuMonitor: {
        enabled: "Monitoring ingeschakeld",
        total: "Totaal geheugen",
        geometries: "Geometrieën",
        textures: "Texturen",
        peak: "Piekgeheugen",
        average: "Gemiddeld geheugen",
        reset: "Geschiedenis wissen",
    },
    situationSetup: {
        mainFov: {
            label: "Hoofd-FOV",
            tooltip: "Gezichtsveld van de hoofdweergavecamera (VERTICAAL)",
        },
        lookCameraFov: "Kijkcamera-FOV",
        azimuth: "Azimut",
        jetPitch: "Jet-helling",
    },
    featureManager: {
        labelText: "Labeltekst",
        latitude: "Breedtegraad",
        longitude: "Lengtegraad",
        altitude: "Hoogte (m)",
        arrowLength: "Pijllengte",
        arrowColor: "Pijlkleur",
        textColor: "Tekstkleur",
        deleteFeature: "Markering verwijderen",
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "Kijkpanorama exporteren",
            tooltip: "Een panoramabeeld maken vanuit de kijkweergave over alle frames op basis van de achtergrondpositie",
        },
    },
    dateTime: {
        liveMode: {
            label: "Live-modus",
            tooltip: "Als de live-modus is ingeschakeld, wordt het afspelen altijd gesynchroniseerd met de huidige tijd.\nPauzeren of scrubben van de tijd schakelt de live-modus uit",
        },
        startTime: {
            tooltip: "De STARTTIJD van het eerste frame van de video, in UTC-formaat",
        },
        currentTime: {
            tooltip: "De HUIDIGE tijd van de video. Dit is waar de onderstaande datum en tijd naar verwijzen",
        },
        year: { label: "Jaar", tooltip: "Jaar van het huidige frame" },
        month: { label: "Maand", tooltip: "Maand (1-12)" },
        day: { label: "Dag", tooltip: "Dag van de maand" },
        hour: { label: "Uur", tooltip: "Uur (0-23)" },
        minute: { label: "Minuut", tooltip: "Minuut (0-59)" },
        second: { label: "Seconde", tooltip: "Seconde (0-59)" },
        millisecond: { label: "ms", tooltip: "Milliseconde (0-999)" },
        useTimeZone: {
            label: "Tijdzone gebruiken in interface",
            tooltip: "De hierboven geselecteerde tijdzone gebruiken in de interface\nDit wijzigt de datum en tijd naar de geselecteerde tijdzone in plaats van UTC.\nDit is handig om de datum en tijd weer te geven in een specifieke tijdzone, zoals de lokale tijdzone van de video of de locatie.",
        },
        timeZone: {
            label: "Tijdzone",
            tooltip: "De tijdzone waarin de datum en tijd worden weergegeven in de kijkweergave\nOok in de interface als 'Tijdzone gebruiken in interface' is aangevinkt",
        },
        simSpeed: {
            label: "Simulatiesnelheid",
            tooltip: "De snelheid van de simulatie; 1 is realtime, 2 is tweemaal zo snel, enz.\nDit wijzigt niet de video-afspeelsnelheid, alleen de tijdberekeningen voor de simulatie.",
        },
        sitchFrames: {
            label: "Sitch-frames",
            tooltip: "Het aantal frames in de sitch. Als er een video is, is dit het aantal frames in de video, maar u kunt dit wijzigen als u meer frames wilt toevoegen of de sitch zonder video wilt gebruiken",
        },
        sitchDuration: {
            label: "Sitch-duur",
            tooltip: "Duur van de sitch in UU:MM:SS.sss-formaat",
        },
        aFrame: {
            label: "A-frame",
            tooltip: "Het afspelen beperken tot tussen A en B, weergegeven als groen en rood op de frameschuifregelaar",
        },
        bFrame: {
            label: "B-frame",
            tooltip: "Het afspelen beperken tot tussen A en B, weergegeven als groen en rood op de frameschuifregelaar",
        },
        videoFps: {
            label: "Video-FPS",
            tooltip: "De frames per seconde van de video. Dit wijzigt de afspeelsnelheid van de video (bijv. 30 fps, 25 fps, enz.). Het wijzigt ook de duur van de sitch (in seconden) omdat het verandert hoe lang een individueel frame is\n Dit wordt waar mogelijk afgeleid uit de video, maar u kunt het wijzigen om de video te versnellen of te vertragen",
        },
        syncTimeTo: {
            label: "Tijd synchroniseren met",
            tooltip: "De starttijd van de video synchroniseren met de oorspronkelijke starttijd, de huidige tijd, of de starttijd van een track (indien geladen)",
        },
    },
    jet: {
        frames: {
            time: {
                label: "Tijd (sec)",
                tooltip: "Huidige tijd vanaf het begin van de video in seconden (frame / fps)",
            },
            frame: {
                label: "Frame in video",
                tooltip: "Huidig framenummer in de video",
            },
            paused: {
                label: "Gepauzeerd",
                tooltip: "Gepauzeerde status in-/uitschakelen (ook spatiebalk)",
            },
        },
        controls: {
            pingPong: "A-B Ping-Pong",
            podPitchPhysical: "Pod (bol) helling",
            podRollPhysical: "Pod-hoofd rol",
            deroFromGlare: "Derotatie = schitteringshoek",
            jetPitch: "Jet-helling",
            lookFov: "Smal FOV",
            elevation: "Elevatie",
            glareStartAngle: "Schitteringsbeginhoek",
            initialGlareRotation: "Initiële schitteringsrotatie",
            scaleJetPitch: "Jet-helling schalen met rol",
            horizonMethod: "Horizonmethode",
            horizonMethodOptions: {
                humanHorizon: "Menselijke horizon",
                horizonAngle: "Horizonhoek",
            },
            videoSpeed: "Videosnelheid",
            podWireframe: "[B]ack Pod-draadmodel",
            showVideo: "[V]ideo",
            showGraph: "[G]rafiek",
            showKeyboardShortcuts: "[K]Sneltoetsen",
            showPodHead: "[P]od-hoofd rol",
            showPodsEye: "Pod-[E]ye-weergaven m/ dero",
            showLookCam: "[N]AR-weergave m/ dero",
            showCueData: "[C]ue-gegevens",
            showGlareGraph: "Schitteringsgrafiek t[o]nen",
            showAzGraph: "A[Z]-grafiek tonen",
            declutter: "[D]eclutter]",
            jetOffset: "Jet Y-offset",
            tas: "TAS Ware luchtsnelheid",
            integrate: "Integratiestappen",
        },
    },
    motionAnalysis: {
        menu: {
            title: "Bewegingsanalyse",
            analyzeMotion: {
                label: "Beweging analyseren",
                tooltip: "Realtime bewegingsanalyse-overlay op video in-/uitschakelen",
            },
            createTrack: {
                label: "Track maken van beweging",
                tooltip: "Alle frames analyseren en een grondtrack maken van bewegingsvectoren",
            },
            alignWithFlow: {
                label: "Uitlijnen met stroom",
                tooltip: "Beeld roteren zodat de bewegingsrichting horizontaal is",
            },
            panorama: {
                title: "Panorama",
                exportImage: {
                    label: "Bewegingspanorama exporteren",
                    tooltip: "Een panoramabeeld maken van videoframes met behulp van bewegingstracking-offsets",
                },
                exportVideo: {
                    label: "Panoramavideo exporteren",
                    tooltip: "Een 4K-video maken die het panorama met videoframe-overlay toont",
                },
                stabilize: {
                    label: "Video stabiliseren",
                    disableLabel: "Stabilisatie uitschakelen",
                    tooltip: "Video stabiliseren met globale bewegingsanalyse (verwijdert camerabewegingen)",
                },
                panoFrameStep: {
                    label: "Panorama-framestap",
                    tooltip: "Hoeveel frames er tussen elk panoramaframe worden overgeslagen (1 = elk frame)",
                },
                crop: {
                    label: "Panorama bijsnijden",
                    tooltip: "Pixels om van elke rand van videoframes bij te snijden",
                },
                useMask: {
                    label: "Masker gebruiken in panorama",
                    tooltip: "Bewegingstrackingmasker als transparantie toepassen bij het renderen van het panorama",
                },
                analyzeWithEffects: {
                    label: "Analyseren met effecten",
                    tooltip: "Video-aanpassingen (contrast, enz.) toepassen op frames die voor bewegingsanalyse worden gebruikt",
                },
                exportWithEffects: {
                    label: "Exporteren met effecten",
                    tooltip: "Video-aanpassingen toepassen op panorama-exports",
                },
                removeOuterBlack: {
                    label: "Buitenste zwart verwijderen",
                    tooltip: "Zwarte pixels aan de randen van elke rij transparant maken",
                },
            },
            trackingParameters: {
                title: "Trackingparameters",
                technique: {
                    label: "Techniek",
                    tooltip: "Algoritme voor bewegingsschatting",
                },
                frameSkip: {
                    label: "Frame overslaan",
                    tooltip: "Frames tussen vergelijkingen (hoger = langzamere beweging detecteren)",
                },
                trackletLength: {
                    label: "Trackletlengte",
                    tooltip: "Aantal frames in tracklet (langer = strengere coherentie)",
                },
                blurSize: {
                    label: "Vervagingsgrootte",
                    tooltip: "Gaussiaanse vervaging voor macrokenmerken (oneven getallen)",
                },
                minMotion: {
                    label: "Minimale beweging",
                    tooltip: "Minimale bewegingsmagnitude (pixels/frame)",
                },
                maxMotion: {
                    label: "Maximale beweging",
                    tooltip: "Maximale bewegingsmagnitude",
                },
                smoothing: {
                    label: "Afvlakking",
                    tooltip: "Richtingsafvlakking (hoger = meer afvlakking)",
                },
                minVectorCount: {
                    label: "Minimaal aantal vectoren",
                    tooltip: "Minimaal aantal bewegingsvectoren voor een geldig frame",
                },
                minConfidence: {
                    label: "Minimale betrouwbaarheid",
                    tooltip: "Minimale consensusbetrouwbaarheid voor een geldig frame",
                },
                maxFeatures: {
                    label: "Maximale kenmerken",
                    tooltip: "Maximaal aantal gevolgde kenmerken",
                },
                minDistance: {
                    label: "Minimale afstand",
                    tooltip: "Minimale afstand tussen kenmerken",
                },
                qualityLevel: {
                    label: "Kwaliteitsniveau",
                    tooltip: "Drempelwaarde voor kenmerkdetectie",
                },
                maxTrackError: {
                    label: "Maximale trackingfout",
                    tooltip: "Maximale drempelwaarde voor de trackingfout",
                },
                minQuality: {
                    label: "Minimale kwaliteit",
                    tooltip: "Minimale kwaliteit om pijl weer te geven",
                },
                staticThreshold: {
                    label: "Statische drempel",
                    tooltip: "Beweging onder deze waarde wordt als statisch (HUD) beschouwd",
                },
            },
        },
        status: {
            loadingOpenCv: "OpenCV laden...",
            stopAnalysis: "Analyse stoppen",
            analyzingPercent: "Analyseren... {{pct}}%",
            creatingTrack: "Track aanmaken...",
            buildingPanorama: "Panorama opbouwen...",
            buildingPanoramaPercent: "Panorama opbouwen... {{pct}}%",
            loadingFrame: "Frame {{frame}} laden... ({{current}}/{{total}})",
            loadingFrameSkipped: "Frame {{frame}} laden... ({{current}}/{{total}}) ({{skipped}} overgeslagen)",
            renderingPercent: "Renderen... {{pct}}%",
            panoPercent: "Panorama... {{pct}}%",
            renderingVideo: "Video renderen...",
            videoPercent: "Video... {{pct}}%",
            saving: "Opslaan...",
            buildingStabilization: "Stabilisatie opbouwen...",
            exportProgressTitle: "Panoramavideo exporteren...",
        },
        errors: {
            noVideoView: "Geen videoweergave gevonden.",
            noVideoData: "Geen videogegevens gevonden.",
            failedToLoadOpenCv: "OpenCV laden mislukt: {{message}}",
            noOriginTrack: "Geen oorsprongstrack gevonden. Een doel- of cameratrack is nodig om de startpositie te bepalen.",
            videoEncodingUnsupported: "Video-codering wordt niet ondersteund in deze browser",
            exportFailed: "Video-export mislukt: {{reason}}",
            panoVideoExportFailed: "Panoramavideo-export mislukt: {{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[BETA] Tekstextractie",
            enable: {
                label: "Tekstextractie inschakelen",
                disableLabel: "Tekstextractie uitschakelen",
                tooltip: "Tekstextractiemodus op video in-/uitschakelen",
            },
            addRegion: {
                label: "Regio toevoegen",
                drawingLabel: "Klik en sleep op de video...",
                tooltip: "Klik en sleep op de video om een tekstextractieregio te definiëren",
            },
            removeRegion: {
                label: "Geselecteerde regio verwijderen",
                tooltip: "De huidig geselecteerde regio verwijderen",
            },
            clearRegions: {
                label: "Alle regio's wissen",
                tooltip: "Alle tekstextractieregio's verwijderen",
            },
            startExtract: {
                label: "Extractie starten",
                stopLabel: "Extractie stoppen",
                tooltip: "OCR uitvoeren op alle regio's van het huidige frame tot het einde",
            },
            fixedWidthFont: {
                label: "Lettertype met vaste breedte",
                tooltip: "Teken-voor-teken detectie inschakelen voor lettertypen met vaste breedte (beter voor FLIR/sensor-overlays)",
            },
            numChars: {
                label: "Aantal tekens",
                tooltip: "Aantal tekens in de geselecteerde regio (verdeelt de regio gelijkmatig)",
            },
            learnTemplates: {
                label: "Sjablonen leren",
                activeLabel: "Klik op tekens om te leren...",
                tooltip: "Klik op tekencellen om hun waarden aan te leren (voor sjabloonmatching)",
            },
            clearTemplates: {
                label: "Sjablonen wissen",
                tooltip: "Alle geleerde tekensjablonen verwijderen",
            },
            useTemplates: {
                label: "Sjablonen gebruiken",
                tooltip: "Geleerde sjablonen gebruiken voor matching (sneller en nauwkeuriger na training)",
            },
        },
        prompts: {
            learnCharacter: "Voer teken in voor cel {{index}}:",
        },
        errors: {
            failedToLoadTesseract: "Tesseract.js laden mislukt. Zorg dat het geïnstalleerd is: npm install tesseract.js",
            noVideoView: "Tekstextractie vereist een videoweergave",
        },
    },
    custom: {
        settings: {
            title: "Instellingen",
            tooltipLoggedIn: "Gebruikersspecifieke instellingen opgeslagen op server (met cookie-back-up)",
            tooltipAnonymous: "Gebruikersspecifieke instellingen opgeslagen in browsercookies",
            language: { label: "Taal", tooltip: "Interfacetaal selecteren. Bij wijziging wordt de pagina opnieuw geladen. U verliest niet-opgeslagen werk, dus sla eerst op!" },
            maxDetails: { label: "Maximale details", tooltip: "Maximaal detailniveau voor terreinonderverdeling (5-30)" },
            fpsLimit: { label: "Framesnelheidslimiet", tooltip: "Maximale framesnelheid instellen (60, 30, 20 of 15 fps)" },
            tileSegments: { label: "Tegelsegmenten", tooltip: "Rasterresolutie voor terreintegels. Hogere waarden = meer detail maar langzamer" },
            maxResolution: { label: "Maximale resolutie", tooltip: "Maximale videoframe-resolutie (langste zijde). Vermindert GPU-geheugengebruik. Geldt voor nieuw geladen frames." },
            aiModel: { label: "AI-model", tooltip: "AI-model selecteren voor de chatassistent" },
            centerSidebar: { label: "Middenzijbalk", tooltip: "Middenzijbalk tussen gesplitste weergaven inschakelen (sleep menu's naar de scheidingslijn)" },
            showAttribution: { label: "Bronvermelding tonen", tooltip: "Bronvermelding voor kaart- en hoogtegegevens als overlay tonen" },
        },
        balloons: {
            count: { label: "Aantal", tooltip: "Aantal nabijgelegen stations om te importeren" },
            source: { label: "Bron", tooltip: "uwyo = University of Wyoming (PHP-proxy nodig)\nigra2 = NOAA NCEI-archief (directe download)" },
            getNearby: { label: "Nabijgelegen weerballonnen ophalen", tooltip: "De N dichtstbijzijnde weerballonsonderingen bij de huidige camerapositie importeren.\nGebruikt de meest recente lancering voor de sitch-starttijd + 1 uur." },
            importSounding: { label: "Sondering importeren...", tooltip: "Handmatige stationskiezer: station, datum, bron kiezen en een specifieke sondering importeren." },
        },
        showHide: {
            keyboardShortcuts: { label: "[K]Sneltoetsen", tooltip: "Sneltoetsen-overlay tonen of verbergen" },
            toggleExtendToGround: { label: "Alle [U]itbreidingen naar grond schakelen", tooltip: "'Uitbreiden naar grond' voor alle tracks in-/uitschakelen\nSchakelt alles uit als er een aan is\nSchakelt alles in als er geen aan is" },
            showAllTracksInLook: { label: "Alle tracks in kijkweergave tonen", tooltip: "Alle vliegtuigtracks in de kijk-/cameraweergave weergeven" },
            showCompassElevation: { label: "Kompaselevatie tonen", tooltip: "Kompaselevatie (hoek boven het lokale grondvlak) tonen naast peiling (azimut)" },
            filterTracks: { label: "Tracks filteren", tooltip: "Tracks tonen/verbergen op basis van hoogte, richting of frustumdoorsnede" },
            removeAllTracks: { label: "Alle tracks verwijderen", tooltip: "Alle tracks uit de scène verwijderen\nDit verwijdert niet de objecten, alleen de tracks\nU kunt ze later weer toevoegen door de bestanden opnieuw te slepen" },
        },
        objects: {
            globalScale: { label: "Globale schaal", tooltip: "Schaalfactor toegepast op alle 3D-objecten in de scène – handig om dingen te vinden. Terug op 1 zetten voor werkelijke grootte" },
        },
        admin: {
            dashboard: { label: "Admin-dashboard", tooltip: "Het admin-dashboard openen" },
            validateAllSitches: { label: "Alle sitches valideren", tooltip: "Alle opgeslagen sitches met lokaal terrein laden om op fouten te controleren" },
            testUserID: { label: "Test-gebruikers-ID", tooltip: "Als deze gebruikers-ID werken (0 = uitgeschakeld, moet > 1 zijn)" },
            addMissingScreenshots: { label: "Ontbrekende screenshots toevoegen", tooltip: "Elke sitch zonder screenshot laden, renderen en een screenshot uploaden" },
            feature: { label: "Uitlichten", tooltip: "Uitgelichtstatus voor de huidig geladen sitch in-/uitschakelen" },
        },
        viewPreset: { label: "Weergavesjabloon", tooltip: "Wisselen tussen verschillende weergavesjablonen\nNaast elkaar, Boven en onder, enz." },
        subSitches: {
            folder: { tooltip: "Meerdere camera-/weergaveconfiguraties binnen deze sitch beheren" },
            updateCurrent: { label: "Huidige sub bijwerken", tooltip: "De huidig geselecteerde sub-sitch bijwerken met de huidige weergave-instellingen" },
            updateAndAddNew: { label: "Huidige bijwerken en nieuwe toevoegen", tooltip: "Huidige sub-sitch bijwerken en vervolgens dupliceren naar een nieuwe sub-sitch" },
            discardAndAddNew: { label: "Wijzigingen verwerpen en nieuwe toevoegen", tooltip: "Wijzigingen aan de huidige sub-sitch verwerpen en een nieuwe sub-sitch aanmaken vanuit de huidige staat" },
            renameCurrent: { label: "Huidige sub hernoemen", tooltip: "De huidig geselecteerde sub-sitch hernoemen" },
            deleteCurrent: { label: "Huidige sub verwijderen", tooltip: "De huidig geselecteerde sub-sitch verwijderen" },
            syncSaveDetails: { label: "Sub-opslagdetails synchroniseren", tooltip: "Uit de huidige sub alle nodes verwijderen die niet zijn ingeschakeld in de sub-opslagdetails" },
        },
        contextMenu: {
            setCameraAbove: "Camera erboven plaatsen",
            setCameraOnGround: "Camera op de grond plaatsen",
            setTargetAbove: "Doel erboven plaatsen",
            setTargetOnGround: "Doel op de grond plaatsen",
            dropPin: "Pin plaatsen / Feature toevoegen",
            createTrackWithObject: "Track met object aanmaken",
            createTrackNoObject: "Track aanmaken (zonder object)",
            addBuilding: "Gebouw toevoegen",
            addClouds: "Wolken toevoegen",
            addGroundOverlay: "Grondoverlay toevoegen",
            centerTerrain: "Terreinvierkant hier centreren",
            googleMapsHere: "Google Maps hier",
            googleEarthHere: "Google Earth hier",
            removeClosestPoint: "Dichtstbijzijnde punt verwijderen",
            exitEditMode: "Bewerkingsmodus verlaten",
        },
    },
    view3d: {
        northUp: { label: "Kijkweergave noord boven", tooltip: "De kijkweergave instellen op noord boven in plaats van wereld boven.\nVoor satellietweergaven en vergelijkbaar, recht naar beneden kijkend.\nGeldt niet in PTZ-modus" },
        atmosphere: { label: "Atmosfeer", tooltip: "Afstandsdemping die terrein en 3D-objecten mengt naar de huidige luchtkleur" },
        atmoVisibility: { label: "Atmosfeerzicht (km)", tooltip: "Afstand waar het atmosferisch contrast tot ongeveer 50% daalt (kleiner = dikkere atmosfeer)" },
        atmoHDR: { label: "Atmosfeer HDR", tooltip: "Fysisch gebaseerde HDR-mist/tonemapping voor heldere zonreflecties door nevel" },
        atmoExposure: { label: "Atmosfeerbelichting", tooltip: "HDR-atmosfeer tonemapping-belichtingsmultiplicator voor highlight-rolloff" },
        startXR: { label: "VR/XR starten", tooltip: "WebXR-sessie starten voor testen (werkt met Immersive Web Emulator)" },
        effects: { label: "Effecten", tooltip: "Alle effecten in-/uitschakelen" },
        focusTrack: { label: "Focustrack", tooltip: "Een track selecteren om de camera ernaar te laten kijken en eromheen te roteren" },
        lockTrack: { label: "Vergrendeltrack", tooltip: "Een track selecteren om de camera eraan te koppelen, zodat deze met de track meebeweegt" },
        debug: {
            clearBackground: "Achtergrond wissen", renderSky: "Lucht renderen", renderDaySky: "Daglucht renderen",
            renderMainScene: "Hoofdscène renderen", renderEffects: "Effecten renderen", copyToScreen: "Naar scherm kopiëren",
            updateCameraMatrices: "Cameramatrices bijwerken", mainUseLookLayers: "Hoofd: kijklagen gebruiken",
            sRGBOutputEncoding: "sRGB-uitvoercodering", tileLoadDelay: "Tegellaadvertraging (s)",
            updateStarScales: "Sterschalen bijwerken", updateSatelliteScales: "Satellietschalen bijwerken",
            renderNightSky: "Nachtlucht renderen", renderFullscreenQuad: "Volledig scherm-quad renderen", renderSunSky: "Zonlucht renderen",
        },
        celestial: {
            raHours: "RA (uren)", decDegrees: "Dec (graden)", magnitude: "Magnitude",
            noradNumber: "NORAD-nummer", name: "Naam",
        },
    },
    nightSky: {
        loadLEO: { label: "LEO-satellieten voor datum laden", tooltip: "De nieuwste LEO-satelliet-TLE-gegevens ophalen voor de ingestelde simulatiedatum/-tijd. Dit downloadt gegevens van het internet en kan enkele seconden duren.\nDe satellieten worden ook in de nachtlucht weergegeven." },
        loadStarlink: { label: "HUIDIGE Starlink laden", tooltip: "De HUIDIGE (niet historische, nu, realtime) Starlink-satellietposities ophalen. Dit downloadt gegevens van het internet en kan enkele seconden duren.\n" },
        loadActive: { label: "ACTIEVE satellieten laden", tooltip: "De HUIDIGE (niet historische, nu, realtime) ACTIEVE satellietposities ophalen. Dit downloadt gegevens van het internet en kan enkele seconden duren.\n" },
        loadSlow: { label: "(Experimenteel) LANGZAME satellieten laden", tooltip: "De nieuwste LANGZAME satelliet-TLE-gegevens ophalen voor de ingestelde simulatiedatum/-tijd. Dit downloadt gegevens van het internet en kan enkele seconden duren.\nDe satellieten worden ook in de nachtlucht weergegeven. Kan een time-out geven bij recente datums" },
        loadAll: { label: "(Experimenteel) ALLE satellieten laden", tooltip: "De nieuwste satelliet-TLE-gegevens ophalen voor ALLE satellieten voor de ingestelde simulatiedatum/-tijd. Dit downloadt gegevens van het internet en kan enkele seconden duren.\nDe satellieten worden ook in de nachtlucht weergegeven. Kan een time-out geven bij recente datums" },
        flareAngle: { label: "Flare-hoekspreiding", tooltip: "Maximale hoek van de gereflecteerde kijkvector voor een zichtbare flare\nd.w.z. het hoekbereik tussen de vector van de satelliet naar de zon en de vector van de camera naar de satelliet gereflecteerd op de onderkant van de satelliet (die parallel is aan de grond)" },
        penumbraDepth: { label: "Halfschaduwdiepte van de aarde", tooltip: "Verticale diepte in meters waarover een satelliet vervaagt bij het betreden van de aardschaduw" },
        sunAngleArrows: { label: "Zonhoekpijlen", tooltip: "Bij gedetecteerde schittering, pijlen tonen van camera naar satelliet en vervolgens van satelliet naar zon" },
        celestialFolder: { tooltip: "Nachtluchtgerelateerde zaken" },
        vectorsOnTraverse: { label: "Vectoren op traverse", tooltip: "Indien aangevinkt, worden de vectoren relatief aan het traverse-object getoond. Anders worden ze relatief aan de kijkcamera getoond." },
        vectorsInLookView: { label: "Vectoren in kijkweergave", tooltip: "Indien aangevinkt, worden de vectoren in de kijkweergave getoond. Anders alleen in de hoofdweergave." },
        showSatellitesGlobal: { label: "Satellieten tonen (globaal)", tooltip: "Hoofdschakelaar: alle satellieten tonen of verbergen" },
        showStarlink: { label: "Starlink", tooltip: "SpaceX Starlink-satellieten tonen" },
        showISS: { label: "ISS", tooltip: "Het Internationaal Ruimtestation tonen" },
        celestrackBrightest: { label: "Celestracks helderste", tooltip: "Celestracks lijst van helderste satellieten tonen" },
        otherSatellites: { label: "Andere satellieten", tooltip: "Satellieten tonen die niet in de bovenstaande categorieën vallen" },
        list: { label: "Lijst", tooltip: "Een tekstlijst van zichtbare satellieten tonen" },
        satelliteArrows: { label: "Satellietpijlen", tooltip: "Pijlen tonen die satelliettrajecten aangeven" },
        flareLines: { label: "Flarelijnen", tooltip: "Lijnen tonen die opflitsende satellieten verbinden met de camera en de zon" },
        satelliteGroundArrows: { label: "Satelliet-grondpijlen", tooltip: "Pijlen tonen naar de grond onder elke satelliet" },
        satelliteLabelsLook: { label: "Satellietlabels (kijkweergave)", tooltip: "Satellietnaamlabels in de kijk-/cameraweergave tonen" },
        satelliteLabelsMain: { label: "Satellietlabels (hoofdweergave)", tooltip: "Satellietnaamlabels in de 3D-hoofdweergave tonen" },
        labelFlaresOnly: { label: "Alleen flares labelen", tooltip: "Alleen satellieten labelen die momenteel opflitsen" },
        labelLitOnly: { label: "Alleen verlichte labelen", tooltip: "Alleen satellieten labelen die door de zon verlicht worden (niet in de aardschaduw)" },
        labelLookVisibleOnly: { label: "Alleen zichtbare in kijkweergave labelen", tooltip: "Alleen satellieten labelen die zichtbaar zijn in het frustum van de kijkcamera" },
        flareRegion: { label: "Flare-regio", tooltip: "Het luchtgebied tonen waar satellietflares zichtbaar zijn" },
        flareBand: { label: "Flare-band", tooltip: "De band op de grond tonen waar flares van een satelliettrack overheen strijken" },
        filterTLEs: { label: "TLE's filteren", tooltip: "Zichtbare satellieten filteren op hoogte, positie, orbitale parameters of naam" },
        clearTLEFilter: { label: "TLE-filter wissen", tooltip: "Alle ruimtelijke/orbitale TLE-filters verwijderen en categorie-gebaseerde zichtbaarheid herstellen" },
        maxLabelsDisplayed: { label: "Maximaal weergegeven labels", tooltip: "Maximaal aantal tegelijk gerenderde satellietlabels" },
        starBrightness: { label: "Sterhelderheid", tooltip: "Schaalfactor voor de helderheid van de sterren. 1 is normaal, 0 is onzichtbaar, 2 is tweemaal zo helder, enz." },
        starLimit: { label: "Sterlimiet", tooltip: "Helderheidslimiet voor weer te geven sterren" },
        planetBrightness: { label: "Planeethelderheid", tooltip: "Schaalfactor voor de helderheid van de planeten (behalve zon en maan). 1 is normaal, 0 is onzichtbaar, 2 is tweemaal zo helder, enz." },
        lockStarPlanetBrightness: { label: "Ster-/planeethelderheid koppelen", tooltip: "Indien aangevinkt, zijn de schuifregelaars voor ster- en planeethelderheid aan elkaar gekoppeld" },
        satBrightness: { label: "Satelliethelderheid", tooltip: "Schaalfactor voor de helderheid van de satellieten. 1 is normaal, 0 is onzichtbaar, 2 is tweemaal zo helder, enz." },
        flareBrightness: { label: "Flare-helderheid", tooltip: "Schaalfactor voor de extra helderheid van opflitsende satellieten. 0 is niets" },
        satCutOff: { label: "Satelliet-drempel", tooltip: "Satellieten die tot dit niveau of minder zijn gedimd, worden niet weergegeven" },
        displayRange: { label: "Weergavebereik (km)", tooltip: "Satellieten voorbij deze afstand worden zonder naam of pijlen weergegeven" },
        equatorialGrid: { label: "Equatoriaal raster", tooltip: "Het hemelse equatoriale coördinatenraster tonen" },
        constellationLines: { label: "Sterrenbeeldlijnen", tooltip: "Lijnen tonen die sterren in sterrenbeelden verbinden" },
        renderStars: { label: "Sterren renderen", tooltip: "Sterren aan de nachtlucht tonen" },
        equatorialGridLook: { label: "Equatoriaal raster in kijkweergave", tooltip: "Het equatoriale raster in de kijk-/cameraweergave tonen" },
        flareRegionLook: { label: "Flare-regio in kijkweergave", tooltip: "De flare-regiokegel in de kijkcameraweergave tonen" },
        satelliteEphemeris: { label: "Satellietefemeride" },
        skyPlot: { label: "Hemeldiagram" },
        celestialVector: { label: "{{name}}-vector", tooltip: "Een richtingsvector tonen die naar {{name}} wijst" },
    },
    synthClouds: {
        name: { label: "Naam" },
        visible: { label: "Zichtbaar" },
        editMode: { label: "Bewerkingsmodus" },
        altitude: { label: "Hoogte" },
        radius: { label: "Radius" },
        cloudSize: { label: "Wolkgrootte" },
        density: { label: "Dichtheid" },
        opacity: { label: "Dekking" },
        brightness: { label: "Helderheid" },
        depth: { label: "Diepte" },
        edgeWiggle: { label: "Randbeweging" },
        edgeFrequency: { label: "Randfrequentie" },
        seed: { label: "Seed" },
        feather: { label: "Zachte rand" },
        windMode: { label: "Windmodus" },
        windFrom: { label: "Wind uit (\u00b0)" },
        windKnots: { label: "Wind (knopen)" },
        deleteClouds: { label: "Wolken verwijderen" },
    },
    synthBuilding: {
        name: { label: "Naam" },
        visible: { label: "Zichtbaar" },
        editMode: { label: "Bewerkingsmodus" },
        roofEdgeHeight: { label: "Dakrandhoogte" },
        ridgelineHeight: { label: "Nokhoogte" },
        ridgelineInset: { label: "Nokinzet" },
        roofEaves: { label: "Dakoversteek" },
        type: { label: "Type" },
        wallColor: { label: "Muurkleur" },
        roofColor: { label: "Dakkleur" },
        opacity: { label: "Dekking" },
        transparent: { label: "Transparant" },
        wireframe: { label: "Draadmodel" },
        depthTest: { label: "Dieptetest" },
        deleteBuilding: { label: "Gebouw verwijderen" },
    },

    groundOverlay: {
        name: { label: "Naam" },
        visible: { label: "Zichtbaar" },
        editMode: { label: "Bewerkingsmodus" },
        lockShape: { label: "Vorm vergrendelen" },
        freeTransform: { label: "Vrij transformeren" },
        showBorder: { label: "Rand tonen" },
        properties: { label: "Eigenschappen" },
        imageURL: { label: "Afbeeldings-URL" },
        rehostLocalImage: { label: "Lokale afbeelding opnieuw hosten" },
        north: { label: "Noord" },
        south: { label: "Zuid" },
        east: { label: "Oost" },
        west: { label: "West" },
        rotation: { label: "Rotatie" },
        altitude: { label: "Hoogte (ft)" },
        wireframe: { label: "Draadmodel" },
        opacity: { label: "Dekking" },
        cloudExtraction: { label: "Wolkextractie" },
        extractClouds: { label: "Wolken extraheren" },
        cloudColor: { label: "Wolkkleur" },
        fuzziness: { label: "Vaagheid" },
        feather: { label: "Zachte rand" },
        gotoOverlay: { label: "Naar overlay gaan" },
        deleteOverlay: { label: "Overlay verwijderen" },
    },

    videoView: {
        folders: {
            videoAdjustments: "Video-aanpassingen",
            videoProcessing: "Videoverwerking",
            forensics: "Forensisch onderzoek",
            errorLevelAnalysis: "Foutniveauanalyse",
            noiseAnalysis: "Ruisanalyse",
            grid: "Raster",
        },
        currentVideo: { label: "Huidige video" },
        videoRotation: { label: "Videorotatie" },
        setCameraToExifGps: { label: "Camera instellen op EXIF GPS" },
        expandOutput: {
            label: "Uitvoer uitbreiden",
            tooltip: "Methode om het dynamisch bereik van de ELA-uitvoer uit te breiden",
        },
        displayMode: {
            label: "Weergavemodus",
            tooltip: "Hoe de resultaten van de ruisanalyse gevisualiseerd worden",
        },
        convolutionFilter: {
            label: "Convolutiefilter",
            tooltip: "Type ruimtelijk convolutiefilter om toe te passen",
        },
        resetVideoAdjustments: {
            label: "Video-aanpassingen herstellen",
            tooltip: "Alle video-aanpassingen naar hun standaardwaarden herstellen",
        },
        makeVideo: {
            label: "Video maken",
            tooltip: "De verwerkte video exporteren met alle huidige effecten toegepast",
        },
        gridShow: {
            label: "Tonen",
            tooltip: "Een raster-overlay op de video tonen",
        },
        gridSize: {
            label: "Grootte",
            tooltip: "Rastercelgrootte in pixels",
        },
        gridSubdivisions: {
            label: "Onderverdelingen",
            tooltip: "Aantal onderverdelingen binnen elke rastercel",
        },
        gridXOffset: {
            label: "X-offset",
            tooltip: "Horizontale offset van het raster in pixels",
        },
        gridYOffset: {
            label: "Y-offset",
            tooltip: "Verticale offset van het raster in pixels",
        },
        gridColor: {
            label: "Kleur",
            tooltip: "Kleur van de rasterlijnen",
        },
    },

    floodSim: {
        flood: {
            label: "Overstroming",
            tooltip: "Overstromingsdeeltjessimulatie in- of uitschakelen",
        },
        floodRate: {
            label: "Overstromingssnelheid",
            tooltip: "Aantal deeltjes dat per frame wordt gegenereerd",
        },
        sphereSize: {
            label: "Bolgrootte",
            tooltip: "Visuele straal van elk waterdeeltje",
        },
        dropRadius: {
            label: "Druppelradius",
            tooltip: "Radius rond het druppelpunt waar deeltjes worden gegenereerd",
        },
        maxParticles: {
            label: "Maximale deeltjes",
            tooltip: "Maximaal aantal actieve waterdeeltjes",
        },
        method: {
            label: "Methode",
            tooltip: "Simulatiemethode: HeightMap (raster), Fast (deeltjes) of PBF (positiegebaseerde vloeistoffen)",
        },
        waterSource: {
            label: "Waterbron",
            tooltip: "Regen: water toevoegen over de tijd. Dambreach: waterniveau op doelhoogte handhaven binnen de druppelradius",
        },
        speed: {
            label: "Snelheid",
            tooltip: "Simulatiestappen per frame (1-20x)",
        },
        manningN: {
            label: "Mannings N",
            tooltip: "Bodemruwheid: 0,01=glad, 0,03=natuurlijk kanaal, 0,05=ruwe overstromingsvlakte, 0,1=dichte vegetatie",
        },
        edge: {
            label: "Rand",
            tooltip: "Blokkerend: water reflecteert aan rasterranden. Afvoerend: water stroomt weg en wordt verwijderd",
        },
        waterColor: {
            label: "Waterkleur",
            tooltip: "Kleur van het water",
        },
        reset: {
            label: "Herstellen",
            tooltip: "Alle deeltjes verwijderen en de simulatie opnieuw starten",
        },
    },

    flowOrbs: {
        number: {
            label: "Aantal",
            tooltip: "Aantal weer te geven stroombolletjes. Meer bolletjes kunnen de prestaties beïnvloeden.",
        },
        spreadMethod: {
            label: "Verspreidingsmethode",
            tooltip: "Methode om bolletjes te verspreiden langs de camerakijkvector.\n'Bereik' verspreidt bolletjes gelijkmatig langs de kijkvector tussen nabije en verre afstanden.\n'Hoogte' verspreidt bolletjes gelijkmatig langs de kijkvector, tussen de lage en hoge absolute hoogte (MSL)",
        },
        near: {
            label: "Nabij (m)",
            tooltip: "Dichtstbijzijnde afstand van camera voor bolletjesplaatsing",
        },
        far: {
            label: "Ver (m)",
            tooltip: "Verste afstand van camera voor bolletjesplaatsing",
        },
        high: { label: "Hoog (m)" },
        low: { label: "Laag (m)" },
        colorMethod: {
            label: "Kleurmethode",
            tooltip: "Methode om de kleur van de stroombolletjes te bepalen.\n'Willekeurig' wijst elke bol een willekeurige kleur toe.\n'Gebruiker' wijst alle bollen een door de gebruiker gekozen kleur toe.\n'Tint op basis van hoogte' wijst een kleur toe op basis van de hoogte van het bolletje.\n'Tint op basis van afstand' wijst een kleur toe op basis van de afstand van het bolletje tot de camera.",
        },
        userColor: {
            label: "Gebruikerskleur",
            tooltip: "Selecteer een kleur voor de stroombolletjes wanneer 'Kleurmethode' is ingesteld op 'Gebruiker'.",
        },
        hueRange: {
            label: "Tintbereik",
            tooltip: "Bereik waarover een volledig kleurenspectrum wordt gegenereerd voor de kleurmethode 'Tint op basis van hoogte/afstand'.",
        },
        windWhilePaused: {
            label: "Wind tijdens pauze",
            tooltip: "Indien aangevinkt, beïnvloedt wind de stroombolletjes ook wanneer de simulatie is gepauzeerd. Handig voor het visualiseren van windpatronen.",
        },
    },

    osdController: {
        seriesName: {
            label: "Naam",
        },
        seriesType: {
            label: "Type",
        },
        seriesShow: {
            label: "Tonen",
        },
        seriesLock: {
            label: "Vergrendelen",
        },
        removeTrack: {
            label: "Track verwijderen",
        },
        folderTitle: {
            label: "OSD-tracker",
            tooltip: "On-Screen Display teksttracker voor door de gebruiker gedefinieerde per-frame tekst",
        },
        addNewTrack: {
            label: "Nieuwe OSD-gegevensreeks toevoegen",
            tooltip: "Een nieuwe OSD-gegevensreeks aanmaken voor per-frame tekstoverlay",
        },
        makeTrack: {
            label: "Track aanmaken",
            tooltip: "Een positietrack aanmaken van zichtbare/niet-vergrendelde OSD-gegevensreeksen (MGRS of Lat/Lon)",
        },
        showAll: {
            label: "Alles tonen",
            tooltip: "Zichtbaarheid van alle OSD-gegevensreeksen in-/uitschakelen",
        },
        exportAllData: {
            label: "Alle gegevens exporteren",
            tooltip: "Alle OSD-gegevensreeksen als CSV's in een ZIP-bestand exporteren",
        },
        graphShow: {
            label: "Tonen",
            tooltip: "De OSD-gegevensgrafiekweergave tonen of verbergen",
        },
        xAxis: {
            label: "X-as",
            tooltip: "Gegevensreeks voor de horizontale as",
        },
        y1Axis: {
            label: "Y1-as",
            tooltip: "Gegevensreeks voor de linker verticale as",
        },
        y2Axis: {
            label: "Y2-as",
            tooltip: "Gegevensreeks voor de rechter verticale as",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "Video-informatie",
            tooltip: "Besturingen voor video-informatieweergave voor frameteller, tijdcode en tijdstempel",
        },
        showVideoInfo: {
            label: "Video-informatie tonen",
            tooltip: "Hoofdschakelaar – alle video-informatieweergaven in- of uitschakelen",
        },
        frameCounter: {
            label: "Frameteller",
            tooltip: "Het huidige framenummer tonen",
        },
        offsetFrame: {
            label: "Offsetframe",
            tooltip: "Het huidige framenummer plus een offsetwaarde tonen",
        },
        offsetValue: {
            label: "Offsetwaarde",
            tooltip: "Offsetwaarde die bij het huidige framenummer wordt opgeteld",
        },
        timecode: {
            label: "Tijdcode",
            tooltip: "Tijdcode in UU:MM:SS:FF-formaat tonen",
        },
        timestamp: {
            label: "Tijdstempel",
            tooltip: "Tijdstempel in UU:MM:SS.SS-formaat tonen",
        },
        dateLocal: {
            label: "Datum (lokaal)",
            tooltip: "Huidige datum in de geselecteerde tijdzone tonen",
        },
        timeLocal: {
            label: "Tijd (lokaal)",
            tooltip: "Huidige tijd in de geselecteerde tijdzone tonen",
        },
        dateTimeLocal: {
            label: "Datum & tijd (lokaal)",
            tooltip: "Volledige datum en tijd in de geselecteerde tijdzone tonen",
        },
        dateUTC: {
            label: "Datum (UTC)",
            tooltip: "Huidige datum in UTC tonen",
        },
        timeUTC: {
            label: "Tijd (UTC)",
            tooltip: "Huidige tijd in UTC tonen",
        },
        dateTimeUTC: {
            label: "Datum & tijd (UTC)",
            tooltip: "Volledige datum en tijd in UTC tonen",
        },
        fontSize: {
            label: "Lettergrootte",
            tooltip: "De lettergrootte van de infotekst aanpassen",
        },
    },

    terrainUI: {
        mapType: {
            label: "Kaarttype",
            tooltip: "Kaarttype voor terreintexturen (los van hoogtegegevens)",
        },
        elevationType: {
            label: "Hoogtetype",
            tooltip: "Gegevensbron voor terreinhoogtegegevens",
        },
        lat: {
            tooltip: "Breedtegraad van het midden van het terrein",
        },
        lon: {
            tooltip: "Lengtegraad van het midden van het terrein",
        },
        zoom: {
            tooltip: "Zoomniveau van het terrein. 2 is de hele wereld, 15 zijn enkele huizenblokken",
        },
        nTiles: {
            tooltip: "Aantal tegels in het terrein. Meer tegels betekent meer detail, maar langzamer laden. (NxN)",
        },
        refresh: {
            label: "Vernieuwen",
            tooltip: "Het terrein vernieuwen met de huidige instellingen. Gebruik bij netwerkproblemen die een mislukt laden hebben veroorzaakt",
        },
        debugGrids: {
            label: "Debug-rasters",
            tooltip: "Een raster van grondtexturen (groen) en hoogtegegevens (blauw) tonen",
        },
        elevationScale: {
            tooltip: "Schaalfactor voor de hoogtegegevens. 1 is normaal, 0,5 is halve hoogte, 2 is dubbele hoogte",
        },
        terrainOpacity: {
            label: "Terreindekking",
            tooltip: "Dekking van het terrein. 0 is volledig transparant, 1 is volledig dekkend",
        },
        textureDetail: {
            tooltip: "Detailniveau voor textuuronderverdeling. Hogere waarden = meer detail. 1 is normaal, 0,5 is minder detail, 2 is meer detail",
        },
        elevationDetail: {
            tooltip: "Detailniveau voor hoogte-onderverdeling. Hogere waarden = meer detail. 1 is normaal, 0,5 is minder detail, 2 is meer detail",
        },
        disableDynamicSubdivision: {
            label: "Dynamische onderverdeling uitschakelen",
            tooltip: "Dynamische onderverdeling van terreintegels uitschakelen. Bevriest het terrein op het huidige detailniveau. Handig voor debugging.",
        },
        dynamicSubdivision: {
            label: "Dynamische onderverdeling",
            tooltip: "Camera-adaptieve tegelonderverdeling gebruiken voor weergave op wereldschaal",
        },
        showBuildings: {
            label: "3D-gebouwen",
            tooltip: "3D-gebouwtegels van Cesium Ion of Google tonen",
        },
        buildingEdges: {
            label: "Gebouwranden",
            tooltip: "Draadmodelranden op 3D-gebouwtegels tonen",
        },
        oceanSurface: {
            label: "Oceaanoppervlak (bèta)",
            tooltip: "Experimenteel: wateroppervlak op zeeniveau renderen (vast EGM96 MSL) terwijl Google Photorealistic-tegels actief zijn",
        },
        buildingsSource: {
            label: "Gebouwbron",
            tooltip: "Gegevensbron voor 3D-gebouwtegels",
        },
        useEllipsoid: {
            label: "Ellipsoïde aardmodel gebruiken",
            tooltip: "Bol: snel legacy-model. Ellipsoïde: nauwkeurige WGS84-vorm (hogere breedtegraden profiteren het meest).",
        },
        layer: {
            label: "Laag",
            tooltip: "Laag voor de terreintexturen van het huidige kaarttype",
        },
    },

    displayTrack: {
        visible: {
            tooltip: "Deze track tonen of verbergen",
        },
        extendToGround: {
            label: "Uitbreiden naar grond",
            tooltip: "Verticale lijnen van track naar grond tekenen",
        },
        displayStep: {
            label: "Weergavestap",
            tooltip: "Framestap tussen weergegeven trackpunten (1 = elk frame)",
        },
        contrail: {
            label: "Condensspoor",
            tooltip: "Een condensspoor achter deze track tonen, aangepast voor wind",
        },
        contrailSecs: {
            label: "Condensspoor sec.",
            tooltip: "Duur van het condensspoor in seconden",
        },
        contrailWidth: {
            label: "Condensspoor breedte m",
            tooltip: "Maximale breedte van het condensspoor in meters",
        },
        contrailInitialWidth: {
            label: "Condensspoor begimbreedte m",
            tooltip: "Breedte van het condensspoor bij het uitlaatpunt in meters",
        },
        contrailRamp: {
            label: "Condensspoor oploop m",
            tooltip: "Afstand waarover de condensspoorbreedte toeneemt in meters",
        },
        contrailSpread: {
            label: "Condensspoor spreiding m/s",
            tooltip: "Snelheid waarmee het condensspoor zich naar buiten spreidt in m/s",
        },
        lineColor: {
            label: "Lijnkleur",
            tooltip: "Kleur van de tracklijn",
        },
        polyColor: {
            label: "Polygoonkleur",
            tooltip: "Kleur van de verticale gronduitbreidingspolygonen",
        },
        altLockAGL: {
            label: "Hoogte vergrendelen AGL",
        },
        gotoTrack: {
            label: "Naar track gaan",
            tooltip: "De hoofdcamera centreren op de locatie van deze track",
        },
    },

    ptzUI: {
        panAz: {
            label: "Pan (Az)",
            tooltip: "Camera-azimut / panhoek in graden",
        },
        tiltEl: {
            label: "Kantelen (El)",
            tooltip: "Camera-elevatie / kantelhoek in graden",
        },
        zoomFov: {
            label: "VFOV (deg)",
            tooltip: "Verticaal gezichtsveld van de camera in graden",
        },
        roll: {
            label: "Rol",
            tooltip: "Camerarolhoek in graden",
        },
        xOffset: {
            label: "X-offset",
            tooltip: "Horizontale offset van de camera ten opzichte van het midden",
        },
        yOffset: {
            label: "Y-offset",
            tooltip: "Verticale offset van de camera ten opzichte van het midden",
        },
        nearPlane: {
            label: "Nabij vlak (m)",
            tooltip: "Nabij clipping-vlak van de camera in meters",
        },
        relative: {
            label: "Relatief",
            tooltip: "Relatieve hoeken gebruiken in plaats van absoluut",
        },
        satellite: {
            label: "Satelliet",
            tooltip: "Satellietmodus: schermpannen vanaf nadir.\nRol = koers, Az = links/rechts, El = omhoog/omlaag (-90 = nadir)",
        },
        rotation: {
            label: "Rotatie",
            tooltip: "Schermrotatie rond de camerakijkas",
        },
    },

    nodes3dObject: {
        modelOrGeometry: {
            label: "Model of geometrie",
            tooltip: "Selecteer of u een 3D-model of een gegenereerde geometrie wilt gebruiken voor dit object",
        },
        model: {
            label: "Model",
            tooltip: "Selecteer een 3D-model om te gebruiken voor dit object",
        },
        displayBoundingBox: {
            label: "Begrenzingskader tonen",
            tooltip: "Het begrenzingskader van het object met afmetingen tonen",
        },
        forceAboveSurface: {
            label: "Boven oppervlak forceren",
            tooltip: "Het object forceren om volledig boven het grondoppervlak te zijn",
        },
        exportToKML: {
            label: "Exporteren naar KML",
            tooltip: "Dit 3D-object exporteren als KML-bestand voor Google Earth",
        },
        startAnalysis: {
            label: "Analyse starten",
            tooltip: "Stralen van de camera uitzenden om reflectierichtingen te vinden",
        },
        gridSize: {
            label: "Rastergrootte",
            tooltip: "Aantal steekproefpunten per as voor het reflectieraster",
        },
        cleanUp: {
            label: "Opruimen",
            tooltip: "Alle reflectieanalysepijlen uit de scène verwijderen",
        },
    },

    trackingOverlay: {
        showTracking: {
            label: "Tracking tonen",
            tooltip: "Trackingpunten en curve-overlay tonen of verbergen",
        },
        reset: {
            label: "Herstellen",
            tooltip: "Handmatige tracking herstellen naar een lege staat, alle keyframes en versleepbare elementen verwijderen",
        },
        limitAB: {
            label: "AB begrenzen",
            tooltip: "De A- en B-frames begrenzen tot het bereik van de videotracking-keyframes. Dit voorkomt extrapolatie voorbij het eerste en laatste keyframe, wat niet altijd gewenst is.",
        },
        curveType: {
            label: "Curvetype",
            tooltip: "Spline gebruikt natuurlijke kubische spline. Spline2 gebruikt not-a-knot spline voor vloeiender eindgedrag. Lineair gebruikt rechte lijnsegmenten. Perspectief vereist precies 3 keyframes en modelleert lineaire beweging met perspectiefprojectie.",
        },
        minimizeGroundSpeed: {
            label: "Grondsnelheid minimaliseren",
            tooltip: "De doelstartafstand vinden die de grondafstand van het traversepad minimaliseert",
        },
        minimizeAirSpeed: {
            label: "Luchtsnelheid minimaliseren",
            tooltip: "De doelstartafstand vinden die de luchtafstand minimaliseert (rekening houdend met doelwind)",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "Frustum-grondvierkant",
            tooltip: "De doorsnede van het camerafrustum met de grond tonen",
        },
        videoInFrustum: {
            label: "Video in frustum",
            tooltip: "De video projecteren op het verre vlak van het camerafrustum",
        },
        videoOnGround: {
            label: "Video op de grond",
            tooltip: "De video op de grond projecteren",
        },
        groundVideoInLookView: {
            label: "Grondvideo in kijkweergave",
            tooltip: "De op de grond geprojecteerde video in de kijkweergave tonen",
        },
        matchVideoAspect: {
            label: "Video-beeldverhouding aanpassen",
            tooltip: "De kijkweergave bijsnijden om overeen te komen met de beeldverhouding van de video en het frustum dienovereenkomstig aanpassen",
        },
        videoOpacity: {
            label: "Videodekking",
            tooltip: "Dekking van de geprojecteerde video-overlay",
        },
    },

    labels3d: {
        measurements: {
            label: "Metingen",
            tooltip: "Afstands- en hoekmetinglabels en -pijlen tonen",
        },
        labelsInMain: {
            label: "Labels in hoofdweergave",
            tooltip: "Track-/objectlabels in de 3D-hoofdweergave tonen",
        },
        labelsInLook: {
            label: "Labels in kijkweergave",
            tooltip: "Track-/objectlabels in de kijk-/cameraweergave tonen",
        },
        featuresInMain: {
            label: "Markeringen/pins in hoofdweergave",
            tooltip: "Markeringen (pins) in de 3D-hoofdweergave tonen",
        },
        featuresInLook: {
            label: "Markeringen in kijkweergave",
            tooltip: "Markeringen in de kijk-/cameraweergave tonen",
        },
    },

    losFitPhysics: {
        folder: "Fysica-aanpassingsresultaten",
        model: {
            label: "Model",
        },
        avgError: {
            label: "Gem. fout (rad)",
        },
        windSpeed: {
            label: "Windsnelheid (kt)",
        },
        windFrom: {
            label: "Wind uit (\u00B0)",
        },
    },

    misbData: {
        startTime: {
            label: "Starttijd",
            tooltip: "Starttijd overschrijven (bijv. '10:30', '15 jan', '2024-01-15T10:30:00Z'). Leeg laten voor globale starttijd.",
        },
        enableFilter: {
            label: "Filter inschakelen",
        },
        tryAltitudeFirst: {
            label: "Hoogte eerst proberen",
        },
        maxG: {
            label: "Max G",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "Boven grondniveau",
            tooltip: "Hoogte is relatief ten opzichte van het grondniveau, niet het zeeniveau",
        },
        lookup: {
            label: "Opzoeken",
            tooltip: "Voer een plaatsnaam, lat/lon-coördinaten of MGRS in om ernaartoe te navigeren",
        },
        geolocate: {
            label: "Geolocatie via browser",
            tooltip: "De geolocatie-API van de browser gebruiken om uw huidige positie in te stellen",
        },
        goTo: {
            label: "Naar bovenstaande positie gaan",
            tooltip: "Terrein en camera verplaatsen naar de ingevoerde breedtegraad/lengtegraad/hoogte",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "Stoppen bij",
            tooltip: "De beweging van het cameradoel bij dit frame stoppen, zelfs als de doeltrack doorgaat. Dit is handig om het verlies van volgvergrendeling op een bewegend doel te simuleren. Stel in op 0 om uit te schakelen.",
        },
        horizonMethod: {
            label: "Horizonmethode",
        },
        lookFOV: {
            label: "Kijk-FOV",
        },
        celestialObject: {
            label: "Hemellichaam",
            tooltip: "Naam van het hemellichaam dat de camera volgt (bijv. Maan, Venus, Jupiter)",
        },
    },

    spriteGroup: {
        visible: {
            label: "Zichtbaar",
            tooltip: "Stroombolletjes tonen of verbergen",
        },
        size: {
            label: "Grootte (m)",
            tooltip: "Diameter in meters.",
        },
        viewSizeMultiplier: {
            label: "Weergavegrootte-multiplicator",
            tooltip: "Past de grootte van de stroombolletjes in de hoofdweergave aan, maar wijzigt de grootte in andere weergaven niet.",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "Beste hoek, volledige 180, verfijnd",
        },
        bestAngle5: {
            label: "Beste hoek binnen 5\u00B0 van huidig",
        },
    },

    misc: {
        snapshotCamera: {
            label: "Camera-momentopname",
            tooltip: "De huidige camerapositie en -richting opslaan voor gebruik met 'Camera herstellen'",
        },
        resetCamera: {
            label: "Camera herstellen",
            tooltip: "De camera herstellen naar de standaardinstelling of naar de laatst opgeslagen positie en richting\nOok Numpad-.",
        },
        showMoonShadow: {
            label: "Maanschaduw tonen",
            tooltip: "De weergave van de maanschaduwkegel voor eclipsvisualisatie in-/uitschakelen.",
        },
        shadowSegments: {
            label: "Schaduwsegmenten",
            tooltip: "Aantal segmenten in de schaduwkegel (meer = vloeiender maar langzamer)",
        },
        showEarthShadow: {
            label: "Aardschaduw tonen",
            tooltip: "De weergave van de aardschaduwkegel aan de nachtlucht in-/uitschakelen.",
        },
        earthShadowAltitude: {
            label: "Aardschaduwhoogte",
            tooltip: "Afstand van het aardcentrum tot het vlak waarop de aardschaduwkegel wordt gerenderd (in meters).",
        },
        exportTLE: {
            label: "TLE exporteren",
        },
        backgroundFlowIndicator: {
            label: "Achtergrondstroomindicator",
            tooltip: "Een pijl tonen die aangeeft hoeveel de achtergrond in het volgende frame beweegt.\nHandig voor het synchroniseren van de simulatie met video (gebruik Beeld/Video-overlay)",
        },
        defaultSnap: {
            label: "Standaard uitlijnen",
            tooltip: "Indien ingeschakeld, worden punten standaard horizontaal uitgelijnd tijdens het slepen.\nHoud Shift (tijdens slepen) ingedrukt voor het tegenovergestelde",
        },
        recalcNodeGraph: {
            label: "Knooppuntgrafiek herberekenen",
        },
        downloadVideo: {
            label: "Video downloaden",
        },
        banking: {
            label: "Helling",
            tooltip: "Hoe het object helt/kantelt tijdens bochten",
        },
        angularTraverse: {
            label: "Hoekdoorloop",
        },
        smoothingMethod: {
            label: "Afvlakkingsmethode",
            tooltip: "Algoritme gebruikt voor het afvlakken van de cameratrackgegevens",
        },
        showInLookView: {
            label: "In kijkweergave tonen",
        },
        windFrom: {
            tooltip: "Ware koers waaruit de wind waait (0=Noord, 90=Oost)",
        },
        windKnots: {
            tooltip: "Windsnelheid in knopen",
        },
        fetchWind: {
            tooltip: "Echte windgegevens ophalen van weerdiensten voor deze locatie en tijd",
        },
        debugConsole: {
            label: "Debug-console",
            tooltip: "Debug-console",
        },
        aiAssistant: {
            label: "AI-assistent",
        },
        hide: {
            label: "Verbergen",
            tooltip: "Deze tabblad-canvasweergave verbergen\nOm het weer te tonen, gebruik het menu 'Tonen/Verbergen -> Weergaven'.",
        },
        notes: {
            label: "Notities",
            tooltip: "De notitie-editor tonen/verbergen. Notities worden met de sitch opgeslagen en kunnen klikbare hyperlinks bevatten.",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "Zichtlijnen",
            tooltip: "Zichtlijnen van camera naar doel tonen (schakel: O)",
        },
        physicalPointer: {
            label: "Fysieke aanwijzer",
        },
        jet: {
            label: "[J]et",
        },
        horizonGrid: {
            label: "[H]orizontraster",
        },
        wingPlaneGrid: {
            label: "[W]Vleugelraster",
        },
        sphericalBoresightGrid: {
            label: "[S]ferisch vizierraster",
        },
        azimuthElevationGrid: {
            label: "[A]zimut/elevatieraster",
        },
        frustumOfCamera: {
            label: "F[R]ustum van camera",
        },
        trackLine: {
            label: "[T]racklijn",
        },
        globe: {
            label: "[G]lobe",
        },
        showErrorCircle: {
            label: "Foutcirkel tonen",
        },
        glareSprite: {
            label: "Schitter-spr[I]te",
        },
        cameraViewFrustum: {
            label: "Camerazichtfrustum",
            tooltip: "Het zichtfrustum van de camera in de 3D-scène tonen",
        },
        zaineTriangulation: {
            label: "Zaine-triangulatie",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "Omgevingslichtintensiteit",
            tooltip: "Omgevingslichtintensiteit. 0 is geen omgevingslicht, 1 is normaal omgevingslicht, 2 is dubbel omgevingslicht",
        },
        irAmbientIntensity: {
            label: "IR-omgevingslichtintensiteit",
            tooltip: "IR-omgevingslichtintensiteit (gebruikt voor IR-viewports)",
        },
        sunIntensity: {
            label: "Zonlichtintensiteit",
            tooltip: "Zonlichtintensiteit. 0 is geen zonlicht, 1 is normaal vol zonlicht, 2 is dubbel zonlicht",
        },
        sunScattering: {
            label: "Zonverstrooiing",
            tooltip: "Hoeveelheid zonlichtverstrooiing",
        },
        sunBoost: {
            label: "Zonversterking (HDR)",
            tooltip: "Multiplicator voor de intensiteit van het zon-DirectionalLight (HDR). Verhoogt de helderheid van spiegellicht voor realistische zonreflecties door mist.",
        },
        sceneExposure: {
            label: "Scènebelichting (HDR)",
            tooltip: "Belichtingscompensatie voor HDR-tonemapping. Lager instellen om een hogere zonversterking te compenseren.",
        },
        ambientOnly: {
            label: "Alleen omgevingslicht",
            tooltip: "Indien ingeschakeld, wordt alleen omgevingslicht gebruikt, geen zonlicht",
        },
        daylightSky: {
            label: "Daglichthemel",
            tooltip: "De daglichthemel (blauw) renderen.\nUitschakelen om de bijdrage van de daglichthemel te verwijderen — handig om overdag sterren te zien of om nachthemelobjecten te debuggen.",
        },
        noMainLighting: {
            label: "Geen belichting in hoofdweergave",
            tooltip: "Indien ingeschakeld, wordt geen belichting gebruikt in de hoofdweergave.\nDit is handig voor debugging, maar niet aanbevolen voor normaal gebruik",
        },
        noCityLights: {
            label: "Geen stadslichten op globe",
            tooltip: "Indien ingeschakeld, worden geen stadslichten op de globe gerenderd.",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "ADSB-replay voor deze tijd en locatie",
            tooltip: "Een link naar ADSB Exchange Replay genereren",
        },
        googleMapsLink: {
            label: "Google Maps voor deze locatie",
            tooltip: "Een Google Maps-link naar de huidige locatie aanmaken",
        },
        inTheSkyLink: {
            label: "In-The-Sky voor deze tijd en locatie",
            tooltip: "Een In The Sky-link naar de huidige locatie aanmaken",
        },
    },
    nodeLabels: {
        // Keys must match the node ID (property key in sitch data),
        // NOT the desc text. When no explicit id is set, desc becomes the id.
        focus: "Defocus",
        canvasResolution: "Resolutie",
        "Noise Amount": "Ruishoeveelheid",
        "TV In Black": "TV invoer zwart",
        "TV In White": "TV invoer wit",
        "TV Gamma": "TV Gamma",
        "Tv Out Black": "TV uitvoer zwart",
        "Tv Out White": "TV uitvoer wit",
        "JPEG Artifacts": "JPEG-artefacten",
        pixelZoom: "Pixelzoom %",
        videoBrightness: "Helderheid",
        videoContrast: "Contrast",
        videoBlur: "Vervagingshoeveelheid",
        videoSharpenAmount: "Verscherpingshoeveelheid",
        videoGreyscale: "Grijstinten",
        videoHue: "Tintverschuiving",
        videoInvert: "Inverteren",
        videoSaturate: "Verzadiging",
        startDistanceGUI: "Startafstand",
        targetVCGUI: "Doel vert. snelheid",
        targetSpeedGUI: "Doelsnelheid",
        lockWind: "Doelwind vergrendelen op lokaal",
        jetTAS: "TAS",
        turnRate: "Bochtensnelheid",
        totalTurn: "Totale bocht",
        jetHeadingManual: "Jet-koers",
        headingSmooth: "Koersafvlakking",
        turnRateControl: "Bochtensnelheidsregeling",
        cameraSmoothWindow: "Camera-afvlakkingsvenster",
        targetSmoothWindow: "Doel-afvlakkingsvenster",
        cameraFOV: "Camera-FOV",
        "Tgt Start Dist": "Doelstartafstand",
        "Target Speed": "Doelsnelheid",
        "Tgt Relative Heading": "Doel relatieve koers",
        "KF Process": "KF-proces",
        "KF Noise": "KF-ruis",
        "MC Num Trials": "MC aantal proeven",
        "MC LOS Uncertainty (deg)": "MC LOS-onzekerheid (graden)",
        "MC Polynomial Order": "MC polynoomorde",
        "Physics Max Iterations": "Fysica max. iteraties",
        "Physics Wind Speed (kt)": "Fysica windsnelheid (kt)",
        "Physics Wind From (°)": "Fysica wind uit (°)",
        "Physics Initial Range (m)": "Fysica beginbereik (m)",
        "Tgt Start Altitude": "Doelstarthoogte",
        "Tgt Vert Spd": "Doel vert. snelheid",
        "Cloud Altitude": "Wolkhoogte",
    },
};

export default nl;
