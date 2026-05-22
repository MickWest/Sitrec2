const zh = {
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "选择旧版情景和工具\n部分旧版情景默认在此处有控制选项",
            noTooltip: "此情景未定义提示",
            legacySitches: {
                label: "旧版情景",
                tooltip: "旧版情景是较早的内置（硬编码）情景，即预定义的场景，通常包含独特的代码和资源。选择一个以加载。",
            },
            legacyTools: {
                label: "旧版工具",
                tooltip: "工具是用于自定义设置（如 Starlink）、用户轨迹以及测试、调试或其他特殊用途的特殊情景。选择一个以加载。",
            },
            selectPlaceholder: "-选择-",
        },
        file: {
            title: "文件",
            tooltip: "文件操作，如保存、加载和导出",
        },
        view: {
            title: "视图",
            tooltip: "其他视图控制\n与所有菜单一样，此菜单可以从菜单栏拖出成为浮动菜单",
        },
        video: {
            title: "视频",
            tooltip: "视频调整、效果和分析",
        },
        time: {
            title: "时间",
            tooltip: "时间和帧控制\n将一个时间滑块拖过末尾会影响上面的滑块\n请注意时间滑块使用 UTC",
        },
        objects: {
            title: "对象",
            tooltip: "3D 对象及其属性\n每个文件夹代表一个对象。traverseObject 是沿视线遍历的对象，即我们关注的 UAP",
            addObject: {
                label: "添加对象",
                tooltip: "在指定坐标处创建一个新对象",
                prompt: "输入：[名称] 纬度 经度 [高度]\n示例：\n  MyObject 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Landmark 37.7749 -122.4194",
                invalidInput: "输入无效。请按以下格式输入坐标：\n[名称] 纬度 经度 [高度]",
            },
        },
        satellites: {
            title: "卫星",
            tooltip: "加载和控制卫星\n卫星功能。\nStarlink、ISS 等。地平线闪光和其他卫星效果的控制",
        },
        terrain: {
            title: "地形",
            tooltip: "地形控制\n地形是地面的 3D 模型。“地图”是地面的 2D 图像。“高程”是地面相对海平面的高度",
        },
        physics: {
            title: "物理",
            tooltip: "物理控制\n场景的物理属性，如风速和遍历对象的物理特性",
        },
        camera: {
            title: "相机",
            tooltip: "观察视图相机控制\n观察视图默认在右下角窗口，用于匹配视频。",
        },
        target: {
            title: "目标",
            tooltip: "目标控制\n可选目标对象的位置和属性",
        },
        traverse: {
            title: "遍历",
            tooltip: "遍历控制\n遍历对象是沿视线遍历的对象，即我们关注的 UAP\n此菜单定义遍历对象的移动和行为方式",
        },
        showHide: {
            title: "显示/隐藏",
            tooltip: "显示或隐藏视图、对象和其他元素",
            views: {
                title: "视图",
                tooltip: "显示或隐藏视图（窗口），如观察视图、视频、主视图，以及叠加层如 MQ9UI",
            },
            graphs: {
                title: "图表",
                tooltip: "显示或隐藏各种图表",
            },
        },
        effects: {
            title: "效果",
            tooltip: "应用于观察视图最终图像的特殊效果，如模糊、像素化和颜色调整",
        },
        lighting: {
            title: "光照",
            tooltip: "场景光照，如太阳光和环境光",
        },
        contents: {
            title: "内容",
            tooltip: "场景内容，主要用于轨迹",
        },
        help: {
            title: "帮助",
            tooltip: "文档链接和其他帮助资源",
            documentation: {
                title: "文档",
                localTooltip: "文档链接（本地）",
                githubTooltip: "Github 上的文档链接",
                githubLinkLabel: "{{name}}（Github）",
                about: "关于 Sitrec",
                whatsNew: "最新动态",
                uiBasics: "用户界面基础",
                savingLoading: "保存和加载情景",
                customSitch: "如何设置情景",
                tracks: "轨迹和数据源",
                gis: "GIS 和地图",
                starlink: "如何调查 Starlink 闪光",
                customModels: "对象和 3D 模型（飞机）",
                cameraModes: "相机模式（普通和卫星）",
                thirdPartyNotices: "第三方声明",
                thirdPartyNoticesTooltip: "捆绑的第三方软件的开源许可证声明",
                downloadBridge: "下载 MCP Bridge",
                downloadBridgeTooltip: "下载 SitrecBridge MCP 服务器 + Chrome 扩展（无依赖，仅需 Node.js）",
            },
            externalLinks: {
                title: "外部链接",
                tooltip: "外部帮助链接",
            },
            exportDebugLog: {
                label: "导出调试日志",
                tooltip: "将所有控制台输出（日志、警告、错误）下载为文本文件用于调试",
            },
        },
        debug: {
            title: "调试",
            tooltip: "调试工具和监控\nGPU 内存使用、性能指标和其他调试信息",
        },
    },
    file: {
        newSitch: {
            label: "新建情景",
            tooltip: "创建新的情景（将重新加载此页面，重置所有内容）",
        },
        savingDisabled: "保存已禁用（点击登录）",
        importFile: {
            label: "导入文件",
            tooltip: "从本地系统导入一个或多个文件。与将文件拖放到浏览器窗口相同",
        },
        server: {
            open: "打开",
            save: {
                label: "保存",
                tooltip: "将当前情景保存到服务器",
            },
            saveAs: {
                label: "另存为",
                tooltip: "以新名称将当前情景保存到服务器",
            },
            versions: {
                label: "版本",
                tooltip: "加载当前选定情景的特定版本",
            },
            browseFeatured: "浏览推荐情景",
            browseAll: "在可搜索、可排序的列表中浏览所有已保存的情景",
        },
        local: {
            title: "本地",
            titleWithFolder: "本地：{{name}}",
            titleReconnect: "本地：{{name}}（重新连接）",
            status: "状态",
            noFileSelected: "未选择本地文件",
            noFolderSelected: "未选择文件夹",
            currentFile: "当前文件：{{name}}",
            statusDesktop: "当前本地桌面文件/保存状态",
            statusFolder: "当前本地文件夹/保存状态",
            stateReady: "就绪",
            stateReconnect: "需要重新连接",
            stateNoFolder: "无文件夹",
            statusLine: "{{state}} | 文件夹：{{folder}} | 目标：{{target}}",
            saveLocal: {
                label: "本地保存",
                tooltipDesktop: "保存到当前本地文件，如需要则提示输入文件名",
                tooltipFolder: "保存到工作文件夹（如未设置则提示选择位置）",
                tooltipSaveBack: "回存到 {{name}}",
                tooltipSaveBackInFolder: "回存到 {{folder}} 中的 {{name}}",
                tooltipSaveInto: "保存到 {{folder}}（提示输入情景名称）",
                tooltipPrompt: "保存本地情景文件（提示输入名称/位置）",
                tooltipSaveTo: "将当前情景保存到本地文件",
            },
            saveLocalAs: {
                label: "本地另存为...",
                tooltipDesktop: "将本地情景文件保存到新路径",
                tooltipFolder: "保存本地情景文件，选择位置",
                tooltipInFolder: "以新文件名保存到当前工作文件夹",
                tooltipNewPath: "将当前情景保存到新的本地文件路径",
            },
            openLocal: {
                label: "打开本地情景",
                labelShort: "打开本地...",
                tooltipDesktop: "从磁盘打开本地情景文件",
                tooltipFolder: "从当前工作文件夹打开情景文件",
                tooltipCurrent: "打开其他本地情景文件（当前：{{name}}）",
                tooltipFromFolder: "从 {{folder}} 打开情景文件",
            },
            selectFolder: {
                label: "选择本地情景文件夹",
                tooltip: "选择用于本地保存/加载操作的工作文件夹",
            },
            reconnectFolder: {
                label: "重新连接文件夹",
                tooltip: "重新授权访问之前使用的工作文件夹",
            },
        },
        debug: {
            recalculateAll: "调试：全部重新计算",
            dumpNodes: "调试：转储节点",
            dumpNodesBackwards: "调试：反向转储节点",
            dumpRoots: "调试：转储根节点",
        },
    },
    videoExport: {
        notAvailable: "视频导出不可用",
        folder: {
            title: "视频渲染与导出",
            tooltip: "从 Sitrec 视图或完整视口渲染和导出视频文件的选项",
        },
        renderView: {
            label: "渲染视频视图",
            tooltip: "选择要导出为视频的视图",
        },
        renderSingleVideo: {
            label: "渲染单视图视频",
            tooltip: "将选定视图导出为包含所有帧的视频文件",
        },
        videoFormat: {
            label: "视频格式",
            tooltip: "选择输出视频格式",
        },
        renderViewport: {
            label: "渲染视口视频",
            tooltip: "将整个视口导出为包含所有帧的视频文件",
        },
        renderFullscreen: {
            label: "渲染全屏视频",
            tooltip: "将整个视口以全屏模式导出为包含所有帧的视频文件",
        },
        recordWindow: {
            label: "录制浏览器窗口",
            tooltip: "以锁定帧率录制整个浏览器窗口（包括菜单和界面）为视频",
        },
        retinaExport: {
            label: "使用 HD/Retina 导出",
            tooltip: "以 Retina/HiDPI 分辨率导出（大多数显示器为 2 倍）",
        },
        includeAudio: {
            label: "包含音频",
            tooltip: "如有可用的源视频音轨，则包含音频",
        },
        waitForLoading: {
            label: "等待后台加载",
            tooltip: "启用后，渲染会在捕获每帧之前等待地形/建筑/背景加载完成",
        },
        exportFrame: {
            label: "导出视频帧",
            tooltip: "将当前显示的视频帧（包含效果）导出为 PNG 文件",
        },
    },
    tracking: {
        enable: {
            label: "启用自动跟踪",
            disableLabel: "禁用自动跟踪",
            tooltip: "切换视频上自动跟踪光标的显示",
        },
        start: {
            label: "开始自动跟踪",
            stopLabel: "停止自动跟踪",
            tooltip: "在视频播放时自动跟踪光标内的对象",
        },
        clearFromHere: {
            label: "从此处清除",
            tooltip: "清除从当前帧到末尾的所有跟踪位置",
        },
        clearTrack: {
            label: "清除轨迹",
            tooltip: "清除所有自动跟踪位置并重新开始",
        },
        stabilize: {
            label: "稳定",
            tooltip: "应用自动跟踪位置以稳定视频",
        },
        stabilizeToggle: {
            enableLabel: "启用稳定",
            disableLabel: "禁用稳定",
            tooltip: "切换视频稳定开/关",
        },
        stabilizeCenters: {
            label: "稳定中心",
            tooltip: "勾选时，稳定点固定在视图中心。取消勾选时，保持在初始位置。",
        },
        renderStabilized: {
            label: "渲染稳定视频",
            tooltip: "以原始尺寸导出稳定视频（跟踪点保持固定，边缘可能显示黑色）",
        },
        renderStabilizedExpanded: {
            label: "渲染扩展稳定视频",
            tooltip: "以扩展画布导出稳定视频，确保不丢失像素",
        },
        trackRadius: {
            label: "跟踪半径",
            tooltip: "要匹配的模板大小（对象大小）",
        },
        searchRadius: {
            label: "搜索半径",
            tooltip: "从上一位置搜索的距离（快速运动时增大）",
        },
        trackingMethod: {
            label: "跟踪方法",
            tooltip: "模板匹配 (OpenCV) 或光流法 (jsfeat Lucas-Kanade)",
        },
        centerOnBright: {
            label: "以亮点为中心",
            tooltip: "跟踪亮像素质心（更适合星星/点光源）",
        },
        centerOnDark: {
            label: "以暗点为中心",
            tooltip: "跟踪暗像素质心",
        },
        brightnessThreshold: {
            label: "亮度阈值",
            tooltip: "亮度阈值（0-255）。用于以亮点/暗点为中心模式",
        },
        status: {
            loadingJsfeat: "正在加载 jsfeat...",
            loadingOpenCv: "正在加载 OpenCV...",
            sam2Connecting: "SAM2：正在连接...",
            sam2Uploading: "SAM2：正在上传...",
        },
    },
    trackManager: {
        removeTrack: "移除轨迹",
        createSpline: "创建样条",
        editTrack: "编辑轨迹",
        constantSpeed: "恒定速度",
        extrapolateTrack: "外推轨迹",
        curveType: "曲线类型",
        altLockAGL: "高度锁定 AGL",
        deleteTrack: "删除轨迹",
    },
    gpuMonitor: {
        enabled: "启用监控",
        total: "总内存",
        geometries: "几何体",
        textures: "纹理",
        peak: "峰值内存",
        average: "平均内存",
        reset: "重置历史",
    },
    situationSetup: {
        mainFov: {
            label: "主视图 FOV",
            tooltip: "主视图相机视场角（垂直）",
        },
        lookCameraFov: "观察相机 FOV",
        azimuth: "方位角",
        jetPitch: "飞机俯仰角",
    },
    featureManager: {
        labelText: "标签文本",
        latitude: "纬度",
        longitude: "经度",
        altitude: "高度 (m)",
        arrowLength: "箭头长度",
        arrowColor: "箭头颜色",
        textColor: "文本颜色",
        deleteFeature: "删除要素",
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "导出观察全景",
            tooltip: "根据背景位置，从所有帧的观察视图创建全景图像",
        },
    },
    dateTime: {
        liveMode: {
            label: "实时模式",
            tooltip: "如果开启实时模式，播放将始终与当前时间同步。\n暂停或拖动时间将禁用实时模式",
        },
        startTime: {
            tooltip: "视频第一帧的开始时间，UTC 格式",
        },
        currentTime: {
            tooltip: "视频的当前时间。以下日期和时间即指此值",
        },
        year: { label: "年", tooltip: "当前帧的年份" },
        month: { label: "月", tooltip: "月份（1-12）" },
        day: { label: "日", tooltip: "日期" },
        hour: { label: "时", tooltip: "小时（0-23）" },
        minute: { label: "分", tooltip: "分钟（0-59）" },
        second: { label: "秒", tooltip: "秒（0-59）" },
        millisecond: { label: "毫秒", tooltip: "毫秒（0-999）" },
        useTimeZone: {
            label: "在界面中使用时区",
            tooltip: "在上方界面中使用时区\n这将把日期和时间更改为选定时区而非 UTC。\n适用于显示特定时区的日期和时间，例如视频所在地或拍摄地点的当地时区。",
        },
        timeZone: {
            label: "时区",
            tooltip: "在观察视图中显示日期和时间所用的时区\n如果勾选了“在界面中使用时区”，则也用于界面显示",
        },
        simSpeed: {
            label: "模拟速度",
            tooltip: "模拟速度，1 为实时，2 为两倍速等\n这不会改变视频回放速度，仅影响模拟的时间计算。",
        },
        sitchFrames: {
            label: "情景帧数",
            tooltip: "情景中的帧数。如果有视频则为视频帧数，但你可以更改它以添加更多帧，或在不使用视频时使用",
        },
        sitchDuration: {
            label: "情景时长",
            tooltip: "情景时长，格式为 HH:MM:SS.sss",
        },
        aFrame: {
            label: "A 帧",
            tooltip: "限制播放在 A 和 B 之间，在帧滑块上分别显示为绿色和红色",
        },
        bFrame: {
            label: "B 帧",
            tooltip: "限制播放在 A 和 B 之间，在帧滑块上分别显示为绿色和红色",
        },
        videoFps: {
            label: "视频 FPS",
            tooltip: "视频的每秒帧数。这将改变视频的播放速度（例如 30 fps、25 fps 等）。同时也会改变情景的时长（以秒为单位），因为它改变了单帧的持续时间\n这通常从视频中自动获取，但你可以手动更改以加速或减速视频",
        },
        syncTimeTo: {
            label: "同步时间到",
            tooltip: "将视频开始时间同步到原始开始时间、当前时间或轨迹的开始时间（如已加载）",
        },
    },
    jet: {
        frames: {
            time: {
                label: "时间（秒）",
                tooltip: "从视频开始的当前时间（秒）（帧 / fps）",
            },
            frame: {
                label: "视频中的帧",
                tooltip: "视频中的当前帧号",
            },
            paused: {
                label: "已暂停",
                tooltip: "切换暂停状态（也可使用空格键）",
            },
        },
        controls: {
            pingPong: "A-B 往返",
            podPitchPhysical: "吊舱（球）俯仰",
            podRollPhysical: "吊舱头部横滚",
            deroFromGlare: "去旋转 = 眩光角度",
            jetPitch: "飞机俯仰角",
            lookFov: "窄视场角",
            elevation: "仰角",
            glareStartAngle: "眩光起始角度",
            initialGlareRotation: "眩光初始旋转",
            scaleJetPitch: "随横滚缩放飞机俯仰角",
            horizonMethod: "地平线方法",
            horizonMethodOptions: {
                humanHorizon: "人眼地平线",
                horizonAngle: "地平线角度",
            },
            videoSpeed: "视频速度",
            podWireframe: "[B] 后吊舱线框",
            showVideo: "[V] 视频",
            showGraph: "[G] 图表",
            showKeyboardShortcuts: "[K] 键盘快捷键",
            showPodHead: "[P] 吊舱头部横滚",
            showPodsEye: "吊舱 [E] 视角（含去旋转）",
            showLookCam: "[N]AR 视图（含去旋转）",
            showCueData: "[C] 提示数据",
            showGlareGraph: "显示眩光图表 [O]",
            showAzGraph: "显示方位角图表 [Z]",
            declutter: "[D] 简化显示",
            jetOffset: "飞机 Y 偏移",
            tas: "TAS 真空速",
            integrate: "积分步数",
        },
    },
    motionAnalysis: {
        menu: {
            title: "运动分析",
            analyzeMotion: {
                label: "分析运动",
                tooltip: "切换视频上的实时运动分析叠加层",
            },
            createTrack: {
                label: "从运动创建轨迹",
                tooltip: "分析所有帧并从运动矢量创建地面轨迹",
            },
            alignWithFlow: {
                label: "对齐运动方向",
                tooltip: "旋转图像使运动方向水平",
            },
            panorama: {
                title: "全景",
                exportImage: {
                    label: "导出运动全景",
                    tooltip: "使用运动跟踪偏移从视频帧创建全景图像",
                },
                exportVideo: {
                    label: "导出全景视频",
                    tooltip: "创建 4K 视频，显示带有视频帧叠加的全景",
                },
                stabilize: {
                    label: "稳定视频",
                    disableLabel: "禁用稳定",
                    tooltip: "使用全局运动分析稳定视频（消除相机抖动）",
                },
                panoFrameStep: {
                    label: "全景帧步长",
                    tooltip: "每个全景帧之间的帧步长数（1 = 每帧）",
                },
                crop: {
                    label: "全景裁剪",
                    tooltip: "从视频帧每条边裁剪的像素数",
                },
                useMask: {
                    label: "在全景中使用遮罩",
                    tooltip: "渲染全景时将运动跟踪遮罩应用为透明度",
                },
                analyzeWithEffects: {
                    label: "带效果分析",
                    tooltip: "将视频调整（对比度等）应用到运动分析所用的帧",
                },
                exportWithEffects: {
                    label: "带效果导出",
                    tooltip: "将视频调整应用到全景导出",
                },
                removeOuterBlack: {
                    label: "移除外部黑边",
                    tooltip: "将每行边缘的黑色像素设为透明",
                },
            },
            trackingParameters: {
                title: "跟踪参数",
                technique: {
                    label: "技术",
                    tooltip: "运动估计算法",
                },
                frameSkip: {
                    label: "帧跳过",
                    tooltip: "比较之间的帧数（更高 = 检测更慢的运动）",
                },
                trackletLength: {
                    label: "轨迹片段长度",
                    tooltip: "轨迹片段中的帧数（更长 = 更严格的一致性）",
                },
                blurSize: {
                    label: "模糊大小",
                    tooltip: "宏观特征的高斯模糊（奇数）",
                },
                minMotion: {
                    label: "最小运动",
                    tooltip: "最小运动幅度（像素/帧）",
                },
                maxMotion: {
                    label: "最大运动",
                    tooltip: "最大运动幅度",
                },
                smoothing: {
                    label: "平滑",
                    tooltip: "方向平滑（更高 = 更多平滑）",
                },
                minVectorCount: {
                    label: "最小矢量数",
                    tooltip: "有效帧的最小运动矢量数量",
                },
                minConfidence: {
                    label: "最小置信度",
                    tooltip: "有效帧的最小共识置信度",
                },
                maxFeatures: {
                    label: "最大特征数",
                    tooltip: "最大跟踪特征数量",
                },
                minDistance: {
                    label: "最小距离",
                    tooltip: "特征之间的最小距离",
                },
                qualityLevel: {
                    label: "质量级别",
                    tooltip: "特征检测质量阈值",
                },
                maxTrackError: {
                    label: "最大跟踪误差",
                    tooltip: "最大跟踪误差阈值",
                },
                minQuality: {
                    label: "最小质量",
                    tooltip: "显示箭头的最小质量",
                },
                staticThreshold: {
                    label: "静态阈值",
                    tooltip: "低于此值的运动被视为静态 (HUD)",
                },
            },
        },
        status: {
            loadingOpenCv: "正在加载 OpenCV...",
            stopAnalysis: "停止分析",
            analyzingPercent: "正在分析... {{pct}}%",
            creatingTrack: "正在创建轨迹...",
            buildingPanorama: "正在构建全景...",
            buildingPanoramaPercent: "正在构建全景... {{pct}}%",
            loadingFrame: "正在加载帧 {{frame}}...（{{current}}/{{total}}）",
            loadingFrameSkipped: "正在加载帧 {{frame}}...（{{current}}/{{total}}）（已跳过 {{skipped}} 帧）",
            renderingPercent: "正在渲染... {{pct}}%",
            panoPercent: "全景... {{pct}}%",
            renderingVideo: "正在渲染视频...",
            videoPercent: "视频... {{pct}}%",
            saving: "正在保存...",
            buildingStabilization: "正在构建稳定化...",
            exportProgressTitle: "正在导出全景视频...",
        },
        errors: {
            noVideoView: "未找到视频视图。",
            noVideoData: "未找到视频数据。",
            failedToLoadOpenCv: "加载 OpenCV 失败：{{message}}",
            noOriginTrack: "未找到原点轨迹。需要目标或相机轨迹来确定起始位置。",
            videoEncodingUnsupported: "此浏览器不支持视频编码",
            exportFailed: "视频导出失败：{{reason}}",
            panoVideoExportFailed: "全景视频导出失败：{{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[测试版] 文字提取",
            enable: {
                label: "启用文字提取",
                disableLabel: "禁用文字提取",
                tooltip: "切换视频上的文字提取模式",
            },
            addRegion: {
                label: "添加区域",
                drawingLabel: "在视频上点击并拖动...",
                tooltip: "在视频上点击并拖动以定义文字提取区域",
            },
            removeRegion: {
                label: "移除选中区域",
                tooltip: "移除当前选中的区域",
            },
            clearRegions: {
                label: "清除所有区域",
                tooltip: "移除所有文字提取区域",
            },
            startExtract: {
                label: "开始提取",
                stopLabel: "停止提取",
                tooltip: "从当前帧到末尾对所有区域运行 OCR",
            },
            fixedWidthFont: {
                label: "等宽字体",
                tooltip: "启用等宽字体的逐字符检测（更适合 FLIR/传感器叠加层）",
            },
            numChars: {
                label: "字符数",
                tooltip: "选中区域中的字符数（均匀分割区域）",
            },
            learnTemplates: {
                label: "学习模板",
                activeLabel: "点击字符以学习...",
                tooltip: "点击字符单元格以教授其值（用于模板匹配）",
            },
            clearTemplates: {
                label: "清除模板",
                tooltip: "移除所有已学习的字符模板",
            },
            useTemplates: {
                label: "使用模板",
                tooltip: "使用已学习的模板进行匹配（训练后更快更准确）",
            },
        },
        prompts: {
            learnCharacter: "输入单元格 {{index}} 的字符：",
        },
        errors: {
            failedToLoadTesseract: "加载 Tesseract.js 失败。请确保已安装：npm install tesseract.js",
            noVideoView: "文字提取需要视频视图",
        },
    },
    custom: {
        settings: {
            title: "设置",
            tooltipLoggedIn: "每用户设置保存到服务器（带 cookie 备份）",
            tooltipAnonymous: "每用户设置保存在浏览器 cookie 中",
            language: { label: "语言", tooltip: "选择界面语言。更改后将重新加载页面。未保存的工作将丢失，请先保存！" },
            maxDetails: { label: "最大细节级别", tooltip: "地形细分的最大细节级别（5-30）" },
            fpsLimit: { label: "帧率限制", tooltip: "设置最大帧率（60、30、20 或 15 fps）" },
            tileSegments: { label: "瓦片分段", tooltip: "地形瓦片的网格分辨率。更高的值 = 更多细节但更慢" },
            maxResolution: { label: "最大分辨率", tooltip: "最大视频帧分辨率（长边）。减少 GPU 内存使用。适用于新加载的帧。" },
            aiModel: { label: "AI 模型", tooltip: "选择聊天助手的 AI 模型" },
            centerSidebar: { label: "居中侧边栏", tooltip: "在分屏视图之间启用居中侧边栏（将菜单拖到分割线上）" },
            showAttribution: { label: "显示归属信息", tooltip: "显示地图和高程数据源归属叠加层" },
        },
        balloons: {
            count: { label: "数量", tooltip: "要导入的附近站点数量" },
            source: { label: "数据源", tooltip: "uwyo = 怀俄明大学（需要 PHP 代理）\nigra2 = NOAA NCEI 存档（直接下载）" },
            getNearby: { label: "获取附近气象气球", tooltip: "导入距当前相机位置最近的 N 个气象气球探空数据。\n使用情景开始时间 + 1 小时之前最近一次发射的数据。" },
            importSounding: { label: "导入探空数据...", tooltip: "手动选择站点：选择站点、日期、数据源，并导入特定的探空数据。" },
        },
        showHide: {
            keyboardShortcuts: { label: "[K] 键盘快捷键", tooltip: "显示或隐藏键盘快捷键叠加层" },
            toggleExtendToGround: { label: "切换所有 [E] 延伸到地面", tooltip: "切换所有轨迹的“延伸到地面”选项\n如果有任何打开的则全部关闭\n如果全部关闭则全部打开" },
            showAllTracksInLook: { label: "在观察视图中显示所有轨迹", tooltip: "在观察/相机视图中显示所有飞行器轨迹" },
            showCompassElevation: { label: "显示罗盘仰角", tooltip: "除方位角（水平角）外，还显示罗盘仰角（相对于当地地平面的角度）" },
            filterTracks: { label: "筛选轨迹", tooltip: "根据高度、方向或视锥体交叉筛选显示/隐藏轨迹" },
            removeAllTracks: { label: "移除所有轨迹", tooltip: "从场景中移除所有轨迹\n这不会移除对象，只移除轨迹\n之后可以通过重新拖放文件来添加" },
        },
        objects: {
            globalScale: { label: "全局缩放", tooltip: "应用于场景中所有 3D 对象的缩放系数 - 有助于查找物体。设回 1 为真实大小" },
        },
        admin: {
            dashboard: { label: "管理面板", tooltip: "打开管理面板" },
            validateAllSitches: { label: "验证所有情景", tooltip: "加载所有使用本地地形保存的情景以检查错误" },
            testUserID: { label: "测试用户 ID", tooltip: "以此用户 ID 操作（0 = 禁用，必须 > 1）" },
            addMissingScreenshots: { label: "添加缺失截图", tooltip: "加载每个没有截图的情景，渲染并上传截图" },
            feature: { label: "推荐", tooltip: "切换当前加载情景的推荐状态" },
        },
        viewPreset: { label: "视图预设", tooltip: "在不同视图预设之间切换\n左右并排、上下排列等" },
        subSitches: {
            folder: { tooltip: "管理此情景中的多个相机/视图配置" },
            updateCurrent: { label: "更新当前子情景", tooltip: "用当前视图设置更新当前选中的子情景" },
            updateAndAddNew: { label: "更新当前并添加新子情景", tooltip: "更新当前子情景，然后复制为新的子情景" },
            discardAndAddNew: { label: "放弃更改并添加新子情景", tooltip: "放弃对当前子情景的更改，并从当前状态创建新的子情景" },
            renameCurrent: { label: "重命名当前子情景", tooltip: "重命名当前选中的子情景" },
            deleteCurrent: { label: "删除当前子情景", tooltip: "删除当前选中的子情景" },
            syncSaveDetails: { label: "同步子情景保存详情", tooltip: "从当前子情景中移除未在子情景保存详情中启用的节点" },
        },
        contextMenu: {
            setCameraAbove: "将相机设在上方",
            setCameraOnGround: "将相机设在地面",
            setTargetAbove: "将目标设在上方",
            setTargetOnGround: "将目标设在地面",
            dropPin: "放置图钉 / 添加要素",
            createTrackWithObject: "创建轨迹（带对象）",
            createTrackNoObject: "创建轨迹（无对象）",
            addBuilding: "添加建筑",
            addClouds: "添加云层",
            addGroundOverlay: "添加地面叠加层",
            centerTerrain: "将地形方块居中于此",
            googleMapsHere: "在此打开 Google Maps",
            googleEarthHere: "在此打开 Google Earth",
            removeClosestPoint: "移除最近的点",
            exitEditMode: "退出编辑模式",
        },
    },
    view3d: {
        northUp: { label: "观察视图朝北", tooltip: "将观察视图设为朝北而非世界向上方向。\n适用于卫星视图及类似的垂直俯瞰场景。\n不适用于 PTZ 模式" },
        atmosphere: { label: "大气", tooltip: "将地形和 3D 对象向当前天空颜色混合的距离衰减效果" },
        atmoVisibility: { label: "大气能见度 (km)", tooltip: "大气对比度降至约 50% 的距离（越小 = 大气越浓密）" },
        atmoHDR: { label: "大气 HDR", tooltip: "基于物理的 HDR 雾/色调映射，用于透过雾霾的强烈阳光反射" },
        atmoExposure: { label: "大气曝光", tooltip: "HDR 大气色调映射曝光乘数，用于高光渐弱" },
        startXR: { label: "启动 VR/XR", tooltip: "启动 WebXR 会话进行测试（与 Immersive Web Emulator 配合使用）" },
        effects: { label: "效果", tooltip: "启用/禁用所有效果" },
        focusTrack: { label: "焦点轨迹", tooltip: "选择一个轨迹使相机注视并围绕其旋转" },
        lockTrack: { label: "锁定轨迹", tooltip: "选择一个轨迹将相机锁定到该轨迹，使相机随轨迹移动" },
        debug: {
            clearBackground: "清除背景", renderSky: "渲染天空", renderDaySky: "渲染白天天空",
            renderMainScene: "渲染主场景", renderEffects: "渲染效果", copyToScreen: "复制到屏幕",
            updateCameraMatrices: "更新相机矩阵", mainUseLookLayers: "主视图使用观察图层",
            sRGBOutputEncoding: "sRGB 输出编码", tileLoadDelay: "瓦片加载延迟 (s)",
            updateStarScales: "更新星星缩放", updateSatelliteScales: "更新卫星缩放",
            renderNightSky: "渲染夜空", renderFullscreenQuad: "渲染全屏四边形", renderSunSky: "渲染太阳天空",
        },
        celestial: {
            raHours: "赤经（时）", decDegrees: "赤纬（度）", magnitude: "星等",
            noradNumber: "NORAD 编号", name: "名称",
        },
    },
    nightSky: {
        loadLEO: { label: "加载当日 LEO 卫星", tooltip: "获取设定模拟日期/时间的最新 LEO 卫星 TLE 数据。这将从互联网下载数据，可能需要几秒钟。\n同时会启用在夜空中显示卫星。" },
        loadStarlink: { label: "加载当前 Starlink", tooltip: "获取当前（非历史，实时）Starlink 卫星位置。这将从互联网下载数据，可能需要几秒钟。\n" },
        loadActive: { label: "加载活跃卫星", tooltip: "获取当前（非历史，实时）活跃卫星位置。这将从互联网下载数据，可能需要几秒钟。\n" },
        loadSlow: { label: "（实验性）加载慢速卫星", tooltip: "获取设定模拟日期/时间的最新慢速卫星 TLE 数据。这将从互联网下载数据，可能需要几秒钟。\n同时会启用在夜空中显示卫星。较新日期可能会超时" },
        loadAll: { label: "（实验性）加载所有卫星", tooltip: "获取设定模拟日期/时间的所有卫星的最新 TLE 数据。这将从互联网下载数据，可能需要几秒钟。\n同时会启用在夜空中显示卫星。较新日期可能会超时" },
        flareAngle: { label: "闪光角度范围", tooltip: "闪光可见时反射视线矢量的最大角度\n即卫星到太阳的矢量与相机到卫星的反射矢量（平行于地面的卫星底部反射）之间的角度范围" },
        penumbraDepth: { label: "地球半影深度", tooltip: "卫星进入地球阴影时逐渐消失的垂直深度（米）" },
        sunAngleArrows: { label: "太阳角度箭头", tooltip: "检测到眩光时，显示从相机到卫星以及从卫星到太阳的箭头" },
        celestialFolder: { tooltip: "夜空相关功能" },
        vectorsOnTraverse: { label: "遍历对象上的矢量", tooltip: "勾选时，矢量相对于遍历对象显示。否则相对于观察相机显示。" },
        vectorsInLookView: { label: "观察视图中的矢量", tooltip: "勾选时，矢量在观察视图中显示。否则仅在主视图中显示。" },
        showSatellitesGlobal: { label: "显示卫星（全局）", tooltip: "主开关：显示或隐藏所有卫星" },
        showStarlink: { label: "Starlink", tooltip: "显示 SpaceX Starlink 卫星" },
        showISS: { label: "ISS", tooltip: "显示国际空间站" },
        celestrackBrightest: { label: "Celestrack 最亮卫星", tooltip: "显示 Celestrack 的最亮卫星列表" },
        otherSatellites: { label: "其他卫星", tooltip: "显示不在上述类别中的卫星" },
        list: { label: "列表", tooltip: "显示可见卫星的文本列表" },
        satelliteArrows: { label: "卫星箭头", tooltip: "显示指示卫星轨迹的箭头" },
        flareLines: { label: "闪光连线", tooltip: "显示将闪光卫星连接到相机和太阳的线条" },
        satelliteGroundArrows: { label: "卫星地面箭头", tooltip: "显示指向每颗卫星正下方地面的箭头" },
        satelliteLabelsLook: { label: "卫星标签（观察视图）", tooltip: "在观察/相机视图中显示卫星名称标签" },
        satelliteLabelsMain: { label: "卫星标签（主视图）", tooltip: "在主 3D 视图中显示卫星名称标签" },
        labelFlaresOnly: { label: "仅标注闪光卫星", tooltip: "仅标注当前正在闪光的卫星" },
        labelLitOnly: { label: "仅标注受光卫星", tooltip: "仅标注受太阳照射（不在地球阴影中）的卫星" },
        labelLookVisibleOnly: { label: "仅标注观察视图可见卫星", tooltip: "仅标注在观察视图相机视锥体中可见的卫星" },
        flareRegion: { label: "闪光区域", tooltip: "显示卫星闪光可见的天空区域" },
        flareBand: { label: "闪光带", tooltip: "显示卫星轨迹闪光扫过的地面带状区域" },
        filterTLEs: { label: "筛选 TLE", tooltip: "按高度、位置、轨道参数或名称筛选可见卫星" },
        clearTLEFilter: { label: "清除 TLE 筛选", tooltip: "移除所有 TLE 空间/轨道筛选器，恢复基于类别的可见性" },
        maxLabelsDisplayed: { label: "最大显示标签数", tooltip: "同时渲染的最大卫星标签数量" },
        starBrightness: { label: "星星亮度", tooltip: "星星亮度的缩放系数。1 为正常，0 为不可见，2 为两倍亮度等。" },
        starLimit: { label: "星星亮度限制", tooltip: "显示星星的亮度限制" },
        planetBrightness: { label: "行星亮度", tooltip: "行星（不含太阳和月球）亮度的缩放系数。1 为正常，0 为不可见，2 为两倍亮度等。" },
        lockStarPlanetBrightness: { label: "锁定星星行星亮度", tooltip: "勾选时，星星亮度和行星亮度滑块联动" },
        satBrightness: { label: "卫星亮度", tooltip: "卫星亮度的缩放系数。1 为正常，0 为不可见，2 为两倍亮度等。" },
        flareBrightness: { label: "闪光亮度", tooltip: "闪光卫星额外亮度的缩放系数。0 为无效果" },
        satCutOff: { label: "卫星截止值", tooltip: "暗至此级别或更低的卫星将不显示" },
        displayRange: { label: "显示范围 (km)", tooltip: "超出此距离的卫星将不显示名称或箭头" },
        equatorialGrid: { label: "赤道坐标网格", tooltip: "显示天球赤道坐标网格" },
        constellationLines: { label: "星座连线", tooltip: "显示星座中星星的连线" },
        renderStars: { label: "渲染星星", tooltip: "在夜空中显示星星" },
        equatorialGridLook: { label: "观察视图中的赤道网格", tooltip: "在观察/相机视图中显示赤道坐标网格" },
        flareRegionLook: { label: "观察视图中的闪光区域", tooltip: "在观察相机视图中显示闪光区域锥体" },
        satelliteEphemeris: { label: "卫星星历" },
        skyPlot: { label: "天空图" },
        celestialVector: { label: "{{name}} 矢量", tooltip: "显示指向 {{name}} 的方向矢量" },
    },
    synthClouds: {
        name: { label: "名称" },
        visible: { label: "可见" },
        editMode: { label: "编辑模式" },
        altitude: { label: "高度" },
        radius: { label: "半径" },
        cloudSize: { label: "云朵大小" },
        density: { label: "密度" },
        opacity: { label: "不透明度" },
        brightness: { label: "亮度" },
        depth: { label: "深度" },
        edgeWiggle: { label: "边缘波动" },
        edgeFrequency: { label: "边缘频率" },
        seed: { label: "随机种子" },
        feather: { label: "羽化" },
        windMode: { label: "风模式" },
        windFrom: { label: "风向 (\u00b0)" },
        windKnots: { label: "风速（节）" },
        deleteClouds: { label: "删除云层" },
    },
    synthBuilding: {
        name: { label: "名称" },
        visible: { label: "可见" },
        editMode: { label: "编辑模式" },
        roofEdgeHeight: { label: "屋顶边缘高度" },
        ridgelineHeight: { label: "屋脊高度" },
        ridgelineInset: { label: "屋脊内缩" },
        roofEaves: { label: "屋檐" },
        type: { label: "类型" },
        wallColor: { label: "墙壁颜色" },
        roofColor: { label: "屋顶颜色" },
        opacity: { label: "不透明度" },
        transparent: { label: "透明" },
        wireframe: { label: "线框" },
        depthTest: { label: "深度测试" },
        deleteBuilding: { label: "删除建筑" },
    },

    groundOverlay: {
        name: { label: "名称" },
        visible: { label: "可见" },
        editMode: { label: "编辑模式" },
        lockShape: { label: "锁定形状" },
        freeTransform: { label: "自由变换" },
        showBorder: { label: "显示边框" },
        properties: { label: "属性" },
        imageURL: { label: "图片 URL" },
        rehostLocalImage: { label: "重新托管本地图片" },
        north: { label: "北" },
        south: { label: "南" },
        east: { label: "东" },
        west: { label: "西" },
        rotation: { label: "旋转" },
        altitude: { label: "高度（英尺）" },
        wireframe: { label: "线框" },
        opacity: { label: "不透明度" },
        cloudExtraction: { label: "云提取" },
        extractClouds: { label: "提取云层" },
        cloudColor: { label: "云颜色" },
        fuzziness: { label: "模糊度" },
        feather: { label: "羽化" },
        gotoOverlay: { label: "前往叠加层" },
        deleteOverlay: { label: "删除叠加层" },
    },

    videoView: {
        folders: {
            videoAdjustments: "视频调整",
            videoProcessing: "视频处理",
            forensics: "取证分析",
            errorLevelAnalysis: "错误级别分析",
            noiseAnalysis: "噪声分析",
            grid: "网格",
        },
        currentVideo: { label: "当前视频" },
        videoRotation: { label: "视频旋转" },
        setCameraToExifGps: { label: "将相机设为 EXIF GPS 位置" },
        expandOutput: {
            label: "扩展输出",
            tooltip: "扩展 ELA 输出动态范围的方法",
        },
        displayMode: {
            label: "显示模式",
            tooltip: "噪声分析结果的可视化方式",
        },
        convolutionFilter: {
            label: "卷积滤波器",
            tooltip: "要应用的空间卷积滤波器类型",
        },
        resetVideoAdjustments: {
            label: "重置视频调整",
            tooltip: "将所有视频调整重置为默认值",
        },
        makeVideo: {
            label: "生成视频",
            tooltip: "导出应用了所有当前效果的处理后视频",
        },
        gridShow: {
            label: "显示",
            tooltip: "在视频上显示网格叠加层",
        },
        gridSize: {
            label: "大小",
            tooltip: "网格单元大小（像素）",
        },
        gridSubdivisions: {
            label: "细分",
            tooltip: "每个网格单元内的细分数",
        },
        gridXOffset: {
            label: "X 偏移",
            tooltip: "网格的水平偏移（像素）",
        },
        gridYOffset: {
            label: "Y 偏移",
            tooltip: "网格的垂直偏移（像素）",
        },
        gridColor: {
            label: "颜色",
            tooltip: "网格线的颜色",
        },
    },

    floodSim: {
        flood: {
            label: "洪水",
            tooltip: "启用或禁用洪水粒子模拟",
        },
        floodRate: {
            label: "洪水速率",
            tooltip: "每帧生成的粒子数量",
        },
        sphereSize: {
            label: "球体大小",
            tooltip: "每个水粒子的可视半径",
        },
        dropRadius: {
            label: "投放半径",
            tooltip: "粒子生成的投放点周围半径",
        },
        maxParticles: {
            label: "最大粒子数",
            tooltip: "活跃水粒子的最大数量",
        },
        method: {
            label: "方法",
            tooltip: "模拟方法：HeightMap（网格）、Fast（粒子）或 PBF（基于位置的流体）",
        },
        waterSource: {
            label: "水源",
            tooltip: "Rain：随时间添加水。DamBurst：在投放半径内维持目标高度的水位",
        },
        speed: {
            label: "速度",
            tooltip: "每帧模拟步数（1-20 倍）",
        },
        manningN: {
            label: "曼宁系数 N",
            tooltip: "河床粗糙度：0.01=光滑，0.03=天然河道，0.05=粗糙漫滩，0.1=茂密植被",
        },
        edge: {
            label: "边缘",
            tooltip: "阻挡：水在网格边缘反射。排放：水流出并被移除",
        },
        waterColor: {
            label: "水颜色",
            tooltip: "水的颜色",
        },
        reset: {
            label: "重置",
            tooltip: "移除所有粒子并重新开始模拟",
        },
    },

    flowOrbs: {
        number: {
            label: "数量",
            tooltip: "要显示的流动球数量。更多球体可能影响性能。",
        },
        spreadMethod: {
            label: "分布方式",
            tooltip: "沿相机观察矢量分布球体的方法。\n“范围”在近距离和远距离之间沿观察矢量均匀分布球体。\n“高度”在低高度和高高度之间沿观察矢量均匀分布球体（海拔高度 MSL）",
        },
        near: {
            label: "近距离 (m)",
            tooltip: "球体放置距相机的最近距离",
        },
        far: {
            label: "远距离 (m)",
            tooltip: "球体放置距相机的最远距离",
        },
        high: { label: "高 (m)" },
        low: { label: "低 (m)" },
        colorMethod: {
            label: "颜色方法",
            tooltip: "确定流动球颜色的方法。\n“随机”为每个球体分配随机颜色。\n“用户”为所有球体分配用户选择的颜色。\n“按高度色相”根据球体高度分配颜色。\n“按距离色相”根据球体与相机的距离分配颜色。",
        },
        userColor: {
            label: "用户颜色",
            tooltip: "当“颜色方法”设为“用户”时选择流动球的颜色。",
        },
        hueRange: {
            label: "色相范围",
            tooltip: "“按高度/范围色相”颜色方法中获得完整色谱的范围。",
        },
        windWhilePaused: {
            label: "暂停时风效",
            tooltip: "勾选时，即使模拟暂停，风仍会影响流动球。有助于可视化风场。",
        },
    },

    osdController: {
        seriesName: {
            label: "名称",
        },
        seriesType: {
            label: "类型",
        },
        seriesShow: {
            label: "显示",
        },
        seriesLock: {
            label: "锁定",
        },
        removeTrack: {
            label: "移除轨迹",
        },
        folderTitle: {
            label: "OSD 跟踪器",
            tooltip: "用于用户定义的逐帧文字的屏显文字跟踪器",
        },
        addNewTrack: {
            label: "添加新 OSD 数据系列",
            tooltip: "创建新的 OSD 数据系列用于逐帧文字叠加",
        },
        makeTrack: {
            label: "生成轨迹",
            tooltip: "从可见/未锁定的 OSD 数据系列（MGRS 或经纬度）创建位置轨迹",
        },
        showAll: {
            label: "全部显示",
            tooltip: "切换所有 OSD 数据系列的可见性",
        },
        exportAllData: {
            label: "导出所有数据",
            tooltip: "将所有 OSD 数据系列导出为 ZIP 文件中的 CSV",
        },
        graphShow: {
            label: "显示",
            tooltip: "显示或隐藏 OSD 数据图表视图",
        },
        xAxis: {
            label: "X 轴",
            tooltip: "水平轴的数据系列",
        },
        y1Axis: {
            label: "Y1 轴",
            tooltip: "左垂直轴的数据系列",
        },
        y2Axis: {
            label: "Y2 轴",
            tooltip: "右垂直轴的数据系列",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "视频信息显示",
            tooltip: "帧计数器、时间码和时间戳的视频信息显示控制",
        },
        showVideoInfo: {
            label: "显示视频信息",
            tooltip: "主开关 - 启用或禁用所有视频信息显示",
        },
        frameCounter: {
            label: "帧号",
            tooltip: "显示当前帧号（视频经过补丁处理时为虚拟帧）",
        },
        sourceFrame: {
            label: "源帧号",
            tooltip: "显示底层解码的源帧号（视频经过补丁处理时，在保持帧期间与帧号不同）",
        },
        offsetFrame: {
            label: "偏移帧",
            tooltip: "显示当前帧号加上偏移值",
        },
        offsetValue: {
            label: "偏移值",
            tooltip: "添加到当前帧号的偏移值",
        },
        timecode: {
            label: "时间码",
            tooltip: "以 HH:MM:SS:FF 格式显示时间码",
        },
        timestamp: {
            label: "时间戳",
            tooltip: "以 HH:MM:SS.SS 格式显示时间戳",
        },
        dateLocal: {
            label: "日期（本地）",
            tooltip: "以选定时区显示当前日期",
        },
        timeLocal: {
            label: "时间（本地）",
            tooltip: "以选定时区显示当前时间",
        },
        dateTimeLocal: {
            label: "日期时间（本地）",
            tooltip: "以选定时区显示完整日期和时间",
        },
        dateUTC: {
            label: "日期 (UTC)",
            tooltip: "以 UTC 显示当前日期",
        },
        timeUTC: {
            label: "时间 (UTC)",
            tooltip: "以 UTC 显示当前时间",
        },
        dateTimeUTC: {
            label: "日期时间 (UTC)",
            tooltip: "以 UTC 显示完整日期和时间",
        },
        fontSize: {
            label: "字号",
            tooltip: "调整信息文本的字号",
        },
    },

    terrainUI: {
        mapType: {
            label: "地图类型",
            tooltip: "地形纹理的地图类型（与高程数据分开）",
        },
        elevationType: {
            label: "高程类型",
            tooltip: "地形高度数据的高程数据源",
        },
        lat: {
            tooltip: "地形中心的纬度",
        },
        lon: {
            tooltip: "地形中心的经度",
        },
        zoom: {
            tooltip: "地形的缩放级别。2 为整个世界，15 为几个街区",
        },
        nTiles: {
            tooltip: "地形的瓦片数量。更多瓦片意味着更多细节，但加载更慢。（N×N）",
        },
        refresh: {
            label: "刷新",
            tooltip: "使用当前设置刷新地形。用于可能导致加载失败的网络故障",
        },
        debugGrids: {
            label: "调试网格",
            tooltip: "显示地面纹理（绿色）和高程数据（蓝色）的网格",
        },
        elevationScale: {
            tooltip: "高程数据的缩放系数。1 为正常，0.5 为半高，2 为双倍高度",
        },
        terrainOpacity: {
            label: "地形不透明度",
            tooltip: "地形的不透明度。0 为完全透明，1 为完全不透明",
        },
        textureDetail: {
            tooltip: "纹理细分的细节级别。更高的值 = 更多细节。1 为正常，0.5 为更少细节，2 为更多细节",
        },
        elevationDetail: {
            tooltip: "高程细分的细节级别。更高的值 = 更多细节。1 为正常，0.5 为更少细节，2 为更多细节",
        },
        disableDynamicSubdivision: {
            label: "禁用动态细分",
            tooltip: "禁用地形瓦片的动态细分。将地形冻结在当前细节级别。适用于调试。",
        },
        dynamicSubdivision: {
            label: "动态细分",
            tooltip: "使用相机自适应瓦片细分进行全球尺度查看",
        },
        showBuildings: {
            label: "3D 建筑",
            tooltip: "显示来自 Cesium Ion 或 Google 的 3D 建筑瓦片",
        },
        buildingEdges: {
            label: "建筑边缘",
            tooltip: "在 3D 建筑瓦片上显示线框边缘",
        },
        oceanSurface: {
            label: "海面（测试版）",
            tooltip: "实验性功能：在 Google 真实感瓦片激活时渲染海平面水面（固定 EGM96 MSL）",
        },
        buildingsSource: {
            label: "建筑数据源",
            tooltip: "3D 建筑瓦片的数据源",
        },
        useEllipsoid: {
            label: "使用椭球体地球模型",
            tooltip: "球体：快速旧版模型。椭球体：精确 WGS84 形状（高纬度地区受益最大）。",
        },
        layer: {
            label: "图层",
            tooltip: "当前地图类型的地形纹理图层",
        },
    },

    displayTrack: {
        visible: {
            tooltip: "显示或隐藏此轨迹",
        },
        extendToGround: {
            label: "延伸到地面",
            tooltip: "从轨迹到地面绘制垂直线",
        },
        displayStep: {
            label: "显示步长",
            tooltip: "显示轨迹点之间的帧步长（1 = 每帧）",
        },
        contrail: {
            label: "尾迹",
            tooltip: "在此轨迹后方显示随风调整的尾迹带",
        },
        contrailSecs: {
            label: "尾迹秒数",
            tooltip: "尾迹的持续时间（秒）",
        },
        contrailWidth: {
            label: "尾迹宽度 m",
            tooltip: "尾迹带的最大宽度（米）",
        },
        contrailInitialWidth: {
            label: "尾迹初始宽度 m",
            tooltip: "排气点处尾迹的宽度（米）",
        },
        contrailRamp: {
            label: "尾迹渐变 m",
            tooltip: "尾迹宽度渐增的距离（米）",
        },
        contrailSpread: {
            label: "尾迹扩散 m/s",
            tooltip: "尾迹向外扩散的速率（m/s）",
        },
        lineColor: {
            label: "线条颜色",
            tooltip: "轨迹线的颜色",
        },
        polyColor: {
            label: "多边形颜色",
            tooltip: "垂直地面延伸多边形的颜色",
        },
        altLockAGL: {
            label: "高度锁定 AGL",
        },
        gotoTrack: {
            label: "前往轨迹",
            tooltip: "将主相机对准此轨迹的位置",
        },
    },

    ptzUI: {
        panAz: {
            label: "水平转动（方位角）",
            tooltip: "相机方位角 / 水平转动角度（度）",
        },
        tiltEl: {
            label: "垂直转动（仰角）",
            tooltip: "相机仰角 / 垂直转动角度（度）",
        },
        zoomFov: {
            label: "变焦 (FOV)",
            tooltip: "相机垂直视场角（度）",
        },
        roll: {
            label: "横滚",
            tooltip: "相机横滚角度（度）",
        },
        xOffset: {
            label: "X 偏移",
            tooltip: "相机相对中心的水平偏移",
        },
        yOffset: {
            label: "Y 偏移",
            tooltip: "相机相对中心的垂直偏移",
        },
        nearPlane: {
            label: "近裁剪面 (m)",
            tooltip: "相机近裁剪面距离（米）",
        },
        relative: {
            label: "相对",
            tooltip: "使用相对角度而非绝对角度",
        },
        satellite: {
            label: "卫星",
            tooltip: "卫星模式：从天底进行屏幕空间平移。\n横滚 = 航向，方位角 = 左/右，仰角 = 上/下（-90 = 天底）",
        },
        rotation: {
            label: "旋转",
            tooltip: "围绕相机观察轴的屏幕空间旋转",
        },
    },

    nodes3dObject: {
        modelOrGeometry: {
            label: "模型或几何体",
            tooltip: "选择此对象使用 3D 模型还是生成的几何体",
        },
        model: {
            label: "模型",
            tooltip: "选择此对象使用的 3D 模型",
        },
        displayBoundingBox: {
            label: "显示包围盒",
            tooltip: "显示对象的包围盒及尺寸",
        },
        forceAboveSurface: {
            label: "强制在地面以上",
            tooltip: "强制使对象完全位于地面以上",
        },
        exportToKML: {
            label: "导出为 KML",
            tooltip: "将此 3D 对象导出为 Google Earth 的 KML 文件",
        },
        startAnalysis: {
            label: "开始分析",
            tooltip: "从相机投射光线以查找反射方向",
        },
        gridSize: {
            label: "网格大小",
            tooltip: "反射网格每轴的采样点数量",
        },
        cleanUp: {
            label: "清理",
            tooltip: "从场景中移除所有反射分析箭头",
        },
    },

    trackingOverlay: {
        showTracking: {
            label: "显示跟踪",
            tooltip: "显示或隐藏跟踪点和曲线叠加层",
        },
        reset: {
            label: "重置",
            tooltip: "将手动跟踪重置为空状态，移除所有关键帧和可拖动项目",
        },
        limitAB: {
            label: "限制 AB",
            tooltip: "将 A 和 B 帧限制在视频跟踪关键帧的范围内。这将防止超出首尾关键帧的外推，这并不总是理想的。",
        },
        curveType: {
            label: "曲线类型",
            tooltip: "Spline 使用自然三次样条。Spline2 使用 not-a-knot 样条以获得更平滑的端点行为。Linear 使用直线段。Perspective 需要恰好 3 个关键帧并建模具有透视投影的线性运动。",
        },
        minimizeGroundSpeed: {
            label: "最小化地面速度",
            tooltip: "找到使遍历路径地面距离最小的目标起始距离",
        },
        minimizeAirSpeed: {
            label: "最小化空速",
            tooltip: "找到使空中距离（考虑目标风速）最小的目标起始距离",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "视锥体地面四边形",
            tooltip: "显示相机视锥体与地面的交线",
        },
        videoInFrustum: {
            label: "视频投影到视锥体",
            tooltip: "将视频投影到相机视锥体远平面",
        },
        videoOnGround: {
            label: "视频投影到地面",
            tooltip: "将视频投影到地面",
        },
        groundVideoInLookView: {
            label: "观察视图中的地面视频",
            tooltip: "在观察视图中显示投影到地面的视频",
        },
        matchVideoAspect: {
            label: "匹配视频纵横比",
            tooltip: "裁剪观察视图以匹配视频纵横比，并相应调整视锥体",
        },
        videoOpacity: {
            label: "视频不透明度",
            tooltip: "投影视频叠加层的不透明度",
        },
    },

    labels3d: {
        measurements: {
            label: "测量",
            tooltip: "显示距离和角度测量标签及箭头",
        },
        labelsInMain: {
            label: "主视图中的标签",
            tooltip: "在主 3D 视图中显示轨迹/对象标签",
        },
        labelsInLook: {
            label: "观察视图中的标签",
            tooltip: "在观察/相机视图中显示轨迹/对象标签",
        },
        featuresInMain: {
            label: "主视图中的要素/图钉",
            tooltip: "在主 3D 视图中显示要素标记（图钉）",
        },
        featuresInLook: {
            label: "观察视图中的要素",
            tooltip: "在观察/相机视图中显示要素标记",
        },
    },

    losFitPhysics: {
        folder: "物理拟合结果",
        model: {
            label: "模型",
        },
        avgError: {
            label: "平均误差 (rad)",
        },
        windSpeed: {
            label: "风速 (kt)",
        },
        windFrom: {
            label: "风向 (\u00B0)",
        },
    },

    misbData: {
        startTime: {
            label: "开始时间",
            tooltip: "覆盖开始时间（例如 '10:30'、'Jan 15'、'2024-01-15T10:30:00Z'）。留空则使用全局开始时间。",
        },
        enableFilter: {
            label: "启用过滤器",
        },
        tryAltitudeFirst: {
            label: "优先尝试高度",
        },
        maxG: {
            label: "最大 G 值",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "相对地面高度",
            tooltip: "高度相对于地面而非海平面",
        },
        lookup: {
            label: "查找",
            tooltip: "输入地名、经纬度坐标或 MGRS 以移动到该位置",
        },
        geolocate: {
            label: "从浏览器定位",
            tooltip: "使用浏览器的地理定位 API 设置当前位置",
        },
        goTo: {
            label: "前往上述位置",
            tooltip: "将地形和相机移动到输入的纬度/经度/高度",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "停止于",
            tooltip: "在此帧停止相机目标移动，即使目标轨迹继续。适用于模拟对移动目标失去锁定的情况。设为 0 以禁用。",
        },
        horizonMethod: {
            label: "地平线方法",
        },
        lookFOV: {
            label: "观察视图 FOV",
        },
        celestialObject: {
            label: "天体",
            tooltip: "相机跟踪的天体名称（例如 Moon、Venus、Jupiter）",
        },
    },

    spriteGroup: {
        visible: {
            label: "可见",
            tooltip: "显示或隐藏流动球",
        },
        size: {
            label: "大小 (m)",
            tooltip: "直径（米）。",
        },
        viewSizeMultiplier: {
            label: "视图大小倍数",
            tooltip: "调整主视图中流动球的大小，不影响其他视图中的大小。",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "最佳角度，完整 180°，精细化",
        },
        bestAngle5: {
            label: "当前角度 5\u00B0 范围内的最佳角度",
        },
    },

    misc: {
        snapshotCamera: {
            label: "快照相机",
            tooltip: "保存当前相机位置和朝向，用于\u201c重置相机\u201d",
        },
        resetCamera: {
            label: "重置相机",
            tooltip: "将相机重置为默认位置，或恢复到上次快照的位置和朝向\n也可使用小键盘 .",
        },
        showMoonShadow: {
            label: "显示月球阴影",
            tooltip: "切换月球阴影锥的显示，用于日食可视化。",
        },
        shadowSegments: {
            label: "阴影分段",
            tooltip: "阴影锥的分段数（更多 = 更平滑但更慢）",
        },
        showEarthShadow: {
            label: "显示地球阴影",
            tooltip: "切换夜空中地球阴影锥的显示。",
        },
        earthShadowAltitude: {
            label: "地球阴影高度",
            tooltip: "渲染地球阴影锥的平面距地心的距离（米）。",
        },
        exportTLE: {
            label: "导出 TLE",
        },
        backgroundFlowIndicator: {
            label: "背景运动指示器",
            tooltip: "显示一个箭头，指示下一帧背景将移动的方向和距离。\n适用于将模拟与视频同步（使用视图/视频叠加）",
        },
        defaultSnap: {
            label: "默认对齐",
            tooltip: "启用后，拖动时点将默认对齐到水平方向。\n拖动时按住 Shift 键执行相反操作",
        },
        recalcNodeGraph: {
            label: "重新计算节点图",
        },
        downloadVideo: {
            label: "下载视频",
        },
        banking: {
            label: "倾斜",
            tooltip: "对象在转弯时的倾斜方式",
        },
        angularTraverse: {
            label: "角度遍历",
        },
        smoothingMethod: {
            label: "平滑方法",
            tooltip: "用于平滑相机轨迹数据的算法",
        },
        showInLookView: {
            label: "在观察视图中显示",
        },
        windFrom: {
            tooltip: "风的来向真航向（0=北，90=东）",
        },
        windKnots: {
            tooltip: "风速（节）",
        },
        fetchWind: {
            tooltip: "从气象服务获取此位置和时间的真实风数据",
        },
        debugConsole: {
            label: "调试控制台",
            tooltip: "调试控制台",
        },
        aiAssistant: {
            label: "AI 助手",
        },
        hide: {
            label: "隐藏",
            tooltip: "隐藏此标签页画布视图\n要再次显示，请使用“显示/隐藏 -> 视图”菜单。",
        },
        notes: {
            label: "备注",
            tooltip: "显示/隐藏备注编辑器。备注随情景保存，可包含可点击的超链接。",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "视线",
            tooltip: "显示从相机到目标的视线（快捷键：O）",
        },
        physicalPointer: {
            label: "物理指针",
        },
        jet: {
            label: "[J] 飞机",
        },
        horizonGrid: {
            label: "[H] 地平线网格",
        },
        wingPlaneGrid: {
            label: "[W] 机翼平面网格",
        },
        sphericalBoresightGrid: {
            label: "[S] 球面瞄准线网格",
        },
        azimuthElevationGrid: {
            label: "[A] 方位角/仰角网格",
        },
        frustumOfCamera: {
            label: "[R] 相机视锥体",
        },
        trackLine: {
            label: "[T] 轨迹线",
        },
        globe: {
            label: "[G] 地球仪",
        },
        showErrorCircle: {
            label: "显示误差圆",
        },
        glareSprite: {
            label: "眩光精灵 [I]",
        },
        cameraViewFrustum: {
            label: "相机视图视锥体",
            tooltip: "在 3D 场景中显示相机的视锥体",
        },
        zaineTriangulation: {
            label: "Zaine 三角测量",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "环境光强度",
            tooltip: "环境光强度。0 为无环境光，1 为正常环境光，2 为两倍环境光",
        },
        irAmbientIntensity: {
            label: "红外环境光强度",
            tooltip: "红外环境光强度（用于红外视口）",
        },
        sunIntensity: {
            label: "太阳光强度",
            tooltip: "太阳光强度。0 为无太阳光，1 为正常全日照，2 为两倍太阳光",
        },
        sunScattering: {
            label: "太阳散射",
            tooltip: "太阳光散射量",
        },
        sunBoost: {
            label: "太阳增强 (HDR)",
            tooltip: "太阳平行光强度倍数 (HDR)。增加镜面高光亮度以实现通过雾霾的逼真太阳反射。",
        },
        sceneExposure: {
            label: "场景曝光 (HDR)",
            tooltip: "HDR 色调映射的曝光补偿。降低以补偿更高的太阳增强值。",
        },
        ambientOnly: {
            label: "仅环境光",
            tooltip: "如果为真，则仅使用环境光，不使用太阳光",
        },
        daylightSky: {
            label: "日光天空",
            tooltip: "渲染日光（蓝色）天空。\n关闭以移除日光天空的贡献，便于在白天观察星星或调试夜空对象。",
        },
        noMainLighting: {
            label: "主视图无光照",
            tooltip: "如果为真，则主视图中不使用光照。\n适用于调试，不建议正常使用",
        },
        noCityLights: {
            label: "地球仪无城市灯光",
            tooltip: "如果为真，则不在地球仪上渲染城市灯光。",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "此时间和位置的 ADSB 回放",
            tooltip: "生成 ADSB Exchange Replay 链接",
        },
        googleMapsLink: {
            label: "此位置的 Google Maps",
            tooltip: "创建指向当前位置的 Google Maps 链接",
        },
        inTheSkyLink: {
            label: "此时间和位置的 In-The-Sky",
            tooltip: "创建指向当前位置的 In The Sky 链接",
        },
    },
    nodeLabels: {
        // Keys must match the node ID (property key in sitch data),
        // NOT the desc text. When no explicit id is set, desc becomes the id.
        focus: "散焦",
        canvasResolution: "分辨率",
        "Noise Amount": "噪声量",
        "TV In Black": "TV 输入黑电平",
        "TV In White": "TV 输入白电平",
        "TV Gamma": "TV 伽马",
        "Tv Out Black": "Tv 输出黑电平",
        "Tv Out White": "Tv 输出白电平",
        "JPEG Artifacts": "JPEG 伪影",
        pixelZoom: "像素缩放 %",
        videoBrightness: "亮度",
        videoContrast: "对比度",
        videoBlur: "模糊量",
        videoSharpenAmount: "锐化量",
        videoGreyscale: "灰度",
        videoHue: "色相偏移",
        videoInvert: "反色",
        videoSaturate: "饱和度",
        startDistanceGUI: "起始距离",
        targetVCGUI: "目标垂直速度",
        targetSpeedGUI: "目标速度",
        lockWind: "锁定目标风为本地风",
        jetTAS: "TAS",
        turnRate: "转弯率",
        totalTurn: "总转弯角",
        jetHeadingManual: "飞机航向",
        headingSmooth: "航向平滑",
        turnRateControl: "转弯率控制",
        cameraSmoothWindow: "相机平滑窗口",
        targetSmoothWindow: "目标平滑窗口",
        cameraFOV: "相机 FOV",
        "Tgt Start Dist": "目标起始距离",
        "Target Speed": "目标速度",
        "Tgt Relative Heading": "目标相对航向",
        "KF Process": "KF 过程",
        "KF Noise": "KF 噪声",
        "MC Num Trials": "MC 试验次数",
        "MC LOS Uncertainty (deg)": "MC 视线不确定度 (deg)",
        "MC Polynomial Order": "MC 多项式阶数",
        "Physics Max Iterations": "物理最大迭代次数",
        "Physics Wind Speed (kt)": "物理风速 (kt)",
        "Physics Wind From (°)": "物理风向 (°)",
        "Physics Initial Range (m)": "物理初始范围 (m)",
        "Tgt Start Altitude": "目标起始高度",
        "Tgt Vert Spd": "目标垂直速度",
        "Cloud Altitude": "云层高度",
    },
};

export default zh;
