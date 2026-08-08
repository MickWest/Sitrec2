const fr = {
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "Sélection des sitches et outils hérités\nCertains sitches hérités ont ici leurs contrôles par défaut",
            noTooltip: "Aucune info-bulle définie pour ce sitch",
            legacySitches: {
                label: "Sitches hérités",
                tooltip: "Les sitches hérités sont d'anciens sitches intégrés (codés en dur), c'est-à-dire des situations prédéfinies qui ont souvent un code et des ressources spécifiques. Sélectionnez-en un pour le charger.",
            },
            legacyTools: {
                label: "Outils hérités",
                tooltip: "Les outils sont des sitches spéciaux utilisés pour les configurations personnalisées comme Starlink ou les pistes utilisateur, ainsi que pour les tests, le débogage et d'autres usages spéciaux. Sélectionnez-en un pour le charger.",
            },
            selectPlaceholder: "-Sélectionner-",
        },
        file: {
            title: "Fichier",
            tooltip: "Opérations de fichier comme enregistrer, charger et exporter",
        },
        view: {
            title: "Vue",
            tooltip: "Commandes diverses d'affichage\nComme tous les menus, celui-ci peut être détaché de la barre pour devenir une fenêtre flottante",
        },
        video: {
            title: "Vidéo",
            tooltip: "Réglages, effets et analyse vidéo",
        },
        time: {
            title: "Temps",
            tooltip: "Commandes de temps et d'image\nFaire glisser un curseur de temps au-delà de la fin affectera le curseur au-dessus\nNotez que les curseurs de temps sont en UTC",
        },
        objects: {
            title: "Objets",
            tooltip: "Objets 3D et leurs propriétés\nChaque dossier correspond à un objet. L'objet de traversée est l'objet qui parcourt les lignes de visée, c'est-à-dire l'UAP qui nous intéresse",
            addObject: {
                label: "Ajouter un objet",
                tooltip: "Créer un nouvel objet à des coordonnées spécifiées",
                prompt: "Saisir : [Nom] Lat Lon [Alt]\nExemples :\n  MonObjet 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Repère 37.7749 -122.4194",
                invalidInput: "Saisie invalide. Veuillez entrer des coordonnées au format :\n[Nom] Lat Lon [Alt]",
            },
        },
        satellites: {
            title: "Satellites",
            tooltip: "Chargement et contrôle des satellites\nLes satellites.\nStarlink, ISS, etc. Réglages pour les flares d'horizon et autres effets satellites",
        },
        terrain: {
            title: "Terrain",
            tooltip: "Commandes du terrain\nLe terrain est le modèle 3D du sol. La carte est l'image 2D du sol. L'élévation est la hauteur du sol au-dessus du niveau de la mer",
        },
        physics: {
            title: "Physique",
            tooltip: "Commandes physiques\nLa physique de la situation, comme la vitesse du vent et la physique de l'objet de traversée",
        },
        camera: {
            title: "Caméra",
            tooltip: "Commandes de la caméra de la vue look\nLa vue look est par défaut la fenêtre en bas à droite, et doit correspondre à la vidéo.",
        },
        target: {
            title: "Cible",
            tooltip: "Commandes de la cible\nPosition et propriétés de l'objet cible optionnel",
        },
        traverse: {
            title: "Traversée",
            tooltip: "Commandes de traversée\nL'objet de traversée est celui qui parcourt les lignes de visée, c'est-à-dire l'UAP qui nous intéresse\nCe menu définit comment l'objet de traversée se déplace et se comporte",
        },
        showHide: {
            title: "Afficher/Masquer",
            tooltip: "Affichage ou masquage des vues, objets et autres éléments",
            views: {
                title: "Vues",
                tooltip: "Afficher ou masquer les vues (fenêtres) comme la vue look, la vidéo, la vue principale, ainsi que les surcouches comme le MQ9UI",
            },
            graphs: {
                title: "Graphiques",
                tooltip: "Afficher ou masquer divers graphiques",
            },
        },
        effects: {
            title: "Effets",
            tooltip: "Effets spéciaux comme le flou, la pixelisation et les ajustements de couleur appliqués à l'image finale dans la vue look",
        },
        lighting: {
            title: "Éclairage",
            tooltip: "L'éclairage de la scène, comme le soleil et la lumière ambiante",
        },
        contents: {
            title: "Contenu",
            tooltip: "Le contenu de la scène, surtout utilisé pour les pistes",
        },
        help: {
            title: "Aide",
            tooltip: "Liens vers la documentation et d'autres ressources d'aide",
            whatsNew: "Nouveautés",
            documentation: {
                title: "Documentation",
                localTooltip: "Liens vers la documentation (locale)",
                githubTooltip: "Liens vers la documentation sur GitHub",
                githubLinkLabel: "{{name}} (GitHub)",
                about: "À propos de Sitrec",
                whatsNew: "Nouveautés",
                whatsNewDetails: "Nouveautés (Détails)",
                uiBasics: "Bases de l'interface utilisateur",
                savingLoading: "Enregistrer et charger des sitches",
                customSitch: "Comment configurer un sitch",
                tracks: "Pistes et sources de données",
                gis: "SIG et cartographie",
                starlink: "Comment analyser les flares Starlink",
                customModels: "Objets et modèles 3D (avions)",
                cameraModes: "Modes de caméra (normal et satellite)",
                thirdPartyNotices: "Mentions tierces",
                thirdPartyNoticesTooltip: "Attributions de licences open source pour les logiciels tiers inclus",
                downloadBridge: "Télécharger MCP Bridge",
                downloadBridgeTooltip: "Télécharger le serveur MCP SitrecBridge + l'extension Chrome (zéro dépendance, Node.js seulement)",
            },
            externalLinks: {
                title: "Liens externes",
                tooltip: "Liens d'aide externes",
            },
            exportDebugLog: {
                label: "Exporter le journal de débogage",
                tooltip: "Télécharger toute la sortie console (log, warn, error) sous forme de fichier texte pour le débogage",
            },
        },
        debug: {
            title: "Débogage",
            tooltip: "Outils de débogage et de surveillance\nUtilisation mémoire GPU, mesures de performance et autres informations de débogage",
        },
    },
    file: {
        newSitch: {
            label: "Nouveau sitch",
            tooltip: "Créer un nouveau sitch (rechargera cette page en réinitialisant tout)",
        },
        savingDisabled: "Sauvegarde désactivée (cliquez pour vous connecter)",
        importFile: {
            label: "Importer un fichier",
            tooltip: "Importer un ou plusieurs fichiers depuis votre système. Identique au glisser-déposer dans la fenêtre du navigateur",
        },
        server: {
            open: "Ouvrir",
            save: {
                label: "Enregistrer",
                tooltip: "Enregistrer le sitch actuel sur le serveur",
            },
            saveAs: {
                label: "Enregistrer sous",
                tooltip: "Enregistrer le sitch actuel sur le serveur sous un nouveau nom",
            },
            versions: {
                label: "Versions",
                tooltip: "Charger une version spécifique du sitch sélectionné",
            },
            browseFeatured: "Parcourir les sitches en vedette",
            browseAll: "Parcourir tous vos sitches enregistrés dans une liste consultable et triable",
        },
        local: {
            title: "Local",
            titleWithFolder: "Local : {{name}}",
            titleReconnect: "Local : {{name}} (reconnecter)",
            status: "État",
            noFileSelected: "Aucun fichier local sélectionné",
            noFolderSelected: "Aucun dossier sélectionné",
            currentFile: "Fichier actuel : {{name}}",
            statusDesktop: "État actuel du fichier/sauvegarde local",
            statusFolder: "État actuel du dossier/sauvegarde local",
            stateReady: "Prêt",
            stateReconnect: "Reconnexion nécessaire",
            stateNoFolder: "Aucun dossier",
            statusLine: "{{state}} | Dossier : {{folder}} | Cible : {{target}}",
            saveLocal: {
                label: "Enregistrer localement",
                tooltipDesktop: "Enregistrer dans le fichier local actuel, ou demander un nom de fichier si nécessaire",
                tooltipFolder: "Enregistrer dans le dossier de travail (ou demander un emplacement si aucun n'est défini)",
                tooltipSaveBack: "Enregistrer dans {{name}}",
                tooltipSaveBackInFolder: "Enregistrer dans {{name}} dans {{folder}}",
                tooltipSaveInto: "Enregistrer dans {{folder}} (demande le nom du sitch)",
                tooltipPrompt: "Enregistrer un fichier sitch local (demande le nom/emplacement)",
                tooltipSaveTo: "Enregistrer le sitch actuel dans un fichier local",
            },
            saveLocalAs: {
                label: "Enregistrer localement sous...",
                tooltipDesktop: "Enregistrer un fichier sitch local vers un nouveau chemin",
                tooltipFolder: "Enregistrer un fichier sitch local en choisissant l'emplacement",
                tooltipInFolder: "Enregistrer avec un nouveau nom dans le dossier de travail actuel",
                tooltipNewPath: "Enregistrer le sitch actuel dans un nouveau chemin local",
            },
            openLocal: {
                label: "Ouvrir un sitch local",
                labelShort: "Ouvrir local...",
                tooltipDesktop: "Ouvrir un fichier sitch local depuis le disque",
                tooltipFolder: "Ouvrir un fichier sitch depuis le dossier de travail actuel",
                tooltipCurrent: "Ouvrir un autre fichier sitch local (actuel : {{name}})",
                tooltipFromFolder: "Ouvrir un fichier sitch depuis {{folder}}",
            },
            selectFolder: {
                label: "Sélectionner le dossier de sitches locaux",
                tooltip: "Sélectionner un dossier de travail pour les opérations de sauvegarde/chargement locales",
            },
            reconnectFolder: {
                label: "Reconnecter le dossier",
                tooltip: "Redonner l'accès au dossier de travail précédemment utilisé",
            },
        },
        debug: {
            recalculateAll: "debug recalculer tout",
            dumpNodes: "debug lister les nœuds",
            dumpNodesBackwards: "debug lister les nœuds à l'envers",
            dumpRoots: "debug lister les nœuds racines",
        },
    },
    videoExport: {
        notAvailable: "Export vidéo non disponible",
        folder: {
            title: "Rendu et export vidéo",
            tooltip: "Options de rendu et d'exportation de fichiers vidéo depuis les vues Sitrec ou la fenêtre complète",
        },
        renderView: {
            label: "Vue de rendu vidéo",
            tooltip: "Sélectionner la vue à exporter en vidéo",
        },
        renderSingleVideo: {
            label: "Rendu vidéo vue unique",
            tooltip: "Exporter la vue sélectionnée en fichier vidéo avec tous les photogrammes",
        },
        videoFormat: {
            label: "Format vidéo",
            tooltip: "Sélectionner le format de sortie vidéo",
        },
        renderViewport: {
            label: "Rendu vidéo fenêtre",
            tooltip: "Exporter la fenêtre entière en fichier vidéo avec tous les photogrammes",
        },
        renderFullscreen: {
            label: "Rendu vidéo plein écran",
            tooltip: "Exporter la fenêtre entière en mode plein écran en fichier vidéo",
        },
        recordWindow: {
            label: "Enregistrer la fenêtre du navigateur",
            tooltip: "Enregistrer toute la fenêtre du navigateur (menus et interface inclus) en vidéo à cadence fixe",
        },
        retinaExport: {
            label: "Export HD/Retina",
            tooltip: "Exporter en résolution Retina/HiDPI (2x sur la plupart des écrans)",
        },
        includeAudio: {
            label: "Inclure l'audio",
            tooltip: "Inclure la piste audio de la vidéo source si disponible",
        },
        waitForLoading: {
            label: "Attendre le chargement en arrière-plan",
            tooltip: "Quand activé, le rendu attend les chargements de terrain/bâtiments/arrière-plan avant chaque image",
        },
        exportFrame: {
            label: "Exporter l'image vidéo",
            tooltip: "Exporter l'image vidéo actuelle telle qu'affichée (avec effets) en fichier PNG",
        },
    },
    tracking: {
        enable: {
            label: "Activer le suivi automatique",
            disableLabel: "Désactiver le suivi automatique",
            tooltip: "Afficher/masquer le curseur de suivi automatique sur la vidéo",
        },
        start: {
            label: "Démarrer le suivi automatique",
            stopLabel: "Arrêter le suivi automatique",
            tooltip: "Suivre automatiquement l'objet dans le curseur pendant la lecture",
        },
        clearFromHere: {
            label: "Effacer à partir d'ici",
            tooltip: "Effacer toutes les positions suivies de l'image courante à la fin",
        },
        clearTrack: {
            label: "Effacer la piste",
            tooltip: "Effacer toutes les positions suivies et recommencer",
        },
        stabilize: {
            label: "Stabiliser",
            tooltip: "Appliquer les positions suivies pour stabiliser la vidéo",
        },
        stabilizeToggle: {
            enableLabel: "Activer la stabilisation",
            disableLabel: "Désactiver la stabilisation",
            tooltip: "Activer/désactiver la stabilisation vidéo",
        },
        stabilizeCenters: {
            label: "Centrer la stabilisation",
            tooltip: "Quand coché, le point stabilisé est fixé au centre. Sinon, il reste à sa position initiale.",
        },
        renderStabilized: {
            label: "Rendu vidéo stabilisée",
            tooltip: "Exporter la vidéo stabilisée à la taille originale (le point suivi reste fixe, bords noirs possibles)",
        },
        renderStabilizedExpanded: {
            label: "Rendu stabilisé étendu",
            tooltip: "Exporter la vidéo stabilisée avec un canvas élargi pour ne perdre aucun pixel",
        },
        trackRadius: {
            label: "Rayon de suivi",
            tooltip: "Taille du modèle à rechercher (taille de l'objet)",
        },
        searchRadius: {
            label: "Rayon de recherche",
            tooltip: "Distance de recherche depuis la position précédente (augmenter pour les mouvements rapides)",
        },
        trackingMethod: {
            label: "Méthode de suivi",
            tooltip: "Correspondance de modèle (OpenCV) ou flux optique (jsfeat Lucas-Kanade)",
        },
        centerOnBright: {
            label: "Centrer sur les pixels clairs",
            tooltip: "Suivre le centre de masse des pixels clairs (mieux pour les étoiles/lumières ponctuelles)",
        },
        centerOnDark: {
            label: "Centrer sur les pixels sombres",
            tooltip: "Suivre le centre de masse des pixels sombres",
        },
        brightnessThreshold: {
            label: "Seuil de luminosité",
            tooltip: "Seuil de luminosité (0-255). Utilisé dans les modes centrer sur clair/sombre",
        },
        status: {
            loadingJsfeat: "Chargement de jsfeat...",
            loadingOpenCv: "Chargement d'OpenCV...",
            sam2Connecting: "SAM2 : Connexion...",
            sam2Uploading: "SAM2 : Envoi...",
        },
    },
    trackManager: {
        removeTrack: "Supprimer la piste",
        createSpline: "Créer une spline",
        editTrack: "Modifier la piste",
        constantSpeed: "Vitesse constante",
        extrapolateTrack: "Extrapoler la piste",
        curveType: "Type de courbe",
        altLockAGL: "Verrouillage alt. AGL",
        deleteTrack: "Supprimer la piste",
    },
    gpuMonitor: {
        enabled: "Moniteur activé",
        total: "Mémoire totale",
        geometries: "Géométries",
        textures: "Textures",
        peak: "Mémoire maximale",
        average: "Mémoire moyenne",
        reset: "Réinitialiser l'historique",
    },
    situationSetup: {
        mainFov: {
            label: "FOV principal",
            tooltip: "Champ de vision de la caméra de la vue principale (VERTICAL)",
        },
        lookCameraFov: "FOV caméra look",
        azimuth: "azimut",
        jetPitch: "Tangage de l'avion",
    },
    featureManager: {
        labelText: "Texte du label",
        latitude: "Latitude",
        longitude: "Longitude",
        altitude: "Altitude (m)",
        arrowLength: "Longueur de la flèche",
        arrowColor: "Couleur de la flèche",
        textColor: "Couleur du texte",
        deleteFeature: "Supprimer le repère",
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "Exporter le panorama look",
            tooltip: "Créer une image panoramique à partir de la vue look sur toutes les images selon la position d'arrière-plan",
        },
    },
    dateTime: {
        liveMode: {
            label: "Mode en direct",
            tooltip: "Si le mode en direct est activé, la lecture sera toujours synchronisée avec l'heure actuelle.\nMettre en pause ou naviguer désactivera le mode en direct",
        },
        startTime: {
            tooltip: "L'heure de DÉBUT de la première image de la vidéo, au format UTC",
        },
        currentTime: {
            tooltip: "L'heure ACTUELLE de la vidéo. C'est à quoi se réfèrent la date et l'heure ci-dessous",
        },
        year: { label: "Année", tooltip: "Année de l'image courante" },
        month: { label: "Mois", tooltip: "Mois (1-12)" },
        day: { label: "Jour", tooltip: "Jour du mois" },
        hour: { label: "Heure", tooltip: "Heure (0-23)" },
        minute: { label: "Minute", tooltip: "Minute (0-59)" },
        second: { label: "Seconde", tooltip: "Seconde (0-59)" },
        millisecond: { label: "ms", tooltip: "Milliseconde (0-999)" },
        useTimeZone: {
            label: "Utiliser le fuseau horaire dans l'interface",
            tooltip: "Utiliser le fuseau horaire dans l'interface ci-dessus\nCela changera la date et l'heure pour le fuseau horaire sélectionné, plutôt qu'UTC.\nUtile pour afficher la date et l'heure dans un fuseau horaire spécifique.",
        },
        timeZone: {
            label: "Fuseau horaire",
            tooltip: "Le fuseau horaire pour afficher la date et l'heure dans la vue look\nAussi dans l'interface si 'Utiliser le fuseau horaire' est coché",
        },
        simSpeed: {
            label: "Vitesse de simulation",
            tooltip: "La vitesse de la simulation, 1 est en temps réel, 2 est deux fois plus rapide, etc.\nCela ne change pas la vitesse de lecture vidéo, seulement les calculs de temps pour la simulation.",
        },
        sitchFrames: {
            label: "Images du sitch",
            tooltip: "Le nombre d'images dans le sitch. S'il y a une vidéo, ce sera le nombre d'images de la vidéo, mais vous pouvez le modifier si vous souhaitez ajouter plus d'images ou utiliser le sitch sans vidéo",
        },
        sitchDuration: {
            label: "Durée du sitch",
            tooltip: "Durée du sitch au format HH:MM:SS.sss",
        },
        aFrame: {
            label: "Image A",
            tooltip: "Limiter la lecture entre A et B, affichés en vert et rouge sur le curseur d'images",
        },
        bFrame: {
            label: "Image B",
            tooltip: "Limiter la lecture entre A et B, affichés en vert et rouge sur le curseur d'images",
        },
        videoFps: {
            label: "IPS vidéo",
            tooltip: "Les images par seconde de la vidéo. Cela changera la vitesse de lecture (ex: 30 ips, 25 ips, etc). Cela changera aussi la durée du sitch car cela modifie la durée d'une image individuelle\nDérivé de la vidéo quand possible, mais modifiable",
        },
        syncTimeTo: {
            label: "Synchroniser le temps avec",
            tooltip: "Synchroniser l'heure de début de la vidéo avec l'heure de début originale, l'heure actuelle, ou l'heure de début d'une piste (si chargée)",
        },
    },
    jet: {
        frames: {
            time: {
                label: "Temps (sec)",
                tooltip: "Temps courant depuis le début de la vidéo en secondes (image / fps)",
            },
            frame: {
                label: "Image dans la vidéo",
                tooltip: "Numéro de l'image courante dans la vidéo",
            },
            paused: {
                label: "Pause",
                tooltip: "Basculer l'état de pause (également barre d'espace)",
            },
        },
        controls: {
            pingPong: "Ping-pong A-B",
            podPitchPhysical: "Tangage du pod (bille)",
            podRollPhysical: "Roulis de la tête du pod",
            deroFromGlare: "Dérotation = angle d'éclat",
            jetPitch: "Tangage de l'avion",
            lookFov: "Champ de vision étroit",
            elevation: "élévation",
            glareStartAngle: "Angle initial d'éclat",
            initialGlareRotation: "Rotation initiale d'éclat",
            scaleJetPitch: "Mettre à l'échelle le tangage avec le roulis",
            horizonMethod: "Méthode d'horizon",
            horizonMethodOptions: {
                humanHorizon: "Horizon humain",
                horizonAngle: "Angle d'horizon",
            },
            videoSpeed: "Vitesse vidéo",
            podWireframe: "Pod en fil de fer [B]ack",
            showVideo: "[V]idéo",
            showGraph: "[G]raphique",
            showKeyboardShortcuts: "Raccourcis [K]clavier",
            showPodHead: "Roulis de tête du [P]od",
            showPodsEye: "Vues de l'[E]il du pod avec dérotation",
            showLookCam: "Vue [N]AR avec dérotation",
            showCueData: "Données de [C]ible",
            showGlareGraph: "Afficher le graphique d'éclat [o]",
            showAzGraph: "Afficher le graphique A[Z]",
            declutter: "[D]ésencombrer",
            jetOffset: "Décalage Y de l'avion",
            tas: "TAS vitesse air vraie",
            integrate: "Étapes d'intégration",
        },
    },
    motionAnalysis: {
        menu: {
            title: "Analyse du mouvement",
            analyzeMotion: {
                label: "Analyser le mouvement",
                tooltip: "Activer l'analyse du mouvement en temps réel sur la vidéo",
            },
            createTrack: {
                label: "Créer une piste à partir du mouvement",
                tooltip: "Analyser toutes les images et créer une piste au sol à partir des vecteurs de mouvement",
            },
            alignWithFlow: {
                label: "Aligner avec le flux",
                tooltip: "Faire pivoter l'image pour que la direction du mouvement soit horizontale",
            },
            panorama: {
                title: "Panorama",
                exportImage: {
                    label: "Exporter le panorama de mouvement",
                    tooltip: "Créer une image panoramique à partir des images vidéo avec les décalages issus du suivi de mouvement",
                },
                exportVideo: {
                    label: "Exporter la vidéo pano",
                    tooltip: "Créer une vidéo 4K montrant le panorama avec la superposition de l'image vidéo",
                },
                stabilize: {
                    label: "Stabiliser la vidéo",
                    disableLabel: "Désactiver la stabilisation",
                    tooltip: "Stabiliser la vidéo avec l'analyse globale du mouvement (supprime les tremblements de caméra)",
                },
                panoFrameStep: {
                    label: "Pas d'image du pano",
                    tooltip: "Nombre d'images sautées entre chaque image du panorama (1 = chaque image)",
                },
                crop: {
                    label: "Rognage du panorama",
                    tooltip: "Pixels à rogner sur chaque bord des images vidéo",
                },
                useMask: {
                    label: "Utiliser le masque dans le pano",
                    tooltip: "Appliquer le masque de suivi de mouvement comme transparence lors du rendu du panorama",
                },
                analyzeWithEffects: {
                    label: "Analyser avec effets",
                    tooltip: "Appliquer les réglages vidéo (contraste, etc.) aux images utilisées pour l'analyse du mouvement",
                },
                exportWithEffects: {
                    label: "Exporter avec effets",
                    tooltip: "Appliquer les réglages vidéo aux exportations du panorama",
                },
                removeOuterBlack: {
                    label: "Supprimer le noir extérieur",
                    tooltip: "Rendre transparents les pixels noirs sur les bords de chaque ligne",
                },
            },
            trackingParameters: {
                title: "Paramètres de suivi",
                technique: {
                    label: "Technique",
                    tooltip: "Algorithme d'estimation du mouvement",
                },
                frameSkip: {
                    label: "Saut d'images",
                    tooltip: "Nombre d'images entre les comparaisons (plus élevé = détection de mouvements plus lents)",
                },
                trackletLength: {
                    label: "Longueur du tracklet",
                    tooltip: "Nombre d'images dans le tracklet (plus long = cohérence plus stricte)",
                },
                blurSize: {
                    label: "Taille du flou",
                    tooltip: "Flou gaussien pour les macro-caractéristiques (nombres impairs)",
                },
                minMotion: {
                    label: "Mouvement min",
                    tooltip: "Amplitude minimale du mouvement (pixels/image)",
                },
                maxMotion: {
                    label: "Mouvement max",
                    tooltip: "Amplitude maximale du mouvement",
                },
                smoothing: {
                    label: "Lissage",
                    tooltip: "Lissage de direction (plus élevé = plus de lissage)",
                },
                minVectorCount: {
                    label: "Nombre minimal de vecteurs",
                    tooltip: "Nombre minimal de vecteurs de mouvement pour une image valide",
                },
                minConfidence: {
                    label: "Confiance minimale",
                    tooltip: "Confiance minimale du consensus pour une image valide",
                },
                maxFeatures: {
                    label: "Caractéristiques max",
                    tooltip: "Nombre maximal de caractéristiques suivies",
                },
                minDistance: {
                    label: "Distance minimale",
                    tooltip: "Distance minimale entre les caractéristiques",
                },
                qualityLevel: {
                    label: "Niveau de qualité",
                    tooltip: "Seuil de qualité de détection des caractéristiques",
                },
                maxTrackError: {
                    label: "Erreur de suivi max",
                    tooltip: "Seuil maximal d'erreur de suivi",
                },
                minQuality: {
                    label: "Qualité minimale",
                    tooltip: "Qualité minimale pour afficher la flèche",
                },
                staticThreshold: {
                    label: "Seuil statique",
                    tooltip: "Un mouvement inférieur à ce seuil est considéré comme statique (HUD)",
                },
            },
        },
        status: {
            loadingOpenCv: "Chargement d'OpenCV...",
            stopAnalysis: "Arrêter l'analyse",
            analyzingPercent: "Analyse... {{pct}}%",
            creatingTrack: "Création de la piste...",
            buildingPanorama: "Construction du panorama...",
            buildingPanoramaPercent: "Construction du panorama... {{pct}}%",
            loadingFrame: "Chargement de l'image {{frame}}... ({{current}}/{{total}})",
            loadingFrameSkipped: "Chargement de l'image {{frame}}... ({{current}}/{{total}}) ({{skipped}} ignorées)",
            renderingPercent: "Rendu... {{pct}}%",
            panoPercent: "Pano... {{pct}}%",
            renderingVideo: "Rendu vidéo...",
            videoPercent: "Vidéo... {{pct}}%",
            saving: "Enregistrement...",
            buildingStabilization: "Construction de la stabilisation...",
            exportProgressTitle: "Exportation de la vidéo pano...",
        },
        errors: {
            noVideoView: "Aucune vue vidéo trouvée.",
            noVideoData: "Aucune donnée vidéo trouvée.",
            failedToLoadOpenCv: "Impossible de charger OpenCV : {{message}}",
            noOriginTrack: "Aucune piste d'origine trouvée. Une piste cible ou caméra est nécessaire pour déterminer la position initiale.",
            videoEncodingUnsupported: "L'encodage vidéo n'est pas pris en charge dans ce navigateur",
            exportFailed: "Échec de l'export vidéo : {{reason}}",
            panoVideoExportFailed: "Échec de l'export de la vidéo pano : {{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[BETA] Extraction de texte",
            enable: {
                label: "Activer l'extraction de texte",
                disableLabel: "Désactiver l'extraction de texte",
                tooltip: "Activer le mode d'extraction de texte sur la vidéo",
            },
            addRegion: {
                label: "Ajouter une région",
                drawingLabel: "Cliquer et faire glisser sur la vidéo...",
                tooltip: "Cliquer et faire glisser sur la vidéo pour définir une région d'extraction de texte",
            },
            removeRegion: {
                label: "Supprimer la région sélectionnée",
                tooltip: "Supprimer la région actuellement sélectionnée",
            },
            clearRegions: {
                label: "Effacer toutes les régions",
                tooltip: "Supprimer toutes les régions d'extraction de texte",
            },
            startExtract: {
                label: "Démarrer l'extraction",
                stopLabel: "Arrêter l'extraction",
                tooltip: "Lancer l'OCR sur toutes les régions de l'image courante jusqu'à la fin",
            },
            fixedWidthFont: {
                label: "Police à largeur fixe",
                tooltip: "Activer la détection caractère par caractère pour les polices à largeur fixe (mieux pour les surimpressions FLIR/capteurs)",
            },
            numChars: {
                label: "Nombre de caractères",
                tooltip: "Nombre de caractères dans la région sélectionnée (divise la région uniformément)",
            },
            learnTemplates: {
                label: "Apprendre les modèles",
                activeLabel: "Cliquer sur les caractères à apprendre...",
                tooltip: "Cliquer sur les cellules de caractères pour apprendre leurs valeurs (pour l'appariement de modèles)",
            },
            clearTemplates: {
                label: "Effacer les modèles",
                tooltip: "Supprimer tous les modèles de caractères appris",
            },
            useTemplates: {
                label: "Utiliser les modèles",
                tooltip: "Utiliser les modèles appris pour l'appariement (plus rapide et plus précis une fois entraîné)",
            },
        },
        prompts: {
            learnCharacter: "Entrer le caractère pour la cellule {{index}} :",
        },
        errors: {
            failedToLoadTesseract: "Impossible de charger Tesseract.js. Vérifiez qu'il est installé : npm install tesseract.js",
            noVideoView: "L'extraction de texte nécessite une vue vidéo",
        },
    },
    custom: {
        settings: {
            title: "Paramètres",
            tooltipLoggedIn: "Paramètres par utilisateur enregistrés sur le serveur (avec sauvegarde par cookie)",
            tooltipAnonymous: "Paramètres par utilisateur enregistrés dans les cookies du navigateur",
            language: { label: "Langue", tooltip: "Sélectionner la langue de l'interface. Changer recharge la page. Vous perdrez tout travail non enregistré, sauvegardez d'abord !" },
            maxDetails: { label: "Détails max", tooltip: "Niveau de détail maximum pour la subdivision du terrain (5-30)" },
            fpsLimit: { label: "Limite d'images/s", tooltip: "Définir le taux d'images maximum (60, 30, 20 ou 15 ips)" },
            tileSegments: { label: "Segments de tuile", tooltip: "Résolution du maillage pour les tuiles de terrain. Plus élevé = plus de détails mais plus lent" },
            maxResolution: { label: "Résolution max", tooltip: "Résolution maximale de l'image vidéo (côté le plus long). Réduit l'utilisation mémoire GPU. S'applique aux nouvelles images chargées." },
            aiModel: { label: "Modèle IA", tooltip: "Sélectionner le modèle d'IA pour l'assistant de chat" },
            centerSidebar: { label: "Barre latérale centrale", tooltip: "Activer la barre latérale centrale entre les vues séparées (glisser les menus vers la ligne de séparation)" },
            showAttribution: { label: "Afficher l'attribution", tooltip: "Afficher la superposition d'attribution des sources de carte et d'élévation" },
        },
        balloons: {
            count: { label: "Nombre", tooltip: "Nombre de stations proches à importer" },
            source: { label: "Source", tooltip: "uwyo = University of Wyoming (nécessite un proxy PHP)\nigra2 = Archive NOAA NCEI (téléchargement direct)" },
            getNearby: { label: "Obtenir les ballons-sondes proches", tooltip: "Importer les N sondages de ballons météorologiques les plus proches de la position actuelle de la caméra.\nUtilise le lancement le plus récent avant l'heure de début du sitch + 1 heure." },
            importSounding: { label: "Importer un sondage...", tooltip: "Sélecteur manuel de station : choisissez la station, la date, la source et importez un sondage spécifique." },
        },
        showHide: {
            keyboardShortcuts: { label: "Raccourcis [K]clavier", tooltip: "Afficher ou masquer la superposition des raccourcis clavier" },
            toggleExtendToGround: { label: "Basculer TOUS [E]tendre au sol", tooltip: "Basculer 'Étendre au sol' pour toutes les pistes\nDésactivera toutes si certaines sont activées\nActivera toutes si aucune n'est activée" },
            showAllTracksInLook: { label: "Afficher toutes les pistes dans la vue look", tooltip: "Afficher toutes les pistes d'aéronefs dans la vue look/caméra" },
            showCompassElevation: { label: "Afficher l'élévation de la boussole", tooltip: "Afficher l'élévation de la boussole (angle au-dessus du plan du sol local) en plus du cap (azimut)" },
            filterTracks: { label: "Filtrer les pistes", tooltip: "Afficher/masquer les pistes selon l'altitude, la direction ou l'intersection avec le frustum" },
            removeAllTracks: { label: "Supprimer toutes les pistes", tooltip: "Supprimer toutes les pistes de la scène\nCela ne supprimera pas les objets, seulement les pistes\nVous pourrez les réajouter en glissant-déposant les fichiers" },
        },
        objects: {
            globalScale: { label: "Échelle globale", tooltip: "Facteur d'échelle appliqué à tous les objets 3D de la scène - utile pour retrouver des éléments. Remettre à 1 pour la taille réelle" },
        },
        admin: {
            dashboard: { label: "Tableau de bord admin", tooltip: "Ouvrir le tableau de bord d'administration" },
            validateAllSitches: { label: "Valider tous les sitches", tooltip: "Charger tous les sitches enregistrés avec le terrain local pour vérifier les erreurs" },
            testUserID: { label: "ID utilisateur de test", tooltip: "Opérer en tant que cet ID utilisateur (0 = désactivé, doit être > 1)" },
            addMissingScreenshots: { label: "Ajouter les captures manquantes", tooltip: "Charger chaque sitch sans capture d'écran, le rendre et téléverser une capture" },
            feature: { label: "Mettre en avant", tooltip: "Basculer le statut de mise en avant pour le sitch actuellement chargé" },
        },
        viewPreset: { label: "Préréglage de vue", tooltip: "Basculer entre différents préréglages de vue\nCôte à côte, haut et bas, etc." },
        subSitches: {
            folder: { tooltip: "Gérer plusieurs configurations de caméra/vue au sein de ce sitch" },
            updateCurrent: { label: "Mettre à jour le sub actuel", tooltip: "Mettre à jour le sub sitch sélectionné avec les paramètres de vue actuels" },
            updateAndAddNew: { label: "Mettre à jour l'actuel et ajouter un nouveau sub", tooltip: "Mettre à jour le sub sitch actuel, puis le dupliquer dans un nouveau sub sitch" },
            discardAndAddNew: { label: "Abandonner les modifications et ajouter un nouveau", tooltip: "Abandonner les modifications du sub sitch actuel et créer un nouveau sub sitch depuis l'état actuel" },
            renameCurrent: { label: "Renommer le sub actuel", tooltip: "Renommer le sub sitch actuellement sélectionné" },
            deleteCurrent: { label: "Supprimer le sub actuel", tooltip: "Supprimer le sub sitch actuellement sélectionné" },
            syncSaveDetails: { label: "Synchroniser les détails de sauvegarde", tooltip: "Supprimer du sub actuel les nœuds non activés dans les détails de sauvegarde" },
        },
        contextMenu: {
            setCameraAbove: "Placer la caméra au-dessus",
            setCameraOnGround: "Placer la caméra au sol",
            setTargetAbove: "Placer la cible au-dessus",
            setTargetOnGround: "Placer la cible au sol",
            dropPin: "Placer un repère / Ajouter un élément",
            createTrackWithObject: "Créer une piste avec objet",
            createTrackNoObject: "Créer une piste (sans objet)",
            addBuilding: "Ajouter un bâtiment",
            addClouds: "Ajouter des nuages",
            addGroundOverlay: "Ajouter une superposition au sol",
            centerTerrain: "Centrer le carré de terrain ici",
            googleMapsHere: "Google Maps ici",
            googleEarthHere: "Google Earth ici",
            removeClosestPoint: "Supprimer le point le plus proche",
            exitEditMode: "Quitter le mode édition",
        },
    },
    view3d: {
        northUp: { label: "Vue look nord en haut", tooltip: "La vue look est orientée nord en haut, au lieu du monde en haut.\nPour les vues satellite et similaires, en regardant droit vers le bas.\nNe s'applique pas en mode PTZ" },
        atmosphere: { label: "Atmosphère", tooltip: "Atténuation par la distance qui mélange le terrain et les objets 3D vers la couleur du ciel actuelle" },
        atmoVisibility: { label: "Visibilité atmo (km)", tooltip: "Distance où le contraste atmosphérique chute à environ 50 % (plus petit = atmosphère plus épaisse)" },
        atmoHDR: { label: "Atmo HDR", tooltip: "Brouillard/tone mapping HDR physiquement réaliste pour les reflets du soleil à travers la brume" },
        atmoExposure: { label: "Exposition atmo", tooltip: "Multiplicateur d'exposition de tone mapping HDR pour l'adoucissement des hautes lumières" },
        startXR: { label: "Démarrer VR/XR", tooltip: "Démarrer une session WebXR pour les tests (fonctionne avec Immersive Web Emulator)" },
        effects: { label: "Effets", tooltip: "Activer/désactiver tous les effets" },
        focusTrack: { label: "Piste de focus", tooltip: "Sélectionner une piste pour que la caméra la regarde et tourne autour" },
        lockTrack: { label: "Verrouiller sur piste", tooltip: "Sélectionner une piste pour verrouiller la caméra dessus, afin qu'elle se déplace avec la piste" },
        debug: {
            clearBackground: "Effacer l'arrière-plan", renderSky: "Rendu du ciel", renderDaySky: "Rendu du ciel diurne",
            renderMainScene: "Rendu de la scène principale", renderEffects: "Rendu des effets", copyToScreen: "Copie à l'écran",
            updateCameraMatrices: "Mise à jour matrices caméra", mainUseLookLayers: "Principal utilise calques look",
            sRGBOutputEncoding: "Encodage de sortie sRGB", tileLoadDelay: "Délai de chargement des tuiles (s)",
            updateStarScales: "Mise à jour échelles étoiles", updateSatelliteScales: "Mise à jour échelles satellites",
            renderNightSky: "Rendu du ciel nocturne", renderFullscreenQuad: "Rendu du quad plein écran", renderSunSky: "Rendu du ciel solaire",
        },
        celestial: {
            raHours: "AD (heures)", decDegrees: "Déc (degrés)", magnitude: "Magnitude",
            noradNumber: "Numéro NORAD", name: "Nom",
        },
    },
    nightSky: {
        loadLEO: { label: "Charger les satellites LEO pour la date", tooltip: "Obtenir les dernières données TLE des satellites LEO pour la date/heure du simulateur. Cela téléchargera les données depuis Internet, ce qui peut prendre quelques secondes.\nPermettra également l'affichage des satellites dans le ciel nocturne." },
        loadStarlink: { label: "Charger Starlink ACTUEL", tooltip: "Obtenir les positions ACTUELLES (pas historiques, maintenant, en temps réel) des satellites Starlink. Cela téléchargera les données depuis Internet, ce qui peut prendre quelques secondes.\n" },
        loadActive: { label: "Charger les satellites ACTIFS", tooltip: "Obtenir les positions ACTUELLES (pas historiques, maintenant, en temps réel) des satellites ACTIFS. Cela téléchargera les données depuis Internet, ce qui peut prendre quelques secondes.\n" },
        loadSlow: { label: "(Expérimental) Charger les satellites LENTS", tooltip: "Obtenir les dernières données TLE des satellites LENTS pour la date/heure du simulateur. Cela téléchargera les données depuis Internet, ce qui peut prendre quelques secondes.\nPermettra également l'affichage des satellites dans le ciel nocturne. Peut expirer pour les dates récentes" },
        loadAll: { label: "(Expérimental) Charger TOUS les satellites", tooltip: "Obtenir les dernières données TLE de TOUS les satellites pour la date/heure du simulateur. Cela téléchargera les données depuis Internet, ce qui peut prendre quelques secondes.\nPermettra également l'affichage des satellites dans le ciel nocturne. Peut expirer pour les dates récentes" },
        flareAngle: { label: "Angle d'éclat", tooltip: "Angle maximal du vecteur de vue réfléchi pour qu'un éclat soit visible\nc.-à-d. la plage d'angles entre le vecteur du satellite au soleil et le vecteur de la caméra au satellite réfléchi sur le dessous du satellite (qui est parallèle au sol)" },
        penumbraDepth: { label: "Profondeur de pénombre terrestre", tooltip: "Profondeur verticale en mètres sur laquelle un satellite s'estompe en entrant dans l'ombre de la Terre" },
        sunAngleArrows: { label: "Flèches d'angle solaire", tooltip: "Lorsqu'un reflet est détecté, afficher les flèches de la caméra au satellite, puis du satellite au soleil" },
        celestialFolder: { tooltip: "Éléments liés au ciel nocturne" },
        vectorsOnTraverse: { label: "Vecteurs sur la trajectoire", tooltip: "Si coché, les vecteurs sont affichés par rapport à l'objet de traversée. Sinon, ils sont affichés par rapport à la caméra look." },
        vectorsInLookView: { label: "Vecteurs dans la vue look", tooltip: "Si coché, les vecteurs sont affichés dans la vue look. Sinon, uniquement dans la vue principale." },
        showSatellitesGlobal: { label: "Afficher les satellites (global)", tooltip: "Commutateur principal : afficher ou masquer tous les satellites" },
        showStarlink: { label: "Starlink", tooltip: "Afficher les satellites SpaceX Starlink" },
        showISS: { label: "ISS", tooltip: "Afficher la Station spatiale internationale" },
        celestrackBrightest: { label: "Les plus brillants de Celestrack", tooltip: "Afficher la liste des satellites les plus brillants de Celestrack" },
        otherSatellites: { label: "Autres satellites", tooltip: "Afficher les satellites hors des catégories ci-dessus" },
        list: { label: "Liste", tooltip: "Afficher une liste textuelle des satellites visibles" },
        satelliteArrows: { label: "Flèches de satellites", tooltip: "Afficher des flèches indiquant les trajectoires des satellites" },
        flareLines: { label: "Lignes d'éclat", tooltip: "Afficher des lignes reliant les satellites en éclat à la caméra et au Soleil" },
        satelliteGroundArrows: { label: "Flèches au sol des satellites", tooltip: "Afficher des flèches vers le sol sous chaque satellite" },
        satelliteLabelsLook: { label: "Étiquettes satellites (vue look)", tooltip: "Afficher les noms des satellites dans la vue look/caméra" },
        satelliteLabelsMain: { label: "Étiquettes satellites (vue principale)", tooltip: "Afficher les noms des satellites dans la vue 3D principale" },
        labelFlaresOnly: { label: "Étiqueter uniquement les éclats", tooltip: "N'étiqueter que les satellites actuellement en éclat" },
        labelLitOnly: { label: "Étiqueter uniquement les éclairés", tooltip: "N'étiqueter que les satellites éclairés par le soleil (pas dans l'ombre terrestre)" },
        labelLookVisibleOnly: { label: "Étiqueter uniquement les visibles dans look", tooltip: "N'étiqueter que les satellites visibles dans le frustum de la caméra look" },
        flareRegion: { label: "Région d'éclat", tooltip: "Afficher la région du ciel où les éclats de satellites sont visibles" },
        flareBand: { label: "Bande d'éclat", tooltip: "Afficher la bande au sol balayée par les éclats d'une trajectoire satellite" },
        filterTLEs: { label: "Filtrer les TLE", tooltip: "Filtrer les satellites visibles par altitude, position, paramètres orbitaux ou nom" },
        clearTLEFilter: { label: "Effacer le filtre TLE", tooltip: "Supprimer tous les filtres spatiaux/orbitaux TLE, rétablissant la visibilité par catégorie" },
        maxLabelsDisplayed: { label: "Étiquettes max affichées", tooltip: "Nombre maximal d'étiquettes de satellites à afficher simultanément" },
        starBrightness: { label: "Luminosité des étoiles", tooltip: "Facteur d'échelle de la luminosité des étoiles. 1 = normal, 0 = invisible, 2 = deux fois plus lumineux, etc." },
        starLimit: { label: "Limite des étoiles", tooltip: "Seuil de luminosité pour l'affichage des étoiles" },
        planetBrightness: { label: "Luminosité des planètes", tooltip: "Facteur d'échelle de la luminosité des planètes (sauf Soleil et Lune). 1 = normal, 0 = invisible, 2 = deux fois plus lumineux, etc." },
        lockStarPlanetBrightness: { label: "Verrouiller luminosité étoiles/planètes", tooltip: "Lorsque coché, les curseurs de luminosité des étoiles et des planètes sont verrouillés ensemble" },
        satBrightness: { label: "Luminosité satellites", tooltip: "Facteur d'échelle de la luminosité des satellites. 1 = normal, 0 = invisible, 2 = deux fois plus lumineux, etc." },
        flareBrightness: { label: "Luminosité des éclats", tooltip: "Facteur d'échelle de la luminosité supplémentaire des satellites en éclat. 0 = rien" },
        satCutOff: { label: "Seuil de coupure satellite", tooltip: "Les satellites atténués à ce niveau ou en dessous ne seront pas affichés" },
        displayRange: { label: "Portée d'affichage (km)", tooltip: "Les satellites au-delà de cette distance n'auront pas leurs noms ou flèches affichés" },
        equatorialGrid: { label: "Grille équatoriale", tooltip: "Afficher la grille de coordonnées équatoriales célestes" },
        constellationLines: { label: "Lignes de constellations", tooltip: "Afficher les lignes reliant les étoiles des constellations" },
        renderStars: { label: "Afficher les étoiles", tooltip: "Afficher les étoiles dans le ciel nocturne" },
        equatorialGridLook: { label: "Grille équatoriale dans la vue look", tooltip: "Afficher la grille équatoriale dans la vue look/caméra" },
        flareRegionLook: { label: "Région d'éclat dans la vue look", tooltip: "Afficher le cône de la région d'éclat dans la vue look" },
        satelliteEphemeris: { label: "Éphémérides satellite" },
        skyPlot: { label: "Diagramme céleste" },
        celestialVector: { label: "Vecteur {{name}}", tooltip: "Afficher un vecteur de direction pointant vers {{name}}" },
    },
    synthClouds: {
        name: { label: "Nom" },
        visible: { label: "Visible" },
        editMode: { label: "Mode édition" },
        altitude: { label: "Altitude" },
        radius: { label: "Rayon" },
        cloudSize: { label: "Taille des nuages" },
        density: { label: "Densité" },
        opacity: { label: "Opacité" },
        brightness: { label: "Luminosité" },
        depth: { label: "Profondeur" },
        edgeWiggle: { label: "Ondulation des bords" },
        edgeFrequency: { label: "Fréquence des bords" },
        seed: { label: "Graine" },
        feather: { label: "Estompage" },
        windMode: { label: "Mode vent" },
        windFrom: { label: "Vent de (°)" },
        windKnots: { label: "Vent (nœuds)" },
        deleteClouds: { label: "Supprimer les nuages" },
    },
    synthBuilding: {
        name: { label: "Nom" },
        visible: { label: "Visible" },
        editMode: { label: "Mode édition" },
        roofEdgeHeight: { label: "Hauteur bord du toit" },
        ridgelineHeight: { label: "Hauteur du faîtage" },
        ridgelineInset: { label: "Retrait du faîtage" },
        roofEaves: { label: "Débord de toit" },
        type: { label: "Type" },
        wallColor: { label: "Couleur des murs" },
        roofColor: { label: "Couleur du toit" },
        opacity: { label: "Opacité" },
        transparent: { label: "Transparent" },
        wireframe: { label: "Fil de fer" },
        depthTest: { label: "Test de profondeur" },
        deleteBuilding: { label: "Supprimer le bâtiment" },
    },

    groundOverlay: {
        name: { label: "Nom" },
        visible: { label: "Visible" },
        editMode: { label: "Mode édition" },
        lockShape: { label: "Verrouiller la forme" },
        freeTransform: { label: "Transformation libre" },
        showBorder: { label: "Afficher la bordure" },
        properties: { label: "Propriétés" },
        imageURL: { label: "URL de l'image" },
        rehostLocalImage: { label: "Réhéberger l'image locale" },
        north: { label: "Nord" },
        south: { label: "Sud" },
        east: { label: "Est" },
        west: { label: "Ouest" },
        rotation: { label: "Rotation" },
        altitude: { label: "Altitude (ft)" },
        wireframe: { label: "Fil de fer" },
        opacity: { label: "Opacité" },
        cloudExtraction: { label: "Extraction de nuages" },
        extractClouds: { label: "Extraire les nuages" },
        cloudColor: { label: "Couleur des nuages" },
        fuzziness: { label: "Flou" },
        feather: { label: "Contour progressif" },
        gotoOverlay: { label: "Aller à la superposition" },
        deleteOverlay: { label: "Supprimer la superposition" },
    },

    videoView: {
        folders: {
            videoAdjustments: "Réglages vidéo",
            videoProcessing: "Traitement vidéo",
            forensics: "Analyses forensiques",
            errorLevelAnalysis: "Analyse du niveau d'erreur",
            noiseAnalysis: "Analyse du bruit",
            grid: "Grille",
        },
        currentVideo: { label: "Vidéo actuelle" },
        videoRotation: { label: "Rotation vidéo" },
        setCameraToExifGps: { label: "Positionner la caméra sur le GPS EXIF" },
        expandOutput: {
            label: "Étendre la sortie",
            tooltip: "Méthode pour étendre la plage dynamique de la sortie ELA",
        },
        displayMode: {
            label: "Mode d'affichage",
            tooltip: "Comment visualiser les résultats de l'analyse de bruit",
        },
        convolutionFilter: {
            label: "Filtre de convolution",
            tooltip: "Type de filtre de convolution spatiale à appliquer",
        },
        resetVideoAdjustments: {
            label: "Réinitialiser les ajustements vidéo",
            tooltip: "Réinitialiser tous les ajustements vidéo à leurs valeurs par défaut",
        },
        makeVideo: {
            label: "Créer la vidéo",
            tooltip: "Exporter la vidéo traitée avec tous les effets actuels appliqués",
        },
        gridShow: {
            label: "Afficher",
            tooltip: "Afficher une grille superposée sur la vidéo",
        },
        gridSize: {
            label: "Taille",
            tooltip: "Taille des cellules de la grille en pixels",
        },
        gridSubdivisions: {
            label: "Subdivisions",
            tooltip: "Nombre de subdivisions dans chaque cellule de la grille",
        },
        gridXOffset: {
            label: "Décalage X",
            tooltip: "Décalage horizontal de la grille en pixels",
        },
        gridYOffset: {
            label: "Décalage Y",
            tooltip: "Décalage vertical de la grille en pixels",
        },
        gridColor: {
            label: "Couleur",
            tooltip: "Couleur des lignes de la grille",
        },
    },

    floodSim: {
        flood: {
            label: "Inondation",
            tooltip: "Activer ou désactiver la simulation de particules d'inondation",
        },
        floodRate: {
            label: "Débit d'inondation",
            tooltip: "Nombre de particules créées par image",
        },
        sphereSize: {
            label: "Taille des sphères",
            tooltip: "Rayon visuel de chaque particule d'eau",
        },
        dropRadius: {
            label: "Rayon de chute",
            tooltip: "Rayon autour du point de chute où les particules apparaissent",
        },
        maxParticles: {
            label: "Particules max",
            tooltip: "Nombre maximum de particules d'eau actives",
        },
        method: {
            label: "Méthode",
            tooltip: "Méthode de simulation : HeightMap (grille), Fast (particules) ou PBF (fluides basés sur la position)",
        },
        waterSource: {
            label: "Source d'eau",
            tooltip: "Rain : ajouter de l'eau au fil du temps. DamBurst : maintenir le niveau d'eau à l'altitude cible dans le rayon de chute",
        },
        speed: {
            label: "Vitesse",
            tooltip: "Pas de simulation par image (1-20x)",
        },
        manningN: {
            label: "Manning's N",
            tooltip: "Rugosité du lit : 0.01=lisse, 0.03=canal naturel, 0.05=plaine d'inondation rugueuse, 0.1=végétation dense",
        },
        edge: {
            label: "Bord",
            tooltip: "Blocking : l'eau rebondit aux bords de la grille. Draining : l'eau s'écoule et est supprimée",
        },
        waterColor: {
            label: "Couleur de l'eau",
            tooltip: "Couleur de l'eau",
        },
        reset: {
            label: "Réinitialiser",
            tooltip: "Supprimer toutes les particules et redémarrer la simulation",
        },
    },

    flowOrbs: {
        number: {
            label: "Nombre",
            tooltip: "Nombre d'orbes de flux à afficher. Plus d'orbes peut affecter les performances.",
        },
        spreadMethod: {
            label: "Méthode de répartition",
            tooltip: "Méthode pour répartir les orbes le long du vecteur de visée de la caméra. \n'Range' répartit les orbes uniformément entre les distances proche et lointaine. \n'Altitude' répartit les orbes entre les altitudes absolues basse et haute (MSL)",
        },
        near: {
            label: "Proche (m)",
            tooltip: "Distance la plus proche de la caméra pour le placement des orbes",
        },
        far: {
            label: "Loin (m)",
            tooltip: "Distance la plus éloignée de la caméra pour le placement des orbes",
        },
        high: { label: "Haut (m)" },
        low: { label: "Bas (m)" },
        colorMethod: {
            label: "Méthode de couleur",
            tooltip: "Méthode pour déterminer la couleur des orbes de flux. \n'Random' attribue une couleur aléatoire à chaque orbe. \n'User' attribue une couleur choisie par l'utilisateur à tous les orbes. \n'Hue From Altitude' attribue une couleur basée sur l'altitude de l'orbe. \n'Hue From Distance' attribue une couleur basée sur la distance de l'orbe par rapport à la caméra.",
        },
        userColor: {
            label: "Couleur utilisateur",
            tooltip: "Sélectionner une couleur pour les orbes de flux lorsque la 'Méthode de couleur' est réglée sur 'User'.",
        },
        hueRange: {
            label: "Plage de teinte",
            tooltip: "Plage sur laquelle vous obtenez un spectre complet de couleurs pour la méthode de couleur 'Hue From Altitude/Range'.",
        },
        windWhilePaused: {
            label: "Vent en pause",
            tooltip: "Si coché, le vent affectera toujours les orbes de flux même lorsque la simulation est en pause. Utile pour visualiser les motifs de vent.",
        },
    },

    osdController: {
        seriesName: {
            label: "Nom",
        },
        seriesType: {
            label: "Type",
        },
        seriesShow: {
            label: "Afficher",
        },
        seriesLock: {
            label: "Verrouiller",
        },
        removeTrack: {
            label: "Supprimer la piste",
        },
        folderTitle: {
            label: "Suivi OSD",
            tooltip: "Suivi de texte OSD (affichage à l'écran) pour du texte par image défini par l'utilisateur",
        },
        addNewTrack: {
            label: "Ajouter une série de données OSD",
            tooltip: "Créer une nouvelle série de données OSD pour une superposition de texte par image",
        },
        makeTrack: {
            label: "Créer une piste",
            tooltip: "Créer une piste de position à partir des séries de données OSD visibles/déverrouillées (MGRS ou Lat/Lon)",
        },
        showAll: {
            label: "Tout afficher",
            tooltip: "Basculer la visibilité de toutes les séries de données OSD",
        },
        exportAllData: {
            label: "Exporter toutes les données",
            tooltip: "Exporter toutes les séries de données OSD en fichiers CSV dans un ZIP",
        },
        graphShow: {
            label: "Afficher",
            tooltip: "Afficher ou masquer la vue graphique des données OSD",
        },
        xAxis: {
            label: "Axe X",
            tooltip: "Série de données pour l'axe horizontal",
        },
        y1Axis: {
            label: "Axe Y1",
            tooltip: "Série de données pour l'axe vertical gauche",
        },
        y2Axis: {
            label: "Axe Y2",
            tooltip: "Série de données pour l'axe vertical droit",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "Affichage des infos vidéo",
            tooltip: "Contrôles d'affichage des infos vidéo pour le compteur d'images, le timecode et l'horodatage",
        },
        showVideoInfo: {
            label: "Afficher les infos vidéo",
            tooltip: "Commutateur principal - activer ou désactiver tous les affichages d'infos vidéo",
        },
        frameCounter: {
            label: "Compteur d'images",
            tooltip: "Afficher le numéro de l'image actuelle",
        },
        offsetFrame: {
            label: "Image avec décalage",
            tooltip: "Afficher le numéro d'image actuel plus une valeur de décalage",
        },
        offsetValue: {
            label: "Valeur de décalage",
            tooltip: "Valeur de décalage ajoutée au numéro d'image actuel",
        },
        timecode: {
            label: "Timecode",
            tooltip: "Afficher le timecode au format HH:MM:SS:FF",
        },
        timestamp: {
            label: "Horodatage",
            tooltip: "Afficher l'horodatage au format HH:MM:SS.SS",
        },
        dateLocal: {
            label: "Date (locale)",
            tooltip: "Afficher la date actuelle dans le fuseau horaire sélectionné",
        },
        timeLocal: {
            label: "Heure (locale)",
            tooltip: "Afficher l'heure actuelle dans le fuseau horaire sélectionné",
        },
        dateTimeLocal: {
            label: "Date et heure (locale)",
            tooltip: "Afficher la date et l'heure complètes dans le fuseau horaire sélectionné",
        },
        dateUTC: {
            label: "Date (UTC)",
            tooltip: "Afficher la date actuelle en UTC",
        },
        timeUTC: {
            label: "Heure (UTC)",
            tooltip: "Afficher l'heure actuelle en UTC",
        },
        dateTimeUTC: {
            label: "Date et heure (UTC)",
            tooltip: "Afficher la date et l'heure complètes en UTC",
        },
        fontSize: {
            label: "Taille de police",
            tooltip: "Ajuster la taille de police du texte d'information",
        },
    },

    terrainUI: {
        mapType: {
            label: "Type de carte",
            tooltip: "Type de carte pour les textures du terrain (séparé des données d'élévation)",
        },
        elevationType: {
            label: "Type d'élévation",
            tooltip: "Source de données d'élévation pour les hauteurs du terrain",
        },
        lat: {
            tooltip: "Latitude du centre du terrain",
        },
        lon: {
            tooltip: "Longitude du centre du terrain",
        },
        zoom: {
            tooltip: "Niveau de zoom du terrain. 2 correspond au monde entier, 15 à quelques pâtés de maisons",
        },
        nTiles: {
            tooltip: "Nombre de tuiles du terrain. Plus de tuiles signifie plus de détails, mais un chargement plus lent. (NxN)",
        },
        refresh: {
            label: "Rafraîchir",
            tooltip: "Rafraîchir le terrain avec les paramètres actuels. Utile en cas de problèmes réseau ayant causé un échec de chargement",
        },
        debugGrids: {
            label: "Grilles de débogage",
            tooltip: "Afficher une grille des textures au sol (vert) et des données d'élévation (bleu)",
        },
        elevationScale: {
            tooltip: "Facteur d'échelle pour les données d'élévation. 1 est normal, 0.5 est la moitié, 2 est le double",
        },
        terrainOpacity: {
            label: "Opacité du terrain",
            tooltip: "Opacité du terrain. 0 est totalement transparent, 1 est totalement opaque",
        },
        textureDetail: {
            tooltip: "Niveau de détail pour la subdivision des textures. Des valeurs plus élevées = plus de détails. 1 est normal, 0.5 est moins détaillé, 2 est plus détaillé",
        },
        elevationDetail: {
            tooltip: "Niveau de détail pour la subdivision de l'élévation. Des valeurs plus élevées = plus de détails. 1 est normal, 0.5 est moins détaillé, 2 est plus détaillé",
        },
        disableDynamicSubdivision: {
            label: "Désactiver la subdivision dynamique",
            tooltip: "Désactiver la subdivision dynamique des tuiles de terrain. Fige le terrain au niveau de détail actuel. Utile pour le débogage.",
        },
        dynamicSubdivision: {
            label: "Subdivision dynamique",
            tooltip: "Utiliser la subdivision de tuiles adaptative à la caméra pour une vue à l'échelle du globe",
        },
        showBuildings: {
            label: "Bâtiments 3D",
            tooltip: "Afficher les tuiles de bâtiments 3D de Cesium Ion ou Google",
        },
        buildingEdges: {
            label: "Arêtes des bâtiments",
            tooltip: "Afficher les arêtes en fil de fer sur les tuiles de bâtiments 3D",
        },
        oceanSurface: {
            label: "Surface océanique (Bêta)",
            tooltip: "Expérimental : afficher la surface d'eau au niveau de la mer (MSL fixe EGM96) lorsque les tuiles photoréalistes Google sont actives",
        },
        buildingsSource: {
            label: "Source des bâtiments",
            tooltip: "Source de données pour les tuiles de bâtiments 3D",
        },
        useEllipsoid: {
            label: "Utiliser le modèle terrestre ellipsoïdal",
            tooltip: "Sphère : modèle ancien rapide. Ellipsoïde : forme WGS84 précise (les latitudes élevées en bénéficient le plus).",
        },
        layer: {
            label: "Couche",
            tooltip: "Couche pour les textures de terrain du type de carte actuel",
        },
    },

    displayTrack: {
        visible: {
            tooltip: "Afficher ou masquer cette piste",
        },
        extendToGround: {
            label: "Étendre au sol",
            tooltip: "Tracer des lignes verticales de la piste au sol",
        },
        displayStep: {
            label: "Pas d'affichage",
            tooltip: "Pas d'images entre les points de piste affichés (1 = chaque image)",
        },
        contrail: {
            label: "Traînée de condensation",
            tooltip: "Afficher un ruban de traînée de condensation derrière cette piste, ajusté pour le vent",
        },
        contrailSecs: {
            label: "Durée traînée (s)",
            tooltip: "Durée de la traînée de condensation en secondes",
        },
        contrailWidth: {
            label: "Largeur traînée (m)",
            tooltip: "Largeur maximale du ruban de traînée en mètres",
        },
        contrailInitialWidth: {
            label: "Largeur initiale traînée (m)",
            tooltip: "Largeur de la traînée au point d'échappement en mètres",
        },
        contrailRamp: {
            label: "Rampe traînée (m)",
            tooltip: "Distance sur laquelle la largeur de la traînée augmente en mètres",
        },
        contrailSpread: {
            label: "Dispersion traînée (m/s)",
            tooltip: "Taux d'expansion de la traînée en m/s",
        },
        lineColor: {
            label: "Couleur de ligne",
            tooltip: "Couleur de la ligne de piste",
        },
        polyColor: {
            label: "Couleur des polygones",
            tooltip: "Couleur des polygones verticaux d'extension au sol",
        },
        altLockAGL: {
            label: "Verrouillage alt. AGL",
        },
        gotoTrack: {
            label: "Aller à la piste",
            tooltip: "Centrer la caméra principale sur la position de cette piste",
        },
    },

    ptzUI: {
        panAz: {
            label: "Panoramique (Az)",
            tooltip: "Angle d'azimut / panoramique de la caméra en degrés",
        },
        tiltEl: {
            label: "Inclinaison (Él)",
            tooltip: "Angle d'élévation / inclinaison de la caméra en degrés",
        },
        zoomFov: {
            label: "VFOV (deg)",
            tooltip: "Champ de vision vertical de la caméra en degrés",
        },
        roll: {
            label: "Roulis",
            tooltip: "Angle de roulis de la caméra en degrés",
        },
        xOffset: {
            label: "Décalage X",
            tooltip: "Décalage horizontal de la caméra par rapport au centre",
        },
        yOffset: {
            label: "Décalage Y",
            tooltip: "Décalage vertical de la caméra par rapport au centre",
        },
        nearPlane: {
            label: "Plan proche (m)",
            tooltip: "Distance du plan de découpe proche de la caméra en mètres",
        },
        relative: {
            label: "Relatif",
            tooltip: "Utiliser des angles relatifs au lieu d'absolus",
        },
        satellite: {
            label: "Satellite",
            tooltip: "Mode satellite : déplacement à l'écran depuis le nadir.\nRoulis = cap, Az = gauche/droite, Él = haut/bas (−90 = nadir)",
        },
        rotation: {
            label: "Rotation",
            tooltip: "Rotation à l'écran autour de l'axe de visée de la caméra",
        },
    },

    nodes3dObject: {
        modelOrGeometry: {
            label: "Modèle ou Géométrie",
            tooltip: "Choisir entre un modèle 3D ou une géométrie générée pour cet objet",
        },
        model: {
            label: "Modèle",
            tooltip: "Sélectionner un modèle 3D à utiliser pour cet objet",
        },
        displayBoundingBox: {
            label: "Afficher la boîte englobante",
            tooltip: "Afficher la boîte englobante de l'objet avec ses dimensions",
        },
        forceAboveSurface: {
            label: "Forcer au-dessus de la surface",
            tooltip: "Forcer l'objet à rester entièrement au-dessus de la surface du sol",
        },
        exportToKML: {
            label: "Exporter en KML",
            tooltip: "Exporter cet objet 3D en fichier KML pour Google Earth",
        },
        startAnalysis: {
            label: "Lancer l'analyse",
            tooltip: "Lancer des rayons depuis la caméra pour trouver les directions de réflexion",
        },
        gridSize: {
            label: "Taille de grille",
            tooltip: "Nombre de points d'échantillonnage par axe pour la grille de réflexion",
        },
        cleanUp: {
            label: "Nettoyer",
            tooltip: "Supprimer toutes les flèches d'analyse de réflexion de la scène",
        },
    },

    trackingOverlay: {
        showTracking: {
            label: "Afficher le suivi",
            tooltip: "Afficher ou masquer les points de suivi et la courbe superposée",
        },
        reset: {
            label: "Réinitialiser",
            tooltip: "Réinitialiser le suivi manuel à un état vide, en supprimant toutes les images clés et les éléments déplaçables",
        },
        limitAB: {
            label: "Limiter AB",
            tooltip: "Limiter les images A et B à la plage des images clés de suivi vidéo. Cela empêchera l'extrapolation au-delà des premières et dernières images clés, ce qui n'est pas toujours souhaité.",
        },
        curveType: {
            label: "Type de courbe",
            tooltip: "Spline utilise la spline cubique naturelle. Spline2 utilise la spline not-a-knot pour un comportement plus lisse aux extrémités. Linéaire utilise des segments de droite. Perspective nécessite exactement 3 images clés et modélise un mouvement linéaire avec projection perspective.",
        },
        minimizeGroundSpeed: {
            label: "Minimiser la vitesse au sol",
            tooltip: "Trouver la distance de départ cible qui minimise la distance au sol parcourue par la trajectoire de traversée",
        },
        minimizeAirSpeed: {
            label: "Minimiser la vitesse air",
            tooltip: "Trouver la distance de départ cible qui minimise la distance air parcourue (en tenant compte du vent cible)",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "Quadrilatère au sol du frustum",
            tooltip: "Afficher l'intersection du frustum de la caméra avec le sol",
        },
        videoInFrustum: {
            label: "Vidéo dans le frustum",
            tooltip: "Projeter la vidéo sur le plan éloigné du frustum de la caméra",
        },
        videoOnGround: {
            label: "Vidéo au sol",
            tooltip: "Projeter la vidéo sur le sol",
        },
        groundVideoInLookView: {
            label: "Vidéo au sol dans la vue caméra",
            tooltip: "Afficher la vidéo projetée au sol dans la vue caméra",
        },
        matchVideoAspect: {
            label: "Adapter le ratio vidéo",
            tooltip: "Recadrer la vue caméra pour correspondre au ratio d'aspect de la vidéo et ajuster le frustum en conséquence",
        },
        videoOpacity: {
            label: "Opacité de la vidéo",
            tooltip: "Opacité de la superposition vidéo projetée",
        },
    },

    labels3d: {
        measurements: {
            label: "Mesures",
            tooltip: "Afficher les étiquettes et flèches de mesure de distance et d'angle",
        },
        labelsInMain: {
            label: "Étiquettes dans la vue principale",
            tooltip: "Afficher les étiquettes de trajectoire/objet dans la vue 3D principale",
        },
        labelsInLook: {
            label: "Étiquettes dans la vue caméra",
            tooltip: "Afficher les étiquettes de trajectoire/objet dans la vue caméra",
        },
        featuresInMain: {
            label: "Marqueurs/Épingles dans la vue principale",
            tooltip: "Afficher les marqueurs de points d'intérêt (épingles) dans la vue 3D principale",
        },
        featuresInLook: {
            label: "Marqueurs dans la vue caméra",
            tooltip: "Afficher les marqueurs de points d'intérêt dans la vue caméra",
        },
    },

    losFitPhysics: {
        folder: "Résultats d'ajustement physique",
        model: {
            label: "Modèle",
        },
        avgError: {
            label: "Erreur moy. (rad)",
        },
        windSpeed: {
            label: "Vitesse du vent (kt)",
        },
        windFrom: {
            label: "Vent venant de (\u00B0)",
        },
    },

    misbData: {
        startTime: {
            label: "Heure de début",
            tooltip: "Remplacer l'heure de début (ex. : '10:30', '15 jan', '2024-01-15T10:30:00Z'). Laisser vide pour l'heure de début globale.",
        },
        enableFilter: {
            label: "Activer le filtre",
        },
        tryAltitudeFirst: {
            label: "Essayer l'altitude d'abord",
        },
        maxG: {
            label: "G max",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "Au-dessus du sol",
            tooltip: "L'altitude est relative au niveau du sol, pas au niveau de la mer",
        },
        lookup: {
            label: "Rechercher",
            tooltip: "Entrer un nom de lieu, des coordonnées lat,lon ou MGRS pour s'y déplacer",
        },
        geolocate: {
            label: "Géolocaliser depuis le navigateur",
            tooltip: "Utiliser l'API de géolocalisation du navigateur pour définir votre position actuelle",
        },
        goTo: {
            label: "Aller à la position ci-dessus",
            tooltip: "Déplacer le terrain et la caméra vers la latitude/longitude/altitude saisie",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "Arrêter à",
            tooltip: "Arrêter le mouvement de la cible de la caméra à cette image, même si la trajectoire cible continue. Utile pour simuler la perte de verrouillage sur une cible en mouvement. Mettre à 0 pour désactiver.",
        },
        horizonMethod: {
            label: "Méthode d'horizon",
        },
        lookFOV: {
            label: "CDV de la vue",
        },
        celestialObject: {
            label: "Objet céleste",
            tooltip: "Nom du corps céleste que la caméra suit (ex. : Lune, Vénus, Jupiter)",
        },
    },

    spriteGroup: {
        visible: {
            label: "Visible",
            tooltip: "Afficher ou masquer les orbes de flux",
        },
        size: {
            label: "Taille (m)",
            tooltip: "Diamètre en mètres.",
        },
        viewSizeMultiplier: {
            label: "Multiplicateur de taille de vue",
            tooltip: "Ajuste la taille des orbes de flux dans la vue principale, sans changer la taille dans les autres vues.",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "Meilleur angle, 180° complet, affiné",
        },
        bestAngle5: {
            label: "Meilleur angle dans les 5° de l'actuel",
        },
    },

    misc: {
        snapshotCamera: {
            label: "Instantané caméra",
            tooltip: "Sauvegarder la position et l'orientation actuelles de la caméra pour 'Réinitialiser la caméra'",
        },
        resetCamera: {
            label: "Réinitialiser la caméra",
            tooltip: "Réinitialiser la caméra à la position par défaut, ou au dernier instantané\nAussi Pavé num-.",
        },
        showMoonShadow: {
            label: "Afficher l'ombre de la Lune",
            tooltip: "Basculer l'affichage du cône d'ombre de la Lune pour la visualisation d'éclipse.",
        },
        shadowSegments: {
            label: "Segments d'ombre",
            tooltip: "Nombre de segments dans le cône d'ombre (plus = plus lisse mais plus lent)",
        },
        showEarthShadow: {
            label: "Afficher l'ombre de la Terre",
            tooltip: "Basculer l'affichage du cône d'ombre de la Terre dans le ciel nocturne.",
        },
        earthShadowAltitude: {
            label: "Altitude de l'ombre terrestre",
            tooltip: "Distance du centre de la Terre au plan de rendu du cône d'ombre terrestre (en mètres).",
        },
        exportTLE: {
            label: "Exporter TLE",
        },
        backgroundFlowIndicator: {
            label: "Indicateur de flux d'arrière-plan",
            tooltip: "Afficher une flèche indiquant le déplacement de l'arrière-plan à l'image suivante.\nUtile pour synchroniser la simulation avec la vidéo (utiliser Vue/Superposition Vidéo)",
        },
        defaultSnap: {
            label: "Accrochage par défaut",
            tooltip: "Lorsqu'activé, les points s'aligneront horizontalement par défaut pendant le glissement.\nMaintenir Maj (pendant le glissement) pour faire l'inverse",
        },
        recalcNodeGraph: {
            label: "Recalculer le graphe de nœuds",
        },
        downloadVideo: {
            label: "Télécharger la vidéo",
        },
        banking: {
            label: "Inclinaison",
            tooltip: "Comment l'objet s'incline pendant les virages",
        },
        angularTraverse: {
            label: "Traversée angulaire",
        },
        smoothingMethod: {
            label: "Méthode de lissage",
            tooltip: "Algorithme utilisé pour lisser les données de trajectoire de la caméra",
        },
        showInLookView: {
            label: "Afficher dans la vue caméra",
        },
        windFrom: {
            tooltip: "Cap vrai d'où vient le vent (0=Nord, 90=Est)",
        },
        windKnots: {
            tooltip: "Vitesse du vent en nœuds",
        },
        fetchWind: {
            tooltip: "Récupérer les données de vent réelles depuis les services météo pour cette position et cette heure",
        },
        debugConsole: {
            label: "Console de débogage",
            tooltip: "Console de débogage",
        },
        aiAssistant: {
            label: "Assistant IA",
        },
        hide: {
            label: "Masquer",
            tooltip: "Masquer cette vue à onglets\nPour la réafficher, utilisez le menu 'Affichage/Masquage -> Vues'.",
        },
        notes: {
            label: "Notes",
            tooltip: "Afficher/Masquer l'éditeur de notes. Les notes sont sauvegardées avec le sitch et peuvent contenir des hyperliens cliquables.",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "Lignes de visée",
            tooltip: "Afficher les lignes de visée de la caméra vers la cible (basculer : O)",
        },
        physicalPointer: {
            label: "Pointeur physique",
        },
        jet: {
            label: "[J]et",
        },
        horizonGrid: {
            label: "Grille d'[H]orizon",
        },
        wingPlaneGrid: {
            label: "Grille du plan d'aile ([W])",
        },
        sphericalBoresightGrid: {
            label: "Grille [S]phérique de visée",
        },
        azimuthElevationGrid: {
            label: "Grille [A]zimut/Élévation",
        },
        frustumOfCamera: {
            label: "F[R]ustum de la caméra",
        },
        trackLine: {
            label: "Ligne de [T]rajectoire",
        },
        globe: {
            label: "[G]lobe",
        },
        showErrorCircle: {
            label: "Cercle d'erreur",
        },
        glareSprite: {
            label: "Spr[I]te d'éblouissement",
        },
        cameraViewFrustum: {
            label: "Frustum de la caméra",
            tooltip: "Afficher le frustum de la caméra dans la scène 3D",
        },
        zaineTriangulation: {
            label: "Triangulation Zaine",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "Intensité ambiante",
            tooltip: "Intensité de la lumière ambiante. 0 = pas de lumière ambiante, 1 = lumière ambiante normale, 2 = double lumière ambiante",
        },
        irAmbientIntensity: {
            label: "Intensité ambiante IR",
            tooltip: "Intensité de la lumière ambiante IR (utilisée pour les vues IR)",
        },
        sunIntensity: {
            label: "Intensité du soleil",
            tooltip: "Intensité de la lumière du soleil. 0 = pas de soleil, 1 = plein soleil normal, 2 = double soleil",
        },
        sunScattering: {
            label: "Diffusion du soleil",
            tooltip: "Quantité de diffusion de la lumière du soleil",
        },
        sunBoost: {
            label: "Amplification soleil (HDR)",
            tooltip: "Multiplicateur pour l'intensité de la DirectionalLight du soleil (HDR). Augmente la luminosité des reflets spéculaires pour des réflexions solaires réalistes à travers le brouillard.",
        },
        sceneExposure: {
            label: "Exposition de la scène (HDR)",
            tooltip: "Compensation d'exposition pour le mappage de tons HDR. Diminuer pour compenser une amplification soleil plus élevée.",
        },
        ambientOnly: {
            label: "Ambiant uniquement",
            tooltip: "Si vrai, seule la lumière ambiante est utilisée, pas de lumière du soleil",
        },
        daylightSky: {
            label: "Ciel diurne",
            tooltip: "Affiche le ciel diurne (bleu).\nDésactiver pour supprimer la contribution du ciel diurne — utile pour voir les étoiles en journée ou pour déboguer les objets du ciel nocturne.",
        },
        noMainLighting: {
            label: "Pas d'éclairage dans la vue principale",
            tooltip: "Si vrai, aucun éclairage n'est utilisé dans la vue principale.\nUtile pour le débogage, mais non recommandé pour une utilisation normale",
        },
        noCityLights: {
            label: "Pas de lumières des villes sur le globe",
            tooltip: "Si vrai, ne pas afficher les lumières des villes sur le globe.",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "Replay ADSB pour cette heure et ce lieu",
            tooltip: "Générer un lien vers ADSB Exchange Replay",
        },
        googleMapsLink: {
            label: "Google Maps pour ce lieu",
            tooltip: "Créer un lien Google Maps vers la position actuelle",
        },
        inTheSkyLink: {
            label: "In-The-Sky pour cette heure et ce lieu",
            tooltip: "Créer un lien In The Sky vers la position actuelle",
        },
    },
    nodeLabels: {
        focus: "Défocalisation",
        canvasResolution: "Résolution",
        "Noise Amount": "Quantité de bruit",
        "TV In Black": "TV noir d'entrée",
        "TV In White": "TV blanc d'entrée",
        "TV Gamma": "TV gamma",
        "Tv Out Black": "TV noir de sortie",
        "Tv Out White": "TV blanc de sortie",
        "JPEG Artifacts": "Artefacts JPEG",
        pixelZoom: "Zoom pixel %",
        videoBrightness: "Luminosité",
        videoContrast: "Contraste",
        videoBlur: "Quantité de flou",
        videoSharpenAmount: "Quantité de netteté",
        videoGreyscale: "Niveaux de gris",
        videoHue: "Décalage de teinte",
        videoInvert: "Inverser",
        videoSaturate: "Saturation",
        startDistanceGUI: "Distance de départ",
        targetVCGUI: "Vitesse vert. cible",
        targetSpeedGUI: "Vitesse cible",
        lockWind: "Verrouiller le vent cible sur le vent local",
        jetTAS: "TAS",
        turnRate: "Taux de virage",
        totalTurn: "Virage total",
        jetHeadingManual: "Cap de l'avion",
        headingSmooth: "Lissage du cap",
        turnRateControl: "Contrôle du taux de virage",
        cameraSmoothWindow: "Fenêtre de lissage caméra",
        targetSmoothWindow: "Fenêtre de lissage cible",
        cameraFOV: "FOV caméra",
        "Tgt Start Dist": "Distance initiale cible",
        "Target Speed": "Vitesse cible",
        "Tgt Relative Heading": "Cap relatif cible",
        "KF Process": "KF processus",
        "KF Noise": "KF bruit",
        "MC Num Trials": "MC nombre d'essais",
        "MC LOS Uncertainty (deg)": "MC incertitude LOS (deg)",
        "MC Polynomial Order": "MC ordre polynomial",
        "Physics Max Iterations": "Physique itérations max",
        "Physics Wind Speed (kt)": "Physique vitesse du vent (kt)",
        "Physics Wind From (°)": "Physique vent depuis (°)",
        "Physics Initial Range (m)": "Physique distance initiale (m)",
        "Tgt Start Altitude": "Altitude initiale cible",
        "Tgt Vert Spd": "Vitesse vert. cible",
        "Cloud Altitude": "Altitude des nuages",
    },
};

export default fr;