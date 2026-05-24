const it = {
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "Selezione di sitch legacy e strumenti\nAlcuni sitch legacy hanno controlli qui per impostazione predefinita",
            noTooltip: "Nessun suggerimento definito per questo sitch",
            legacySitches: {
                label: "Sitch Legacy",
                tooltip: "I Sitch Legacy sono situazioni predefinite più vecchie (codificate) che spesso hanno codice e risorse uniche. Selezionarne uno per caricarlo.",
            },
            legacyTools: {
                label: "Strumenti Legacy",
                tooltip: "Gli strumenti sono sitch speciali utilizzati per configurazioni personalizzate come Starlink o con tracce utente, e per test, debug o altri scopi speciali. Selezionarne uno per caricarlo.",
            },
            selectPlaceholder: "-Seleziona-",
        },
        file: {
            title: "File",
            tooltip: "Operazioni sui file come salvataggio, caricamento ed esportazione",
        },
        view: {
            title: "Vista",
            tooltip: "Controlli di visualizzazione vari\nCome tutti i menu, questo menu può essere trascinato fuori dalla barra dei menu per diventare un menu flottante",
        },
        video: {
            title: "Video",
            tooltip: "Regolazione, effetti e analisi video",
        },
        time: {
            title: "Tempo",
            tooltip: "Controlli di tempo e fotogramma\nTrascinare un cursore del tempo oltre la fine influenzerà il cursore soprastante\nNota che i cursori del tempo sono in UTC",
        },
        objects: {
            title: "Oggetti",
            tooltip: "Oggetti 3D e le loro proprietà\nOgni cartella è un oggetto. Il traverseObject è l'oggetto che percorre le linee di vista - cioè l'UAP che ci interessa",
            addObject: {
                label: "Aggiungi Oggetto",
                tooltip: "Crea un nuovo oggetto alle coordinate specificate",
                prompt: "Inserire: [Nome] Lat Lon [Alt]\nEsempi:\n  MioOggetto 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Punto 37.7749 -122.4194",
                invalidInput: "Input non valido. Inserire le coordinate nel formato:\n[Nome] Lat Lon [Alt]",
            },
        },
        satellites: {
            title: "Satelliti",
            tooltip: "Caricamento e controllo dei satelliti\nI satelliti.\nStarlink, ISS, ecc. Controlli per flare all'orizzonte e altri effetti satellitari",
        },
        terrain: {
            title: "Terreno",
            tooltip: "Controlli del terreno\nIl terreno è il modello 3D del suolo. La 'Mappa' è l'immagine 2D del suolo. L''Elevazione' è l'altezza del suolo sopra il livello del mare",
        },
        physics: {
            title: "Fisica",
            tooltip: "Controlli della fisica\nLa fisica della situazione, come la velocità del vento e la fisica dell'oggetto di attraversamento",
        },
        camera: {
            title: "Camera",
            tooltip: "Controlli della telecamera per la vista di osservazione\nLa vista di osservazione è la finestra in basso a destra per impostazione predefinita, ed è destinata a corrispondere al video.",
        },
        target: {
            title: "Bersaglio",
            tooltip: "Controlli del bersaglio\nPosizione e proprietà dell'oggetto bersaglio opzionale",
        },
        traverse: {
            title: "Percorso",
            tooltip: "Controlli di attraversamento\nL'oggetto di attraversamento è l'oggetto che percorre le linee di vista - cioè l'UAP che ci interessa\nQuesto menu definisce come l'oggetto di attraversamento si muove e si comporta",
        },
        showHide: {
            title: "Visibilità",
            tooltip: "Mostrare o nascondere viste, oggetti e altri elementi",
            views: {
                title: "Viste",
                tooltip: "Mostrare o nascondere viste (finestre) come la vista di osservazione, il video, la vista principale, nonché overlay come MQ9UI",
            },
            graphs: {
                title: "Grafici",
                tooltip: "Mostrare o nascondere vari grafici",
            },
        },
        effects: {
            title: "Effetti",
            tooltip: "Effetti speciali come sfocatura, pixelizzazione e regolazioni del colore applicati all'immagine finale nella vista di osservazione",
        },
        lighting: {
            title: "Luci",
            tooltip: "L'illuminazione della scena, come il sole e la luce ambientale",
        },
        contents: {
            title: "Contenuti",
            tooltip: "I contenuti della scena, utilizzati principalmente per le tracce",
        },
        help: {
            title: "Guida",
            tooltip: "Link alla documentazione e altre risorse di aiuto",
            whatsNew: "Novità",
            documentation: {
                title: "Documentazione",
                localTooltip: "Link alla documentazione (locale)",
                githubTooltip: "Link alla documentazione su Github",
                githubLinkLabel: "{{name}} (Github)",
                about: "Informazioni su Sitrec",
                whatsNew: "Novità",
                whatsNewDetails: "Novità (Dettagli)",
                uiBasics: "Nozioni di Base dell'Interfaccia",
                savingLoading: "Salvataggio e Caricamento dei Sitch",
                customSitch: "Come configurare un sitch",
                tracks: "Tracce e Fonti di Dati",
                gis: "GIS e Cartografia",
                starlink: "Come Investigare i Flare Starlink",
                customModels: "Oggetti e Modelli 3D (Aerei)",
                cameraModes: "Modalità Telecamera (Normale e Satellite)",
                thirdPartyNotices: "Avvisi di Terze Parti",
                thirdPartyNoticesTooltip: "Attribuzioni di licenze open-source per software di terze parti incluso",
                downloadBridge: "Scarica MCP Bridge",
                downloadBridgeTooltip: "Scarica il server MCP SitrecBridge + estensione Chrome (nessuna dipendenza, serve solo Node.js)",
            },
            externalLinks: {
                title: "Link Esterni",
                tooltip: "Link esterni di aiuto",
            },
            exportDebugLog: {
                label: "Esporta Log di Debug",
                tooltip: "Scarica tutto l'output della console (log, warn, error) come file di testo per il debug",
            },
        },
        debug: {
            title: "Debug",
            tooltip: "Strumenti di debug e monitoraggio\nUtilizzo memoria GPU, metriche di prestazione e altre informazioni di debug",
        },
    },
    file: {
        newSitch: {
            label: "Nuovo Sitch",
            tooltip: "Crea un nuovo sitch (ricaricherà questa pagina, reimpostando tutto)",
        },
        savingDisabled: "Salvataggio Disabilitato (clicca per accedere)",
        importFile: {
            label: "Importa File",
            tooltip: "Importa un file (o più file) dal tuo sistema locale. Equivale a trascinare e rilasciare un file nella finestra del browser",
        },
        server: {
            open: "Apri",
            save: {
                label: "Salva",
                tooltip: "Salva il sitch corrente sul server",
            },
            saveAs: {
                label: "Salva con Nome",
                tooltip: "Salva il sitch corrente sul server con un nuovo nome",
            },
            versions: {
                label: "Versioni",
                tooltip: "Carica una versione specifica del sitch attualmente selezionato",
            },
            browseFeatured: "Esplora i sitch in evidenza",
            browseAll: "Esplora tutti i tuoi sitch salvati in un elenco ricercabile e ordinabile",
        },
        local: {
            title: "Locale",
            titleWithFolder: "Locale: {{name}}",
            titleReconnect: "Locale: {{name}} (riconnetti)",
            status: "Stato",
            noFileSelected: "Nessun file locale selezionato",
            noFolderSelected: "Nessuna cartella selezionata",
            currentFile: "File corrente: {{name}}",
            statusDesktop: "File/stato di salvataggio locale corrente sul desktop",
            statusFolder: "Cartella/stato di salvataggio locale corrente",
            stateReady: "Pronto",
            stateReconnect: "Riconnessione necessaria",
            stateNoFolder: "Nessuna cartella",
            statusLine: "{{state}} | Cartella: {{folder}} | Destinazione: {{target}}",
            saveLocal: {
                label: "Salva Locale",
                tooltipDesktop: "Salva nel file locale corrente, o richiedi un nome file se necessario",
                tooltipFolder: "Salva nella cartella di lavoro (o richiede una posizione se nessuna è impostata)",
                tooltipSaveBack: "Salva di nuovo in {{name}}",
                tooltipSaveBackInFolder: "Salva di nuovo in {{name}} nella cartella {{folder}}",
                tooltipSaveInto: "Salva in {{folder}} (richiede il nome del sitch)",
                tooltipPrompt: "Salva un file sitch locale (richiede nome/posizione)",
                tooltipSaveTo: "Salva il sitch corrente in un file locale",
            },
            saveLocalAs: {
                label: "Salva Locale con Nome...",
                tooltipDesktop: "Salva un file sitch locale in un nuovo percorso",
                tooltipFolder: "Salva un file sitch locale, scegliendo la posizione",
                tooltipInFolder: "Salva con un nuovo nome file nella cartella di lavoro corrente",
                tooltipNewPath: "Salva il sitch corrente in un nuovo percorso file locale",
            },
            openLocal: {
                label: "Apri Sitch Locale",
                labelShort: "Apri Locale...",
                tooltipDesktop: "Apri un file sitch locale dal disco",
                tooltipFolder: "Apri un file sitch dalla cartella di lavoro corrente",
                tooltipCurrent: "Apri un file sitch locale diverso (corrente: {{name}})",
                tooltipFromFolder: "Apri un file sitch da {{folder}}",
            },
            selectFolder: {
                label: "Seleziona Cartella Sitch Locale",
                tooltip: "Seleziona una cartella di lavoro per le operazioni locali di salvataggio/caricamento",
            },
            reconnectFolder: {
                label: "Riconnetti Cartella",
                tooltip: "Concedi nuovamente l'accesso alla cartella di lavoro utilizzata in precedenza",
            },
        },
        debug: {
            recalculateAll: "debug ricalcola tutto",
            dumpNodes: "debug elenca nodi",
            dumpNodesBackwards: "debug elenca nodi al contrario",
            dumpRoots: "debug elenca nodi radice",
        },
    },
    videoExport: {
        notAvailable: "Esportazione Video Non Disponibile",
        folder: {
            title: "Rendering ed Esportazione Video",
            tooltip: "Opzioni per il rendering e l'esportazione di file video dalle viste di Sitrec o dalla viewport completa",
        },
        renderView: {
            label: "Rendering Vista Video",
            tooltip: "Seleziona quale vista esportare come video",
        },
        renderSingleVideo: {
            label: "Rendering Video Vista Singola",
            tooltip: "Esporta la vista selezionata come file video con tutti i fotogrammi",
        },
        videoFormat: {
            label: "Formato Video",
            tooltip: "Seleziona il formato di output del video",
        },
        renderViewport: {
            label: "Rendering Video Viewport",
            tooltip: "Esporta l'intera viewport come file video con tutti i fotogrammi",
        },
        renderFullscreen: {
            label: "Rendering Video a Schermo Intero",
            tooltip: "Esporta l'intera viewport in modalità schermo intero come file video con tutti i fotogrammi",
        },
        recordWindow: {
            label: "Registra Finestra del Browser",
            tooltip: "Registra l'intera finestra del browser (inclusi menu e interfaccia) come video con framerate bloccato",
        },
        retinaExport: {
            label: "Usa Esportazione HD/Retina",
            tooltip: "Esporta a risoluzione retina/HiDPI (2x sulla maggior parte dei display)",
        },
        includeAudio: {
            label: "Includi Audio",
            tooltip: "Includi la traccia audio dal video sorgente se disponibile",
        },
        waitForLoading: {
            label: "Attendi caricamento in background",
            tooltip: "Quando abilitato, il rendering attende il caricamento di terreno/edifici/sfondo prima di catturare ogni fotogramma",
        },
        exportFrame: {
            label: "Esporta Fotogramma Video",
            tooltip: "Esporta il fotogramma video corrente come visualizzato (con effetti) come file PNG",
        },
    },
    tracking: {
        enable: {
            label: "Abilita Tracciamento Automatico",
            disableLabel: "Disabilita Tracciamento Automatico",
            tooltip: "Attiva/disattiva la visualizzazione del cursore di tracciamento automatico sul video",
        },
        start: {
            label: "Avvia Tracciamento Automatico",
            stopLabel: "Ferma Tracciamento Automatico",
            tooltip: "Traccia automaticamente l'oggetto all'interno del cursore durante la riproduzione del video",
        },
        clearFromHere: {
            label: "Cancella da Qui",
            tooltip: "Cancella tutte le posizioni tracciate dal fotogramma corrente alla fine",
        },
        clearTrack: {
            label: "Cancella Traccia",
            tooltip: "Cancella tutte le posizioni tracciate automaticamente e ricomincia da zero",
        },
        stabilize: {
            label: "Stabilizza",
            tooltip: "Applica le posizioni tracciate automaticamente per stabilizzare il video",
        },
        stabilizeToggle: {
            enableLabel: "Abilita Stabilizzazione",
            disableLabel: "Disabilita Stabilizzazione",
            tooltip: "Attiva/disattiva la stabilizzazione video",
        },
        stabilizeCenters: {
            label: "Stabilizza al Centro",
            tooltip: "Quando selezionato, il punto stabilizzato è fisso al centro della vista. Quando deselezionato, rimane nella posizione iniziale.",
        },
        renderStabilized: {
            label: "Rendering Video Stabilizzato",
            tooltip: "Esporta video stabilizzato a dimensione originale (il punto tracciato resta fisso, i bordi possono mostrare nero)",
        },
        renderStabilizedExpanded: {
            label: "Rendering Stabilizzato Espanso",
            tooltip: "Esporta video stabilizzato con canvas espanso affinché nessun pixel venga perso",
        },
        trackRadius: {
            label: "Raggio di Tracciamento",
            tooltip: "Dimensione del modello da confrontare (dimensione dell'oggetto)",
        },
        searchRadius: {
            label: "Raggio di Ricerca",
            tooltip: "Quanto lontano dalla posizione precedente cercare (aumentare per movimento veloce)",
        },
        trackingMethod: {
            label: "Metodo di Tracciamento",
            tooltip: "Corrispondenza Modello (OpenCV) o Flusso Ottico (jsfeat Lucas-Kanade)",
        },
        centerOnBright: {
            label: "Centra sul Chiaro",
            tooltip: "Traccia il centroide dei pixel chiari (migliore per stelle/luci puntiformi)",
        },
        centerOnDark: {
            label: "Centra sullo Scuro",
            tooltip: "Traccia il centroide dei pixel scuri",
        },
        brightnessThreshold: {
            label: "Soglia di Luminosità",
            tooltip: "Soglia di luminosità (0-255). Usata nelle modalità Centra sul Chiaro/Scuro",
        },
        status: {
            loadingJsfeat: "Caricamento jsfeat...",
            loadingOpenCv: "Caricamento OpenCV...",
            sam2Connecting: "SAM2: Connessione...",
            sam2Uploading: "SAM2: Caricamento...",
        },
    },
    trackManager: {
        removeTrack: "Rimuovi Traccia",
        createSpline: "Crea Spline",
        editTrack: "Modifica Traccia",
        constantSpeed: "Velocità Costante",
        extrapolateTrack: "Estrapola Traccia",
        curveType: "Tipo di Curva",
        altLockAGL: "Blocca Alt AGL",
        deleteTrack: "Elimina Traccia",
    },
    gpuMonitor: {
        enabled: "Monitor Abilitato",
        total: "Memoria Totale",
        geometries: "Geometrie",
        textures: "Texture",
        peak: "Memoria di Picco",
        average: "Memoria Media",
        reset: "Reimposta Cronologia",
    },
    situationSetup: {
        mainFov: {
            label: "FOV Principale",
            tooltip: "Campo visivo della telecamera della vista principale (VERTICALE)",
        },
        lookCameraFov: "FOV Telecamera di Osservazione",
        azimuth: "azimut",
        jetPitch: "Beccheggio del Jet",
    },
    featureManager: {
        labelText: "Testo dell'Etichetta",
        latitude: "Latitudine",
        longitude: "Longitudine",
        altitude: "Altitudine (m)",
        arrowLength: "Lunghezza Freccia",
        arrowColor: "Colore Freccia",
        textColor: "Colore Testo",
        deleteFeature: "Elimina Segnaposto",
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "Esporta Panorama Osservazione",
            tooltip: "Crea un'immagine panoramica dalla vista di osservazione su tutti i fotogrammi basata sulla posizione dello sfondo",
        },
    },
    dateTime: {
        liveMode: {
            label: "Modalità Live",
            tooltip: "Se la Modalità Live è attiva, la riproduzione sarà sempre sincronizzata con l'ora corrente.\nMettere in pausa o trascinare il tempo disabiliterà la modalità live",
        },
        startTime: {
            tooltip: "L'ora di INIZIO del primo fotogramma del video, in formato UTC",
        },
        currentTime: {
            tooltip: "L'ora CORRENTE del video. Questo è ciò a cui si riferiscono la data e l'ora sottostanti",
        },
        year: { label: "Anno", tooltip: "Anno del fotogramma corrente" },
        month: { label: "Mese", tooltip: "Mese (1-12)" },
        day: { label: "Giorno", tooltip: "Giorno del mese" },
        hour: { label: "Ora", tooltip: "Ora (0-23)" },
        minute: { label: "Minuto", tooltip: "Minuto (0-59)" },
        second: { label: "Secondo", tooltip: "Secondo (0-59)" },
        millisecond: { label: "ms", tooltip: "Millisecondo (0-999)" },
        useTimeZone: {
            label: "Usa Fuso Orario nell'Interfaccia",
            tooltip: "Usa il fuso orario nell'interfaccia soprastante\nQuesto cambierà la data e l'ora nel fuso orario selezionato, invece di UTC.\nUtile per visualizzare la data e l'ora in un fuso orario specifico, come quello locale del video o della posizione.",
        },
        timeZone: {
            label: "Fuso Orario",
            tooltip: "Il fuso orario per visualizzare la data e l'ora nella vista di osservazione\nAnche nell'interfaccia se 'Usa Fuso Orario nell'Interfaccia' è selezionato",
        },
        simSpeed: {
            label: "Velocità di Simulazione",
            tooltip: "La velocità della simulazione, 1 è tempo reale, 2 è il doppio, ecc.\nQuesto non cambia la velocità di riproduzione del video, solo i calcoli temporali della simulazione.",
        },
        sitchFrames: {
            label: "Fotogrammi del Sitch",
            tooltip: "Il numero di fotogrammi nel sitch. Se c'è un video sarà il numero di fotogrammi nel video, ma puoi modificarlo se vuoi aggiungere più fotogrammi al sitch, o se vuoi usare il sitch senza un video",
        },
        sitchDuration: {
            label: "Durata del Sitch",
            tooltip: "Durata del sitch in formato HH:MM:SS.sss",
        },
        aFrame: {
            label: "Fotogramma A",
            tooltip: "Limita la riproduzione tra A e B, visualizzati in verde e rosso sul cursore dei fotogrammi",
        },
        bFrame: {
            label: "Fotogramma B",
            tooltip: "Limita la riproduzione tra A e B, visualizzati in verde e rosso sul cursore dei fotogrammi",
        },
        videoFps: {
            label: "FPS Video",
            tooltip: "I fotogrammi al secondo del video. Questo cambierà la velocità di riproduzione del video (es: 30 fps, 25 fps, ecc). Cambierà anche la durata del sitch (in secondi) poiché cambia la durata di ogni singolo fotogramma\nQuesto è derivato dal video quando possibile, ma puoi modificarlo se vuoi accelerare o rallentare il video",
        },
        syncTimeTo: {
            label: "Sincronizza Tempo con",
            tooltip: "Sincronizza l'ora di inizio del video con l'ora di inizio originale, l'ora corrente, o l'ora di inizio di una traccia (se caricata)",
        },
    },
    jet: {
        frames: {
            time: {
                label: "Tempo (sec)",
                tooltip: "Tempo corrente dall'inizio del video in secondi (fotogramma / fps)",
            },
            frame: {
                label: "Fotogramma nel Video",
                tooltip: "Numero del fotogramma corrente nel video",
            },
            paused: {
                label: "In Pausa",
                tooltip: "Attiva/disattiva lo stato di pausa (anche barra spaziatrice)",
            },
        },
        controls: {
            pingPong: "Ping-Pong A-B",
            podPitchPhysical: "Beccheggio Pod (Sfera)",
            podRollPhysical: "Rollio Testina Pod",
            deroFromGlare: "Derotazione = Angolo di Riflesso",
            jetPitch: "Beccheggio del Jet",
            lookFov: "FOV Stretto",
            elevation: "elevazione",
            glareStartAngle: "Angolo Iniziale Riflesso",
            initialGlareRotation: "Rotazione Iniziale Riflesso",
            scaleJetPitch: "Scala Beccheggio Jet con Rollio",
            horizonMethod: "Metodo Orizzonte",
            horizonMethodOptions: {
                humanHorizon: "Orizzonte Umano",
                horizonAngle: "Angolo dell'Orizzonte",
            },
            videoSpeed: "Velocità Video",
            podWireframe: "Wireframe Pod [P]osteriore",
            showVideo: "[V]ideo",
            showGraph: "[G]rafico",
            showKeyboardShortcuts: "Scorciatoie da [T]astiera",
            showPodHead: "Rollio Testina [P]od",
            showPodsEye: "Vista [O]cchio del Pod c/ derot",
            showLookCam: "Vista [N]AR c/ derot",
            showCueData: "Dati di [C]ue",
            showGlareGraph: "M[o]stra Grafico Riflesso",
            showAzGraph: "Mostra Grafico A[Z]",
            declutter: "[D]isimpegna",
            jetOffset: "Offset Y del Jet",
            tas: "TAS Velocità Reale",
            integrate: "Passi di Integrazione",
        },
    },
    motionAnalysis: {
        menu: {
            title: "Analisi del Movimento",
            analyzeMotion: {
                label: "Analizza Movimento",
                tooltip: "Attiva/disattiva l'overlay di analisi del movimento in tempo reale sul video",
            },
            createTrack: {
                label: "Crea Traccia dal Movimento",
                tooltip: "Analizza tutti i fotogrammi e crea una traccia a terra dai vettori di movimento",
            },
            alignWithFlow: {
                label: "Allinea con il Flusso",
                tooltip: "Ruota l'immagine in modo che la direzione del movimento sia orizzontale",
            },
            panorama: {
                title: "Panorama",
                exportImage: {
                    label: "Esporta Panorama di Movimento",
                    tooltip: "Crea un'immagine panoramica dai fotogrammi video usando gli offset del tracciamento del movimento",
                },
                exportVideo: {
                    label: "Esporta Video Panoramico",
                    tooltip: "Crea un video 4K che mostra il panorama con overlay del fotogramma video",
                },
                stabilize: {
                    label: "Stabilizza Video",
                    disableLabel: "Disabilita Stabilizzazione",
                    tooltip: "Stabilizza il video usando l'analisi del movimento globale (rimuove i tremolii della telecamera)",
                },
                panoFrameStep: {
                    label: "Passo Fotogramma Panorama",
                    tooltip: "Quanti fotogrammi saltare tra ogni fotogramma del panorama (1 = ogni fotogramma)",
                },
                crop: {
                    label: "Ritaglio Panorama",
                    tooltip: "Pixel da ritagliare da ogni bordo dei fotogrammi video",
                },
                useMask: {
                    label: "Usa Maschera nel Panorama",
                    tooltip: "Applica la maschera di tracciamento del movimento come trasparenza durante il rendering del panorama",
                },
                analyzeWithEffects: {
                    label: "Analizza con Effetti",
                    tooltip: "Applica le regolazioni video (contrasto, ecc.) ai fotogrammi usati per l'analisi del movimento",
                },
                exportWithEffects: {
                    label: "Esporta con Effetti",
                    tooltip: "Applica le regolazioni video alle esportazioni panoramiche",
                },
                removeOuterBlack: {
                    label: "Rimuovi Nero Esterno",
                    tooltip: "Rendi trasparenti i pixel neri ai bordi di ogni riga",
                },
            },
            trackingParameters: {
                title: "Parametri di Tracciamento",
                technique: {
                    label: "Tecnica",
                    tooltip: "Algoritmo di stima del movimento",
                },
                frameSkip: {
                    label: "Salto Fotogrammi",
                    tooltip: "Fotogrammi tra i confronti (maggiore = rileva movimenti più lenti)",
                },
                trackletLength: {
                    label: "Lunghezza Tracklet",
                    tooltip: "Numero di fotogrammi nel tracklet (maggiore = coerenza più rigorosa)",
                },
                blurSize: {
                    label: "Dimensione Sfocatura",
                    tooltip: "Sfocatura gaussiana per macro caratteristiche (numeri dispari)",
                },
                minMotion: {
                    label: "Movimento Minimo",
                    tooltip: "Magnitudine minima del movimento (pixel/fotogramma)",
                },
                maxMotion: {
                    label: "Movimento Massimo",
                    tooltip: "Magnitudine massima del movimento",
                },
                smoothing: {
                    label: "Ammorbidimento",
                    tooltip: "Ammorbidimento della direzione (maggiore = più ammorbidimento)",
                },
                minVectorCount: {
                    label: "Conteggio Minimo Vettori",
                    tooltip: "Numero minimo di vettori di movimento per un fotogramma valido",
                },
                minConfidence: {
                    label: "Confidenza Minima",
                    tooltip: "Confidenza minima di consenso per un fotogramma valido",
                },
                maxFeatures: {
                    label: "Massimo Caratteristiche",
                    tooltip: "Massimo di caratteristiche tracciate",
                },
                minDistance: {
                    label: "Distanza Minima",
                    tooltip: "Distanza minima tra le caratteristiche",
                },
                qualityLevel: {
                    label: "Livello di Qualità",
                    tooltip: "Soglia di qualità per il rilevamento delle caratteristiche",
                },
                maxTrackError: {
                    label: "Errore Massimo di Tracciamento",
                    tooltip: "Soglia massima di errore di tracciamento",
                },
                minQuality: {
                    label: "Qualità Minima",
                    tooltip: "Qualità minima per visualizzare la freccia",
                },
                staticThreshold: {
                    label: "Soglia Statica",
                    tooltip: "Il movimento al di sotto di questo valore è considerato statico (HUD)",
                },
            },
        },
        status: {
            loadingOpenCv: "Caricamento OpenCV...",
            stopAnalysis: "Ferma Analisi",
            analyzingPercent: "Analisi in corso... {{pct}}%",
            creatingTrack: "Creazione traccia...",
            buildingPanorama: "Costruzione panorama...",
            buildingPanoramaPercent: "Costruzione panorama... {{pct}}%",
            loadingFrame: "Caricamento fotogramma {{frame}}... ({{current}}/{{total}})",
            loadingFrameSkipped: "Caricamento fotogramma {{frame}}... ({{current}}/{{total}}) ({{skipped}} saltati)",
            renderingPercent: "Rendering... {{pct}}%",
            panoPercent: "Panorama... {{pct}}%",
            renderingVideo: "Rendering video...",
            videoPercent: "Video... {{pct}}%",
            saving: "Salvataggio...",
            buildingStabilization: "Costruzione stabilizzazione...",
            exportProgressTitle: "Esportazione video panoramico...",
        },
        errors: {
            noVideoView: "Nessuna vista video trovata.",
            noVideoData: "Nessun dato video trovato.",
            failedToLoadOpenCv: "Impossibile caricare OpenCV: {{message}}",
            noOriginTrack: "Nessuna traccia di origine trovata. È necessaria una traccia bersaglio o telecamera per determinare la posizione iniziale.",
            videoEncodingUnsupported: "Codifica video non supportata in questo browser",
            exportFailed: "Esportazione video fallita: {{reason}}",
            panoVideoExportFailed: "Esportazione video panoramico fallita: {{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[BETA] Estrazione Testo",
            enable: {
                label: "Abilita Estrazione Testo",
                disableLabel: "Disabilita Estrazione Testo",
                tooltip: "Attiva/disattiva la modalità di estrazione testo sul video",
            },
            addRegion: {
                label: "Aggiungi Regione",
                drawingLabel: "Clicca e trascina sul video...",
                tooltip: "Clicca e trascina sul video per definire una regione di estrazione testo",
            },
            removeRegion: {
                label: "Rimuovi Regione Selezionata",
                tooltip: "Rimuovi la regione attualmente selezionata",
            },
            clearRegions: {
                label: "Cancella Tutte le Regioni",
                tooltip: "Rimuovi tutte le regioni di estrazione testo",
            },
            startExtract: {
                label: "Avvia Estrazione",
                stopLabel: "Ferma Estrazione",
                tooltip: "Esegui OCR su tutte le regioni dal fotogramma corrente alla fine",
            },
            fixedWidthFont: {
                label: "Font a Larghezza Fissa",
                tooltip: "Abilita il rilevamento carattere per carattere per font a larghezza fissa (migliore per overlay FLIR/sensori)",
            },
            numChars: {
                label: "Numero Caratteri",
                tooltip: "Numero di caratteri nella regione selezionata (divide la regione in parti uguali)",
            },
            learnTemplates: {
                label: "Apprendi Modelli",
                activeLabel: "Clicca sui caratteri per apprendere...",
                tooltip: "Clicca sulle celle dei caratteri per insegnare i loro valori (per la corrispondenza di modelli)",
            },
            clearTemplates: {
                label: "Cancella Modelli",
                tooltip: "Rimuovi tutti i modelli di caratteri appresi",
            },
            useTemplates: {
                label: "Usa Modelli",
                tooltip: "Usa i modelli appresi per la corrispondenza (più veloce e preciso quando addestrato)",
            },
        },
        prompts: {
            learnCharacter: "Inserisci il carattere per la cella {{index}}:",
        },
        errors: {
            failedToLoadTesseract: "Impossibile caricare Tesseract.js. Assicurati che sia installato: npm install tesseract.js",
            noVideoView: "L'estrazione testo richiede una vista video",
        },
    },
    custom: {
        settings: {
            title: "Impostazioni",
            tooltipLoggedIn: "Impostazioni per utente salvate sul server (con backup nei cookie)",
            tooltipAnonymous: "Impostazioni per utente salvate nei cookie del browser",
            language: { label: "Lingua", tooltip: "Seleziona la lingua dell'interfaccia. La modifica ricarica la pagina. Si perderà il lavoro non salvato, quindi salvare prima!" },
            maxDetails: { label: "Dettaglio Massimo", tooltip: "Livello massimo di dettaglio per la suddivisione del terreno (5-30)" },
            fpsLimit: { label: "Limite Frequenza Fotogrammi", tooltip: "Imposta la frequenza fotogrammi massima (60, 30, 20 o 15 fps)" },
            tileSegments: { label: "Segmenti Tile", tooltip: "Risoluzione della mesh per i tile del terreno. Valori maggiori = più dettaglio ma più lento" },
            maxResolution: { label: "Risoluzione Massima", tooltip: "Risoluzione massima del fotogramma video (lato più lungo). Riduce l'uso della memoria GPU. Si applica ai fotogrammi appena caricati." },
            aiModel: { label: "Modello IA", tooltip: "Seleziona il modello IA per l'assistente di chat" },
            centerSidebar: { label: "Barra Laterale Centrale", tooltip: "Abilita la barra laterale centrale tra le viste divise (trascina i menu sulla linea divisoria)" },
            showAttribution: { label: "Mostra Attribuzione", tooltip: "Mostra l'overlay di attribuzione delle fonti dati di mappa ed elevazione" },
        },
        balloons: {
            count: { label: "Quantità", tooltip: "Numero di stazioni vicine da importare" },
            source: { label: "Fonte", tooltip: "uwyo = Università del Wyoming (necessita proxy PHP)\nigra2 = Archivio NOAA NCEI (download diretto)" },
            getNearby: { label: "Ottieni Palloni Sonda Vicini", tooltip: "Importa le N sonde meteorologiche più vicine alla posizione corrente della telecamera.\nUsa il lancio più recente prima dell'ora di inizio del sitch + 1 ora." },
            importSounding: { label: "Importa Sondaggio...", tooltip: "Selettore manuale di stazione: scegli stazione, data, fonte e importa un sondaggio specifico." },
        },
        showHide: {
            keyboardShortcuts: { label: "Scorciatoie da [T]astiera", tooltip: "Mostra o nasconde l'overlay delle scorciatoie da tastiera" },
            toggleExtendToGround: { label: "Attiva/disattiva TUTTE le [E]stensioni a Terra", tooltip: "Attiva/disattiva 'Estendi a Terra' per tutte le tracce\nDisattiverà tutte se qualcuna è attiva\nAttiverà tutte se nessuna è attiva" },
            showAllTracksInLook: { label: "Mostra Tutte le Tracce nella Vista di Osservazione", tooltip: "Visualizza tutte le tracce degli aerei nella vista di osservazione" },
            showCompassElevation: { label: "Mostra Elevazione Bussola", tooltip: "Mostra l'elevazione della bussola (angolo sopra il piano del terreno locale) oltre al rilevamento (azimut)" },
            filterTracks: { label: "Filtra Tracce", tooltip: "Mostra/nascondi tracce in base ad altitudine, direzione o intersezione con il frustum" },
            removeAllTracks: { label: "Rimuovi Tutte le Tracce", tooltip: "Rimuovi tutte le tracce dalla scena\nQuesto non rimuoverà gli oggetti, solo le tracce\nPuoi aggiungerle di nuovo trascinando e rilasciando i file" },
        },
        objects: {
            globalScale: { label: "Scala Globale", tooltip: "Fattore di scala applicato a tutti gli oggetti 3D nella scena - utile per trovarli. Reimpostare a 1 per la dimensione reale" },
        },
        admin: {
            dashboard: { label: "Pannello di Amministrazione", tooltip: "Apri il pannello di amministrazione" },
            validateAllSitches: { label: "Valida Tutti i Sitch", tooltip: "Carica tutti i sitch salvati con terreno locale per verificare la presenza di errori" },
            testUserID: { label: "ID Utente di Test", tooltip: "Opera come questo ID utente (0 = disabilitato, deve essere > 1)" },
            addMissingScreenshots: { label: "Aggiungi Screenshot Mancanti", tooltip: "Carica ogni sitch senza screenshot, esegui il rendering e carica uno screenshot" },
            feature: { label: "In Evidenza", tooltip: "Attiva/disattiva lo stato In Evidenza per il sitch attualmente caricato" },
        },
        viewPreset: { label: "Preimpostazione Vista", tooltip: "Passa tra diverse preimpostazioni di vista\nAffiancate, Sopra e Sotto, ecc." },
        subSitches: {
            folder: { tooltip: "Gestisci più configurazioni telecamera/vista all'interno di questo sitch" },
            updateCurrent: { label: "Aggiorna Sub Corrente", tooltip: "Aggiorna il Sub Sitch attualmente selezionato con le impostazioni di vista correnti" },
            updateAndAddNew: { label: "Aggiorna Corrente e Aggiungi Nuovo Sub", tooltip: "Aggiorna il Sub Sitch corrente, poi duplicalo in un nuovo Sub Sitch" },
            discardAndAddNew: { label: "Scarta Modifiche e Aggiungi Nuovo", tooltip: "Scarta le modifiche al Sub Sitch corrente e crea un nuovo Sub Sitch dallo stato corrente" },
            renameCurrent: { label: "Rinomina Sub Corrente", tooltip: "Rinomina il Sub Sitch attualmente selezionato" },
            deleteCurrent: { label: "Elimina Sub Corrente", tooltip: "Elimina il Sub Sitch attualmente selezionato" },
            syncSaveDetails: { label: "Sincronizza Dettagli Salvataggio Sub", tooltip: "Rimuovi dal sub corrente tutti i nodi non abilitati nei Dettagli di Salvataggio del Sub" },
        },
        contextMenu: {
            setCameraAbove: "Posiziona Telecamera Sopra",
            setCameraOnGround: "Posiziona Telecamera a Terra",
            setTargetAbove: "Posiziona Bersaglio Sopra",
            setTargetOnGround: "Posiziona Bersaglio a Terra",
            dropPin: "Segnaposto / Aggiungi Punto",
            createTrackWithObject: "Crea Traccia con Oggetto",
            createTrackNoObject: "Crea Traccia (Senza Oggetto)",
            addBuilding: "Aggiungi Edificio",
            addClouds: "Aggiungi Nuvole",
            addGroundOverlay: "Aggiungi Overlay a Terra",
            centerTerrain: "Centra Quadrato Terreno qui",
            googleMapsHere: "Google Maps Qui",
            googleEarthHere: "Google Earth Qui",
            removeClosestPoint: "Rimuovi Punto più Vicino",
            exitEditMode: "Esci dalla Modalità Modifica",
        },
    },
    view3d: {
        northUp: { label: "Vista Nord in Alto", tooltip: "Imposta la vista di osservazione con il nord in alto, invece del mondo in alto.\nPer viste satellitari e simili, guardando direttamente in basso.\nNon si applica in modalità PTZ" },
        atmosphere: { label: "Atmosfera", tooltip: "Attenuazione per distanza che fonde terreno e oggetti 3D verso il colore del cielo corrente" },
        atmoVisibility: { label: "Visibilità Atmosferica (km)", tooltip: "Distanza in cui il contrasto atmosferico scende a circa il 50% (minore = atmosfera più densa)" },
        atmoHDR: { label: "HDR Atmosferico", tooltip: "Nebbia/tone mapping HDR fisicamente basato per riflessi solari brillanti attraverso la foschia" },
        atmoExposure: { label: "Esposizione Atmosferica", tooltip: "Moltiplicatore di esposizione del tone mapping HDR atmosferico per l'attenuazione delle alte luci" },
        startXR: { label: "Avvia VR/XR", tooltip: "Avvia sessione WebXR per test (funziona con Immersive Web Emulator)" },
        effects: { label: "Effetti", tooltip: "Abilita/Disabilita Tutti gli Effetti" },
        focusTrack: { label: "Traccia di Messa a Fuoco", tooltip: "Seleziona una traccia per far guardare la telecamera verso di essa e ruotare attorno" },
        lockTrack: { label: "Blocca Traccia", tooltip: "Seleziona una traccia per bloccare la telecamera ad essa, in modo che si muova con la traccia" },
        debug: {
            clearBackground: "Cancella Sfondo", renderSky: "Rendering Cielo", renderDaySky: "Rendering Cielo Diurno",
            renderMainScene: "Rendering Scena Principale", renderEffects: "Rendering Effetti", copyToScreen: "Copia su Schermo",
            updateCameraMatrices: "Aggiorna Matrici Telecamera", mainUseLookLayers: "Principale Usa Layer di Osservazione",
            sRGBOutputEncoding: "Codifica Output sRGB", tileLoadDelay: "Ritardo Caricamento Tile (s)",
            updateStarScales: "Aggiorna Scale Stelle", updateSatelliteScales: "Aggiorna Scale Satelliti",
            renderNightSky: "Rendering Cielo Notturno", renderFullscreenQuad: "Rendering Quad a Schermo Intero", renderSunSky: "Rendering Cielo Solare",
        },
        celestial: {
            raHours: "AR (ore)", decDegrees: "Dec (gradi)", magnitude: "Magnitudine",
            noradNumber: "Numero NORAD", name: "Nome",
        },
    },
    nightSky: {
        loadLEO: { label: "Carica Satelliti LEO per la Data", tooltip: "Ottieni i dati TLE più recenti dei satelliti LEO per la data/ora impostata nel simulatore. Questo scaricherà i dati da internet, potrebbe richiedere alcuni secondi.\nAbiliterà anche la visualizzazione dei satelliti nel cielo notturno." },
        loadStarlink: { label: "Carica Starlink ATTUALI", tooltip: "Ottieni le posizioni ATTUALI (non storiche, adesso, in tempo reale) dei satelliti Starlink. Questo scaricherà i dati da internet, potrebbe richiedere alcuni secondi.\n" },
        loadActive: { label: "Carica Satelliti ATTIVI", tooltip: "Ottieni le posizioni ATTUALI (non storiche, adesso, in tempo reale) dei satelliti ATTIVI. Questo scaricherà i dati da internet, potrebbe richiedere alcuni secondi.\n" },
        loadSlow: { label: "(Sperimentale) Carica Satelliti LENTI", tooltip: "Ottieni i dati TLE più recenti dei satelliti LENTI per la data/ora impostata nel simulatore. Questo scaricherà i dati da internet, potrebbe richiedere alcuni secondi.\nAbiliterà anche la visualizzazione dei satelliti nel cielo notturno. Potrebbe scadere per date recenti" },
        loadAll: { label: "(Sperimentale) Carica TUTTI i Satelliti", tooltip: "Ottieni i dati TLE più recenti di TUTTI i satelliti per la data/ora impostata nel simulatore. Questo scaricherà i dati da internet, potrebbe richiedere alcuni secondi.\nAbiliterà anche la visualizzazione dei satelliti nel cielo notturno. Potrebbe scadere per date recenti" },
        flareAngle: { label: "Angolo di Dispersione del Flare", tooltip: "Angolo massimo del vettore di vista riflesso affinché un flare sia visibile\ncioè l'intervallo di angoli tra il vettore dal satellite al sole e il vettore dalla telecamera al satellite riflesso sul fondo del satellite (che è parallelo al suolo)" },
        penumbraDepth: { label: "Profondità della Penombra Terrestre", tooltip: "Profondità verticale in metri entro cui un satellite svanisce entrando nell'ombra della Terra" },
        sunAngleArrows: { label: "Frecce Angolo Solare", tooltip: "Quando viene rilevato un riflesso, mostra frecce dalla telecamera al satellite e dal satellite al sole" },
        celestialFolder: { tooltip: "Elementi relativi al cielo notturno" },
        vectorsOnTraverse: { label: "Vettori sull'Oggetto di Attraversamento", tooltip: "Se selezionato, i vettori sono mostrati relativi all'oggetto di attraversamento. Altrimenti sono mostrati relativi alla telecamera di osservazione." },
        vectorsInLookView: { label: "Vettori nella Vista di Osservazione", tooltip: "Se selezionato, i vettori sono mostrati nella Vista di Osservazione. Altrimenti solo nella vista principale." },
        showSatellitesGlobal: { label: "Mostra Satelliti (Globale)", tooltip: "Controllo principale: mostra o nascondi tutti i satelliti" },
        showStarlink: { label: "Starlink", tooltip: "Mostra i satelliti SpaceX Starlink" },
        showISS: { label: "ISS", tooltip: "Mostra la Stazione Spaziale Internazionale" },
        celestrackBrightest: { label: "Più Luminosi di Celestrack", tooltip: "Mostra l'elenco dei satelliti più luminosi di Celestrack" },
        otherSatellites: { label: "Altri Satelliti", tooltip: "Mostra i satelliti non inclusi nelle categorie precedenti" },
        list: { label: "Elenco", tooltip: "Mostra un elenco testuale dei satelliti visibili" },
        satelliteArrows: { label: "Frecce Satelliti", tooltip: "Mostra frecce che indicano le traiettorie dei satelliti" },
        flareLines: { label: "Linee di Flare", tooltip: "Mostra linee che collegano i satelliti in flare alla telecamera e al Sole" },
        satelliteGroundArrows: { label: "Frecce a Terra dei Satelliti", tooltip: "Mostra frecce verso il suolo sotto ogni satellite" },
        satelliteLabelsLook: { label: "Etichette Satelliti (Vista di Osservazione)", tooltip: "Mostra le etichette con i nomi dei satelliti nella vista di osservazione" },
        satelliteLabelsMain: { label: "Etichette Satelliti (Vista Principale)", tooltip: "Mostra le etichette con i nomi dei satelliti nella vista 3D principale" },
        labelFlaresOnly: { label: "Etichetta Solo Flare", tooltip: "Etichetta solo i satelliti che sono attualmente in flare" },
        labelLitOnly: { label: "Etichetta Solo Illuminati", tooltip: "Etichetta solo i satelliti illuminati dal sole (non nell'ombra della Terra)" },
        labelLookVisibleOnly: { label: "Etichetta Solo Visibili nella Vista", tooltip: "Etichetta solo i satelliti visibili nel frustum della telecamera di osservazione" },
        flareRegion: { label: "Regione di Flare", tooltip: "Mostra la regione del cielo dove i flare dei satelliti sono visibili" },
        flareBand: { label: "Fascia di Flare", tooltip: "Mostra la fascia a terra dove i flare di una traccia satellitare spazzano" },
        filterTLEs: { label: "Filtra TLE", tooltip: "Filtra i satelliti visibili per altitudine, posizione, parametri orbitali o nome" },
        clearTLEFilter: { label: "Cancella Filtro TLE", tooltip: "Rimuovi tutti i filtri spaziali/orbitali TLE, ripristinando la visibilità basata su categoria" },
        maxLabelsDisplayed: { label: "Massimo Etichette Visualizzate", tooltip: "Numero massimo di etichette satellitari da renderizzare contemporaneamente" },
        starBrightness: { label: "Luminosità Stelle", tooltip: "Fattore di scala per la luminosità delle stelle. 1 è normale, 0 è invisibile, 2 è il doppio, ecc." },
        starLimit: { label: "Limite Stelle", tooltip: "Limite di luminosità per la visualizzazione delle stelle" },
        planetBrightness: { label: "Luminosità Pianeti", tooltip: "Fattore di scala per la luminosità dei pianeti (esclusi Sole e Luna). 1 è normale, 0 è invisibile, 2 è il doppio, ecc." },
        lockStarPlanetBrightness: { label: "Blocca Luminosità Stelle-Pianeti", tooltip: "Quando selezionato, i cursori di Luminosità Stelle e Luminosità Pianeti sono bloccati insieme" },
        satBrightness: { label: "Luminosità Satelliti", tooltip: "Fattore di scala per la luminosità dei satelliti. 1 è normale, 0 è invisibile, 2 è il doppio, ecc." },
        flareBrightness: { label: "Luminosità Flare", tooltip: "Fattore di scala per la luminosità aggiuntiva dei satelliti in flare. 0 è nulla" },
        satCutOff: { label: "Taglio Satelliti", tooltip: "I satelliti attenuati a questo livello o inferiore non saranno visualizzati" },
        displayRange: { label: "Raggio di Visualizzazione (km)", tooltip: "I satelliti oltre questa distanza non avranno i nomi o le frecce visualizzate" },
        equatorialGrid: { label: "Griglia Equatoriale", tooltip: "Mostra la griglia di coordinate equatoriali celesti" },
        constellationLines: { label: "Linee delle Costellazioni", tooltip: "Mostra linee che collegano le stelle nelle costellazioni" },
        renderStars: { label: "Rendering Stelle", tooltip: "Mostra le stelle nel cielo notturno" },
        equatorialGridLook: { label: "Griglia Equatoriale nella Vista di Osservazione", tooltip: "Mostra la griglia equatoriale nella vista di osservazione" },
        flareRegionLook: { label: "Regione Flare nella Vista di Osservazione", tooltip: "Mostra il cono della regione di flare nella vista di osservazione" },
        satelliteEphemeris: { label: "Effemeridi del Satellite" },
        skyPlot: { label: "Mappa del Cielo" },
        celestialVector: { label: "Vettore di {{name}}", tooltip: "Mostra un vettore di direzione che punta verso {{name}}" },
    },
    synthClouds: {
        name: { label: "Nome" },
        visible: { label: "Visibile" },
        editMode: { label: "Modalità Modifica" },
        altitude: { label: "Altitudine" },
        radius: { label: "Raggio" },
        cloudSize: { label: "Dimensione Nuvola" },
        density: { label: "Densità" },
        opacity: { label: "Opacità" },
        brightness: { label: "Luminosità" },
        depth: { label: "Profondità" },
        edgeWiggle: { label: "Ondulazione Bordo" },
        edgeFrequency: { label: "Frequenza Bordo" },
        seed: { label: "Seme" },
        feather: { label: "Sfumatura" },
        windMode: { label: "Modalità Vento" },
        windFrom: { label: "Vento Da (\u00b0)" },
        windKnots: { label: "Vento (nodi)" },
        deleteClouds: { label: "Elimina Nuvole" },
    },
    synthBuilding: {
        name: { label: "Nome" },
        visible: { label: "Visibile" },
        editMode: { label: "Modalità Modifica" },
        roofEdgeHeight: { label: "Altezza Bordo Tetto" },
        ridgelineHeight: { label: "Altezza Colmo" },
        ridgelineInset: { label: "Rientro Colmo" },
        roofEaves: { label: "Gronde del Tetto" },
        type: { label: "Tipo" },
        wallColor: { label: "Colore Parete" },
        roofColor: { label: "Colore Tetto" },
        opacity: { label: "Opacità" },
        transparent: { label: "Trasparente" },
        wireframe: { label: "Wireframe" },
        depthTest: { label: "Test di Profondità" },
        deleteBuilding: { label: "Elimina Edificio" },
    },

    groundOverlay: {
        name: { label: "Nome" },
        visible: { label: "Visibile" },
        editMode: { label: "Modalità Modifica" },
        lockShape: { label: "Blocca Forma" },
        freeTransform: { label: "Trasformazione Libera" },
        showBorder: { label: "Mostra Bordo" },
        properties: { label: "Proprietà" },
        imageURL: { label: "URL Immagine" },
        rehostLocalImage: { label: "Riospita Immagine Locale" },
        north: { label: "Nord" },
        south: { label: "Sud" },
        east: { label: "Est" },
        west: { label: "Ovest" },
        rotation: { label: "Rotazione" },
        altitude: { label: "Altitudine (piedi)" },
        wireframe: { label: "Wireframe" },
        opacity: { label: "Opacità" },
        cloudExtraction: { label: "Estrazione Nuvole" },
        extractClouds: { label: "Estrai Nuvole" },
        cloudColor: { label: "Colore Nuvola" },
        fuzziness: { label: "Sfumatura" },
        feather: { label: "Sfumatura Bordi" },
        gotoOverlay: { label: "Vai all'Overlay" },
        deleteOverlay: { label: "Elimina Overlay" },
    },

    videoView: {
        folders: {
            videoAdjustments: "Regolazioni Video",
            videoProcessing: "Elaborazione Video",
            forensics: "Analisi Forense",
            errorLevelAnalysis: "Analisi Livello di Errore",
            noiseAnalysis: "Analisi del Rumore",
            grid: "Griglia",
        },
        currentVideo: { label: "Video Corrente" },
        videoRotation: { label: "Rotazione Video" },
        setCameraToExifGps: { label: "Imposta Telecamera su GPS EXIF" },
        expandOutput: {
            label: "Espandi Output",
            tooltip: "Metodo per espandere la gamma dinamica dell'output ELA",
        },
        displayMode: {
            label: "Modalità Visualizzazione",
            tooltip: "Come visualizzare i risultati dell'analisi del rumore",
        },
        convolutionFilter: {
            label: "Filtro di Convoluzione",
            tooltip: "Tipo di filtro di convoluzione spaziale da applicare",
        },
        resetVideoAdjustments: {
            label: "Reimposta Regolazioni Video",
            tooltip: "Reimposta tutte le regolazioni video ai valori predefiniti",
        },
        makeVideo: {
            label: "Crea Video",
            tooltip: "Esporta il video elaborato con tutti gli effetti correnti applicati",
        },
        gridShow: {
            label: "Mostra",
            tooltip: "Mostra un overlay a griglia sul video",
        },
        gridSize: {
            label: "Dimensione",
            tooltip: "Dimensione della cella della griglia in pixel",
        },
        gridSubdivisions: {
            label: "Suddivisioni",
            tooltip: "Numero di suddivisioni all'interno di ogni cella della griglia",
        },
        gridXOffset: {
            label: "Offset X",
            tooltip: "Offset orizzontale della griglia in pixel",
        },
        gridYOffset: {
            label: "Offset Y",
            tooltip: "Offset verticale della griglia in pixel",
        },
        gridColor: {
            label: "Colore",
            tooltip: "Colore delle linee della griglia",
        },
    },

    floodSim: {
        flood: {
            label: "Inondazione",
            tooltip: "Abilita o disabilita la simulazione di particelle di inondazione",
        },
        floodRate: {
            label: "Tasso di Inondazione",
            tooltip: "Numero di particelle generate per fotogramma",
        },
        sphereSize: {
            label: "Dimensione Sfera",
            tooltip: "Raggio visivo di ogni particella d'acqua",
        },
        dropRadius: {
            label: "Raggio di Caduta",
            tooltip: "Raggio attorno al punto di caduta dove le particelle vengono generate",
        },
        maxParticles: {
            label: "Massimo Particelle",
            tooltip: "Numero massimo di particelle d'acqua attive",
        },
        method: {
            label: "Metodo",
            tooltip: "Metodo di simulazione: HeightMap (griglia), Fast (particelle) o PBF (fluidi basati sulla posizione)",
        },
        waterSource: {
            label: "Fonte d'Acqua",
            tooltip: "Pioggia: aggiungi acqua nel tempo. Rottura Diga: mantieni il livello d'acqua all'altitudine target entro il raggio di caduta",
        },
        speed: {
            label: "Velocità",
            tooltip: "Passi di simulazione per fotogramma (1-20x)",
        },
        manningN: {
            label: "N di Manning",
            tooltip: "Rugosità del letto: 0.01=liscio, 0.03=canale naturale, 0.05=piana alluvionale rugosa, 0.1=vegetazione densa",
        },
        edge: {
            label: "Bordo",
            tooltip: "Blocco: l'acqua si riflette ai bordi della griglia. Drenaggio: l'acqua defluisce e viene rimossa",
        },
        waterColor: {
            label: "Colore Acqua",
            tooltip: "Colore dell'acqua",
        },
        reset: {
            label: "Reimposta",
            tooltip: "Rimuovi tutte le particelle e riavvia la simulazione",
        },
    },

    flowOrbs: {
        number: {
            label: "Numero",
            tooltip: "Numero di sfere di flusso da visualizzare. Più sfere possono influire sulle prestazioni.",
        },
        spreadMethod: {
            label: "Metodo di Distribuzione",
            tooltip: "Metodo per distribuire le sfere lungo il vettore di vista della telecamera. \n'Raggio d'azione' distribuisce le sfere uniformemente lungo il vettore di vista tra le distanze vicina e lontana. \n'Altitudine' distribuisce le sfere uniformemente lungo il vettore di vista, tra le altitudini assolute bassa e alta (MSL)",
        },
        near: {
            label: "Vicino (m)",
            tooltip: "Distanza più vicina dalla telecamera per il posizionamento delle sfere",
        },
        far: {
            label: "Lontano (m)",
            tooltip: "Distanza più lontana dalla telecamera per il posizionamento delle sfere",
        },
        high: { label: "Alto (m)" },
        low: { label: "Basso (m)" },
        colorMethod: {
            label: "Metodo Colore",
            tooltip: "Metodo per determinare il colore delle sfere di flusso. \n'Casuale' assegna un colore casuale a ogni sfera. \n'Utente' assegna un colore selezionato dall'utente a tutte le sfere. \n'Tinta per Altitudine' assegna un colore basato sull'altitudine della sfera. \n'Tinta per Distanza' assegna un colore basato sulla distanza della sfera dalla telecamera.",
        },
        userColor: {
            label: "Colore Utente",
            tooltip: "Seleziona un colore per le sfere di flusso quando il 'Metodo Colore' è impostato su 'Utente'.",
        },
        hueRange: {
            label: "Gamma di Tinta",
            tooltip: "Gamma su cui si ottiene uno spettro completo di colori per il metodo colore 'Tinta per Altitudine/Raggio d'azione'.",
        },
        windWhilePaused: {
            label: "Vento con Simulazione in Pausa",
            tooltip: "Se selezionato, il vento influenzerà comunque le sfere di flusso anche quando la simulazione è in pausa. Utile per visualizzare i pattern del vento.",
        },
    },

    osdController: {
        seriesName: {
            label: "Nome",
        },
        seriesType: {
            label: "Tipo",
        },
        seriesShow: {
            label: "Mostra",
        },
        seriesLock: {
            label: "Blocca",
        },
        removeTrack: {
            label: "Rimuovi Traccia",
        },
        folderTitle: {
            label: "Tracker OSD",
            tooltip: "Tracker di testo a schermo (On-Screen Display) per testo per fotogramma definito dall'utente",
        },
        addNewTrack: {
            label: "Aggiungi Nuova Serie Dati OSD",
            tooltip: "Crea una nuova serie dati OSD per overlay di testo per fotogramma",
        },
        makeTrack: {
            label: "Crea Traccia",
            tooltip: "Crea una traccia di posizione dalle serie dati OSD visibili/sbloccate (MGRS o Lat/Lon)",
        },
        showAll: {
            label: "Mostra Tutto",
            tooltip: "Attiva/disattiva la visibilità di tutte le serie dati OSD",
        },
        exportAllData: {
            label: "Esporta Tutti i Dati",
            tooltip: "Esporta tutte le serie dati OSD come CSV in un file ZIP",
        },
        graphShow: {
            label: "Mostra",
            tooltip: "Mostra o nascondi la vista grafico dei dati OSD",
        },
        xAxis: {
            label: "Asse X",
            tooltip: "Serie dati per l'asse orizzontale",
        },
        y1Axis: {
            label: "Asse Y1",
            tooltip: "Serie dati per l'asse verticale sinistro",
        },
        y2Axis: {
            label: "Asse Y2",
            tooltip: "Serie dati per l'asse verticale destro",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "Visualizzazione Informazioni Video",
            tooltip: "Controlli di visualizzazione delle informazioni video per contatore fotogrammi, timecode e timestamp",
        },
        showVideoInfo: {
            label: "Mostra Informazioni Video",
            tooltip: "Controllo principale - abilita o disabilita tutte le visualizzazioni di informazioni video",
        },
        frameCounter: {
            label: "Numero Fotogramma",
            tooltip: "Mostra il numero del fotogramma corrente (fotogramma virtuale quando il video è ricalibrato)",
        },
        sourceFrame: {
            label: "Numero Fotogramma Sorgente",
            tooltip: "Mostra il numero del fotogramma sorgente decodificato (differisce dal Numero Fotogramma durante le pause quando il video è ricalibrato)",
        },
        offsetFrame: {
            label: "Fotogramma con Offset",
            tooltip: "Mostra il numero del fotogramma corrente più un valore di offset",
        },
        offsetValue: {
            label: "Valore Offset",
            tooltip: "Valore di offset aggiunto al numero del fotogramma corrente",
        },
        timecode: {
            label: "Timecode",
            tooltip: "Mostra il timecode in formato HH:MM:SS:FF",
        },
        timestamp: {
            label: "Timestamp",
            tooltip: "Mostra il timestamp in formato HH:MM:SS.SS",
        },
        dateLocal: {
            label: "Data (Locale)",
            tooltip: "Mostra la data corrente nel fuso orario selezionato",
        },
        timeLocal: {
            label: "Ora (Locale)",
            tooltip: "Mostra l'ora corrente nel fuso orario selezionato",
        },
        dateTimeLocal: {
            label: "Data e Ora (Locale)",
            tooltip: "Mostra data e ora complete nel fuso orario selezionato",
        },
        dateUTC: {
            label: "Data (UTC)",
            tooltip: "Mostra la data corrente in UTC",
        },
        timeUTC: {
            label: "Ora (UTC)",
            tooltip: "Mostra l'ora corrente in UTC",
        },
        dateTimeUTC: {
            label: "Data e Ora (UTC)",
            tooltip: "Mostra data e ora complete in UTC",
        },
        fontSize: {
            label: "Dimensione Font",
            tooltip: "Regola la dimensione del font del testo informativo",
        },
    },

    terrainUI: {
        mapType: {
            label: "Tipo di Mappa",
            tooltip: "Tipo di mappa per le texture del terreno (separato dai dati di elevazione)",
        },
        elevationType: {
            label: "Tipo di Elevazione",
            tooltip: "Fonte dati di elevazione per i dati di altezza del terreno",
        },
        lat: {
            tooltip: "Latitudine del centro del terreno",
        },
        lon: {
            tooltip: "Longitudine del centro del terreno",
        },
        zoom: {
            tooltip: "Livello di zoom del terreno. 2 è il mondo intero, 15 sono pochi isolati",
        },
        nTiles: {
            tooltip: "Numero di tile nel terreno. Più tile significa più dettaglio, ma caricamento più lento. (NxN)",
        },
        refresh: {
            label: "Aggiorna",
            tooltip: "Aggiorna il terreno con le impostazioni correnti. Usa per problemi di rete che potrebbero aver causato un caricamento fallito",
        },
        debugGrids: {
            label: "Griglie di Debug",
            tooltip: "Mostra una griglia di texture del terreno (Verde) e dati di elevazione (Blu)",
        },
        elevationScale: {
            tooltip: "Fattore di scala per i dati di elevazione. 1 è normale, 0.5 è metà altezza, 2 è doppia altezza",
        },
        terrainOpacity: {
            label: "Opacità Terreno",
            tooltip: "Opacità del terreno. 0 è completamente trasparente, 1 è completamente opaco",
        },
        textureDetail: {
            tooltip: "Livello di dettaglio per la suddivisione delle texture. Valori maggiori = più dettaglio. 1 è normale, 0.5 è meno dettaglio, 2 è più dettaglio",
        },
        elevationDetail: {
            tooltip: "Livello di dettaglio per la suddivisione dell'elevazione. Valori maggiori = più dettaglio. 1 è normale, 0.5 è meno dettaglio, 2 è più dettaglio",
        },
        disableDynamicSubdivision: {
            label: "Disabilita Suddivisione Dinamica",
            tooltip: "Disabilita la suddivisione dinamica dei tile del terreno. Congela il terreno al livello di dettaglio corrente. Utile per il debug.",
        },
        dynamicSubdivision: {
            label: "Suddivisione Dinamica",
            tooltip: "Usa la suddivisione adattiva dei tile basata sulla telecamera per la visualizzazione a scala globale",
        },
        showBuildings: {
            label: "Edifici 3D",
            tooltip: "Mostra tile di edifici 3D da Cesium Ion o Google",
        },
        buildingEdges: {
            label: "Bordi Edifici",
            tooltip: "Mostra bordi wireframe sui tile di edifici 3D",
        },
        oceanSurface: {
            label: "Superficie Oceanica (Beta)",
            tooltip: "Sperimentale: rendering della superficie d'acqua a livello del mare (MSL EGM96 fisso) mentre i tile fotorealistici di Google sono attivi",
        },
        buildingsSource: {
            label: "Fonte Edifici",
            tooltip: "Fonte dati per i tile di edifici 3D",
        },
        useEllipsoid: {
            label: "Usa Modello Terra Ellissoidale",
            tooltip: "Sfera: modello legacy veloce. Ellissoide: forma WGS84 accurata (le latitudini più alte ne beneficiano maggiormente).",
        },
        layer: {
            label: "Layer",
            tooltip: "Layer per le texture del terreno del tipo di mappa corrente",
        },
    },

    displayTrack: {
        visible: {
            tooltip: "Mostra o nascondi questa traccia",
        },
        extendToGround: {
            label: "Estendi a Terra",
            tooltip: "Disegna linee verticali dalla traccia al suolo",
        },
        displayStep: {
            label: "Passo di Visualizzazione",
            tooltip: "Passo tra i punti della traccia visualizzati (1 = ogni fotogramma)",
        },
        contrail: {
            label: "Scia di Condensazione",
            tooltip: "Mostra un nastro di scia di condensazione dietro questa traccia, regolato per il vento",
        },
        contrailSecs: {
            label: "Durata Scia (s)",
            tooltip: "Durata della scia di condensazione in secondi",
        },
        contrailWidth: {
            label: "Larghezza Scia (m)",
            tooltip: "Larghezza massima del nastro della scia di condensazione in metri",
        },
        contrailInitialWidth: {
            label: "Larghezza Iniziale Scia (m)",
            tooltip: "Larghezza della scia di condensazione al punto di scarico in metri",
        },
        contrailRamp: {
            label: "Rampa Scia (m)",
            tooltip: "Distanza su cui la larghezza della scia di condensazione aumenta in metri",
        },
        contrailSpread: {
            label: "Dispersione Scia (m/s)",
            tooltip: "Tasso di espansione della scia di condensazione in m/s",
        },
        lineColor: {
            label: "Colore Linea",
            tooltip: "Colore della linea della traccia",
        },
        polyColor: {
            label: "Colore Poligono",
            tooltip: "Colore dei poligoni di estensione verticale al suolo",
        },
        altLockAGL: {
            label: "Blocca Alt AGL",
        },
        gotoTrack: {
            label: "Vai alla traccia",
            tooltip: "Centra la telecamera principale sulla posizione di questa traccia",
        },
    },

    ptzUI: {
        panAz: {
            label: "Pan (Az)",
            tooltip: "Azimut / angolo di panoramica della telecamera in gradi",
        },
        tiltEl: {
            label: "Inclinazione (El)",
            tooltip: "Elevazione / angolo di inclinazione della telecamera in gradi",
        },
        zoomFov: {
            label: "Zoom (fov)",
            tooltip: "Campo visivo verticale della telecamera in gradi",
        },
        roll: {
            label: "Rollio",
            tooltip: "Angolo di rollio della telecamera in gradi",
        },
        xOffset: {
            label: "xOffset",
            tooltip: "Offset orizzontale della telecamera dal centro",
        },
        yOffset: {
            label: "yOffset",
            tooltip: "Offset verticale della telecamera dal centro",
        },
        nearPlane: {
            label: "Piano Vicino (m)",
            tooltip: "Distanza del piano di ritaglio vicino della telecamera in metri",
        },
        relative: {
            label: "Relativo",
            tooltip: "Usa angoli relativi invece di assoluti",
        },
        satellite: {
            label: "Satellite",
            tooltip: "Modalità satellite: panoramica nello spazio schermo dal nadir.\nRollio = direzione, Az = sinistra/destra, El = su/giù (-90 = nadir)",
        },
        rotation: {
            label: "Rotazione",
            tooltip: "Rotazione nello spazio schermo attorno all'asse di vista della telecamera",
        },
    },

    nodes3dObject: {
        modelOrGeometry: {
            label: "Modello o Geometria",
            tooltip: "Seleziona se usare un Modello 3D o una geometria generata per questo oggetto",
        },
        model: {
            label: "Modello",
            tooltip: "Seleziona un Modello 3D da usare per questo oggetto",
        },
        displayBoundingBox: {
            label: "Mostra Bounding Box",
            tooltip: "Mostra il bounding box dell'oggetto con le dimensioni",
        },
        forceAboveSurface: {
            label: "Forza Sopra la Superficie",
            tooltip: "Forza l'oggetto a stare completamente sopra la superficie del suolo",
        },
        exportToKML: {
            label: "Esporta in KML",
            tooltip: "Esporta questo oggetto 3D come file KML per Google Earth",
        },
        startAnalysis: {
            label: "Avvia Analisi",
            tooltip: "Lancia raggi dalla telecamera per trovare le direzioni di riflessione",
        },
        gridSize: {
            label: "Dimensione Griglia",
            tooltip: "Numero di punti campione per asse per la griglia di riflessione",
        },
        cleanUp: {
            label: "Pulisci",
            tooltip: "Rimuovi tutte le frecce dell'analisi di riflessione dalla scena",
        },
    },

    trackingOverlay: {
        showTracking: {
            label: "Mostra Tracciamento",
            tooltip: "Mostra o nascondi i punti di tracciamento e l'overlay della curva",
        },
        reset: {
            label: "Reimposta",
            tooltip: "Reimposta il tracciamento manuale a uno stato vuoto, rimuovendo tutti i keyframe e gli elementi trascinabili",
        },
        limitAB: {
            label: "Limita AB",
            tooltip: "Limita i fotogrammi A e B all'intervallo dei keyframe di tracciamento video. Questo impedirà l'estrapolazione oltre il primo e l'ultimo keyframe, che non è sempre desiderata.",
        },
        curveType: {
            label: "Tipo di Curva",
            tooltip: "Spline usa spline cubica naturale. Spline2 usa spline not-a-knot per un comportamento più morbido alle estremità. Lineare usa segmenti di retta. Prospettiva richiede esattamente 3 keyframe e modella il movimento lineare con proiezione prospettica.",
        },
        minimizeGroundSpeed: {
            label: "Minimizza Velocità a Terra",
            tooltip: "Trova la Distanza Iniziale del Bersaglio che minimizza la distanza a terra percorsa dal percorso di attraversamento",
        },
        minimizeAirSpeed: {
            label: "Minimizza Velocità dell'Aria",
            tooltip: "Trova la Distanza Iniziale del Bersaglio che minimizza la distanza aerea percorsa (tenendo conto del vento del bersaglio)",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "Quadrilatero a Terra del Frustum",
            tooltip: "Mostra l'intersezione del frustum della telecamera con il suolo",
        },
        videoInFrustum: {
            label: "Video nel Frustum",
            tooltip: "Proietta il video sul piano lontano del frustum della telecamera",
        },
        videoOnGround: {
            label: "Video a Terra",
            tooltip: "Proietta il video sul suolo",
        },
        groundVideoInLookView: {
            label: "Video a Terra nella Vista di Osservazione",
            tooltip: "Mostra il video proiettato a terra nella vista di osservazione",
        },
        matchVideoAspect: {
            label: "Abbina Proporzioni Video",
            tooltip: "Ritaglia la vista di osservazione per abbinarla alle proporzioni del video e regola il frustum di conseguenza",
        },
        videoOpacity: {
            label: "Opacità Video",
            tooltip: "Opacità dell'overlay video proiettato",
        },
    },

    labels3d: {
        measurements: {
            label: "Misurazioni",
            tooltip: "Mostra etichette e frecce di misurazione di distanza e angolo",
        },
        labelsInMain: {
            label: "Etichette nella Principale",
            tooltip: "Mostra etichette traccia/oggetto nella vista 3D principale",
        },
        labelsInLook: {
            label: "Etichette nella Osservazione",
            tooltip: "Mostra etichette traccia/oggetto nella vista di osservazione",
        },
        featuresInMain: {
            label: "Segnaposti/Pin nella Principale",
            tooltip: "Mostra segnaposti (pin) nella vista 3D principale",
        },
        featuresInLook: {
            label: "Segnaposti nella Osservazione",
            tooltip: "Mostra segnaposti nella vista di osservazione",
        },
    },

    losFitPhysics: {
        folder: "Risultati Adattamento Fisico",
        model: {
            label: "Modello",
        },
        avgError: {
            label: "Errore Medio (rad)",
        },
        windSpeed: {
            label: "Velocità del Vento (nodi)",
        },
        windFrom: {
            label: "Vento Da (\u00B0)",
        },
    },

    misbData: {
        startTime: {
            label: "Ora di Inizio",
            tooltip: "Sovrascrivi l'ora di inizio (es: '10:30', 'Gen 15', '2024-01-15T10:30:00Z'). Lascia vuoto per l'ora di inizio globale.",
        },
        enableFilter: {
            label: "Abilita Filtro",
        },
        tryAltitudeFirst: {
            label: "Prova Altitudine Prima",
        },
        maxG: {
            label: "G Massimo",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "Sopra il Livello del Suolo",
            tooltip: "L'altitudine è relativa al livello del suolo, non al livello del mare",
        },
        lookup: {
            label: "Cerca",
            tooltip: "Inserisci un nome di luogo, coordinate lat,lon o MGRS per spostarti",
        },
        geolocate: {
            label: "Geolocalizza dal browser",
            tooltip: "Usa l'API di geolocalizzazione del browser per impostare la posizione corrente",
        },
        goTo: {
            label: "Vai alla posizione soprastante",
            tooltip: "Sposta terreno e telecamera alla latitudine/longitudine/altitudine inserita",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "Ferma A",
            tooltip: "Ferma il movimento del bersaglio della telecamera a questo fotogramma, anche se la traccia del bersaglio continua. Utile per simulare la perdita di aggancio su un bersaglio in movimento. Imposta a 0 per disabilitare.",
        },
        horizonMethod: {
            label: "Metodo Orizzonte",
        },
        lookFOV: {
            label: "FOV Osservazione",
        },
        celestialObject: {
            label: "Oggetto Celeste",
            tooltip: "Nome del corpo celeste che la telecamera traccia (es: Luna, Venere, Giove)",
        },
    },

    spriteGroup: {
        visible: {
            label: "Visibile",
            tooltip: "Mostra o nascondi le sfere di flusso",
        },
        size: {
            label: "Dimensione (m)",
            tooltip: "Diametro in metri.",
        },
        viewSizeMultiplier: {
            label: "Moltiplicatore Dimensione Vista",
            tooltip: "Regola la dimensione delle sfere di flusso nella vista principale, ma non cambia la dimensione nelle altre viste.",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "Miglior Angolo, 180 completi, raffinato",
        },
        bestAngle5: {
            label: "Miglior angolo entro 5\u00B0 dal corrente",
        },
    },

    misc: {
        snapshotCamera: {
            label: "Cattura Telecamera",
            tooltip: "Salva la posizione e la direzione correnti della telecamera per l'uso con 'Reimposta Telecamera'",
        },
        resetCamera: {
            label: "Reimposta Telecamera",
            tooltip: "Reimposta la telecamera ai valori predefiniti o all'ultima posizione e direzione catturate\nAnche Tastierino Numerico-.",
        },
        showMoonShadow: {
            label: "Mostra Ombra della Luna",
            tooltip: "Attiva/disattiva la visualizzazione del cono d'ombra della Luna per la visualizzazione delle eclissi.",
        },
        shadowSegments: {
            label: "Segmenti dell'Ombra",
            tooltip: "Numero di segmenti nel cono d'ombra (più = più morbido ma più lento)",
        },
        showEarthShadow: {
            label: "Mostra Ombra della Terra",
            tooltip: "Attiva/disattiva la visualizzazione del cono d'ombra della Terra nel cielo notturno.",
        },
        earthShadowAltitude: {
            label: "Altitudine Ombra della Terra",
            tooltip: "Distanza dal centro della Terra al piano in cui renderizzare il cono d'ombra della Terra (in metri).",
        },
        exportTLE: {
            label: "Esporta TLE",
        },
        backgroundFlowIndicator: {
            label: "Indicatore Flusso di Sfondo",
            tooltip: "Mostra una freccia che indica quanto lo sfondo si sposterà nel prossimo fotogramma.\nUtile per sincronizzare la simulazione con il video (usa Visualizzazione/Overlay Video)",
        },
        defaultSnap: {
            label: "Aggancio Predefinito",
            tooltip: "Quando abilitato, i punti si agganceranno all'allineamento orizzontale per impostazione predefinita durante il trascinamento.\nTenere premuto Shift (durante il trascinamento) per fare il contrario",
        },
        recalcNodeGraph: {
            label: "Ricalcola Grafo Nodi",
        },
        downloadVideo: {
            label: "Scarica Video",
        },
        banking: {
            label: "Inclinazione",
            tooltip: "Come l'oggetto si inclina durante le virate",
        },
        angularTraverse: {
            label: "Attraversamento Angolare",
        },
        smoothingMethod: {
            label: "Metodo di Ammorbidimento",
            tooltip: "Algoritmo usato per ammorbidire i dati della traccia della telecamera",
        },
        showInLookView: {
            label: "Mostra nella vista di osservazione",
        },
        windFrom: {
            tooltip: "Direzione vera DA cui soffia il vento (0=Nord, 90=Est)",
        },
        windKnots: {
            tooltip: "Velocità del vento in nodi",
        },
        fetchWind: {
            tooltip: "Ottieni dati reali del vento dai servizi meteorologici per questa posizione e ora",
        },
        debugConsole: {
            label: "Console di Debug",
            tooltip: "Console di Debug",
        },
        aiAssistant: {
            label: "Assistente IA",
        },
        hide: {
            label: "Nascondi",
            tooltip: "Nascondi questa vista canvas a schede\nPer mostrarla di nuovo, usa il menu 'Mostra/Nascondi -> Viste'.",
        },
        notes: {
            label: "Note",
            tooltip: "Mostra/Nascondi l'editor delle note. Le note vengono salvate con il sitch e possono contenere hyperlink cliccabili.",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "Linee di Vista",
            tooltip: "Mostra le linee di vista dalla telecamera al bersaglio (attiva/disattiva: O)",
        },
        physicalPointer: {
            label: "Puntatore Fisico",
        },
        jet: {
            label: "[J]et",
        },
        horizonGrid: {
            label: "Griglia dell'[O]rizzonte",
        },
        wingPlaneGrid: {
            label: "Griglia del Piano [A]lare",
        },
        sphericalBoresightGrid: {
            label: "Griglia [S]ferica del Mirino",
        },
        azimuthElevationGrid: {
            label: "Griglia [A]zimut/Elevazione",
        },
        frustumOfCamera: {
            label: "F[R]ustum della telecamera",
        },
        trackLine: {
            label: "Linea di [T]raccia",
        },
        globe: {
            label: "[G]lobo",
        },
        showErrorCircle: {
            label: "Mostra Cerchio di Errore",
        },
        glareSprite: {
            label: "Spr[I]te Riflesso",
        },
        cameraViewFrustum: {
            label: "Frustum della Vista Telecamera",
            tooltip: "Mostra il frustum di visualizzazione della telecamera nella scena 3D",
        },
        zaineTriangulation: {
            label: "Triangolazione di Zaine",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "Intensità Ambientale",
            tooltip: "Intensità della luce ambientale. 0 è nessuna luce ambientale, 1 è luce ambientale normale, 2 è il doppio della luce ambientale",
        },
        irAmbientIntensity: {
            label: "Intensità Ambientale IR",
            tooltip: "Intensità della luce ambientale IR (usata per le viewport IR)",
        },
        sunIntensity: {
            label: "Intensità del Sole",
            tooltip: "Intensità della luce solare. 0 è nessuna luce solare, 1 è luce solare piena normale, 2 è il doppio della luce solare",
        },
        sunScattering: {
            label: "Diffusione Solare",
            tooltip: "Quantità di diffusione della luce solare",
        },
        sunBoost: {
            label: "Potenziamento Solare (HDR)",
            tooltip: "Moltiplicatore dell'intensità della luce direzionale del sole (HDR). Aumenta la luminosità dei riflessi speculari per riflessi solari realistici attraverso la nebbia.",
        },
        sceneExposure: {
            label: "Esposizione Scena (HDR)",
            tooltip: "Compensazione dell'esposizione per il tone mapping HDR. Ridurre per compensare un potenziamento solare maggiore.",
        },
        ambientOnly: {
            label: "Solo Ambientale",
            tooltip: "Se vero, viene usata solo la luce ambientale, nessuna luce solare",
        },
        daylightSky: {
            label: "Cielo diurno",
            tooltip: "Renderizza il cielo diurno (azzurro).\nDisattivare per rimuovere il contributo del cielo diurno — utile per vedere le stelle di giorno o per il debug degli oggetti del cielo notturno.",
        },
        noMainLighting: {
            label: "Nessuna Illuminazione nella Vista Principale",
            tooltip: "Se vero, nessuna illuminazione viene usata nella vista principale.\nUtile per il debug, ma non consigliato per l'uso normale",
        },
        noCityLights: {
            label: "Nessuna Luce Cittadina sul Globo",
            tooltip: "Se vero, non renderizzare le luci delle città sul globo.",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "Replay ADSB per questa ora e posizione",
            tooltip: "Genera un link per ADSB Exchange Replay",
        },
        googleMapsLink: {
            label: "Google Maps per questa posizione",
            tooltip: "Crea un link di Google Maps per la posizione corrente",
        },
        inTheSkyLink: {
            label: "In-The-Sky per questa ora e posizione",
            tooltip: "Crea un link di In The Sky per la posizione corrente",
        },
    },
    nodeLabels: {
        // Le chiavi devono corrispondere all'ID del nodo (chiave di proprietà nei dati del sitch),
        // NON al testo di descrizione. Quando nessun id esplicito è impostato, desc diventa l'id.
        focus: "Sfocatura",
        canvasResolution: "Risoluzione",
        "Noise Amount": "Quantità di Rumore",
        "TV In Black": "TV Nero in Ingresso",
        "TV In White": "TV Bianco in Ingresso",
        "TV Gamma": "TV Gamma",
        "Tv Out Black": "TV Nero in Uscita",
        "Tv Out White": "TV Bianco in Uscita",
        "JPEG Artifacts": "Artefatti JPEG",
        pixelZoom: "Zoom Pixel %",
        videoBrightness: "Luminosità",
        videoContrast: "Contrasto",
        videoBlur: "Quantità Sfocatura",
        videoSharpenAmount: "Quantità Nitidezza",
        videoGreyscale: "Scala di Grigi",
        videoHue: "Variazione di Tinta",
        videoInvert: "Inverti",
        videoSaturate: "Saturazione",
        startDistanceGUI: "Distanza Iniziale",
        targetVCGUI: "Velocità Verticale Bersaglio",
        targetSpeedGUI: "Velocità Bersaglio",
        lockWind: "Blocca Vento Bersaglio al Locale",
        jetTAS: "TAS",
        turnRate: "Tasso di Virata",
        totalTurn: "Virata Totale",
        jetHeadingManual: "Direzione del Jet",
        headingSmooth: "Ammorbidimento Direzione",
        turnRateControl: "Controllo Tasso di Virata",
        cameraSmoothWindow: "Finestra Ammorbidimento Telecamera",
        targetSmoothWindow: "Finestra Ammorbidimento Bersaglio",
        cameraFOV: "FOV Telecamera",
        "Tgt Start Dist": "Distanza Iniziale Bersaglio",
        "Target Speed": "Velocità Bersaglio",
        "Tgt Relative Heading": "Direzione Relativa Bersaglio",
        "KF Process": "Processo KF",
        "KF Noise": "Rumore KF",
        "MC Num Trials": "Numero Prove MC",
        "MC LOS Uncertainty (deg)": "Incertezza MC della LOS (gradi)",
        "MC Polynomial Order": "Ordine Polinomiale MC",
        "Physics Max Iterations": "Iterazioni Massime Fisica",
        "Physics Wind Speed (kt)": "Velocità Vento Fisica (nodi)",
        "Physics Wind From (°)": "Vento Fisico Da (°)",
        "Physics Initial Range (m)": "Raggio Iniziale Fisico (m)",
        "Tgt Start Altitude": "Altitudine Iniziale Bersaglio",
        "Tgt Vert Spd": "Vel. Verticale Bersaglio",
        "Cloud Altitude": "Altitudine Nuvola",
    },
};

export default it;
