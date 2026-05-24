const pt = {
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "Seleção de sitches legados e ferramentas\nAlguns sitches legados possuem controles aqui por padrão",
            noTooltip: "Nenhuma dica definida para este sitch",
            legacySitches: {
                label: "Sitches Legados",
                tooltip: "Os Sitches Legados são situações predefinidas mais antigas (codificadas) que frequentemente possuem código e recursos exclusivos. Selecione um para carregá-lo.",
            },
            legacyTools: {
                label: "Ferramentas Legadas",
                tooltip: "Ferramentas são sitches especiais usados para configurações personalizadas como Starlink ou com trilhas do usuário, e para testes, depuração ou outros fins especiais. Selecione uma para carregá-la.",
            },
            selectPlaceholder: "-Selecionar-",
        },
        file: {
            title: "Arquivo",
            tooltip: "Operações de arquivo como salvar, carregar e exportar",
        },
        view: {
            title: "Exibir",
            tooltip: "Controles diversos de visualização\nComo todos os menus, este menu pode ser arrastado para fora da barra de menus para se tornar um menu flutuante",
        },
        video: {
            title: "Vídeo",
            tooltip: "Ajuste, efeitos e análise de vídeo",
        },
        time: {
            title: "Tempo",
            tooltip: "Controles de tempo e quadro\nArrastar um controle deslizante de tempo além do final afetará o controle deslizante acima\nNote que os controles deslizantes de tempo estão em UTC",
        },
        objects: {
            title: "Objetos",
            tooltip: "Objetos 3D e suas propriedades\nCada pasta é um objeto. O traverseObject é o objeto que percorre as linhas de visada - ou seja, o UAP que estamos investigando",
            addObject: {
                label: "Adicionar Objeto",
                tooltip: "Criar um novo objeto nas coordenadas especificadas",
                prompt: "Digite: [Nome] Lat Lon [Alt]\nExemplos:\n  MeuObjeto 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Ponto 37.7749 -122.4194",
                invalidInput: "Entrada inválida. Por favor, insira coordenadas no formato:\n[Nome] Lat Lon [Alt]",
            },
        },
        satellites: {
            title: "Satélites",
            tooltip: "Carregamento e controle de satélites\nOs satélites.\nStarlink, ISS, etc. Controles para flares no horizonte e outros efeitos de satélites",
        },
        terrain: {
            title: "Terreno",
            tooltip: "Controles de terreno\nO terreno é o modelo 3D do solo. O 'Mapa' é a imagem 2D do solo. A 'Elevação' é a altura do solo acima do nível do mar",
        },
        physics: {
            title: "Física",
            tooltip: "Controles de física\nA física da situação, como velocidade do vento e a física do objeto de travessia",
        },
        camera: {
            title: "Câmera",
            tooltip: "Controles de câmera para a câmera de visualização\nA visualização padrão é a janela inferior direita, e destina-se a corresponder ao vídeo.",
        },
        target: {
            title: "Alvo",
            tooltip: "Controles do alvo\nPosição e propriedades do objeto alvo opcional",
        },
        traverse: {
            title: "Travessia",
            tooltip: "Controles de travessia\nO objeto de travessia é o objeto que percorre as linhas de visada - ou seja, o UAP que estamos investigando\nEste menu define como o objeto de travessia se move e se comporta",
        },
        showHide: {
            title: "Visibilidade",
            tooltip: "Mostrar ou ocultar visualizações, objetos e outros elementos",
            views: {
                title: "Visualizações",
                tooltip: "Mostrar ou ocultar visualizações (janelas) como a visualização de câmera, o vídeo, a visualização principal, bem como sobreposições como o MQ9UI",
            },
            graphs: {
                title: "Gráficos",
                tooltip: "Mostrar ou ocultar vários gráficos",
            },
        },
        effects: {
            title: "Efeitos",
            tooltip: "Efeitos especiais como desfoque, pixelização e ajustes de cor aplicados à imagem final na visualização de câmera",
        },
        lighting: {
            title: "Iluminação",
            tooltip: "A iluminação da cena, como o sol e a luz ambiente",
        },
        contents: {
            title: "Conteúdo",
            tooltip: "O conteúdo da cena, usado principalmente para trilhas",
        },
        help: {
            title: "Ajuda",
            tooltip: "Links para a documentação e outros recursos de ajuda",
            whatsNew: "Novidades",
            documentation: {
                title: "Documentação",
                localTooltip: "Links para a documentação (local)",
                githubTooltip: "Links para a documentação no Github",
                githubLinkLabel: "{{name}} (Github)",
                about: "Sobre o Sitrec",
                whatsNew: "Novidades",
                whatsNewDetails: "Novidades (Detalhes)",
                uiBasics: "Noções Básicas da Interface",
                savingLoading: "Salvando e Carregando Sitches",
                customSitch: "Como configurar um sitch",
                tracks: "Trilhas e Fontes de Dados",
                gis: "GIS e Mapeamento",
                starlink: "Como Investigar Flares de Starlink",
                customModels: "Objetos e Modelos 3D (Aeronaves)",
                cameraModes: "Modos de Câmera (Normal e Satélite)",
                thirdPartyNotices: "Avisos de Terceiros",
                thirdPartyNoticesTooltip: "Atribuições de licenças de código aberto para software de terceiros incluído",
                downloadBridge: "Baixar MCP Bridge",
                downloadBridgeTooltip: "Baixar o servidor MCP SitrecBridge + extensão Chrome (sem dependências, apenas precisa do Node.js)",
            },
            externalLinks: {
                title: "Links Externos",
                tooltip: "Links externos de ajuda",
            },
            exportDebugLog: {
                label: "Exportar Log de Depuração",
                tooltip: "Baixar toda a saída do console (log, warn, error) como arquivo de texto para depuração",
            },
        },
        debug: {
            title: "Depuração",
            tooltip: "Ferramentas de depuração e monitoramento\nUso de memória GPU, métricas de desempenho e outras informações de depuração",
        },
    },
    file: {
        newSitch: {
            label: "Novo Sitch",
            tooltip: "Criar um novo sitch (recarregará esta página, redefinindo tudo)",
        },
        savingDisabled: "Salvamento Desabilitado (clique para entrar)",
        importFile: {
            label: "Importar Arquivo",
            tooltip: "Importar um arquivo (ou arquivos) do seu sistema local. O mesmo que arrastar e soltar um arquivo na janela do navegador",
        },
        server: {
            open: "Abrir",
            save: {
                label: "Salvar",
                tooltip: "Salvar o sitch atual no servidor",
            },
            saveAs: {
                label: "Salvar Como",
                tooltip: "Salvar o sitch atual no servidor com um novo nome",
            },
            versions: {
                label: "Versões",
                tooltip: "Carregar uma versão específica do sitch selecionado atualmente",
            },
            browseFeatured: "Navegar por sitches em destaque",
            browseAll: "Navegar por todos os seus sitches salvos em uma lista pesquisável e ordenável",
        },
        local: {
            title: "Local",
            titleWithFolder: "Local: {{name}}",
            titleReconnect: "Local: {{name}} (reconectar)",
            status: "Status",
            noFileSelected: "Nenhum arquivo local selecionado",
            noFolderSelected: "Nenhuma pasta selecionada",
            currentFile: "Arquivo atual: {{name}}",
            statusDesktop: "Arquivo/estado de salvamento local atual na área de trabalho",
            statusFolder: "Pasta/estado de salvamento local atual",
            stateReady: "Pronto",
            stateReconnect: "Necessita reconexão",
            stateNoFolder: "Sem pasta",
            statusLine: "{{state}} | Pasta: {{folder}} | Destino: {{target}}",
            saveLocal: {
                label: "Salvar Local",
                tooltipDesktop: "Salvar no arquivo local atual, ou solicitar um nome de arquivo se necessário",
                tooltipFolder: "Salvar na pasta de trabalho (ou solicitar um local se nenhum estiver definido)",
                tooltipSaveBack: "Salvar de volta em {{name}}",
                tooltipSaveBackInFolder: "Salvar de volta em {{name}} na pasta {{folder}}",
                tooltipSaveInto: "Salvar em {{folder}} (solicita o nome do sitch)",
                tooltipPrompt: "Salvar um arquivo de sitch local (solicita nome/local)",
                tooltipSaveTo: "Salvar o sitch atual em um arquivo local",
            },
            saveLocalAs: {
                label: "Salvar Local Como...",
                tooltipDesktop: "Salvar um arquivo de sitch local em um novo caminho",
                tooltipFolder: "Salvar um arquivo de sitch local, escolhendo o local",
                tooltipInFolder: "Salvar com um novo nome de arquivo na pasta de trabalho atual",
                tooltipNewPath: "Salvar o sitch atual em um novo caminho de arquivo local",
            },
            openLocal: {
                label: "Abrir Sitch Local",
                labelShort: "Abrir Local...",
                tooltipDesktop: "Abrir um arquivo de sitch local do disco",
                tooltipFolder: "Abrir um arquivo de sitch da pasta de trabalho atual",
                tooltipCurrent: "Abrir um arquivo de sitch local diferente (atual: {{name}})",
                tooltipFromFolder: "Abrir um arquivo de sitch de {{folder}}",
            },
            selectFolder: {
                label: "Selecionar Pasta de Sitch Local",
                tooltip: "Selecionar uma pasta de trabalho para operações locais de salvar/carregar",
            },
            reconnectFolder: {
                label: "Reconectar Pasta",
                tooltip: "Conceder acesso novamente à pasta de trabalho usada anteriormente",
            },
        },
        debug: {
            recalculateAll: "depuração recalcular tudo",
            dumpNodes: "depuração listar nós",
            dumpNodesBackwards: "depuração listar nós invertido",
            dumpRoots: "depuração listar nós raiz",
        },
    },
    videoExport: {
        notAvailable: "Exportação de Vídeo Não Disponível",
        folder: {
            title: "Renderização e Exportação de Vídeo",
            tooltip: "Opções para renderizar e exportar arquivos de vídeo das visualizações do Sitrec ou da viewport completa",
        },
        renderView: {
            label: "Renderizar Visualização de Vídeo",
            tooltip: "Selecionar qual visualização exportar como vídeo",
        },
        renderSingleVideo: {
            label: "Renderizar Vídeo de Visualização Única",
            tooltip: "Exportar a visualização selecionada como arquivo de vídeo com todos os quadros",
        },
        videoFormat: {
            label: "Formato de Vídeo",
            tooltip: "Selecionar o formato de saída do vídeo",
        },
        renderViewport: {
            label: "Renderizar Vídeo da Viewport",
            tooltip: "Exportar toda a viewport como arquivo de vídeo com todos os quadros",
        },
        renderFullscreen: {
            label: "Renderizar Vídeo em Tela Cheia",
            tooltip: "Exportar toda a viewport em modo tela cheia como arquivo de vídeo com todos os quadros",
        },
        recordWindow: {
            label: "Gravar Janela do Navegador",
            tooltip: "Gravar toda a janela do navegador (incluindo menus e interface) como vídeo com taxa de quadros fixa",
        },
        retinaExport: {
            label: "Usar Exportação HD/Retina",
            tooltip: "Exportar em resolução retina/HiDPI (2x na maioria dos displays)",
        },
        includeAudio: {
            label: "Incluir Áudio",
            tooltip: "Incluir faixa de áudio do vídeo de origem, se disponível",
        },
        waitForLoading: {
            label: "Aguardar carregamento em segundo plano",
            tooltip: "Quando habilitado, a renderização aguarda o carregamento de terreno/edifícios/plano de fundo antes de capturar cada quadro",
        },
        exportFrame: {
            label: "Exportar Quadro de Vídeo",
            tooltip: "Exportar o quadro de vídeo atual conforme exibido (com efeitos) como arquivo PNG",
        },
    },
    tracking: {
        enable: {
            label: "Ativar Rastreamento Automático",
            disableLabel: "Desativar Rastreamento Automático",
            tooltip: "Alternar exibição do cursor de rastreamento automático no vídeo",
        },
        start: {
            label: "Iniciar Rastreamento Automático",
            stopLabel: "Parar Rastreamento Automático",
            tooltip: "Rastrear automaticamente o objeto dentro do cursor conforme o vídeo é reproduzido",
        },
        clearFromHere: {
            label: "Limpar Daqui",
            tooltip: "Limpar todas as posições rastreadas do quadro atual até o final",
        },
        clearTrack: {
            label: "Limpar Trilha",
            tooltip: "Limpar todas as posições rastreadas automaticamente e começar do zero",
        },
        stabilize: {
            label: "Estabilizar",
            tooltip: "Aplicar posições rastreadas automaticamente para estabilizar o vídeo",
        },
        stabilizeToggle: {
            enableLabel: "Ativar Estabilização",
            disableLabel: "Desativar Estabilização",
            tooltip: "Alternar estabilização de vídeo ligada/desligada",
        },
        stabilizeCenters: {
            label: "Estabilizar no Centro",
            tooltip: "Quando marcado, o ponto estabilizado fica fixo no centro da visualização. Quando desmarcado, permanece na posição inicial.",
        },
        renderStabilized: {
            label: "Renderizar Vídeo Estabilizado",
            tooltip: "Exportar vídeo estabilizado no tamanho original (ponto rastreado fica fixo, bordas podem mostrar preto)",
        },
        renderStabilizedExpanded: {
            label: "Renderizar Estabilizado Expandido",
            tooltip: "Exportar vídeo estabilizado com tela expandida para que nenhum pixel seja perdido",
        },
        trackRadius: {
            label: "Raio de Rastreamento",
            tooltip: "Tamanho do modelo a ser correspondido (tamanho do objeto)",
        },
        searchRadius: {
            label: "Raio de Busca",
            tooltip: "Distância da posição anterior para buscar (aumentar para movimento rápido)",
        },
        trackingMethod: {
            label: "Método de Rastreamento",
            tooltip: "Correspondência de Modelo (OpenCV) ou Fluxo Óptico (jsfeat Lucas-Kanade)",
        },
        centerOnBright: {
            label: "Centralizar no Brilhante",
            tooltip: "Rastrear centroide de pixels brilhantes (melhor para estrelas/luzes pontuais)",
        },
        centerOnDark: {
            label: "Centralizar no Escuro",
            tooltip: "Rastrear centroide de pixels escuros",
        },
        brightnessThreshold: {
            label: "Limite de Brilho",
            tooltip: "Limite de brilho (0-255). Usado nos modos Centralizar no Brilhante/Escuro",
        },
        status: {
            loadingJsfeat: "Carregando jsfeat...",
            loadingOpenCv: "Carregando OpenCV...",
            sam2Connecting: "SAM2: Conectando...",
            sam2Uploading: "SAM2: Enviando...",
        },
    },
    trackManager: {
        removeTrack: "Remover Trilha",
        createSpline: "Criar Spline",
        editTrack: "Editar Trilha",
        constantSpeed: "Velocidade Constante",
        extrapolateTrack: "Extrapolar Trilha",
        curveType: "Tipo de Curva",
        altLockAGL: "Travar Alt AGL",
        deleteTrack: "Excluir Trilha",
    },
    gpuMonitor: {
        enabled: "Monitor Ativado",
        total: "Memória Total",
        geometries: "Geometrias",
        textures: "Texturas",
        peak: "Memória de Pico",
        average: "Memória Média",
        reset: "Redefinir Histórico",
    },
    situationSetup: {
        mainFov: {
            label: "FOV Principal",
            tooltip: "Campo de visão da câmera da visualização principal (VERTICAL)",
        },
        lookCameraFov: "FOV da Câmera de Visualização",
        azimuth: "azimute",
        jetPitch: "Inclinação do Jato",
    },
    featureManager: {
        labelText: "Texto do Rótulo",
        latitude: "Latitude",
        longitude: "Longitude",
        altitude: "Altitude (m)",
        arrowLength: "Comprimento da Seta",
        arrowColor: "Cor da Seta",
        textColor: "Cor do Texto",
        deleteFeature: "Excluir Marcador",
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "Exportar Panorama da Câmera",
            tooltip: "Criar uma imagem panorâmica a partir da visualização de câmera em todos os quadros com base na posição do fundo",
        },
    },
    dateTime: {
        liveMode: {
            label: "Modo Ao Vivo",
            tooltip: "Se o Modo Ao Vivo estiver ativado, a reprodução será sempre sincronizada com o horário atual.\nPausar ou arrastar o tempo desativará o modo ao vivo",
        },
        startTime: {
            tooltip: "O horário de INÍCIO do primeiro quadro do vídeo, em formato UTC",
        },
        currentTime: {
            tooltip: "O horário ATUAL do vídeo. É a isso que a data e hora abaixo se referem",
        },
        year: { label: "Ano", tooltip: "Ano do quadro atual" },
        month: { label: "Mês", tooltip: "Mês (1-12)" },
        day: { label: "Dia", tooltip: "Dia do mês" },
        hour: { label: "Hora", tooltip: "Hora (0-23)" },
        minute: { label: "Minuto", tooltip: "Minuto (0-59)" },
        second: { label: "Segundo", tooltip: "Segundo (0-59)" },
        millisecond: { label: "ms", tooltip: "Milissegundo (0-999)" },
        useTimeZone: {
            label: "Usar Fuso Horário na Interface",
            tooltip: "Usar o fuso horário na interface acima\nIsso alterará a data e hora para o fuso horário selecionado, em vez de UTC.\nÚtil para exibir a data e hora em um fuso horário específico, como o fuso horário local do vídeo ou da localização.",
        },
        timeZone: {
            label: "Fuso Horário",
            tooltip: "O fuso horário para exibir a data e hora na visualização de câmera\nTambém na interface se 'Usar Fuso Horário na Interface' estiver marcado",
        },
        simSpeed: {
            label: "Velocidade da Simulação",
            tooltip: "A velocidade da simulação, 1 é tempo real, 2 é duas vezes mais rápido, etc.\nIsso não altera a velocidade de reprodução do vídeo, apenas os cálculos de tempo da simulação.",
        },
        sitchFrames: {
            label: "Quadros do Sitch",
            tooltip: "O número de quadros no sitch. Se houver um vídeo, este será o número de quadros no vídeo, mas você pode alterá-lo se quiser adicionar mais quadros ao sitch, ou se quiser usar o sitch sem um vídeo",
        },
        sitchDuration: {
            label: "Duração do Sitch",
            tooltip: "Duração do sitch no formato HH:MM:SS.sss",
        },
        aFrame: {
            label: "Quadro A",
            tooltip: "Limitar a reprodução entre A e B, exibidos em verde e vermelho no controle deslizante de quadros",
        },
        bFrame: {
            label: "Quadro B",
            tooltip: "Limitar a reprodução entre A e B, exibidos em verde e vermelho no controle deslizante de quadros",
        },
        videoFps: {
            label: "FPS do Vídeo",
            tooltip: "Os quadros por segundo do vídeo. Isso alterará a velocidade de reprodução do vídeo (ex: 30 fps, 25 fps, etc). Também alterará a duração do sitch (em segundos) pois muda a duração de cada quadro individual\nIsto é derivado do vídeo quando possível, mas você pode alterá-lo se quiser acelerar ou desacelerar o vídeo",
        },
        syncTimeTo: {
            label: "Sincronizar Tempo com",
            tooltip: "Sincronizar o horário de início do vídeo com o horário de início original, o horário atual, ou o horário de início de uma trilha (se carregada)",
        },
    },
    jet: {
        frames: {
            time: {
                label: "Tempo (seg)",
                tooltip: "Tempo atual desde o início do vídeo em segundos (quadro / fps)",
            },
            frame: {
                label: "Quadro no Vídeo",
                tooltip: "Número do quadro atual no vídeo",
            },
            paused: {
                label: "Pausado",
                tooltip: "Alternar o estado de pausa (também barra de espaço)",
            },
        },
        controls: {
            pingPong: "Ping-Pong A-B",
            podPitchPhysical: "Inclinação do Pod (Esfera)",
            podRollPhysical: "Rolagem do Cabeçote do Pod",
            deroFromGlare: "Desrotação = Ângulo de Reflexo",
            jetPitch: "Inclinação do Jato",
            lookFov: "FOV Estreito",
            elevation: "elevação",
            glareStartAngle: "Ângulo Inicial do Reflexo",
            initialGlareRotation: "Rotação Inicial do Reflexo",
            scaleJetPitch: "Escalar Inclinação do Jato com Rolagem",
            horizonMethod: "Método do Horizonte",
            horizonMethodOptions: {
                humanHorizon: "Horizonte Humano",
                horizonAngle: "Ângulo do Horizonte",
            },
            videoSpeed: "Velocidade do Vídeo",
            podWireframe: "Wireframe do Pod [T]raseiro",
            showVideo: "[V]ídeo",
            showGraph: "[G]ráfico",
            showKeyboardShortcuts: "Atalhos de [T]eclado",
            showPodHead: "Rolagem do Cabeçote do [P]od",
            showPodsEye: "Visualização do [O]lho do Pod c/ desrot",
            showLookCam: "Visualização [N]AR c/ desrot",
            showCueData: "Dados de [C]ue",
            showGlareGraph: "M[o]strar Gráfico de Reflexo",
            showAzGraph: "Mostrar Gráfico A[Z]",
            declutter: "[D]esimpedir",
            jetOffset: "Deslocamento Y do Jato",
            tas: "TAS Velocidade Real",
            integrate: "Passos de Integração",
        },
    },
    motionAnalysis: {
        menu: {
            title: "Análise de Movimento",
            analyzeMotion: {
                label: "Analisar Movimento",
                tooltip: "Alternar sobreposição de análise de movimento em tempo real no vídeo",
            },
            createTrack: {
                label: "Criar Trilha a partir do Movimento",
                tooltip: "Analisar todos os quadros e criar uma trilha de solo a partir de vetores de movimento",
            },
            alignWithFlow: {
                label: "Alinhar com o Fluxo",
                tooltip: "Rotacionar a imagem para que a direção do movimento fique horizontal",
            },
            panorama: {
                title: "Panorama",
                exportImage: {
                    label: "Exportar Panorama de Movimento",
                    tooltip: "Criar uma imagem panorâmica a partir de quadros de vídeo usando deslocamentos de rastreamento de movimento",
                },
                exportVideo: {
                    label: "Exportar Vídeo Panorâmico",
                    tooltip: "Criar um vídeo 4K mostrando o panorama com sobreposição de quadro de vídeo",
                },
                stabilize: {
                    label: "Estabilizar Vídeo",
                    disableLabel: "Desativar Estabilização",
                    tooltip: "Estabilizar vídeo usando análise de movimento global (remove tremor da câmera)",
                },
                panoFrameStep: {
                    label: "Passo de Quadro do Panorama",
                    tooltip: "Quantos quadros pular entre cada quadro do panorama (1 = todo quadro)",
                },
                crop: {
                    label: "Corte do Panorama",
                    tooltip: "Pixels a cortar de cada borda dos quadros de vídeo",
                },
                useMask: {
                    label: "Usar Máscara no Panorama",
                    tooltip: "Aplicar máscara de rastreamento de movimento como transparência ao renderizar o panorama",
                },
                analyzeWithEffects: {
                    label: "Analisar com Efeitos",
                    tooltip: "Aplicar ajustes de vídeo (contraste, etc.) aos quadros usados para análise de movimento",
                },
                exportWithEffects: {
                    label: "Exportar com Efeitos",
                    tooltip: "Aplicar ajustes de vídeo às exportações de panorama",
                },
                removeOuterBlack: {
                    label: "Remover Preto Externo",
                    tooltip: "Tornar transparentes os pixels pretos nas bordas de cada linha",
                },
            },
            trackingParameters: {
                title: "Parâmetros de Rastreamento",
                technique: {
                    label: "Técnica",
                    tooltip: "Algoritmo de estimativa de movimento",
                },
                frameSkip: {
                    label: "Pular Quadros",
                    tooltip: "Quadros entre comparações (maior = detecta movimento mais lento)",
                },
                trackletLength: {
                    label: "Comprimento do Tracklet",
                    tooltip: "Número de quadros no tracklet (maior = coerência mais rigorosa)",
                },
                blurSize: {
                    label: "Tamanho do Desfoque",
                    tooltip: "Desfoque gaussiano para macro características (números ímpares)",
                },
                minMotion: {
                    label: "Movimento Mínimo",
                    tooltip: "Magnitude mínima de movimento (pixels/quadro)",
                },
                maxMotion: {
                    label: "Movimento Máximo",
                    tooltip: "Magnitude máxima de movimento",
                },
                smoothing: {
                    label: "Suavização",
                    tooltip: "Suavização de direção (maior = mais suavização)",
                },
                minVectorCount: {
                    label: "Contagem Mínima de Vetores",
                    tooltip: "Número mínimo de vetores de movimento para um quadro válido",
                },
                minConfidence: {
                    label: "Confiança Mínima",
                    tooltip: "Confiança mínima de consenso para um quadro válido",
                },
                maxFeatures: {
                    label: "Máximo de Características",
                    tooltip: "Máximo de características rastreadas",
                },
                minDistance: {
                    label: "Distância Mínima",
                    tooltip: "Distância mínima entre características",
                },
                qualityLevel: {
                    label: "Nível de Qualidade",
                    tooltip: "Limite de qualidade para detecção de características",
                },
                maxTrackError: {
                    label: "Erro Máximo de Rastreamento",
                    tooltip: "Limite máximo de erro de rastreamento",
                },
                minQuality: {
                    label: "Qualidade Mínima",
                    tooltip: "Qualidade mínima para exibir seta",
                },
                staticThreshold: {
                    label: "Limite Estático",
                    tooltip: "Movimento abaixo deste valor é considerado estático (HUD)",
                },
            },
        },
        status: {
            loadingOpenCv: "Carregando OpenCV...",
            stopAnalysis: "Parar Análise",
            analyzingPercent: "Analisando... {{pct}}%",
            creatingTrack: "Criando trilha...",
            buildingPanorama: "Construindo panorama...",
            buildingPanoramaPercent: "Construindo panorama... {{pct}}%",
            loadingFrame: "Carregando quadro {{frame}}... ({{current}}/{{total}})",
            loadingFrameSkipped: "Carregando quadro {{frame}}... ({{current}}/{{total}}) ({{skipped}} pulados)",
            renderingPercent: "Renderizando... {{pct}}%",
            panoPercent: "Panorama... {{pct}}%",
            renderingVideo: "Renderizando vídeo...",
            videoPercent: "Vídeo... {{pct}}%",
            saving: "Salvando...",
            buildingStabilization: "Construindo estabilização...",
            exportProgressTitle: "Exportando vídeo panorâmico...",
        },
        errors: {
            noVideoView: "Nenhuma visualização de vídeo encontrada.",
            noVideoData: "Nenhum dado de vídeo encontrado.",
            failedToLoadOpenCv: "Falha ao carregar OpenCV: {{message}}",
            noOriginTrack: "Nenhuma trilha de origem encontrada. É necessária uma trilha de alvo ou câmera para determinar a posição inicial.",
            videoEncodingUnsupported: "Codificação de vídeo não suportada neste navegador",
            exportFailed: "Falha na exportação de vídeo: {{reason}}",
            panoVideoExportFailed: "Falha na exportação do vídeo panorâmico: {{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[BETA] Extração de Texto",
            enable: {
                label: "Ativar Extração de Texto",
                disableLabel: "Desativar Extração de Texto",
                tooltip: "Alternar modo de extração de texto no vídeo",
            },
            addRegion: {
                label: "Adicionar Região",
                drawingLabel: "Clique e arraste no vídeo...",
                tooltip: "Clique e arraste no vídeo para definir uma região de extração de texto",
            },
            removeRegion: {
                label: "Remover Região Selecionada",
                tooltip: "Remover a região atualmente selecionada",
            },
            clearRegions: {
                label: "Limpar Todas as Regiões",
                tooltip: "Remover todas as regiões de extração de texto",
            },
            startExtract: {
                label: "Iniciar Extração",
                stopLabel: "Parar Extração",
                tooltip: "Executar OCR em todas as regiões do quadro atual até o final",
            },
            fixedWidthFont: {
                label: "Fonte de Largura Fixa",
                tooltip: "Ativar detecção caractere por caractere para fontes de largura fixa (melhor para sobreposições FLIR/sensor)",
            },
            numChars: {
                label: "Número de Caracteres",
                tooltip: "Número de caracteres na região selecionada (divide a região igualmente)",
            },
            learnTemplates: {
                label: "Aprender Modelos",
                activeLabel: "Clique nos caracteres para aprender...",
                tooltip: "Clique nas células de caracteres para ensinar seus valores (para correspondência de modelos)",
            },
            clearTemplates: {
                label: "Limpar Modelos",
                tooltip: "Remover todos os modelos de caracteres aprendidos",
            },
            useTemplates: {
                label: "Usar Modelos",
                tooltip: "Usar modelos aprendidos para correspondência (mais rápido e preciso quando treinado)",
            },
        },
        prompts: {
            learnCharacter: "Digite o caractere para a célula {{index}}:",
        },
        errors: {
            failedToLoadTesseract: "Falha ao carregar Tesseract.js. Certifique-se de que está instalado: npm install tesseract.js",
            noVideoView: "A extração de texto requer uma visualização de vídeo",
        },
    },
    custom: {
        settings: {
            title: "Configurações",
            tooltipLoggedIn: "Configurações por usuário salvas no servidor (com backup em cookie)",
            tooltipAnonymous: "Configurações por usuário salvas em cookies do navegador",
            language: { label: "Idioma", tooltip: "Selecionar idioma da interface. Alterar isso recarrega a página. Você perderá trabalho não salvo, então salve primeiro!" },
            maxDetails: { label: "Máximo de Detalhes", tooltip: "Nível máximo de detalhe para subdivisão de terreno (5-30)" },
            fpsLimit: { label: "Limite de Taxa de Quadros", tooltip: "Definir taxa máxima de quadros (60, 30, 20 ou 15 fps)" },
            tileSegments: { label: "Segmentos de Tile", tooltip: "Resolução de malha para tiles de terreno. Valores maiores = mais detalhe, porém mais lento" },
            maxResolution: { label: "Resolução Máxima", tooltip: "Resolução máxima do quadro de vídeo (lado mais longo). Reduz o uso de memória GPU. Aplica-se a quadros recém-carregados." },
            aiModel: { label: "Modelo de IA", tooltip: "Selecionar o modelo de IA para o assistente de chat" },
            centerSidebar: { label: "Barra Lateral Central", tooltip: "Ativar barra lateral central entre visualizações divididas (arraste menus para a linha divisória)" },
            showAttribution: { label: "Mostrar Atribuição", tooltip: "Mostrar sobreposição de atribuição de fontes de dados de mapa e elevação" },
        },
        balloons: {
            count: { label: "Quantidade", tooltip: "Número de estações próximas para importar" },
            source: { label: "Fonte", tooltip: "uwyo = Universidade de Wyoming (precisa de proxy PHP)\nigra2 = Arquivo NOAA NCEI (download direto)" },
            getNearby: { label: "Obter Balões Meteorológicos Próximos", tooltip: "Importar as N sondagens de balões meteorológicos mais próximas da posição atual da câmera.\nUsa o lançamento mais recente antes do horário de início do sitch + 1 hora." },
            importSounding: { label: "Importar Sondagem...", tooltip: "Seletor manual de estação: escolha estação, data, fonte e importe uma sondagem específica." },
        },
        showHide: {
            keyboardShortcuts: { label: "Atalhos de [T]eclado", tooltip: "Mostrar ou ocultar a sobreposição de atalhos de teclado" },
            toggleExtendToGround: { label: "Alternar TODAS as [E]xtensões ao Solo", tooltip: "Alternar 'Estender ao Solo' para todas as trilhas\nDesativará todas se alguma estiver ativada\nAtivará todas se nenhuma estiver ativada" },
            showAllTracksInLook: { label: "Mostrar Todas as Trilhas na Visualização de Câmera", tooltip: "Exibir todas as trilhas de aeronaves na visualização de câmera" },
            showCompassElevation: { label: "Mostrar Elevação da Bússola", tooltip: "Mostrar elevação da bússola (ângulo acima do plano do solo local) além do rumo (azimute)" },
            filterTracks: { label: "Filtrar Trilhas", tooltip: "Mostrar/ocultar trilhas com base em altitude, direção ou interseção com o frustum" },
            removeAllTracks: { label: "Remover Todas as Trilhas", tooltip: "Remover todas as trilhas da cena\nIsso não removerá os objetos, apenas as trilhas\nVocê pode adicioná-las novamente arrastando e soltando os arquivos" },
        },
        objects: {
            globalScale: { label: "Escala Global", tooltip: "Fator de escala aplicado a todos os objetos 3D na cena - útil para encontrar coisas. Defina de volta para 1 para tamanho real" },
        },
        admin: {
            dashboard: { label: "Painel Administrativo", tooltip: "Abrir o painel administrativo" },
            validateAllSitches: { label: "Validar Todos os Sitches", tooltip: "Carregar todos os sitches salvos com terreno local para verificar erros" },
            testUserID: { label: "ID de Usuário de Teste", tooltip: "Operar como este ID de usuário (0 = desabilitado, deve ser > 1)" },
            addMissingScreenshots: { label: "Adicionar Capturas de Tela Ausentes", tooltip: "Carregar cada sitch que não possui captura de tela, renderizar e enviar uma captura de tela" },
            feature: { label: "Destaque", tooltip: "Alternar o status de Destaque para o sitch carregado atualmente" },
        },
        viewPreset: { label: "Predefinição de Visualização", tooltip: "Alternar entre diferentes predefinições de visualização\nLado a lado, Superior e Inferior, etc." },
        subSitches: {
            folder: { tooltip: "Gerenciar múltiplas configurações de câmera/visualização dentro deste sitch" },
            updateCurrent: { label: "Atualizar Sub Atual", tooltip: "Atualizar o Sub Sitch selecionado atualmente com as configurações de visualização atuais" },
            updateAndAddNew: { label: "Atualizar Atual e Adicionar Novo Sub", tooltip: "Atualizar o Sub Sitch atual, depois duplicá-lo em um novo Sub Sitch" },
            discardAndAddNew: { label: "Descartar Alterações e Adicionar Novo", tooltip: "Descartar alterações no Sub Sitch atual e criar um novo Sub Sitch a partir do estado atual" },
            renameCurrent: { label: "Renomear Sub Atual", tooltip: "Renomear o Sub Sitch selecionado atualmente" },
            deleteCurrent: { label: "Excluir Sub Atual", tooltip: "Excluir o Sub Sitch selecionado atualmente" },
            syncSaveDetails: { label: "Sincronizar Detalhes de Salvamento do Sub", tooltip: "Remover do sub atual quaisquer nós não habilitados nos Detalhes de Salvamento do Sub" },
        },
        contextMenu: {
            setCameraAbove: "Posicionar Câmera Acima",
            setCameraOnGround: "Posicionar Câmera no Solo",
            setTargetAbove: "Posicionar Alvo Acima",
            setTargetOnGround: "Posicionar Alvo no Solo",
            dropPin: "Colocar Marcador / Adicionar Ponto",
            createTrackWithObject: "Criar Trilha com Objeto",
            createTrackNoObject: "Criar Trilha (Sem Objeto)",
            addBuilding: "Adicionar Edifício",
            addClouds: "Adicionar Nuvens",
            addGroundOverlay: "Adicionar Sobreposição de Solo",
            centerTerrain: "Centralizar quadrado de Terreno aqui",
            googleMapsHere: "Google Maps Aqui",
            googleEarthHere: "Google Earth Aqui",
            removeClosestPoint: "Remover Ponto Mais Próximo",
            exitEditMode: "Sair do Modo de Edição",
        },
    },
    view3d: {
        northUp: { label: "Visualização Norte Acima", tooltip: "Definir a visualização de câmera com o norte para cima, em vez do mundo para cima.\nPara visualizações de satélite e similares, olhando diretamente para baixo.\nNão se aplica no modo PTZ" },
        atmosphere: { label: "Atmosfera", tooltip: "Atenuação por distância que mescla terreno e objetos 3D em direção à cor atual do céu" },
        atmoVisibility: { label: "Visibilidade Atmosférica (km)", tooltip: "Distância onde o contraste atmosférico cai para cerca de 50% (menor = atmosfera mais densa)" },
        atmoHDR: { label: "HDR Atmosférico", tooltip: "Névoa/mapeamento de tons HDR fisicamente baseado para reflexos brilhantes do sol através da neblina" },
        atmoExposure: { label: "Exposição Atmosférica", tooltip: "Multiplicador de exposição do mapeamento de tons HDR atmosférico para atenuação de realces" },
        startXR: { label: "Iniciar VR/XR", tooltip: "Iniciar sessão WebXR para teste (funciona com Immersive Web Emulator)" },
        effects: { label: "Efeitos", tooltip: "Ativar/Desativar Todos os Efeitos" },
        focusTrack: { label: "Trilha de Foco", tooltip: "Selecionar uma trilha para fazer a câmera olhar para ela e rotacionar ao redor" },
        lockTrack: { label: "Travar Trilha", tooltip: "Selecionar uma trilha para travar a câmera nela, fazendo-a mover-se com a trilha" },
        debug: {
            clearBackground: "Limpar Fundo", renderSky: "Renderizar Céu", renderDaySky: "Renderizar Céu Diurno",
            renderMainScene: "Renderizar Cena Principal", renderEffects: "Renderizar Efeitos", copyToScreen: "Copiar para Tela",
            updateCameraMatrices: "Atualizar Matrizes da Câmera", mainUseLookLayers: "Principal Usar Camadas de Visualização",
            sRGBOutputEncoding: "Codificação de Saída sRGB", tileLoadDelay: "Atraso no Carregamento de Tile (s)",
            updateStarScales: "Atualizar Escalas das Estrelas", updateSatelliteScales: "Atualizar Escalas dos Satélites",
            renderNightSky: "Renderizar Céu Noturno", renderFullscreenQuad: "Renderizar Quadrante em Tela Cheia", renderSunSky: "Renderizar Céu Solar",
        },
        celestial: {
            raHours: "AR (horas)", decDegrees: "Dec (graus)", magnitude: "Magnitude",
            noradNumber: "Número NORAD", name: "Nome",
        },
    },
    nightSky: {
        loadLEO: { label: "Carregar Satélites LEO para a Data", tooltip: "Obter os dados TLE mais recentes de satélites LEO para a data/hora definida no simulador. Isso baixará os dados da internet, podendo levar alguns segundos.\nTambém ativará a exibição dos satélites no céu noturno." },
        loadStarlink: { label: "Carregar Starlink ATUAIS", tooltip: "Obter as posições ATUAIS (não históricas, agora, em tempo real) dos satélites Starlink. Isso baixará os dados da internet, podendo levar alguns segundos.\n" },
        loadActive: { label: "Carregar Satélites ATIVOS", tooltip: "Obter as posições ATUAIS (não históricas, agora, em tempo real) dos satélites ATIVOS. Isso baixará os dados da internet, podendo levar alguns segundos.\n" },
        loadSlow: { label: "(Experimental) Carregar Satélites LENTOS", tooltip: "Obter os dados TLE mais recentes de satélites LENTOS para a data/hora definida no simulador. Isso baixará os dados da internet, podendo levar alguns segundos.\nTambém ativará a exibição dos satélites no céu noturno. Pode expirar para datas recentes" },
        loadAll: { label: "(Experimental) Carregar TODOS os Satélites", tooltip: "Obter os dados TLE mais recentes de TODOS os satélites para a data/hora definida no simulador. Isso baixará os dados da internet, podendo levar alguns segundos.\nTambém ativará a exibição dos satélites no céu noturno. Pode expirar para datas recentes" },
        flareAngle: { label: "Ângulo de Dispersão do Flare", tooltip: "Ângulo máximo do vetor de visão refletido para que um flare seja visível\ni.e. a faixa de ângulos entre o vetor do satélite ao sol e o vetor da câmera ao satélite refletido na parte inferior do satélite (que é paralela ao solo)" },
        penumbraDepth: { label: "Profundidade da Penumbra Terrestre", tooltip: "Profundidade vertical em metros sobre a qual um satélite desaparece gradualmente ao entrar na sombra da Terra" },
        sunAngleArrows: { label: "Setas do Ângulo Solar", tooltip: "Quando um reflexo é detectado, mostrar setas da câmera ao satélite e do satélite ao sol" },
        celestialFolder: { tooltip: "Itens relacionados ao céu noturno" },
        vectorsOnTraverse: { label: "Vetores no Objeto de Travessia", tooltip: "Se marcado, os vetores são mostrados relativos ao objeto de travessia. Caso contrário, são mostrados relativos à câmera de visualização." },
        vectorsInLookView: { label: "Vetores na Visualização de Câmera", tooltip: "Se marcado, os vetores são mostrados na Visualização de Câmera. Caso contrário, apenas na visualização principal." },
        showSatellitesGlobal: { label: "Mostrar Satélites (Global)", tooltip: "Controle mestre: mostrar ou ocultar todos os satélites" },
        showStarlink: { label: "Starlink", tooltip: "Mostrar satélites SpaceX Starlink" },
        showISS: { label: "ISS", tooltip: "Mostrar a Estação Espacial Internacional" },
        celestrackBrightest: { label: "Mais Brilhantes do Celestrack", tooltip: "Mostrar a lista de satélites mais brilhantes do Celestrack" },
        otherSatellites: { label: "Outros Satélites", tooltip: "Mostrar satélites não incluídos nas categorias acima" },
        list: { label: "Lista", tooltip: "Mostrar lista de texto dos satélites visíveis" },
        satelliteArrows: { label: "Setas de Satélite", tooltip: "Mostrar setas indicando trajetórias dos satélites" },
        flareLines: { label: "Linhas de Flare", tooltip: "Mostrar linhas conectando satélites em flare à câmera e ao Sol" },
        satelliteGroundArrows: { label: "Setas de Solo dos Satélites", tooltip: "Mostrar setas apontando para o solo abaixo de cada satélite" },
        satelliteLabelsLook: { label: "Rótulos de Satélite (Visualização de Câmera)", tooltip: "Mostrar rótulos com nomes dos satélites na visualização de câmera" },
        satelliteLabelsMain: { label: "Rótulos de Satélite (Visualização Principal)", tooltip: "Mostrar rótulos com nomes dos satélites na visualização 3D principal" },
        labelFlaresOnly: { label: "Rotular Apenas Flares", tooltip: "Rotular apenas satélites que estão atualmente em flare" },
        labelLitOnly: { label: "Rotular Apenas Iluminados", tooltip: "Rotular apenas satélites iluminados pelo sol (não na sombra da Terra)" },
        labelLookVisibleOnly: { label: "Rotular Apenas Visíveis na Câmera", tooltip: "Rotular apenas satélites visíveis no frustum da câmera de visualização" },
        flareRegion: { label: "Região de Flare", tooltip: "Mostrar a região do céu onde flares de satélite são visíveis" },
        flareBand: { label: "Faixa de Flare", tooltip: "Mostrar a faixa no solo onde flares de uma trilha de satélite varrem" },
        filterTLEs: { label: "Filtrar TLEs", tooltip: "Filtrar satélites visíveis por altitude, posição, parâmetros orbitais ou nome" },
        clearTLEFilter: { label: "Limpar Filtro TLE", tooltip: "Remover todos os filtros espaciais/orbitais de TLE, restaurando visibilidade baseada em categoria" },
        maxLabelsDisplayed: { label: "Máximo de Rótulos Exibidos", tooltip: "Número máximo de rótulos de satélite a renderizar de uma vez" },
        starBrightness: { label: "Brilho das Estrelas", tooltip: "Fator de escala para o brilho das estrelas. 1 é normal, 0 é invisível, 2 é o dobro de brilho, etc." },
        starLimit: { label: "Limite de Estrelas", tooltip: "Limite de brilho para que as estrelas sejam exibidas" },
        planetBrightness: { label: "Brilho dos Planetas", tooltip: "Fator de escala para o brilho dos planetas (exceto Sol e Lua). 1 é normal, 0 é invisível, 2 é o dobro de brilho, etc." },
        lockStarPlanetBrightness: { label: "Travar Brilho Estrela-Planeta", tooltip: "Quando marcado, os controles deslizantes de Brilho das Estrelas e Brilho dos Planetas ficam travados juntos" },
        satBrightness: { label: "Brilho dos Satélites", tooltip: "Fator de escala para o brilho dos satélites. 1 é normal, 0 é invisível, 2 é o dobro de brilho, etc." },
        flareBrightness: { label: "Brilho do Flare", tooltip: "Fator de escala para o brilho adicional de satélites em flare. 0 é nada" },
        satCutOff: { label: "Corte de Satélite", tooltip: "Satélites atenuados a este nível ou menos não serão exibidos" },
        displayRange: { label: "Alcance de Exibição (km)", tooltip: "Satélites além desta distância não terão seus nomes ou setas exibidos" },
        equatorialGrid: { label: "Grade Equatorial", tooltip: "Mostrar a grade de coordenadas equatoriais celestes" },
        constellationLines: { label: "Linhas de Constelação", tooltip: "Mostrar linhas conectando estrelas em constelações" },
        renderStars: { label: "Renderizar Estrelas", tooltip: "Mostrar estrelas no céu noturno" },
        equatorialGridLook: { label: "Grade Equatorial na Visualização de Câmera", tooltip: "Mostrar a grade equatorial na visualização de câmera" },
        flareRegionLook: { label: "Região de Flare na Visualização de Câmera", tooltip: "Mostrar o cone de região de flare na visualização de câmera" },
        satelliteEphemeris: { label: "Efemérides do Satélite" },
        skyPlot: { label: "Mapa do Céu" },
        celestialVector: { label: "Vetor de {{name}}", tooltip: "Mostrar um vetor de direção apontando para {{name}}" },
    },
    synthClouds: {
        name: { label: "Nome" },
        visible: { label: "Visível" },
        editMode: { label: "Modo de Edição" },
        altitude: { label: "Altitude" },
        radius: { label: "Raio" },
        cloudSize: { label: "Tamanho da Nuvem" },
        density: { label: "Densidade" },
        opacity: { label: "Opacidade" },
        brightness: { label: "Brilho" },
        depth: { label: "Profundidade" },
        edgeWiggle: { label: "Ondulação da Borda" },
        edgeFrequency: { label: "Frequência da Borda" },
        seed: { label: "Semente" },
        feather: { label: "Suavização" },
        windMode: { label: "Modo de Vento" },
        windFrom: { label: "Vento De (\u00b0)" },
        windKnots: { label: "Vento (nós)" },
        deleteClouds: { label: "Excluir Nuvens" },
    },
    synthBuilding: {
        name: { label: "Nome" },
        visible: { label: "Visível" },
        editMode: { label: "Modo de Edição" },
        roofEdgeHeight: { label: "Altura da Borda do Telhado" },
        ridgelineHeight: { label: "Altura da Cumeeira" },
        ridgelineInset: { label: "Recuo da Cumeeira" },
        roofEaves: { label: "Beirais do Telhado" },
        type: { label: "Tipo" },
        wallColor: { label: "Cor da Parede" },
        roofColor: { label: "Cor do Telhado" },
        opacity: { label: "Opacidade" },
        transparent: { label: "Transparente" },
        wireframe: { label: "Wireframe" },
        depthTest: { label: "Teste de Profundidade" },
        deleteBuilding: { label: "Excluir Edifício" },
    },

    groundOverlay: {
        name: { label: "Nome" },
        visible: { label: "Visível" },
        editMode: { label: "Modo de Edição" },
        lockShape: { label: "Travar Forma" },
        freeTransform: { label: "Transformação Livre" },
        showBorder: { label: "Mostrar Borda" },
        properties: { label: "Propriedades" },
        imageURL: { label: "URL da Imagem" },
        rehostLocalImage: { label: "Rehospedar Imagem Local" },
        north: { label: "Norte" },
        south: { label: "Sul" },
        east: { label: "Leste" },
        west: { label: "Oeste" },
        rotation: { label: "Rotação" },
        altitude: { label: "Altitude (pés)" },
        wireframe: { label: "Wireframe" },
        opacity: { label: "Opacidade" },
        cloudExtraction: { label: "Extração de Nuvens" },
        extractClouds: { label: "Extrair Nuvens" },
        cloudColor: { label: "Cor da Nuvem" },
        fuzziness: { label: "Difusão" },
        feather: { label: "Suavização" },
        gotoOverlay: { label: "Ir para Sobreposição" },
        deleteOverlay: { label: "Excluir Sobreposição" },
    },

    videoView: {
        folders: {
            videoAdjustments: "Ajustes de Vídeo",
            videoProcessing: "Processamento de Vídeo",
            forensics: "Forense",
            errorLevelAnalysis: "Análise de Nível de Erro",
            noiseAnalysis: "Análise de Ruído",
            grid: "Grade",
        },
        currentVideo: { label: "Vídeo Atual" },
        videoRotation: { label: "Rotação do Vídeo" },
        setCameraToExifGps: { label: "Definir Câmera para GPS EXIF" },
        expandOutput: {
            label: "Expandir Saída",
            tooltip: "Método para expandir a faixa dinâmica da saída ELA",
        },
        displayMode: {
            label: "Modo de Exibição",
            tooltip: "Como visualizar os resultados da análise de ruído",
        },
        convolutionFilter: {
            label: "Filtro de Convolução",
            tooltip: "Tipo de filtro de convolução espacial a aplicar",
        },
        resetVideoAdjustments: {
            label: "Redefinir Ajustes de Vídeo",
            tooltip: "Redefinir todos os ajustes de vídeo para seus valores padrão",
        },
        makeVideo: {
            label: "Criar Vídeo",
            tooltip: "Exportar o vídeo processado com todos os efeitos atuais aplicados",
        },
        gridShow: {
            label: "Mostrar",
            tooltip: "Mostrar uma sobreposição de grade no vídeo",
        },
        gridSize: {
            label: "Tamanho",
            tooltip: "Tamanho da célula da grade em pixels",
        },
        gridSubdivisions: {
            label: "Subdivisões",
            tooltip: "Número de subdivisões dentro de cada célula da grade",
        },
        gridXOffset: {
            label: "Deslocamento X",
            tooltip: "Deslocamento horizontal da grade em pixels",
        },
        gridYOffset: {
            label: "Deslocamento Y",
            tooltip: "Deslocamento vertical da grade em pixels",
        },
        gridColor: {
            label: "Cor",
            tooltip: "Cor das linhas da grade",
        },
    },

    floodSim: {
        flood: {
            label: "Inundação",
            tooltip: "Ativar ou desativar a simulação de partículas de inundação",
        },
        floodRate: {
            label: "Taxa de Inundação",
            tooltip: "Número de partículas geradas por quadro",
        },
        sphereSize: {
            label: "Tamanho da Esfera",
            tooltip: "Raio visual de cada partícula de água",
        },
        dropRadius: {
            label: "Raio de Queda",
            tooltip: "Raio ao redor do ponto de queda onde as partículas são geradas",
        },
        maxParticles: {
            label: "Máximo de Partículas",
            tooltip: "Número máximo de partículas de água ativas",
        },
        method: {
            label: "Método",
            tooltip: "Método de simulação: HeightMap (grade), Fast (partículas) ou PBF (fluidos baseados em posição)",
        },
        waterSource: {
            label: "Fonte de Água",
            tooltip: "Chuva: adicionar água ao longo do tempo. Rompimento de Barragem: manter o nível de água na altitude alvo dentro do raio de queda",
        },
        speed: {
            label: "Velocidade",
            tooltip: "Passos de simulação por quadro (1-20x)",
        },
        manningN: {
            label: "N de Manning",
            tooltip: "Rugosidade do leito: 0.01=liso, 0.03=canal natural, 0.05=planície aluvial rugosa, 0.1=vegetação densa",
        },
        edge: {
            label: "Borda",
            tooltip: "Bloqueio: a água reflete nas bordas da grade. Drenagem: a água flui para fora e é removida",
        },
        waterColor: {
            label: "Cor da Água",
            tooltip: "Cor da água",
        },
        reset: {
            label: "Redefinir",
            tooltip: "Remover todas as partículas e reiniciar a simulação",
        },
    },

    flowOrbs: {
        number: {
            label: "Número",
            tooltip: "Número de orbes de fluxo a exibir. Mais orbes podem afetar o desempenho.",
        },
        spreadMethod: {
            label: "Método de Distribuição",
            tooltip: "Método para distribuir orbes ao longo do vetor de visão da câmera. \n'Alcance' distribui orbes uniformemente ao longo do vetor de visão entre distâncias próxima e distante. \n'Altitude' distribui orbes uniformemente ao longo do vetor de visão, entre as altitudes absolutas baixa e alta (MSL)",
        },
        near: {
            label: "Próximo (m)",
            tooltip: "Distância mais próxima da câmera para posicionamento de orbes",
        },
        far: {
            label: "Distante (m)",
            tooltip: "Distância mais distante da câmera para posicionamento de orbes",
        },
        high: { label: "Alto (m)" },
        low: { label: "Baixo (m)" },
        colorMethod: {
            label: "Método de Cor",
            tooltip: "Método para determinar a cor das orbes de fluxo. \n'Aleatório' atribui uma cor aleatória a cada orbe. \n'Usuário' atribui uma cor selecionada pelo usuário a todas as orbes. \n'Matiz por Altitude' atribui uma cor baseada na altitude da orbe. \n'Matiz por Distância' atribui uma cor baseada na distância da orbe à câmera.",
        },
        userColor: {
            label: "Cor do Usuário",
            tooltip: "Selecionar uma cor para as orbes de fluxo quando o 'Método de Cor' está definido como 'Usuário'.",
        },
        hueRange: {
            label: "Faixa de Matiz",
            tooltip: "Faixa sobre a qual se obtém um espectro completo de cores para o método de cor 'Matiz por Altitude/Alcance'.",
        },
        windWhilePaused: {
            label: "Vento com Simulação Pausada",
            tooltip: "Se marcado, o vento ainda afetará as orbes de fluxo mesmo quando a simulação estiver pausada. Útil para visualizar padrões de vento.",
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
            label: "Mostrar",
        },
        seriesLock: {
            label: "Travar",
        },
        removeTrack: {
            label: "Remover Trilha",
        },
        folderTitle: {
            label: "Rastreador OSD",
            tooltip: "Rastreador de texto na tela (On-Screen Display) para texto por quadro definido pelo usuário",
        },
        addNewTrack: {
            label: "Adicionar Nova Série de Dados OSD",
            tooltip: "Criar uma nova série de dados OSD para sobreposição de texto por quadro",
        },
        makeTrack: {
            label: "Criar Trilha",
            tooltip: "Criar uma trilha de posição a partir de séries de dados OSD visíveis/desbloqueadas (MGRS ou Lat/Lon)",
        },
        showAll: {
            label: "Mostrar Todos",
            tooltip: "Alternar visibilidade de todas as séries de dados OSD",
        },
        exportAllData: {
            label: "Exportar Todos os Dados",
            tooltip: "Exportar todas as séries de dados OSD como CSVs em um arquivo ZIP",
        },
        graphShow: {
            label: "Mostrar",
            tooltip: "Mostrar ou ocultar a visualização do gráfico de dados OSD",
        },
        xAxis: {
            label: "Eixo X",
            tooltip: "Série de dados para o eixo horizontal",
        },
        y1Axis: {
            label: "Eixo Y1",
            tooltip: "Série de dados para o eixo vertical esquerdo",
        },
        y2Axis: {
            label: "Eixo Y2",
            tooltip: "Série de dados para o eixo vertical direito",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "Exibição de Informações do Vídeo",
            tooltip: "Controles de exibição de informações do vídeo para contador de quadros, timecode e carimbo de tempo",
        },
        showVideoInfo: {
            label: "Mostrar Informações do Vídeo",
            tooltip: "Controle mestre - ativar ou desativar todas as exibições de informações do vídeo",
        },
        frameCounter: {
            label: "Contador de Quadros",
            tooltip: "Mostrar o número do quadro atual",
        },
        offsetFrame: {
            label: "Quadro com Deslocamento",
            tooltip: "Mostrar o número do quadro atual mais um valor de deslocamento",
        },
        offsetValue: {
            label: "Valor de Deslocamento",
            tooltip: "Valor de deslocamento adicionado ao número do quadro atual",
        },
        timecode: {
            label: "Timecode",
            tooltip: "Mostrar timecode no formato HH:MM:SS:FF",
        },
        timestamp: {
            label: "Carimbo de Tempo",
            tooltip: "Mostrar carimbo de tempo no formato HH:MM:SS.SS",
        },
        dateLocal: {
            label: "Data (Local)",
            tooltip: "Mostrar data atual no fuso horário selecionado",
        },
        timeLocal: {
            label: "Hora (Local)",
            tooltip: "Mostrar hora atual no fuso horário selecionado",
        },
        dateTimeLocal: {
            label: "Data e Hora (Local)",
            tooltip: "Mostrar data e hora completas no fuso horário selecionado",
        },
        dateUTC: {
            label: "Data (UTC)",
            tooltip: "Mostrar data atual em UTC",
        },
        timeUTC: {
            label: "Hora (UTC)",
            tooltip: "Mostrar hora atual em UTC",
        },
        dateTimeUTC: {
            label: "Data e Hora (UTC)",
            tooltip: "Mostrar data e hora completas em UTC",
        },
        fontSize: {
            label: "Tamanho da Fonte",
            tooltip: "Ajustar o tamanho da fonte do texto de informações",
        },
    },

    terrainUI: {
        mapType: {
            label: "Tipo de Mapa",
            tooltip: "Tipo de mapa para texturas de terreno (separado dos dados de elevação)",
        },
        elevationType: {
            label: "Tipo de Elevação",
            tooltip: "Fonte de dados de elevação para dados de altura do terreno",
        },
        lat: {
            tooltip: "Latitude do centro do terreno",
        },
        lon: {
            tooltip: "Longitude do centro do terreno",
        },
        zoom: {
            tooltip: "Nível de zoom do terreno. 2 é o mundo inteiro, 15 são poucos quarteirões da cidade",
        },
        nTiles: {
            tooltip: "Número de tiles no terreno. Mais tiles significa mais detalhe, mas carregamento mais lento. (NxN)",
        },
        refresh: {
            label: "Atualizar",
            tooltip: "Atualizar o terreno com as configurações atuais. Use para falhas de rede que possam ter causado um carregamento falho",
        },
        debugGrids: {
            label: "Grades de Depuração",
            tooltip: "Mostrar uma grade de texturas do solo (Verde) e dados de elevação (Azul)",
        },
        elevationScale: {
            tooltip: "Fator de escala para os dados de elevação. 1 é normal, 0.5 é metade da altura, 2 é o dobro da altura",
        },
        terrainOpacity: {
            label: "Opacidade do Terreno",
            tooltip: "Opacidade do terreno. 0 é totalmente transparente, 1 é totalmente opaco",
        },
        textureDetail: {
            tooltip: "Nível de detalhe para subdivisão de textura. Valores maiores = mais detalhe. 1 é normal, 0.5 é menos detalhe, 2 é mais detalhe",
        },
        elevationDetail: {
            tooltip: "Nível de detalhe para subdivisão de elevação. Valores maiores = mais detalhe. 1 é normal, 0.5 é menos detalhe, 2 é mais detalhe",
        },
        disableDynamicSubdivision: {
            label: "Desativar Subdivisão Dinâmica",
            tooltip: "Desativar subdivisão dinâmica de tiles de terreno. Congela o terreno no nível de detalhe atual. Útil para depuração.",
        },
        dynamicSubdivision: {
            label: "Subdivisão Dinâmica",
            tooltip: "Usar subdivisão adaptativa de tiles baseada na câmera para visualização em escala de globo",
        },
        showBuildings: {
            label: "Edifícios 3D",
            tooltip: "Mostrar tiles de edifícios 3D do Cesium Ion ou Google",
        },
        buildingEdges: {
            label: "Arestas de Edifícios",
            tooltip: "Mostrar arestas em wireframe nos tiles de edifícios 3D",
        },
        oceanSurface: {
            label: "Superfície Oceânica (Beta)",
            tooltip: "Experimental: renderizar superfície de água ao nível do mar (MSL EGM96 fixo) enquanto tiles fotorrealísticos do Google estão ativos",
        },
        buildingsSource: {
            label: "Fonte de Edifícios",
            tooltip: "Fonte de dados para tiles de edifícios 3D",
        },
        useEllipsoid: {
            label: "Usar Modelo de Terra Elipsoidal",
            tooltip: "Esfera: modelo legado rápido. Elipsoide: forma WGS84 precisa (latitudes mais altas se beneficiam mais).",
        },
        layer: {
            label: "Camada",
            tooltip: "Camada para as texturas de terreno do tipo de mapa atual",
        },
    },

    displayTrack: {
        visible: {
            tooltip: "Mostrar ou ocultar esta trilha",
        },
        extendToGround: {
            label: "Estender ao Solo",
            tooltip: "Desenhar linhas verticais da trilha ao solo",
        },
        displayStep: {
            label: "Passo de Exibição",
            tooltip: "Passo de quadro entre pontos de trilha exibidos (1 = todo quadro)",
        },
        contrail: {
            label: "Rastro de Condensação",
            tooltip: "Mostrar uma fita de rastro de condensação atrás desta trilha, ajustada para o vento",
        },
        contrailSecs: {
            label: "Duração do Rastro (s)",
            tooltip: "Duração do rastro de condensação em segundos",
        },
        contrailWidth: {
            label: "Largura do Rastro (m)",
            tooltip: "Largura máxima da fita do rastro de condensação em metros",
        },
        contrailInitialWidth: {
            label: "Largura Inicial do Rastro (m)",
            tooltip: "Largura do rastro de condensação no ponto de exaustão em metros",
        },
        contrailRamp: {
            label: "Rampa do Rastro (m)",
            tooltip: "Distância sobre a qual a largura do rastro de condensação aumenta em metros",
        },
        contrailSpread: {
            label: "Dispersão do Rastro (m/s)",
            tooltip: "Taxa de expansão do rastro de condensação em m/s",
        },
        lineColor: {
            label: "Cor da Linha",
            tooltip: "Cor da linha da trilha",
        },
        polyColor: {
            label: "Cor do Polígono",
            tooltip: "Cor dos polígonos de extensão vertical ao solo",
        },
        altLockAGL: {
            label: "Travar Alt AGL",
        },
        gotoTrack: {
            label: "Ir para trilha",
            tooltip: "Centralizar a câmera principal na localização desta trilha",
        },
    },

    ptzUI: {
        panAz: {
            label: "Pan (Az)",
            tooltip: "Azimute / ângulo de panorâmica da câmera em graus",
        },
        tiltEl: {
            label: "Inclinação (El)",
            tooltip: "Elevação / ângulo de inclinação da câmera em graus",
        },
        zoomFov: {
            label: "Zoom (fov)",
            tooltip: "Campo de visão vertical da câmera em graus",
        },
        roll: {
            label: "Rolagem",
            tooltip: "Ângulo de rolagem da câmera em graus",
        },
        xOffset: {
            label: "xOffset",
            tooltip: "Deslocamento horizontal da câmera em relação ao centro",
        },
        yOffset: {
            label: "yOffset",
            tooltip: "Deslocamento vertical da câmera em relação ao centro",
        },
        nearPlane: {
            label: "Plano Próximo (m)",
            tooltip: "Distância do plano de corte próximo da câmera em metros",
        },
        relative: {
            label: "Relativo",
            tooltip: "Usar ângulos relativos em vez de absolutos",
        },
        satellite: {
            label: "Satélite",
            tooltip: "Modo satélite: panorâmica no espaço de tela a partir do nadir.\nRolagem = direção, Az = esquerda/direita, El = cima/baixo (-90 = nadir)",
        },
        rotation: {
            label: "Rotação",
            tooltip: "Rotação no espaço de tela ao redor do eixo de visão da câmera",
        },
    },

    nodes3dObject: {
        modelOrGeometry: {
            label: "Modelo ou Geometria",
            tooltip: "Selecionar se deve usar um Modelo 3D ou uma geometria gerada para este objeto",
        },
        model: {
            label: "Modelo",
            tooltip: "Selecionar um Modelo 3D para usar neste objeto",
        },
        displayBoundingBox: {
            label: "Exibir Caixa Delimitadora",
            tooltip: "Exibir a caixa delimitadora do objeto com dimensões",
        },
        forceAboveSurface: {
            label: "Forçar Acima da Superfície",
            tooltip: "Forçar o objeto a ficar completamente acima da superfície do solo",
        },
        exportToKML: {
            label: "Exportar para KML",
            tooltip: "Exportar este objeto 3D como arquivo KML para Google Earth",
        },
        startAnalysis: {
            label: "Iniciar Análise",
            tooltip: "Lançar raios da câmera para encontrar direções de reflexão",
        },
        gridSize: {
            label: "Tamanho da Grade",
            tooltip: "Número de pontos de amostra por eixo para a grade de reflexão",
        },
        cleanUp: {
            label: "Limpar",
            tooltip: "Remover todas as setas de análise de reflexão da cena",
        },
    },

    trackingOverlay: {
        showTracking: {
            label: "Mostrar Rastreamento",
            tooltip: "Mostrar ou ocultar os pontos de rastreamento e a sobreposição de curva",
        },
        reset: {
            label: "Redefinir",
            tooltip: "Redefinir o rastreamento manual para um estado vazio, removendo todos os keyframes e itens arrastáveis",
        },
        limitAB: {
            label: "Limitar AB",
            tooltip: "Limitar os quadros A e B ao intervalo dos keyframes de rastreamento de vídeo. Isso impedirá a extrapolação além do primeiro e último keyframes, o que nem sempre é desejado.",
        },
        curveType: {
            label: "Tipo de Curva",
            tooltip: "Spline usa spline cúbica natural. Spline2 usa spline not-a-knot para comportamento mais suave nas extremidades. Linear usa segmentos de linha reta. Perspectiva requer exatamente 3 keyframes e modela movimento linear com projeção perspectiva.",
        },
        minimizeGroundSpeed: {
            label: "Minimizar Velocidade de Solo",
            tooltip: "Encontrar a Distância Inicial do Alvo que minimiza a distância de solo percorrida pelo caminho de travessia",
        },
        minimizeAirSpeed: {
            label: "Minimizar Velocidade do Ar",
            tooltip: "Encontrar a Distância Inicial do Alvo que minimiza a distância aérea percorrida (considerando o vento do alvo)",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "Quadrilátero de Solo do Frustum",
            tooltip: "Mostrar a interseção do frustum da câmera com o solo",
        },
        videoInFrustum: {
            label: "Vídeo no Frustum",
            tooltip: "Projetar o vídeo no plano distante do frustum da câmera",
        },
        videoOnGround: {
            label: "Vídeo no Solo",
            tooltip: "Projetar o vídeo no solo",
        },
        groundVideoInLookView: {
            label: "Vídeo de Solo na Visualização de Câmera",
            tooltip: "Mostrar o vídeo projetado no solo na visualização de câmera",
        },
        matchVideoAspect: {
            label: "Corresponder Proporção do Vídeo",
            tooltip: "Cortar a visualização de câmera para corresponder à proporção do vídeo e ajustar o frustum de acordo",
        },
        videoOpacity: {
            label: "Opacidade do Vídeo",
            tooltip: "Opacidade da sobreposição de vídeo projetado",
        },
    },

    labels3d: {
        measurements: {
            label: "Medições",
            tooltip: "Mostrar rótulos e setas de medição de distância e ângulo",
        },
        labelsInMain: {
            label: "Rótulos na Principal",
            tooltip: "Mostrar rótulos de trilha/objeto na visualização 3D principal",
        },
        labelsInLook: {
            label: "Rótulos na Câmera",
            tooltip: "Mostrar rótulos de trilha/objeto na visualização de câmera",
        },
        featuresInMain: {
            label: "Marcadores/Pinos na Principal",
            tooltip: "Mostrar marcadores (pinos) na visualização 3D principal",
        },
        featuresInLook: {
            label: "Marcadores na Câmera",
            tooltip: "Mostrar marcadores na visualização de câmera",
        },
    },

    losFitPhysics: {
        folder: "Resultados do Ajuste Físico",
        model: {
            label: "Modelo",
        },
        avgError: {
            label: "Erro Médio (rad)",
        },
        windSpeed: {
            label: "Velocidade do Vento (nós)",
        },
        windFrom: {
            label: "Vento De (\u00B0)",
        },
    },

    misbData: {
        startTime: {
            label: "Horário de Início",
            tooltip: "Substituir horário de início (ex: '10:30', 'Jan 15', '2024-01-15T10:30:00Z'). Deixe em branco para o horário de início global.",
        },
        enableFilter: {
            label: "Ativar Filtro",
        },
        tryAltitudeFirst: {
            label: "Tentar Altitude Primeiro",
        },
        maxG: {
            label: "G Máximo",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "Acima do Nível do Solo",
            tooltip: "A altitude é relativa ao nível do solo, não ao nível do mar",
        },
        lookup: {
            label: "Buscar",
            tooltip: "Insira um nome de lugar, coordenadas lat,lon ou MGRS para se mover",
        },
        geolocate: {
            label: "Geolocalizar pelo navegador",
            tooltip: "Usar a API de geolocalização do navegador para definir sua posição atual",
        },
        goTo: {
            label: "Ir para a posição acima",
            tooltip: "Mover terreno e câmera para a latitude/longitude/altitude inserida",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "Parar Em",
            tooltip: "Parar o movimento do alvo da câmera neste quadro, mesmo se a trilha do alvo continuar. Útil para simular a perda de travamento em um alvo em movimento. Defina como 0 para desativar.",
        },
        horizonMethod: {
            label: "Método do Horizonte",
        },
        lookFOV: {
            label: "FOV da Câmera",
        },
        celestialObject: {
            label: "Objeto Celeste",
            tooltip: "Nome do corpo celeste que a câmera rastreia (ex: Lua, Vênus, Júpiter)",
        },
    },

    spriteGroup: {
        visible: {
            label: "Visível",
            tooltip: "Mostrar ou ocultar as orbes de fluxo",
        },
        size: {
            label: "Tamanho (m)",
            tooltip: "Diâmetro em metros.",
        },
        viewSizeMultiplier: {
            label: "Multiplicador de Tamanho da Visualização",
            tooltip: "Ajusta o tamanho das orbes de fluxo na visualização principal, mas não altera o tamanho em outras visualizações.",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "Melhor Ângulo, 180 completos, refinado",
        },
        bestAngle5: {
            label: "Melhor ângulo dentro de 5\u00B0 do atual",
        },
    },

    misc: {
        snapshotCamera: {
            label: "Capturar Câmera",
            tooltip: "Salvar a posição e direção atuais da câmera para uso com 'Redefinir Câmera'",
        },
        resetCamera: {
            label: "Redefinir Câmera",
            tooltip: "Redefinir a câmera para o padrão ou para a última posição e direção capturadas\nTambém Numpad-.",
        },
        showMoonShadow: {
            label: "Mostrar Sombra da Lua",
            tooltip: "Alternar a exibição do cone de sombra da Lua para visualização de eclipses.",
        },
        shadowSegments: {
            label: "Segmentos da Sombra",
            tooltip: "Número de segmentos no cone de sombra (mais = mais suave, porém mais lento)",
        },
        showEarthShadow: {
            label: "Mostrar Sombra da Terra",
            tooltip: "Alternar a exibição do cone de sombra da Terra no céu noturno.",
        },
        earthShadowAltitude: {
            label: "Altitude da Sombra da Terra",
            tooltip: "Distância do centro da Terra ao plano no qual renderizar o cone de sombra da Terra (em metros).",
        },
        exportTLE: {
            label: "Exportar TLE",
        },
        backgroundFlowIndicator: {
            label: "Indicador de Fluxo de Fundo",
            tooltip: "Exibir uma seta indicando quanto o fundo se moverá no próximo quadro.\nÚtil para sincronizar a simulação com o vídeo (use Visualização/Sobreposição de Vídeo)",
        },
        defaultSnap: {
            label: "Encaixe Padrão",
            tooltip: "Quando ativado, os pontos se encaixarão no alinhamento horizontal por padrão ao arrastar.\nSegure Shift (ao arrastar) para fazer o oposto",
        },
        recalcNodeGraph: {
            label: "Recalcular Grafo de Nós",
        },
        downloadVideo: {
            label: "Baixar Vídeo",
        },
        banking: {
            label: "Inclinação",
            tooltip: "Como o objeto se inclina durante curvas",
        },
        angularTraverse: {
            label: "Travessia Angular",
        },
        smoothingMethod: {
            label: "Método de Suavização",
            tooltip: "Algoritmo usado para suavizar os dados da trilha da câmera",
        },
        showInLookView: {
            label: "Mostrar na visualização de câmera",
        },
        windFrom: {
            tooltip: "Direção verdadeira de ONDE o vento sopra (0=Norte, 90=Leste)",
        },
        windKnots: {
            tooltip: "Velocidade do vento em nós",
        },
        fetchWind: {
            tooltip: "Obter dados reais de vento de serviços meteorológicos para esta localização e horário",
        },
        debugConsole: {
            label: "Console de Depuração",
            tooltip: "Console de Depuração",
        },
        aiAssistant: {
            label: "Assistente de IA",
        },
        hide: {
            label: "Ocultar",
            tooltip: "Ocultar esta visualização de canvas com abas\nPara mostrá-la novamente, use o menu 'Mostrar/Ocultar -> Visualizações'.",
        },
        notes: {
            label: "Notas",
            tooltip: "Mostrar/Ocultar o editor de notas. As notas são salvas com o sitch e podem conter hyperlinks clicáveis.",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "Linhas de Visada",
            tooltip: "Mostrar linhas de visada da câmera ao alvo (alternar: O)",
        },
        physicalPointer: {
            label: "Ponteiro Físico",
        },
        jet: {
            label: "[J]ato",
        },
        horizonGrid: {
            label: "Grade do [H]orizonte",
        },
        wingPlaneGrid: {
            label: "Grade do Plano da [A]sa",
        },
        sphericalBoresightGrid: {
            label: "Grade [E]sférica de Mira",
        },
        azimuthElevationGrid: {
            label: "Grade de [A]zimute/Elevação",
        },
        frustumOfCamera: {
            label: "F[R]ustum da câmera",
        },
        trackLine: {
            label: "Linha de [T]rilha",
        },
        globe: {
            label: "[G]lobo",
        },
        showErrorCircle: {
            label: "Mostrar Círculo de Erro",
        },
        glareSprite: {
            label: "Spr[I]te de Reflexo",
        },
        cameraViewFrustum: {
            label: "Frustum da Visualização da Câmera",
            tooltip: "Mostrar o frustum de visualização da câmera na cena 3D",
        },
        zaineTriangulation: {
            label: "Triangulação de Zaine",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "Intensidade Ambiente",
            tooltip: "Intensidade da luz ambiente. 0 é sem luz ambiente, 1 é luz ambiente normal, 2 é o dobro da luz ambiente",
        },
        irAmbientIntensity: {
            label: "Intensidade Ambiente IR",
            tooltip: "Intensidade da luz ambiente IR (usada para viewports IR)",
        },
        sunIntensity: {
            label: "Intensidade do Sol",
            tooltip: "Intensidade da luz solar. 0 é sem luz solar, 1 é luz solar normal completa, 2 é o dobro da luz solar",
        },
        sunScattering: {
            label: "Dispersão Solar",
            tooltip: "Quantidade de dispersão da luz solar",
        },
        sunBoost: {
            label: "Impulso Solar (HDR)",
            tooltip: "Multiplicador da intensidade da luz direcional do sol (HDR). Aumenta o brilho dos realces especulares para reflexos solares realistas através da névoa.",
        },
        sceneExposure: {
            label: "Exposição da Cena (HDR)",
            tooltip: "Compensação de exposição para mapeamento de tons HDR. Reduza para compensar um impulso solar maior.",
        },
        ambientOnly: {
            label: "Apenas Ambiente",
            tooltip: "Se verdadeiro, apenas a luz ambiente é usada, sem luz solar",
        },
        daylightSky: {
            label: "Céu diurno",
            tooltip: "Renderiza o céu diurno (azul).\nDesativar para remover a contribuição do céu diurno — útil para ver as estrelas durante o dia ou depurar objetos do céu noturno.",
        },
        noMainLighting: {
            label: "Sem Iluminação na Visualização Principal",
            tooltip: "Se verdadeiro, nenhuma iluminação é usada na visualização principal.\nÚtil para depuração, mas não recomendado para uso normal",
        },
        noCityLights: {
            label: "Sem Luzes de Cidade no Globo",
            tooltip: "Se verdadeiro, não renderizar as luzes das cidades no globo.",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "Replay ADSB para este horário e localização",
            tooltip: "Gerar um link para o ADSB Exchange Replay",
        },
        googleMapsLink: {
            label: "Google Maps para esta localização",
            tooltip: "Criar um link do Google Maps para a localização atual",
        },
        inTheSkyLink: {
            label: "In-The-Sky para este horário e localização",
            tooltip: "Criar um link do In The Sky para a localização atual",
        },
    },
    nodeLabels: {
        // As chaves devem corresponder ao ID do nó (chave de propriedade nos dados do sitch),
        // NÃO ao texto de descrição. Quando nenhum id explícito é definido, desc se torna o id.
        focus: "Desfoque",
        canvasResolution: "Resolução",
        "Noise Amount": "Quantidade de Ruído",
        "TV In Black": "TV Preto de Entrada",
        "TV In White": "TV Branco de Entrada",
        "TV Gamma": "TV Gama",
        "Tv Out Black": "TV Preto de Saída",
        "Tv Out White": "TV Branco de Saída",
        "JPEG Artifacts": "Artefatos JPEG",
        pixelZoom: "Zoom de Pixel %",
        videoBrightness: "Brilho",
        videoContrast: "Contraste",
        videoBlur: "Quantidade de Desfoque",
        videoSharpenAmount: "Quantidade de Nitidez",
        videoGreyscale: "Escala de Cinza",
        videoHue: "Mudança de Matiz",
        videoInvert: "Inverter",
        videoSaturate: "Saturação",
        startDistanceGUI: "Distância Inicial",
        targetVCGUI: "Velocidade Vertical do Alvo",
        targetSpeedGUI: "Velocidade do Alvo",
        lockWind: "Travar Vento do Alvo ao Local",
        jetTAS: "TAS",
        turnRate: "Taxa de Curva",
        totalTurn: "Curva Total",
        jetHeadingManual: "Rumo do Jato",
        headingSmooth: "Suavização de Rumo",
        turnRateControl: "Controle de Taxa de Curva",
        cameraSmoothWindow: "Janela de Suavização da Câmera",
        targetSmoothWindow: "Janela de Suavização do Alvo",
        cameraFOV: "FOV da Câmera",
        "Tgt Start Dist": "Distância Inicial do Alvo",
        "Target Speed": "Velocidade do Alvo",
        "Tgt Relative Heading": "Rumo Relativo do Alvo",
        "KF Process": "Processo KF",
        "KF Noise": "Ruído KF",
        "MC Num Trials": "Número de Tentativas MC",
        "MC LOS Uncertainty (deg)": "Incerteza MC da LOS (graus)",
        "MC Polynomial Order": "Ordem do Polinômio MC",
        "Physics Max Iterations": "Iterações Máximas de Física",
        "Physics Wind Speed (kt)": "Velocidade do Vento Física (nós)",
        "Physics Wind From (°)": "Vento Físico De (°)",
        "Physics Initial Range (m)": "Alcance Inicial Físico (m)",
        "Tgt Start Altitude": "Altitude Inicial do Alvo",
        "Tgt Vert Spd": "Vel. Vertical do Alvo",
        "Cloud Altitude": "Altitude da Nuvem",
    },
};

export default pt;
