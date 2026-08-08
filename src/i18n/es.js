const es = {
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "Selección de sitches y herramientas heredadas\nAlgunos sitches heredados tienen controles aquí por defecto",
            noTooltip: "No hay descripción emergente definida para este sitch",
            legacySitches: {
                label: "Sitches heredados",
                tooltip: "Los sitches heredados son sitches antiguos integrados (codificados) que son situaciones predefinidas con código y recursos específicos. Seleccione uno para cargarlo.",
            },
            legacyTools: {
                label: "Herramientas heredadas",
                tooltip: "Las herramientas son sitches especiales utilizados para configuraciones personalizadas como Starlink o con pistas de usuario, y para pruebas, depuración u otros propósitos especiales. Seleccione una para cargarla.",
            },
            selectPlaceholder: "-Seleccionar-",
        },
        file: {
            title: "Archivo",
            tooltip: "Operaciones de archivo como guardar, cargar y exportar",
        },
        view: {
            title: "Vista",
            tooltip: "Controles de vista diversos\nComo todos los menús, este puede arrastrarse fuera de la barra para convertirse en una ventana flotante",
        },
        video: {
            title: "Vídeo",
            tooltip: "Ajustes, efectos y análisis de vídeo",
        },
        time: {
            title: "Tiempo",
            tooltip: "Controles de tiempo y fotogramas\nArrastrar un control deslizante de tiempo más allá del final afectará al control superior\nTenga en cuenta que los controles de tiempo están en UTC",
        },
        objects: {
            title: "Objetos",
            tooltip: "Objetos 3D y sus propiedades\nCada carpeta corresponde a un objeto. El objeto de travesía es el que recorre las líneas de visión, es decir, el UAP que nos interesa",
            addObject: {
                label: "Añadir objeto",
                tooltip: "Crear un nuevo objeto en las coordenadas especificadas",
                prompt: "Introduzca: [Nombre] Lat Lon [Alt]\nEjemplos:\n  MiObjeto 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Referencia 37.7749 -122.4194",
                invalidInput: "Entrada no válida. Introduzca las coordenadas en el formato:\n[Nombre] Lat Lon [Alt]",
            },
        },
        satellites: {
            title: "Satélites",
            tooltip: "Carga y control de satélites\nLos satélites.\nStarlink, ISS, etc. Controles para destellos en el horizonte y otros efectos de satélites",
        },
        terrain: {
            title: "Terreno",
            tooltip: "Controles del terreno\nEl terreno es el modelo 3D del suelo. El mapa es la imagen 2D del suelo. La elevación es la altura del suelo sobre el nivel del mar",
        },
        physics: {
            title: "Física",
            tooltip: "Controles de física\nLa física de la situación, como la velocidad del viento y la física del objeto de travesía",
        },
        camera: {
            title: "Cámara",
            tooltip: "Controles de la cámara de la vista look\nLa vista look está por defecto en la ventana inferior derecha y debe coincidir con el vídeo.",
        },
        target: {
            title: "Objetivo",
            tooltip: "Controles del objetivo\nPosición y propiedades del objeto objetivo opcional",
        },
        traverse: {
            title: "Travesía",
            tooltip: "Controles de travesía\nEl objeto de travesía es el que recorre las líneas de visión, es decir, el UAP que nos interesa\nEste menú define cómo se mueve y se comporta el objeto de travesía",
        },
        showHide: {
            title: "Mostrar/Ocultar",
            tooltip: "Mostrar u ocultar vistas, objetos y otros elementos",
            views: {
                title: "Vistas",
                tooltip: "Mostrar u ocultar vistas (ventanas) como la vista look, el vídeo, la vista principal, así como superposiciones como el MQ9UI",
            },
            graphs: {
                title: "Gráficos",
                tooltip: "Mostrar u ocultar varios gráficos",
            },
        },
        effects: {
            title: "Efectos",
            tooltip: "Efectos especiales como desenfoque, pixelación y ajustes de color aplicados a la imagen final en la vista look",
        },
        lighting: {
            title: "Iluminación",
            tooltip: "La iluminación de la escena, como el sol y la luz ambiental",
        },
        contents: {
            title: "Contenido",
            tooltip: "El contenido de la escena, usado principalmente para pistas",
        },
        help: {
            title: "Ayuda",
            tooltip: "Enlaces a la documentación y otros recursos de ayuda",
            whatsNew: "Novedades",
            documentation: {
                title: "Documentación",
                localTooltip: "Enlaces a la documentación (local)",
                githubTooltip: "Enlaces a la documentación en GitHub",
                githubLinkLabel: "{{name}} (GitHub)",
                about: "Acerca de Sitrec",
                whatsNew: "Novedades",
                whatsNewDetails: "Novedades (Detalles)",
                uiBasics: "Conceptos básicos de la interfaz",
                savingLoading: "Guardar y cargar sitches",
                customSitch: "Cómo configurar un sitch",
                tracks: "Pistas y fuentes de datos",
                gis: "SIG y cartografía",
                starlink: "Cómo investigar destellos Starlink",
                customModels: "Objetos y modelos 3D (aviones)",
                cameraModes: "Modos de cámara (normal y satélite)",
                thirdPartyNotices: "Avisos de terceros",
                thirdPartyNoticesTooltip: "Atribuciones de licencias de código abierto para software de terceros incluido",
                downloadBridge: "Descargar MCP Bridge",
                downloadBridgeTooltip: "Descargar el servidor MCP SitrecBridge + extensión de Chrome (sin dependencias, solo necesita Node.js)",
            },
            externalLinks: {
                title: "Enlaces externos",
                tooltip: "Enlaces de ayuda externos",
            },
            exportDebugLog: {
                label: "Exportar registro de depuración",
                tooltip: "Descargar toda la salida de consola (log, warn, error) como archivo de texto para depuración",
            },
        },
        debug: {
            title: "Depuración",
            tooltip: "Herramientas de depuración y monitorización\nUso de memoria GPU, métricas de rendimiento y otra información de depuración",
        },
    },
    file: {
        newSitch: {
            label: "Nuevo sitch",
            tooltip: "Crear un nuevo sitch (recargará esta página, restableciendo todo)",
        },
        savingDisabled: "Guardado desactivado (haga clic para iniciar sesión)",
        importFile: {
            label: "Importar archivo",
            tooltip: "Importar uno o varios archivos desde su sistema. Igual que arrastrar y soltar un archivo en la ventana del navegador",
        },
        server: {
            open: "Abrir",
            save: {
                label: "Guardar",
                tooltip: "Guardar el sitch actual en el servidor",
            },
            saveAs: {
                label: "Guardar como",
                tooltip: "Guardar el sitch actual en el servidor con un nuevo nombre",
            },
            versions: {
                label: "Versiones",
                tooltip: "Cargar una versión específica del sitch seleccionado",
            },
            browseFeatured: "Explorar sitches destacados",
            browseAll: "Explorar todos sus sitches guardados en una lista buscable y ordenable",
        },
        local: {
            title: "Local",
            titleWithFolder: "Local: {{name}}",
            titleReconnect: "Local: {{name}} (reconectar)",
            status: "Estado",
            noFileSelected: "Ningún archivo local seleccionado",
            noFolderSelected: "Ninguna carpeta seleccionada",
            currentFile: "Archivo actual: {{name}}",
            statusDesktop: "Estado actual del archivo/guardado local",
            statusFolder: "Estado actual de la carpeta/guardado local",
            stateReady: "Listo",
            stateReconnect: "Necesita reconexión",
            stateNoFolder: "Sin carpeta",
            statusLine: "{{state}} | Carpeta: {{folder}} | Destino: {{target}}",
            saveLocal: {
                label: "Guardar local",
                tooltipDesktop: "Guardar en el archivo local actual, o solicitar un nombre de archivo si es necesario",
                tooltipFolder: "Guardar en la carpeta de trabajo (o solicitar ubicación si no hay ninguna definida)",
                tooltipSaveBack: "Guardar en {{name}}",
                tooltipSaveBackInFolder: "Guardar en {{name}} en {{folder}}",
                tooltipSaveInto: "Guardar en {{folder}} (solicita el nombre del sitch)",
                tooltipPrompt: "Guardar un archivo sitch local (solicita nombre/ubicación)",
                tooltipSaveTo: "Guardar el sitch actual en un archivo local",
            },
            saveLocalAs: {
                label: "Guardar local como...",
                tooltipDesktop: "Guardar un archivo sitch local en una nueva ruta",
                tooltipFolder: "Guardar un archivo sitch local eligiendo la ubicación",
                tooltipInFolder: "Guardar con un nuevo nombre en la carpeta de trabajo actual",
                tooltipNewPath: "Guardar el sitch actual en una nueva ruta local",
            },
            openLocal: {
                label: "Abrir sitch local",
                labelShort: "Abrir local...",
                tooltipDesktop: "Abrir un archivo sitch local desde el disco",
                tooltipFolder: "Abrir un archivo sitch desde la carpeta de trabajo actual",
                tooltipCurrent: "Abrir otro archivo sitch local (actual: {{name}})",
                tooltipFromFolder: "Abrir un archivo sitch desde {{folder}}",
            },
            selectFolder: {
                label: "Seleccionar carpeta de sitches locales",
                tooltip: "Seleccionar una carpeta de trabajo para operaciones de guardado/carga locales",
            },
            reconnectFolder: {
                label: "Reconectar carpeta",
                tooltip: "Volver a conceder acceso a la carpeta de trabajo usada anteriormente",
            },
        },
        debug: {
            recalculateAll: "debug recalcular todo",
            dumpNodes: "debug listar nodos",
            dumpNodesBackwards: "debug listar nodos en reversa",
            dumpRoots: "debug listar nodos raíz",
        },
    },
    videoExport: {
        notAvailable: "Exportación de vídeo no disponible",
        folder: {
            title: "Renderizado y exportación de vídeo",
            tooltip: "Opciones para renderizar y exportar archivos de vídeo desde las vistas de Sitrec o la ventana completa",
        },
        renderView: {
            label: "Vista de renderizado de vídeo",
            tooltip: "Seleccionar qué vista exportar como vídeo",
        },
        renderSingleVideo: {
            label: "Renderizar vídeo de vista única",
            tooltip: "Exportar la vista seleccionada como archivo de vídeo con todos los fotogramas",
        },
        videoFormat: {
            label: "Formato de vídeo",
            tooltip: "Seleccionar el formato de salida de vídeo",
        },
        renderViewport: {
            label: "Renderizar vídeo de ventana",
            tooltip: "Exportar toda la ventana como archivo de vídeo con todos los fotogramas",
        },
        renderFullscreen: {
            label: "Renderizar vídeo a pantalla completa",
            tooltip: "Exportar toda la ventana en modo pantalla completa como archivo de vídeo",
        },
        recordWindow: {
            label: "Grabar ventana del navegador",
            tooltip: "Grabar toda la ventana del navegador (incluyendo menús e interfaz) como vídeo a velocidad fija",
        },
        retinaExport: {
            label: "Exportación HD/Retina",
            tooltip: "Exportar a resolución Retina/HiDPI (2x en la mayoría de pantallas)",
        },
        includeAudio: {
            label: "Incluir audio",
            tooltip: "Incluir la pista de audio del vídeo fuente si está disponible",
        },
        waitForLoading: {
            label: "Esperar carga en segundo plano",
            tooltip: "Cuando está activado, el renderizado espera a que se carguen terreno/edificios/fondo antes de capturar cada fotograma",
        },
        exportFrame: {
            label: "Exportar fotograma de vídeo",
            tooltip: "Exportar el fotograma de vídeo actual tal como se muestra (con efectos) como archivo PNG",
        },
    },
    tracking: {
        enable: {
            label: "Activar seguimiento automático",
            disableLabel: "Desactivar seguimiento automático",
            tooltip: "Mostrar/ocultar el cursor de seguimiento automático en el vídeo",
        },
        start: {
            label: "Iniciar seguimiento automático",
            stopLabel: "Detener seguimiento automático",
            tooltip: "Seguir automáticamente el objeto dentro del cursor durante la reproducción",
        },
        clearFromHere: {
            label: "Borrar desde aquí",
            tooltip: "Borrar todas las posiciones rastreadas desde el fotograma actual hasta el final",
        },
        clearTrack: {
            label: "Borrar pista",
            tooltip: "Borrar todas las posiciones rastreadas y empezar de nuevo",
        },
        stabilize: {
            label: "Estabilizar",
            tooltip: "Aplicar posiciones rastreadas para estabilizar el vídeo",
        },
        stabilizeToggle: {
            enableLabel: "Activar estabilización",
            disableLabel: "Desactivar estabilización",
            tooltip: "Activar/desactivar la estabilización de vídeo",
        },
        stabilizeCenters: {
            label: "Centrar estabilización",
            tooltip: "Cuando está marcado, el punto estabilizado queda fijo en el centro. Si no, permanece en su posición inicial.",
        },
        renderStabilized: {
            label: "Renderizar vídeo estabilizado",
            tooltip: "Exportar vídeo estabilizado a tamaño original (el punto rastreado queda fijo, bordes negros posibles)",
        },
        renderStabilizedExpanded: {
            label: "Renderizar estabilizado expandido",
            tooltip: "Exportar vídeo estabilizado con lienzo ampliado para no perder píxeles",
        },
        trackRadius: {
            label: "Radio de seguimiento",
            tooltip: "Tamaño de la plantilla a buscar (tamaño del objeto)",
        },
        searchRadius: {
            label: "Radio de búsqueda",
            tooltip: "Distancia de búsqueda desde la posición anterior (aumentar para movimientos rápidos)",
        },
        trackingMethod: {
            label: "Método de seguimiento",
            tooltip: "Coincidencia de plantilla (OpenCV) o flujo óptico (jsfeat Lucas-Kanade)",
        },
        centerOnBright: {
            label: "Centrar en píxeles brillantes",
            tooltip: "Seguir el centroide de píxeles brillantes (mejor para estrellas/luces puntuales)",
        },
        centerOnDark: {
            label: "Centrar en píxeles oscuros",
            tooltip: "Seguir el centroide de píxeles oscuros",
        },
        brightnessThreshold: {
            label: "Umbral de brillo",
            tooltip: "Umbral de brillo (0-255). Usado en los modos centrar en brillante/oscuro",
        },
        status: {
            loadingJsfeat: "Cargando jsfeat...",
            loadingOpenCv: "Cargando OpenCV...",
            sam2Connecting: "SAM2: Conectando...",
            sam2Uploading: "SAM2: Subiendo...",
        },
    },
    trackManager: {
        removeTrack: "Eliminar pista",
        createSpline: "Crear spline",
        editTrack: "Editar pista",
        constantSpeed: "Velocidad constante",
        extrapolateTrack: "Extrapolar pista",
        curveType: "Tipo de curva",
        altLockAGL: "Bloqueo alt. AGL",
        deleteTrack: "Eliminar pista",
    },
    gpuMonitor: {
        enabled: "Monitor activado",
        total: "Memoria total",
        geometries: "Geometrías",
        textures: "Texturas",
        peak: "Memoria máxima",
        average: "Memoria promedio",
        reset: "Restablecer historial",
    },
    situationSetup: {
        mainFov: {
            label: "FOV principal",
            tooltip: "Campo de visión de la cámara de la vista principal (VERTICAL)",
        },
        lookCameraFov: "FOV cámara look",
        azimuth: "acimut",
        jetPitch: "Cabeceo del avión",
    },
    featureManager: {
        labelText: "Texto de etiqueta",
        latitude: "Latitud",
        longitude: "Longitud",
        altitude: "Altitud (m)",
        arrowLength: "Longitud de la flecha",
        arrowColor: "Color de la flecha",
        textColor: "Color del texto",
        deleteFeature: "Eliminar característica",
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "Exportar panorama look",
            tooltip: "Crear una imagen panorámica desde la vista look a través de todos los fotogramas según la posición del fondo",
        },
    },
    dateTime: {
        liveMode: {
            label: "Modo en vivo",
            tooltip: "Si el modo en vivo está activado, la reproducción siempre estará sincronizada con la hora actual.\nPausar o desplazar el tiempo desactivará el modo en vivo",
        },
        startTime: {
            tooltip: "La hora de INICIO del primer fotograma del vídeo, en formato UTC",
        },
        currentTime: {
            tooltip: "La hora ACTUAL del vídeo. Es a lo que se refieren la fecha y hora siguientes",
        },
        year: { label: "Año", tooltip: "Año del fotograma actual" },
        month: { label: "Mes", tooltip: "Mes (1-12)" },
        day: { label: "Día", tooltip: "Día del mes" },
        hour: { label: "Hora", tooltip: "Hora (0-23)" },
        minute: { label: "Minuto", tooltip: "Minuto (0-59)" },
        second: { label: "Segundo", tooltip: "Segundo (0-59)" },
        millisecond: { label: "ms", tooltip: "Milisegundo (0-999)" },
        useTimeZone: {
            label: "Usar zona horaria en la interfaz",
            tooltip: "Usar la zona horaria en la interfaz superior\nEsto cambiará la fecha y hora a la zona horaria seleccionada, en lugar de UTC.\nÚtil para mostrar la fecha y hora en una zona horaria específica.",
        },
        timeZone: {
            label: "Zona horaria",
            tooltip: "La zona horaria para mostrar la fecha y hora en la vista look\nTambién en la interfaz si 'Usar zona horaria' está marcado",
        },
        simSpeed: {
            label: "Velocidad de simulación",
            tooltip: "La velocidad de la simulación, 1 es tiempo real, 2 es el doble de rápido, etc.\nEsto no cambia la velocidad de reproducción del vídeo, solo los cálculos de tiempo para la simulación.",
        },
        sitchFrames: {
            label: "Fotogramas del sitch",
            tooltip: "El número de fotogramas en el sitch. Si hay un vídeo, será el número de fotogramas del vídeo, pero puede cambiarlo si desea añadir más fotogramas o usar el sitch sin vídeo",
        },
        sitchDuration: {
            label: "Duración del sitch",
            tooltip: "Duración del sitch en formato HH:MM:SS.sss",
        },
        aFrame: {
            label: "Fotograma A",
            tooltip: "Limitar la reproducción entre A y B, mostrados en verde y rojo en el deslizador de fotogramas",
        },
        bFrame: {
            label: "Fotograma B",
            tooltip: "Limitar la reproducción entre A y B, mostrados en verde y rojo en el deslizador de fotogramas",
        },
        videoFps: {
            label: "FPS de vídeo",
            tooltip: "Los fotogramas por segundo del vídeo. Esto cambiará la velocidad de reproducción (ej: 30 fps, 25 fps, etc). También cambiará la duración del sitch ya que modifica la duración de un fotograma individual\nDerivado del vídeo cuando es posible, pero modificable",
        },
        syncTimeTo: {
            label: "Sincronizar tiempo con",
            tooltip: "Sincronizar la hora de inicio del vídeo con la hora de inicio original, la hora actual, o la hora de inicio de una pista (si está cargada)",
        },
    },
    jet: {
        frames: {
            time: {
                label: "Tiempo (seg)",
                tooltip: "Tiempo actual desde el inicio del vídeo en segundos (fotograma / fps)",
            },
            frame: {
                label: "Fotograma en vídeo",
                tooltip: "Número del fotograma actual en el vídeo",
            },
            paused: {
                label: "Pausa",
                tooltip: "Alternar el estado de pausa (también barra espaciadora)",
            },
        },
        controls: {
            pingPong: "Ping-pong A-B",
            podPitchPhysical: "Cabeceo del pod (bola)",
            podRollPhysical: "Alabeo de la cabeza del pod",
            deroFromGlare: "Derotación = ángulo de destello",
            jetPitch: "Cabeceo del avión",
            lookFov: "Campo de visión estrecho",
            elevation: "elevación",
            glareStartAngle: "Ángulo inicial de destello",
            initialGlareRotation: "Rotación inicial de destello",
            scaleJetPitch: "Escalar cabeceo con alabeo",
            horizonMethod: "Método de horizonte",
            horizonMethodOptions: {
                humanHorizon: "Horizonte humano",
                horizonAngle: "Ángulo de horizonte",
            },
            videoSpeed: "Velocidad de vídeo",
            podWireframe: "Pod en malla de alambre [B]ack",
            showVideo: "[V]ídeo",
            showGraph: "[G]ráfico",
            showKeyboardShortcuts: "Atajos de [K]teclado",
            showPodHead: "Alabeo de cabeza del [P]od",
            showPodsEye: "Vistas del [E]ojo del pod con derotación",
            showLookCam: "Vista [N]AR con derotación",
            showCueData: "Datos de [C]objetivo",
            showGlareGraph: "Mostrar gráfico de destello [o]",
            showAzGraph: "Mostrar gráfico A[Z]",
            declutter: "[D]espejar",
            jetOffset: "Desplazamiento Y del avión",
            tas: "TAS velocidad real",
            integrate: "Pasos de integración",
        },
    },
    motionAnalysis: {
        menu: {
            title: "Análisis de movimiento",
            analyzeMotion: {
                label: "Analizar movimiento",
                tooltip: "Activar la superposición de análisis de movimiento en tiempo real sobre el vídeo",
            },
            createTrack: {
                label: "Crear pista a partir del movimiento",
                tooltip: "Analizar todos los fotogramas y crear una pista terrestre a partir de vectores de movimiento",
            },
            alignWithFlow: {
                label: "Alinear con el flujo",
                tooltip: "Rotar la imagen para que la dirección del movimiento sea horizontal",
            },
            panorama: {
                title: "Panorama",
                exportImage: {
                    label: "Exportar panorama de movimiento",
                    tooltip: "Crear una imagen panorámica a partir de fotogramas de vídeo usando desplazamientos de seguimiento de movimiento",
                },
                exportVideo: {
                    label: "Exportar vídeo panorámico",
                    tooltip: "Crear un vídeo 4K mostrando el panorama con superposición del fotograma de vídeo",
                },
                stabilize: {
                    label: "Estabilizar vídeo",
                    disableLabel: "Desactivar estabilización",
                    tooltip: "Estabilizar vídeo usando análisis global de movimiento (elimina temblor de cámara)",
                },
                panoFrameStep: {
                    label: "Paso de fotograma del panorama",
                    tooltip: "Cuántos fotogramas saltar entre cada fotograma del panorama (1 = cada fotograma)",
                },
                crop: {
                    label: "Recorte del panorama",
                    tooltip: "Píxeles a recortar de cada borde de los fotogramas de vídeo",
                },
                useMask: {
                    label: "Usar máscara en panorama",
                    tooltip: "Aplicar la máscara de seguimiento de movimiento como transparencia al renderizar el panorama",
                },
                analyzeWithEffects: {
                    label: "Analizar con efectos",
                    tooltip: "Aplicar ajustes de vídeo (contraste, etc.) a los fotogramas usados para el análisis de movimiento",
                },
                exportWithEffects: {
                    label: "Exportar con efectos",
                    tooltip: "Aplicar ajustes de vídeo a las exportaciones del panorama",
                },
                removeOuterBlack: {
                    label: "Eliminar negro exterior",
                    tooltip: "Hacer transparentes los píxeles negros en los bordes de cada fila",
                },
            },
            trackingParameters: {
                title: "Parámetros de seguimiento",
                technique: {
                    label: "Técnica",
                    tooltip: "Algoritmo de estimación de movimiento",
                },
                frameSkip: {
                    label: "Salto de fotogramas",
                    tooltip: "Fotogramas entre comparaciones (mayor = detectar movimiento más lento)",
                },
                trackletLength: {
                    label: "Longitud del tracklet",
                    tooltip: "Número de fotogramas en el tracklet (más largo = coherencia más estricta)",
                },
                blurSize: {
                    label: "Tamaño de desenfoque",
                    tooltip: "Desenfoque gaussiano para macro características (números impares)",
                },
                minMotion: {
                    label: "Movimiento mín.",
                    tooltip: "Magnitud mínima de movimiento (píxeles/fotograma)",
                },
                maxMotion: {
                    label: "Movimiento máx.",
                    tooltip: "Magnitud máxima de movimiento",
                },
                smoothing: {
                    label: "Suavizado",
                    tooltip: "Suavizado de dirección (mayor = más suavizado)",
                },
                minVectorCount: {
                    label: "Número mín. de vectores",
                    tooltip: "Número mínimo de vectores de movimiento para un fotograma válido",
                },
                minConfidence: {
                    label: "Confianza mínima",
                    tooltip: "Confianza mínima del consenso para un fotograma válido",
                },
                maxFeatures: {
                    label: "Características máx.",
                    tooltip: "Número máximo de características rastreadas",
                },
                minDistance: {
                    label: "Distancia mínima",
                    tooltip: "Distancia mínima entre características",
                },
                qualityLevel: {
                    label: "Nivel de calidad",
                    tooltip: "Umbral de calidad de detección de características",
                },
                maxTrackError: {
                    label: "Error de seguimiento máx.",
                    tooltip: "Umbral máximo de error de seguimiento",
                },
                minQuality: {
                    label: "Calidad mínima",
                    tooltip: "Calidad mínima para mostrar la flecha",
                },
                staticThreshold: {
                    label: "Umbral estático",
                    tooltip: "Un movimiento inferior a este valor se considera estático (HUD)",
                },
            },
        },
        status: {
            loadingOpenCv: "Cargando OpenCV...",
            stopAnalysis: "Detener análisis",
            analyzingPercent: "Analizando... {{pct}}%",
            creatingTrack: "Creando pista...",
            buildingPanorama: "Construyendo panorama...",
            buildingPanoramaPercent: "Construyendo panorama... {{pct}}%",
            loadingFrame: "Cargando fotograma {{frame}}... ({{current}}/{{total}})",
            loadingFrameSkipped: "Cargando fotograma {{frame}}... ({{current}}/{{total}}) ({{skipped}} omitidos)",
            renderingPercent: "Renderizando... {{pct}}%",
            panoPercent: "Panorama... {{pct}}%",
            renderingVideo: "Renderizando vídeo...",
            videoPercent: "Vídeo... {{pct}}%",
            saving: "Guardando...",
            buildingStabilization: "Construyendo estabilización...",
            exportProgressTitle: "Exportando vídeo panorámico...",
        },
        errors: {
            noVideoView: "No se encontró vista de vídeo.",
            noVideoData: "No se encontraron datos de vídeo.",
            failedToLoadOpenCv: "Error al cargar OpenCV: {{message}}",
            noOriginTrack: "No se encontró pista de origen. Se necesita una pista de objetivo o de cámara para determinar la posición inicial.",
            videoEncodingUnsupported: "La codificación de vídeo no es compatible con este navegador",
            exportFailed: "Error en la exportación de vídeo: {{reason}}",
            panoVideoExportFailed: "Error en la exportación del vídeo panorámico: {{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[BETA] Extracción de texto",
            enable: {
                label: "Activar extracción de texto",
                disableLabel: "Desactivar extracción de texto",
                tooltip: "Activar el modo de extracción de texto en el vídeo",
            },
            addRegion: {
                label: "Añadir región",
                drawingLabel: "Haga clic y arrastre sobre el vídeo...",
                tooltip: "Haga clic y arrastre sobre el vídeo para definir una región de extracción de texto",
            },
            removeRegion: {
                label: "Eliminar región seleccionada",
                tooltip: "Eliminar la región actualmente seleccionada",
            },
            clearRegions: {
                label: "Borrar todas las regiones",
                tooltip: "Eliminar todas las regiones de extracción de texto",
            },
            startExtract: {
                label: "Iniciar extracción",
                stopLabel: "Detener extracción",
                tooltip: "Ejecutar OCR en todas las regiones desde el fotograma actual hasta el final",
            },
            fixedWidthFont: {
                label: "Fuente de ancho fijo",
                tooltip: "Activar detección carácter por carácter para fuentes de ancho fijo (mejor para superposiciones FLIR/sensores)",
            },
            numChars: {
                label: "Número de caracteres",
                tooltip: "Número de caracteres en la región seleccionada (divide la región uniformemente)",
            },
            learnTemplates: {
                label: "Aprender plantillas",
                activeLabel: "Haga clic en los caracteres para aprender...",
                tooltip: "Haga clic en las celdas de caracteres para enseñar sus valores (para coincidencia de plantillas)",
            },
            clearTemplates: {
                label: "Borrar plantillas",
                tooltip: "Eliminar todas las plantillas de caracteres aprendidas",
            },
            useTemplates: {
                label: "Usar plantillas",
                tooltip: "Usar plantillas aprendidas para la coincidencia (más rápido y preciso una vez entrenado)",
            },
        },
        prompts: {
            learnCharacter: "Introduzca el carácter para la celda {{index}}:",
        },
        errors: {
            failedToLoadTesseract: "Error al cargar Tesseract.js. Asegúrese de que está instalado: npm install tesseract.js",
            noVideoView: "La extracción de texto requiere una vista de vídeo",
        },
    },
    custom: {
        settings: {
            title: "Configuración",
            tooltipLoggedIn: "Configuración por usuario guardada en el servidor (con respaldo por cookie)",
            tooltipAnonymous: "Configuración por usuario guardada en cookies del navegador",
            language: { label: "Idioma", tooltip: "Seleccionar idioma de la interfaz. Cambiar recarga la página. Perderá todo trabajo no guardado, ¡guarde primero!" },
            maxDetails: { label: "Detalles máx.", tooltip: "Nivel máximo de detalle para la subdivisión del terreno (5-30)" },
            fpsLimit: { label: "Límite de FPS", tooltip: "Establecer la tasa máxima de fotogramas (60, 30, 20 o 15 fps)" },
            tileSegments: { label: "Segmentos de tesela", tooltip: "Resolución de malla para teselas de terreno. Mayor = más detalle pero más lento" },
            maxResolution: { label: "Resolución máx.", tooltip: "Resolución máxima del fotograma de vídeo (lado más largo). Reduce el uso de memoria GPU. Se aplica a los nuevos fotogramas cargados." },
            aiModel: { label: "Modelo de IA", tooltip: "Seleccionar el modelo de IA para el asistente de chat" },
            centerSidebar: { label: "Barra lateral central", tooltip: "Activar barra lateral central entre vistas divididas (arrastrar menús a la línea divisora)" },
            showAttribution: { label: "Mostrar atribución", tooltip: "Mostrar superposición de atribución de fuentes de mapa y elevación" },
        },
        balloons: {
            count: { label: "Cantidad", tooltip: "Cantidad de estaciones cercanas a importar" },
            source: { label: "Fuente", tooltip: "uwyo = University of Wyoming (necesita proxy PHP)\nigra2 = Archivo NOAA NCEI (descarga directa)" },
            getNearby: { label: "Obtener globos sonda cercanos", tooltip: "Importar los N sondeos de globos meteorológicos más cercanos a la posición actual de la cámara.\nUsa el lanzamiento más reciente antes de la hora de inicio del sitch + 1 hora." },
            importSounding: { label: "Importar sondeo...", tooltip: "Selector manual de estación: elija estación, fecha, fuente e importe un sondeo específico." },
        },
        showHide: {
            keyboardShortcuts: { label: "Atajos de [K]teclado", tooltip: "Mostrar u ocultar la superposición de atajos de teclado" },
            toggleExtendToGround: { label: "Alternar TODOS [E]xtender al suelo", tooltip: "Alternar 'Extender al suelo' para todas las pistas\nDesactivará todas si alguna está activada\nActivará todas si ninguna está activada" },
            showAllTracksInLook: { label: "Mostrar todas las pistas en la vista look", tooltip: "Mostrar todas las pistas de aeronaves en la vista look/cámara" },
            showCompassElevation: { label: "Mostrar elevación de brújula", tooltip: "Mostrar la elevación de la brújula (ángulo sobre el plano del suelo local) además del rumbo (acimut)" },
            filterTracks: { label: "Filtrar pistas", tooltip: "Mostrar/ocultar pistas según altitud, dirección o intersección con el frustum" },
            removeAllTracks: { label: "Eliminar todas las pistas", tooltip: "Eliminar todas las pistas de la escena\nEsto no eliminará los objetos, solo las pistas\nPuede volver a añadirlas arrastrando y soltando los archivos" },
        },
        objects: {
            globalScale: { label: "Escala global", tooltip: "Factor de escala aplicado a todos los objetos 3D de la escena - útil para encontrar cosas. Volver a 1 para el tamaño real" },
        },
        admin: {
            dashboard: { label: "Panel de administración", tooltip: "Abrir el panel de administración" },
            validateAllSitches: { label: "Validar todos los sitches", tooltip: "Cargar todos los sitches guardados con terreno local para buscar errores" },
            testUserID: { label: "ID de usuario de prueba", tooltip: "Operar como este ID de usuario (0 = desactivado, debe ser > 1)" },
            addMissingScreenshots: { label: "Añadir capturas faltantes", tooltip: "Cargar cada sitch sin captura de pantalla, renderizarlo y subir una captura" },
            feature: { label: "Destacar", tooltip: "Alternar el estado de destacado para el sitch cargado actualmente" },
        },
        viewPreset: { label: "Preajuste de vista", tooltip: "Cambiar entre diferentes preajustes de vista\nLado a lado, arriba y abajo, etc." },
        subSitches: {
            folder: { tooltip: "Gestionar múltiples configuraciones de cámara/vista dentro de este sitch" },
            updateCurrent: { label: "Actualizar sub actual", tooltip: "Actualizar el sub sitch seleccionado con la configuración de vista actual" },
            updateAndAddNew: { label: "Actualizar actual y añadir nuevo sub", tooltip: "Actualizar el sub sitch actual, luego duplicarlo en un nuevo sub sitch" },
            discardAndAddNew: { label: "Descartar cambios y añadir nuevo", tooltip: "Descartar cambios del sub sitch actual y crear un nuevo sub sitch desde el estado actual" },
            renameCurrent: { label: "Renombrar sub actual", tooltip: "Renombrar el sub sitch seleccionado actualmente" },
            deleteCurrent: { label: "Eliminar sub actual", tooltip: "Eliminar el sub sitch seleccionado actualmente" },
            syncSaveDetails: { label: "Sincronizar detalles de guardado", tooltip: "Eliminar del sub actual los nodos no habilitados en los detalles de guardado" },
        },
        contextMenu: {
            setCameraAbove: "Colocar cámara arriba",
            setCameraOnGround: "Colocar cámara en el suelo",
            setTargetAbove: "Colocar objetivo arriba",
            setTargetOnGround: "Colocar objetivo en el suelo",
            dropPin: "Fijar pin / Añadir característica",
            createTrackWithObject: "Crear pista con objeto",
            createTrackNoObject: "Crear pista (sin objeto)",
            addBuilding: "Añadir edificio",
            addClouds: "Añadir nubes",
            addGroundOverlay: "Añadir superposición terrestre",
            centerTerrain: "Centrar cuadro de terreno aquí",
            googleMapsHere: "Google Maps aquí",
            googleEarthHere: "Google Earth aquí",
            removeClosestPoint: "Eliminar punto más cercano",
            exitEditMode: "Salir del modo edición",
        },
    },
    view3d: {
        northUp: { label: "Vista look norte arriba", tooltip: "La vista look se orienta con el norte arriba, en lugar del mundo arriba.\nPara vistas de satélite y similares, mirando directamente hacia abajo.\nNo se aplica en modo PTZ" },
        atmosphere: { label: "Atmósfera", tooltip: "Atenuación por distancia que mezcla el terreno y los objetos 3D hacia el color del cielo actual" },
        atmoVisibility: { label: "Visibilidad atmo (km)", tooltip: "Distancia donde el contraste atmosférico cae a aproximadamente 50% (más pequeño = atmósfera más densa)" },
        atmoHDR: { label: "Atmo HDR", tooltip: "Niebla/tone mapping HDR físicamente realista para reflejos solares a través de la bruma" },
        atmoExposure: { label: "Exposición atmo", tooltip: "Multiplicador de exposición de tone mapping HDR para suavizado de luces altas" },
        startXR: { label: "Iniciar VR/XR", tooltip: "Iniciar sesión WebXR para pruebas (funciona con Immersive Web Emulator)" },
        effects: { label: "Efectos", tooltip: "Activar/desactivar todos los efectos" },
        focusTrack: { label: "Pista de enfoque", tooltip: "Seleccionar una pista para que la cámara la mire y gire a su alrededor" },
        lockTrack: { label: "Bloquear en pista", tooltip: "Seleccionar una pista para bloquear la cámara en ella, de modo que se mueva con la pista" },
        debug: {
            clearBackground: "Limpiar fondo", renderSky: "Renderizar cielo", renderDaySky: "Renderizar cielo diurno",
            renderMainScene: "Renderizar escena principal", renderEffects: "Renderizar efectos", copyToScreen: "Copiar a pantalla",
            updateCameraMatrices: "Actualizar matrices de cámara", mainUseLookLayers: "Principal usa capas look",
            sRGBOutputEncoding: "Codificación de salida sRGB", tileLoadDelay: "Retardo de carga de teselas (s)",
            updateStarScales: "Actualizar escalas de estrellas", updateSatelliteScales: "Actualizar escalas de satélites",
            renderNightSky: "Renderizar cielo nocturno", renderFullscreenQuad: "Renderizar quad pantalla completa", renderSunSky: "Renderizar cielo solar",
        },
        celestial: {
            raHours: "AR (horas)", decDegrees: "Dec (grados)", magnitude: "Magnitud",
            noradNumber: "Número NORAD", name: "Nombre",
        },
    },
    nightSky: {
        loadLEO: { label: "Cargar satélites LEO para la fecha", tooltip: "Obtener los últimos datos TLE de satélites LEO para la fecha/hora del simulador. Esto descargará los datos de Internet, lo que puede tardar unos segundos.\nTambién habilitará la visualización de los satélites en el cielo nocturno." },
        loadStarlink: { label: "Cargar Starlink ACTUAL", tooltip: "Obtener las posiciones ACTUALES (no históricas, ahora, en tiempo real) de los satélites Starlink. Esto descargará los datos de Internet, lo que puede tardar unos segundos.\n" },
        loadActive: { label: "Cargar satélites ACTIVOS", tooltip: "Obtener las posiciones ACTUALES (no históricas, ahora, en tiempo real) de los satélites ACTIVOS. Esto descargará los datos de Internet, lo que puede tardar unos segundos.\n" },
        loadSlow: { label: "(Experimental) Cargar satélites LENTOS", tooltip: "Obtener los últimos datos TLE de satélites LENTOS para la fecha/hora del simulador. Esto descargará los datos de Internet, lo que puede tardar unos segundos.\nTambién habilitará la visualización de los satélites en el cielo nocturno. Puede agotar el tiempo para fechas recientes" },
        loadAll: { label: "(Experimental) Cargar TODOS los satélites", tooltip: "Obtener los últimos datos TLE de TODOS los satélites para la fecha/hora del simulador. Esto descargará los datos de Internet, lo que puede tardar unos segundos.\nTambién habilitará la visualización de los satélites en el cielo nocturno. Puede agotar el tiempo para fechas recientes" },
        flareAngle: { label: "Ángulo de destello", tooltip: "Ángulo máximo del vector de vista reflejado para que un destello sea visible\nes decir, el rango de ángulos entre el vector del satélite al sol y el vector de la cámara al satélite reflejado en la parte inferior del satélite (que es paralela al suelo)" },
        penumbraDepth: { label: "Profundidad de penumbra terrestre", tooltip: "Profundidad vertical en metros durante la cual un satélite se desvanece al entrar en la sombra de la Tierra" },
        sunAngleArrows: { label: "Flechas de ángulo solar", tooltip: "Cuando se detecta un reflejo, mostrar flechas de la cámara al satélite y luego del satélite al sol" },
        celestialFolder: { tooltip: "Elementos relacionados con el cielo nocturno" },
        vectorsOnTraverse: { label: "Vectores en la trayectoria", tooltip: "Si está marcado, los vectores se muestran relativos al objeto de travesía. De lo contrario, se muestran relativos a la cámara look." },
        vectorsInLookView: { label: "Vectores en la vista look", tooltip: "Si está marcado, los vectores se muestran en la vista look. De lo contrario, solo en la vista principal." },
        showSatellitesGlobal: { label: "Mostrar satélites (global)", tooltip: "Control maestro: mostrar u ocultar todos los satélites" },
        showStarlink: { label: "Starlink", tooltip: "Mostrar satélites SpaceX Starlink" },
        showISS: { label: "ISS", tooltip: "Mostrar la Estación Espacial Internacional" },
        celestrackBrightest: { label: "Los más brillantes de Celestrack", tooltip: "Mostrar la lista de satélites más brillantes de Celestrack" },
        otherSatellites: { label: "Otros satélites", tooltip: "Mostrar satélites que no están en las categorías anteriores" },
        list: { label: "Lista", tooltip: "Mostrar una lista de texto de los satélites visibles" },
        satelliteArrows: { label: "Flechas de satélites", tooltip: "Mostrar flechas indicando las trayectorias de los satélites" },
        flareLines: { label: "Líneas de destello", tooltip: "Mostrar líneas que conectan los satélites en destello con la cámara y el Sol" },
        satelliteGroundArrows: { label: "Flechas al suelo de satélites", tooltip: "Mostrar flechas hacia el suelo debajo de cada satélite" },
        satelliteLabelsLook: { label: "Etiquetas de satélites (vista look)", tooltip: "Mostrar etiquetas con nombres de satélites en la vista look/cámara" },
        satelliteLabelsMain: { label: "Etiquetas de satélites (vista principal)", tooltip: "Mostrar etiquetas con nombres de satélites en la vista 3D principal" },
        labelFlaresOnly: { label: "Etiquetar solo destellos", tooltip: "Solo etiquetar satélites que están actualmente en destello" },
        labelLitOnly: { label: "Etiquetar solo iluminados", tooltip: "Solo etiquetar satélites iluminados por el sol (no en la sombra terrestre)" },
        labelLookVisibleOnly: { label: "Etiquetar solo visibles en look", tooltip: "Solo etiquetar satélites visibles en el frustum de la cámara look" },
        flareRegion: { label: "Región de destello", tooltip: "Mostrar la región del cielo donde los destellos de satélites son visibles" },
        flareBand: { label: "Banda de destello", tooltip: "Mostrar la banda en el suelo barrida por los destellos de una trayectoria satelital" },
        filterTLEs: { label: "Filtrar TLE", tooltip: "Filtrar satélites visibles por altitud, posición, parámetros orbitales o nombre" },
        clearTLEFilter: { label: "Borrar filtro TLE", tooltip: "Eliminar todos los filtros espaciales/orbitales TLE, restaurando la visibilidad por categoría" },
        maxLabelsDisplayed: { label: "Máx. etiquetas mostradas", tooltip: "Número máximo de etiquetas de satélites a mostrar simultáneamente" },
        starBrightness: { label: "Brillo de estrellas", tooltip: "Factor de escala del brillo de las estrellas. 1 = normal, 0 = invisible, 2 = el doble de brillante, etc." },
        starLimit: { label: "Límite de estrellas", tooltip: "Umbral de brillo para mostrar las estrellas" },
        planetBrightness: { label: "Brillo de planetas", tooltip: "Factor de escala del brillo de los planetas (excepto Sol y Luna). 1 = normal, 0 = invisible, 2 = el doble de brillante, etc." },
        lockStarPlanetBrightness: { label: "Bloquear brillo estrellas/planetas", tooltip: "Cuando está marcado, los controles de brillo de estrellas y planetas están bloqueados juntos" },
        satBrightness: { label: "Brillo de satélites", tooltip: "Factor de escala del brillo de los satélites. 1 = normal, 0 = invisible, 2 = el doble de brillante, etc." },
        flareBrightness: { label: "Brillo de destellos", tooltip: "Factor de escala del brillo adicional de los satélites en destello. 0 = nada" },
        satCutOff: { label: "Corte de satélites", tooltip: "Los satélites atenuados a este nivel o menos no se mostrarán" },
        displayRange: { label: "Rango de visualización (km)", tooltip: "Los satélites más allá de esta distancia no tendrán sus nombres ni flechas mostrados" },
        equatorialGrid: { label: "Cuadrícula ecuatorial", tooltip: "Mostrar la cuadrícula de coordenadas ecuatoriales celestes" },
        constellationLines: { label: "Líneas de constelaciones", tooltip: "Mostrar líneas que conectan las estrellas de las constelaciones" },
        renderStars: { label: "Mostrar estrellas", tooltip: "Mostrar las estrellas en el cielo nocturno" },
        equatorialGridLook: { label: "Cuadrícula ecuatorial en vista look", tooltip: "Mostrar la cuadrícula ecuatorial en la vista look/cámara" },
        flareRegionLook: { label: "Región de destello en vista look", tooltip: "Mostrar el cono de la región de destello en la vista look" },
        satelliteEphemeris: { label: "Efemérides de satélite" },
        skyPlot: { label: "Diagrama celeste" },
        celestialVector: { label: "Vector {{name}}", tooltip: "Mostrar un vector de dirección apuntando hacia {{name}}" },
    },
    synthClouds: {
        name: { label: "Nombre" },
        visible: { label: "Visible" },
        editMode: { label: "Modo edición" },
        altitude: { label: "Altitud" },
        radius: { label: "Radio" },
        cloudSize: { label: "Tamaño de nube" },
        density: { label: "Densidad" },
        opacity: { label: "Opacidad" },
        brightness: { label: "Brillo" },
        depth: { label: "Profundidad" },
        edgeWiggle: { label: "Ondulación de bordes" },
        edgeFrequency: { label: "Frecuencia de bordes" },
        seed: { label: "Semilla" },
        feather: { label: "Difuminado" },
        windMode: { label: "Modo de viento" },
        windFrom: { label: "Viento desde (°)" },
        windKnots: { label: "Viento (nudos)" },
        deleteClouds: { label: "Eliminar nubes" },
    },
    synthBuilding: {
        name: { label: "Nombre" },
        visible: { label: "Visible" },
        editMode: { label: "Modo edición" },
        roofEdgeHeight: { label: "Altura borde del techo" },
        ridgelineHeight: { label: "Altura de la cumbrera" },
        ridgelineInset: { label: "Retranqueo de cumbrera" },
        roofEaves: { label: "Alero del techo" },
        type: { label: "Tipo" },
        wallColor: { label: "Color de muros" },
        roofColor: { label: "Color del techo" },
        opacity: { label: "Opacidad" },
        transparent: { label: "Transparente" },
        wireframe: { label: "Malla de alambre" },
        depthTest: { label: "Test de profundidad" },
        deleteBuilding: { label: "Eliminar edificio" },
    },

    groundOverlay: {
        name: { label: "Nombre" },
        visible: { label: "Visible" },
        editMode: { label: "Modo edición" },
        lockShape: { label: "Bloquear forma" },
        freeTransform: { label: "Transformación libre" },
        showBorder: { label: "Mostrar borde" },
        properties: { label: "Propiedades" },
        imageURL: { label: "URL de imagen" },
        rehostLocalImage: { label: "Realojar imagen local" },
        north: { label: "Norte" },
        south: { label: "Sur" },
        east: { label: "Este" },
        west: { label: "Oeste" },
        rotation: { label: "Rotación" },
        altitude: { label: "Altitud (ft)" },
        wireframe: { label: "Malla de alambre" },
        opacity: { label: "Opacidad" },
        cloudExtraction: { label: "Extracción de nubes" },
        extractClouds: { label: "Extraer nubes" },
        cloudColor: { label: "Color de nubes" },
        fuzziness: { label: "Difuminado" },
        feather: { label: "Degradado" },
        gotoOverlay: { label: "Ir a la superposición" },
        deleteOverlay: { label: "Eliminar superposición" },
    },

    videoView: {
        folders: {
            videoAdjustments: "Ajustes de vídeo",
            videoProcessing: "Procesamiento de vídeo",
            forensics: "Análisis forense",
            errorLevelAnalysis: "Análisis de nivel de error",
            noiseAnalysis: "Análisis de ruido",
            grid: "Cuadrícula",
        },
        currentVideo: { label: "Video actual" },
        videoRotation: { label: "Rotación de video" },
        setCameraToExifGps: { label: "Posicionar cámara en GPS EXIF" },
        expandOutput: {
            label: "Expandir salida",
            tooltip: "Método para expandir el rango dinámico de la salida ELA",
        },
        displayMode: {
            label: "Modo de visualización",
            tooltip: "Cómo visualizar los resultados del análisis de ruido",
        },
        convolutionFilter: {
            label: "Filtro de convolución",
            tooltip: "Tipo de filtro de convolución espacial a aplicar",
        },
        resetVideoAdjustments: {
            label: "Restablecer ajustes de video",
            tooltip: "Restablecer todos los ajustes de video a sus valores predeterminados",
        },
        makeVideo: {
            label: "Crear video",
            tooltip: "Exportar el video procesado con todos los efectos actuales aplicados",
        },
        gridShow: {
            label: "Mostrar",
            tooltip: "Mostrar una cuadrícula superpuesta en el video",
        },
        gridSize: {
            label: "Tamaño",
            tooltip: "Tamaño de celda de la cuadrícula en píxeles",
        },
        gridSubdivisions: {
            label: "Subdivisiones",
            tooltip: "Número de subdivisiones dentro de cada celda de la cuadrícula",
        },
        gridXOffset: {
            label: "Desplazamiento X",
            tooltip: "Desplazamiento horizontal de la cuadrícula en píxeles",
        },
        gridYOffset: {
            label: "Desplazamiento Y",
            tooltip: "Desplazamiento vertical de la cuadrícula en píxeles",
        },
        gridColor: {
            label: "Color",
            tooltip: "Color de las líneas de la cuadrícula",
        },
    },

    floodSim: {
        flood: {
            label: "Inundación",
            tooltip: "Activar o desactivar la simulación de partículas de inundación",
        },
        floodRate: {
            label: "Tasa de inundación",
            tooltip: "Número de partículas generadas por fotograma",
        },
        sphereSize: {
            label: "Tamaño de esfera",
            tooltip: "Radio visual de cada partícula de agua",
        },
        dropRadius: {
            label: "Radio de caída",
            tooltip: "Radio alrededor del punto de caída donde aparecen las partículas",
        },
        maxParticles: {
            label: "Partículas máx.",
            tooltip: "Número máximo de partículas de agua activas",
        },
        method: {
            label: "Método",
            tooltip: "Método de simulación: HeightMap (cuadrícula), Fast (partículas) o PBF (fluidos basados en posición)",
        },
        waterSource: {
            label: "Fuente de agua",
            tooltip: "Rain: añadir agua con el tiempo. DamBurst: mantener el nivel de agua a la altitud objetivo dentro del radio de caída",
        },
        speed: {
            label: "Velocidad",
            tooltip: "Pasos de simulación por fotograma (1-20x)",
        },
        manningN: {
            label: "Manning's N",
            tooltip: "Rugosidad del lecho: 0.01=liso, 0.03=canal natural, 0.05=llanura de inundación rugosa, 0.1=vegetación densa",
        },
        edge: {
            label: "Borde",
            tooltip: "Blocking: el agua rebota en los bordes de la cuadrícula. Draining: el agua fluye hacia fuera y se elimina",
        },
        waterColor: {
            label: "Color del agua",
            tooltip: "Color del agua",
        },
        reset: {
            label: "Restablecer",
            tooltip: "Eliminar todas las partículas y reiniciar la simulación",
        },
    },

    flowOrbs: {
        number: {
            label: "Número",
            tooltip: "Número de orbes de flujo a mostrar. Más orbes puede afectar el rendimiento.",
        },
        spreadMethod: {
            label: "Método de dispersión",
            tooltip: "Método para dispersar los orbes a lo largo del vector de visión de la cámara. \n'Range' dispersa los orbes uniformemente entre las distancias cercana y lejana. \n'Altitude' dispersa los orbes entre las altitudes absolutas baja y alta (MSL)",
        },
        near: {
            label: "Cerca (m)",
            tooltip: "Distancia más cercana de la cámara para la colocación de orbes",
        },
        far: {
            label: "Lejos (m)",
            tooltip: "Distancia más lejana de la cámara para la colocación de orbes",
        },
        high: { label: "Alto (m)" },
        low: { label: "Bajo (m)" },
        colorMethod: {
            label: "Método de color",
            tooltip: "Método para determinar el color de los orbes de flujo. \n'Random' asigna un color aleatorio a cada orbe. \n'User' asigna un color seleccionado por el usuario a todos los orbes. \n'Hue From Altitude' asigna un color basado en la altitud del orbe. \n'Hue From Distance' asigna un color basado en la distancia del orbe respecto a la cámara.",
        },
        userColor: {
            label: "Color de usuario",
            tooltip: "Seleccionar un color para los orbes de flujo cuando el 'Método de color' está configurado en 'User'.",
        },
        hueRange: {
            label: "Rango de tono",
            tooltip: "Rango sobre el cual se obtiene un espectro completo de colores para el método de color 'Hue From Altitude/Range'.",
        },
        windWhilePaused: {
            label: "Viento en pausa",
            tooltip: "Si está marcado, el viento seguirá afectando a los orbes de flujo incluso cuando la simulación esté en pausa. Útil para visualizar patrones de viento.",
        },
    },

    osdController: {
        seriesName: {
            label: "Nombre",
        },
        seriesType: {
            label: "Tipo",
        },
        seriesShow: {
            label: "Mostrar",
        },
        seriesLock: {
            label: "Bloquear",
        },
        removeTrack: {
            label: "Eliminar pista",
        },
        folderTitle: {
            label: "Rastreador OSD",
            tooltip: "Rastreador de texto OSD (visualización en pantalla) para texto por fotograma definido por el usuario",
        },
        addNewTrack: {
            label: "Añadir serie de datos OSD",
            tooltip: "Crear una nueva serie de datos OSD para superposición de texto por fotograma",
        },
        makeTrack: {
            label: "Crear pista",
            tooltip: "Crear una pista de posición a partir de series de datos OSD visibles/desbloqueadas (MGRS o Lat/Lon)",
        },
        showAll: {
            label: "Mostrar todo",
            tooltip: "Alternar visibilidad de todas las series de datos OSD",
        },
        exportAllData: {
            label: "Exportar todos los datos",
            tooltip: "Exportar todas las series de datos OSD como CSV en un archivo ZIP",
        },
        graphShow: {
            label: "Mostrar",
            tooltip: "Mostrar u ocultar la vista de gráfico de datos OSD",
        },
        xAxis: {
            label: "Eje X",
            tooltip: "Serie de datos para el eje horizontal",
        },
        y1Axis: {
            label: "Eje Y1",
            tooltip: "Serie de datos para el eje vertical izquierdo",
        },
        y2Axis: {
            label: "Eje Y2",
            tooltip: "Serie de datos para el eje vertical derecho",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "Visualización de info de vídeo",
            tooltip: "Controles de visualización de info de vídeo para contador de fotogramas, timecode y marca de tiempo",
        },
        showVideoInfo: {
            label: "Mostrar info de vídeo",
            tooltip: "Interruptor principal - activar o desactivar todas las visualizaciones de info de vídeo",
        },
        frameCounter: {
            label: "Contador de fotogramas",
            tooltip: "Mostrar el número del fotograma actual",
        },
        offsetFrame: {
            label: "Fotograma con desplazamiento",
            tooltip: "Mostrar el número de fotograma actual más un valor de desplazamiento",
        },
        offsetValue: {
            label: "Valor de desplazamiento",
            tooltip: "Valor de desplazamiento añadido al número de fotograma actual",
        },
        timecode: {
            label: "Timecode",
            tooltip: "Mostrar timecode en formato HH:MM:SS:FF",
        },
        timestamp: {
            label: "Marca de tiempo",
            tooltip: "Mostrar marca de tiempo en formato HH:MM:SS.SS",
        },
        dateLocal: {
            label: "Fecha (local)",
            tooltip: "Mostrar la fecha actual en la zona horaria seleccionada",
        },
        timeLocal: {
            label: "Hora (local)",
            tooltip: "Mostrar la hora actual en la zona horaria seleccionada",
        },
        dateTimeLocal: {
            label: "Fecha y hora (local)",
            tooltip: "Mostrar fecha y hora completas en la zona horaria seleccionada",
        },
        dateUTC: {
            label: "Fecha (UTC)",
            tooltip: "Mostrar la fecha actual en UTC",
        },
        timeUTC: {
            label: "Hora (UTC)",
            tooltip: "Mostrar la hora actual en UTC",
        },
        dateTimeUTC: {
            label: "Fecha y hora (UTC)",
            tooltip: "Mostrar fecha y hora completas en UTC",
        },
        fontSize: {
            label: "Tamaño de fuente",
            tooltip: "Ajustar el tamaño de fuente del texto de información",
        },
    },

    terrainUI: {
        mapType: {
            label: "Tipo de mapa",
            tooltip: "Tipo de mapa para texturas del terreno (separado de los datos de elevación)",
        },
        elevationType: {
            label: "Tipo de elevación",
            tooltip: "Fuente de datos de elevación para las alturas del terreno",
        },
        lat: {
            tooltip: "Latitud del centro del terreno",
        },
        lon: {
            tooltip: "Longitud del centro del terreno",
        },
        zoom: {
            tooltip: "Nivel de zoom del terreno. 2 es el mundo entero, 15 son pocas manzanas",
        },
        nTiles: {
            tooltip: "Número de baldosas del terreno. Más baldosas significa más detalle, pero carga más lenta. (NxN)",
        },
        refresh: {
            label: "Refrescar",
            tooltip: "Refrescar el terreno con la configuración actual. Útil para problemas de red que pudieron causar una carga fallida",
        },
        debugGrids: {
            label: "Cuadrículas de depuración",
            tooltip: "Mostrar una cuadrícula de texturas del suelo (verde) y datos de elevación (azul)",
        },
        elevationScale: {
            tooltip: "Factor de escala para los datos de elevación. 1 es normal, 0.5 es la mitad, 2 es el doble",
        },
        terrainOpacity: {
            label: "Opacidad del terreno",
            tooltip: "Opacidad del terreno. 0 es totalmente transparente, 1 es totalmente opaco",
        },
        textureDetail: {
            tooltip: "Nivel de detalle para la subdivisión de texturas. Valores más altos = más detalle. 1 es normal, 0.5 es menos detalle, 2 es más detalle",
        },
        elevationDetail: {
            tooltip: "Nivel de detalle para la subdivisión de elevación. Valores más altos = más detalle. 1 es normal, 0.5 es menos detalle, 2 es más detalle",
        },
        disableDynamicSubdivision: {
            label: "Desactivar subdivisión dinámica",
            tooltip: "Desactivar la subdivisión dinámica de las baldosas del terreno. Congela el terreno en el nivel de detalle actual. Útil para depuración.",
        },
        dynamicSubdivision: {
            label: "Subdivisión dinámica",
            tooltip: "Usar subdivisión de baldosas adaptativa a la cámara para vista a escala global",
        },
        showBuildings: {
            label: "Edificios 3D",
            tooltip: "Mostrar baldosas de edificios 3D de Cesium Ion o Google",
        },
        buildingEdges: {
            label: "Aristas de edificios",
            tooltip: "Mostrar aristas de alambre en las baldosas de edificios 3D",
        },
        oceanSurface: {
            label: "Superficie oceánica (Beta)",
            tooltip: "Experimental: renderizar la superficie del agua al nivel del mar (MSL fijo EGM96) mientras las baldosas fotorrealistas de Google están activas",
        },
        buildingsSource: {
            label: "Fuente de edificios",
            tooltip: "Fuente de datos para las baldosas de edificios 3D",
        },
        useEllipsoid: {
            label: "Usar modelo terrestre elipsoidal",
            tooltip: "Esfera: modelo antiguo rápido. Elipsoide: forma WGS84 precisa (las latitudes altas se benefician más).",
        },
        layer: {
            label: "Capa",
            tooltip: "Capa para las texturas de terreno del tipo de mapa actual",
        },
    },

    displayTrack: {
        visible: {
            tooltip: "Mostrar u ocultar esta pista",
        },
        extendToGround: {
            label: "Extender al suelo",
            tooltip: "Dibujar líneas verticales desde la pista hasta el suelo",
        },
        displayStep: {
            label: "Paso de visualización",
            tooltip: "Paso de fotogramas entre puntos de pista mostrados (1 = cada fotograma)",
        },
        contrail: {
            label: "Estela de condensación",
            tooltip: "Mostrar una cinta de estela de condensación detrás de esta pista, ajustada para el viento",
        },
        contrailSecs: {
            label: "Duración estela (s)",
            tooltip: "Duración de la estela de condensación en segundos",
        },
        contrailWidth: {
            label: "Ancho estela (m)",
            tooltip: "Ancho máximo de la cinta de estela en metros",
        },
        contrailInitialWidth: {
            label: "Ancho inicial estela (m)",
            tooltip: "Ancho de la estela en el punto de escape en metros",
        },
        contrailRamp: {
            label: "Rampa estela (m)",
            tooltip: "Distancia a lo largo de la cual aumenta el ancho de la estela en metros",
        },
        contrailSpread: {
            label: "Dispersión estela (m/s)",
            tooltip: "Tasa de expansión de la estela en m/s",
        },
        lineColor: {
            label: "Color de línea",
            tooltip: "Color de la línea de la pista",
        },
        polyColor: {
            label: "Color de polígonos",
            tooltip: "Color de los polígonos verticales de extensión al suelo",
        },
        altLockAGL: {
            label: "Bloqueo alt. AGL",
        },
        gotoTrack: {
            label: "Ir a la pista",
            tooltip: "Centrar la cámara principal en la ubicación de esta pista",
        },
    },

    ptzUI: {
        panAz: {
            label: "Panorámica (Az)",
            tooltip: "Ángulo de acimut / panorámica de la cámara en grados",
        },
        tiltEl: {
            label: "Inclinación (El)",
            tooltip: "Ángulo de elevación / inclinación de la cámara en grados",
        },
        zoomFov: {
            label: "VFOV (deg)",
            tooltip: "Campo de visión vertical de la cámara en grados",
        },
        roll: {
            label: "Alabeo",
            tooltip: "Ángulo de alabeo de la cámara en grados",
        },
        xOffset: {
            label: "Desplazamiento X",
            tooltip: "Desplazamiento horizontal de la cámara desde el centro",
        },
        yOffset: {
            label: "Desplazamiento Y",
            tooltip: "Desplazamiento vertical de la cámara desde el centro",
        },
        nearPlane: {
            label: "Plano cercano (m)",
            tooltip: "Distancia del plano de recorte cercano de la cámara en metros",
        },
        relative: {
            label: "Relativo",
            tooltip: "Usar ángulos relativos en lugar de absolutos",
        },
        satellite: {
            label: "Satélite",
            tooltip: "Modo satélite: desplazamiento en pantalla desde el nadir.\nAlaleo = rumbo, Az = izquierda/derecha, El = arriba/abajo (−90 = nadir)",
        },
        rotation: {
            label: "Rotación",
            tooltip: "Rotación en pantalla alrededor del eje de visión de la cámara",
        },
    },

    nodes3dObject: {
        modelOrGeometry: {
            label: "Modelo o Geometría",
            tooltip: "Seleccionar si usar un modelo 3D o una geometría generada para este objeto",
        },
        model: {
            label: "Modelo",
            tooltip: "Seleccionar un modelo 3D para usar con este objeto",
        },
        displayBoundingBox: {
            label: "Mostrar caja delimitadora",
            tooltip: "Mostrar la caja delimitadora del objeto con dimensiones",
        },
        forceAboveSurface: {
            label: "Forzar sobre la superficie",
            tooltip: "Forzar al objeto a permanecer completamente sobre la superficie del suelo",
        },
        exportToKML: {
            label: "Exportar a KML",
            tooltip: "Exportar este objeto 3D como archivo KML para Google Earth",
        },
        startAnalysis: {
            label: "Iniciar análisis",
            tooltip: "Lanzar rayos desde la cámara para encontrar direcciones de reflexión",
        },
        gridSize: {
            label: "Tamaño de cuadrícula",
            tooltip: "Número de puntos de muestreo por eje para la cuadrícula de reflexión",
        },
        cleanUp: {
            label: "Limpiar",
            tooltip: "Eliminar todas las flechas de análisis de reflexión de la escena",
        },
    },

    trackingOverlay: {
        showTracking: {
            label: "Mostrar seguimiento",
            tooltip: "Mostrar u ocultar los puntos de seguimiento y la curva superpuesta",
        },
        reset: {
            label: "Restablecer",
            tooltip: "Restablecer el seguimiento manual a un estado vacío, eliminando todos los fotogramas clave y elementos arrastrables",
        },
        limitAB: {
            label: "Limitar AB",
            tooltip: "Limitar los fotogramas A y B al rango de los fotogramas clave de seguimiento de video. Esto evitará la extrapolación más allá de los primeros y últimos fotogramas clave, lo cual no siempre es deseable.",
        },
        curveType: {
            label: "Tipo de curva",
            tooltip: "Spline usa spline cúbica natural. Spline2 usa spline not-a-knot para un comportamiento más suave en los extremos. Lineal usa segmentos de línea recta. Perspectiva requiere exactamente 3 fotogramas clave y modela movimiento lineal con proyección perspectiva.",
        },
        minimizeGroundSpeed: {
            label: "Minimizar velocidad terrestre",
            tooltip: "Encontrar la distancia de inicio del objetivo que minimiza la distancia terrestre recorrida por la trayectoria de travesía",
        },
        minimizeAirSpeed: {
            label: "Minimizar velocidad aérea",
            tooltip: "Encontrar la distancia de inicio del objetivo que minimiza la distancia aérea recorrida (considerando el viento del objetivo)",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "Cuadrilátero de suelo del frustum",
            tooltip: "Mostrar la intersección del frustum de la cámara con el suelo",
        },
        videoInFrustum: {
            label: "Video en el frustum",
            tooltip: "Proyectar el video sobre el plano lejano del frustum de la cámara",
        },
        videoOnGround: {
            label: "Video en el suelo",
            tooltip: "Proyectar el video sobre el suelo",
        },
        groundVideoInLookView: {
            label: "Video de suelo en vista de cámara",
            tooltip: "Mostrar el video proyectado en el suelo en la vista de cámara",
        },
        matchVideoAspect: {
            label: "Ajustar relación de aspecto del video",
            tooltip: "Recortar la vista de cámara para coincidir con la relación de aspecto del video y ajustar el frustum en consecuencia",
        },
        videoOpacity: {
            label: "Opacidad del video",
            tooltip: "Opacidad de la superposición de video proyectada",
        },
    },

    labels3d: {
        measurements: {
            label: "Mediciones",
            tooltip: "Mostrar etiquetas y flechas de medición de distancia y ángulo",
        },
        labelsInMain: {
            label: "Etiquetas en vista principal",
            tooltip: "Mostrar etiquetas de trayectoria/objeto en la vista 3D principal",
        },
        labelsInLook: {
            label: "Etiquetas en vista de cámara",
            tooltip: "Mostrar etiquetas de trayectoria/objeto en la vista de cámara",
        },
        featuresInMain: {
            label: "Marcadores/Pines en vista principal",
            tooltip: "Mostrar marcadores de puntos de interés (pines) en la vista 3D principal",
        },
        featuresInLook: {
            label: "Marcadores en vista de cámara",
            tooltip: "Mostrar marcadores de puntos de interés en la vista de cámara",
        },
    },

    losFitPhysics: {
        folder: "Resultados de ajuste físico",
        model: {
            label: "Modelo",
        },
        avgError: {
            label: "Error prom. (rad)",
        },
        windSpeed: {
            label: "Velocidad del viento (kt)",
        },
        windFrom: {
            label: "Viento desde (\u00B0)",
        },
    },

    misbData: {
        startTime: {
            label: "Hora de inicio",
            tooltip: "Anular la hora de inicio (ej.: '10:30', '15 ene', '2024-01-15T10:30:00Z'). Dejar vacío para la hora de inicio global.",
        },
        enableFilter: {
            label: "Activar filtro",
        },
        tryAltitudeFirst: {
            label: "Probar altitud primero",
        },
        maxG: {
            label: "G máx",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "Sobre el nivel del suelo",
            tooltip: "La altitud es relativa al nivel del suelo, no al nivel del mar",
        },
        lookup: {
            label: "Buscar",
            tooltip: "Introducir un nombre de lugar, coordenadas lat,lon o MGRS para desplazarse allí",
        },
        geolocate: {
            label: "Geolocalizar desde el navegador",
            tooltip: "Usar la API de geolocalización del navegador para establecer su posición actual",
        },
        goTo: {
            label: "Ir a la posición indicada",
            tooltip: "Mover el terreno y la cámara a la latitud/longitud/altitud introducida",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "Detener en",
            tooltip: "Detener el movimiento del objetivo de la cámara en este fotograma, incluso si la trayectoria objetivo continúa. Útil para simular la pérdida de seguimiento de un objetivo en movimiento. Establecer a 0 para desactivar.",
        },
        horizonMethod: {
            label: "Método de horizonte",
        },
        lookFOV: {
            label: "CDV de la vista",
        },
        celestialObject: {
            label: "Objeto celeste",
            tooltip: "Nombre del cuerpo celeste que la cámara sigue (ej.: Luna, Venus, Júpiter)",
        },
    },

    spriteGroup: {
        visible: {
            label: "Visible",
            tooltip: "Mostrar u ocultar los orbes de flujo",
        },
        size: {
            label: "Tamaño (m)",
            tooltip: "Diámetro en metros.",
        },
        viewSizeMultiplier: {
            label: "Multiplicador de tamaño de vista",
            tooltip: "Ajusta el tamaño de los orbes de flujo en la vista principal, sin cambiar el tamaño en otras vistas.",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "Mejor ángulo, 180° completo, refinado",
        },
        bestAngle5: {
            label: "Mejor ángulo dentro de 5° del actual",
        },
    },

    misc: {
        snapshotCamera: {
            label: "Instantánea de cámara",
            tooltip: "Guardar la posición y orientación actuales de la cámara para 'Restablecer cámara'",
        },
        resetCamera: {
            label: "Restablecer cámara",
            tooltip: "Restablecer la cámara a la posición predeterminada, o a la última instantánea\nTambién Teclado num-.",
        },
        showMoonShadow: {
            label: "Mostrar sombra de la Luna",
            tooltip: "Alternar la visualización del cono de sombra de la Luna para la visualización de eclipses.",
        },
        shadowSegments: {
            label: "Segmentos de sombra",
            tooltip: "Número de segmentos en el cono de sombra (más = más suave pero más lento)",
        },
        showEarthShadow: {
            label: "Mostrar sombra de la Tierra",
            tooltip: "Alternar la visualización del cono de sombra de la Tierra en el cielo nocturno.",
        },
        earthShadowAltitude: {
            label: "Altitud de sombra terrestre",
            tooltip: "Distancia del centro de la Tierra al plano en el que se renderiza el cono de sombra terrestre (en metros).",
        },
        exportTLE: {
            label: "Exportar TLE",
        },
        backgroundFlowIndicator: {
            label: "Indicador de flujo de fondo",
            tooltip: "Mostrar una flecha indicando cuánto se moverá el fondo en el siguiente fotograma.\nÚtil para sincronizar la simulación con el video (usar Vista/Superposición de Video)",
        },
        defaultSnap: {
            label: "Ajuste predeterminado",
            tooltip: "Cuando está activado, los puntos se alinearán horizontalmente por defecto al arrastrar.\nMantener Mayús (al arrastrar) para hacer lo contrario",
        },
        recalcNodeGraph: {
            label: "Recalcular grafo de nodos",
        },
        downloadVideo: {
            label: "Descargar video",
        },
        banking: {
            label: "Alabeo",
            tooltip: "Cómo el objeto se inclina durante los giros",
        },
        angularTraverse: {
            label: "Travesía angular",
        },
        smoothingMethod: {
            label: "Método de suavizado",
            tooltip: "Algoritmo utilizado para suavizar los datos de trayectoria de la cámara",
        },
        showInLookView: {
            label: "Mostrar en vista de cámara",
        },
        windFrom: {
            tooltip: "Rumbo verdadero desde donde sopla el viento (0=Norte, 90=Este)",
        },
        windKnots: {
            tooltip: "Velocidad del viento en nudos",
        },
        fetchWind: {
            tooltip: "Obtener datos de viento reales de servicios meteorológicos para esta ubicación y hora",
        },
        debugConsole: {
            label: "Consola de depuración",
            tooltip: "Consola de depuración",
        },
        aiAssistant: {
            label: "Asistente IA",
        },
        hide: {
            label: "Ocultar",
            tooltip: "Ocultar esta vista con pestañas\nPara mostrarla de nuevo, use el menú 'Mostrar/Ocultar -> Vistas'.",
        },
        notes: {
            label: "Notas",
            tooltip: "Mostrar/Ocultar el editor de notas. Las notas se guardan con el sitch y pueden contener hipervínculos clicables.",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "Líneas de visión",
            tooltip: "Mostrar líneas de visión de la cámara al objetivo (alternar: O)",
        },
        physicalPointer: {
            label: "Puntero físico",
        },
        jet: {
            label: "[J]et",
        },
        horizonGrid: {
            label: "Cuadrícula de [H]orizonte",
        },
        wingPlaneGrid: {
            label: "Cuadrícula del plano alar ([W])",
        },
        sphericalBoresightGrid: {
            label: "Cuadrícula e[S]férica de mira",
        },
        azimuthElevationGrid: {
            label: "Cuadrícula de [A]cimut/Elevación",
        },
        frustumOfCamera: {
            label: "F[R]ustum de la cámara",
        },
        trackLine: {
            label: "Línea de [T]rayectoria",
        },
        globe: {
            label: "[G]lobo",
        },
        showErrorCircle: {
            label: "Círculo de error",
        },
        glareSprite: {
            label: "Spr[I]te de resplandor",
        },
        cameraViewFrustum: {
            label: "Frustum de la cámara",
            tooltip: "Mostrar el frustum de visión de la cámara en la escena 3D",
        },
        zaineTriangulation: {
            label: "Triangulación Zaine",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "Intensidad ambiental",
            tooltip: "Intensidad de la luz ambiental. 0 = sin luz ambiental, 1 = luz ambiental normal, 2 = doble luz ambiental",
        },
        irAmbientIntensity: {
            label: "Intensidad ambiental IR",
            tooltip: "Intensidad de la luz ambiental IR (usada para vistas IR)",
        },
        sunIntensity: {
            label: "Intensidad del sol",
            tooltip: "Intensidad de la luz solar. 0 = sin sol, 1 = sol pleno normal, 2 = doble sol",
        },
        sunScattering: {
            label: "Dispersión solar",
            tooltip: "Cantidad de dispersión de la luz solar",
        },
        sunBoost: {
            label: "Amplificación solar (HDR)",
            tooltip: "Multiplicador para la intensidad de la DirectionalLight del sol (HDR). Aumenta el brillo de los reflejos especulares para reflexiones solares realistas a través de la niebla.",
        },
        sceneExposure: {
            label: "Exposición de la escena (HDR)",
            tooltip: "Compensación de exposición para el mapeo de tonos HDR. Reducir para compensar una mayor amplificación solar.",
        },
        ambientOnly: {
            label: "Solo ambiental",
            tooltip: "Si es verdadero, solo se usa luz ambiental, sin luz solar",
        },
        daylightSky: {
            label: "Cielo diurno",
            tooltip: "Renderiza el cielo diurno (azul).\nDesactivar para eliminar la contribución del cielo diurno — útil para ver estrellas durante el día o depurar objetos del cielo nocturno.",
        },
        noMainLighting: {
            label: "Sin iluminación en la vista principal",
            tooltip: "Si es verdadero, no se usa iluminación en la vista principal.\nÚtil para depuración, pero no recomendado para uso normal",
        },
        noCityLights: {
            label: "Sin luces de ciudades en el globo",
            tooltip: "Si es verdadero, no renderizar las luces de las ciudades en el globo.",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "Replay ADSB para esta hora y ubicación",
            tooltip: "Generar un enlace a ADSB Exchange Replay",
        },
        googleMapsLink: {
            label: "Google Maps para esta ubicación",
            tooltip: "Crear un enlace de Google Maps a la ubicación actual",
        },
        inTheSkyLink: {
            label: "In-The-Sky para esta hora y ubicación",
            tooltip: "Crear un enlace de In The Sky a la ubicación actual",
        },
    },
    nodeLabels: {
        focus: "Desenfoque",
        canvasResolution: "Resolución",
        "Noise Amount": "Cantidad de ruido",
        "TV In Black": "TV negro de entrada",
        "TV In White": "TV blanco de entrada",
        "TV Gamma": "TV gamma",
        "Tv Out Black": "TV negro de salida",
        "Tv Out White": "TV blanco de salida",
        "JPEG Artifacts": "Artefactos JPEG",
        pixelZoom: "Zoom de píxel %",
        videoBrightness: "Brillo",
        videoContrast: "Contraste",
        videoBlur: "Cantidad de desenfoque",
        videoSharpenAmount: "Cantidad de nitidez",
        videoGreyscale: "Escala de grises",
        videoHue: "Cambio de tono",
        videoInvert: "Invertir",
        videoSaturate: "Saturación",
        startDistanceGUI: "Distancia inicial",
        targetVCGUI: "Vel. vert. objetivo",
        targetSpeedGUI: "Velocidad objetivo",
        lockWind: "Bloquear viento objetivo al local",
        jetTAS: "TAS",
        turnRate: "Tasa de giro",
        totalTurn: "Giro total",
        jetHeadingManual: "Rumbo del avión",
        headingSmooth: "Suavizado de rumbo",
        turnRateControl: "Control de tasa de giro",
        cameraSmoothWindow: "Ventana de suavizado de cámara",
        targetSmoothWindow: "Ventana de suavizado de objetivo",
        cameraFOV: "FOV de cámara",
        "Tgt Start Dist": "Distancia inicial objetivo",
        "Target Speed": "Velocidad objetivo",
        "Tgt Relative Heading": "Rumbo relativo objetivo",
        "KF Process": "KF proceso",
        "KF Noise": "KF ruido",
        "MC Num Trials": "MC número de intentos",
        "MC LOS Uncertainty (deg)": "MC incertidumbre LOS (deg)",
        "MC Polynomial Order": "MC orden polinomial",
        "Physics Max Iterations": "Física iteraciones máx.",
        "Physics Wind Speed (kt)": "Física velocidad del viento (kt)",
        "Physics Wind From (°)": "Física viento desde (°)",
        "Physics Initial Range (m)": "Física distancia inicial (m)",
        "Tgt Start Altitude": "Altitud inicial objetivo",
        "Tgt Vert Spd": "Vel. vert. objetivo",
        "Cloud Altitude": "Altitud de las nubes",
    },
};

export default es;
