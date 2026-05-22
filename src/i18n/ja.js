const ja = {
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "レガシー状況とツールの選択\n一部のレガシー状況ではデフォルトでここにコントロールがあります",
            noTooltip: "この状況にはツールチップが定義されていません",
            legacySitches: {
                label: "レガシー状況",
                tooltip: "レガシー状況は、独自のコードとアセットを持つことが多い、古い組み込み（ハードコード）の事前定義された状況です。選択して読み込みます。",
            },
            legacyTools: {
                label: "レガシーツール",
                tooltip: "ツールは、Starlinkやユーザートラックなどのカスタムセットアップ、テスト、デバッグ、その他の特殊な目的に使用される特別な状況です。選択して読み込みます。",
            },
            selectPlaceholder: "-選択-",
        },
        file: {
            title: "ファイル",
            tooltip: "保存、読み込み、エクスポートなどのファイル操作",
        },
        view: {
            title: "表示",
            tooltip: "各種表示コントロール\nすべてのメニューと同様に、メニューバーからドラッグしてフローティングメニューにできます",
        },
        video: {
            title: "映像",
            tooltip: "映像の調整、エフェクト、分析",
        },
        time: {
            title: "時間",
            tooltip: "時間とフレームのコントロール\n時間スライダーを端を超えてドラッグすると上のスライダーに影響します\n時間スライダーはUTCで表示されます",
        },
        objects: {
            title: "オブジェクト",
            tooltip: "3Dオブジェクトとそのプロパティ\n各フォルダは1つのオブジェクトです。traverseObjectは視線を横断するオブジェクト、つまり対象のUAPです",
            addObject: {
                label: "オブジェクトを追加",
                tooltip: "指定座標に新しいオブジェクトを作成",
                prompt: "入力: [名前] 緯度 経度 [高度]\n例:\n  MyObject 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Landmark 37.7749 -122.4194",
                invalidInput: "無効な入力です。以下の形式で座標を入力してください:\n[名前] 緯度 経度 [高度]",
            },
        },
        satellites: {
            title: "衛星",
            tooltip: "衛星の読み込みと制御\nStarlink、ISSなど。地平線フレアやその他の衛星エフェクトの制御",
        },
        terrain: {
            title: "地形",
            tooltip: "地形コントロール\n地形は地表の3Dモデルです。「マップ」は地表の2D画像です。「標高」は海面からの地表の高さです",
        },
        physics: {
            title: "物理",
            tooltip: "物理コントロール\n状況の物理: 風速やトラバースオブジェクトの物理挙動",
        },
        camera: {
            title: "カメラ",
            tooltip: "ルックビューカメラのコントロール\nルックビューはデフォルトで右下のウィンドウにあり、映像と一致させることを目的としています。",
        },
        target: {
            title: "ターゲット",
            tooltip: "ターゲットコントロール\nオプションのターゲットオブジェクトの位置とプロパティ",
        },
        traverse: {
            title: "トラバース",
            tooltip: "トラバースコントロール\nトラバースオブジェクトは視線を横断するオブジェクト、つまり対象のUAPです\nこのメニューでトラバースオブジェクトの移動と挙動を定義します",
        },
        showHide: {
            title: "表示/非表示",
            tooltip: "ビュー、オブジェクト、その他の要素の表示/非表示",
            views: {
                title: "ビュー",
                tooltip: "ルックビュー、映像、メインビュー、MQ9UIなどのオーバーレイを表示/非表示",
            },
            graphs: {
                title: "グラフ",
                tooltip: "各種グラフの表示/非表示",
            },
        },
        effects: {
            title: "エフェクト",
            tooltip: "ブラー、ピクセル化、色調補正などの特殊エフェクト（ルックビューの最終画像に適用）",
        },
        lighting: {
            title: "ライティング",
            tooltip: "シーンの照明: 太陽光と環境光",
        },
        contents: {
            title: "コンテンツ",
            tooltip: "シーンの内容（主にトラックに使用）",
        },
        help: {
            title: "ヘルプ",
            tooltip: "ドキュメントやその他のヘルプリソースへのリンク",
            documentation: {
                title: "ドキュメント",
                localTooltip: "ドキュメントへのリンク（ローカル）",
                githubTooltip: "Githubのドキュメントへのリンク",
                githubLinkLabel: "{{name}} (Github)",
                about: "Sitrecについて",
                whatsNew: "新機能",
                uiBasics: "ユーザーインターフェースの基本",
                savingLoading: "状況の保存と読み込み",
                customSitch: "状況のセットアップ方法",
                tracks: "トラックとデータソース",
                gis: "GISとマッピング",
                starlink: "Starlinkフレアの調査方法",
                customModels: "オブジェクトと3Dモデル（航空機）",
                cameraModes: "カメラモード（通常と衛星）",
                thirdPartyNotices: "サードパーティ通知",
                thirdPartyNoticesTooltip: "バンドルされたサードパーティソフトウェアのオープンソースライセンス表示",
                downloadBridge: "MCP Bridgeをダウンロード",
                downloadBridgeTooltip: "SitrecBridge MCPサーバー + Chrome拡張機能をダウンロード（依存関係なし、Node.jsのみ必要）",
            },
            externalLinks: {
                title: "外部リンク",
                tooltip: "外部ヘルプリンク",
            },
            exportDebugLog: {
                label: "デバッグログをエクスポート",
                tooltip: "デバッグ用にすべてのコンソール出力（log、warn、error）をテキストファイルとしてダウンロード",
            },
        },
        debug: {
            title: "デバッグ",
            tooltip: "デバッグツールとモニタリング\nGPUメモリ使用量、パフォーマンス指標、その他のデバッグ情報",
        },
    },
    file: {
        newSitch: {
            label: "新規状況",
            tooltip: "新しい状況を作成（ページが再読み込みされ、すべてリセットされます）",
        },
        savingDisabled: "保存が無効です（クリックしてログイン）",
        importFile: {
            label: "ファイルをインポート",
            tooltip: "ローカルシステムからファイルをインポート。ブラウザウィンドウにファイルをドラッグ＆ドロップするのと同じです",
        },
        server: {
            open: "開く",
            save: {
                label: "保存",
                tooltip: "現在の状況をサーバーに保存",
            },
            saveAs: {
                label: "名前を付けて保存",
                tooltip: "現在の状況を新しい名前でサーバーに保存",
            },
            versions: {
                label: "バージョン",
                tooltip: "現在選択されている状況の特定のバージョンを読み込み",
            },
            browseFeatured: "おすすめの状況を閲覧",
            browseAll: "保存済みの状況を検索・ソート可能なリストで閲覧",
        },
        local: {
            title: "ローカル",
            titleWithFolder: "ローカル: {{name}}",
            titleReconnect: "ローカル: {{name}}（再接続）",
            status: "ステータス",
            noFileSelected: "ローカルファイルが選択されていません",
            noFolderSelected: "フォルダが選択されていません",
            currentFile: "現在のファイル: {{name}}",
            statusDesktop: "現在のローカルデスクトップファイル/保存状態",
            statusFolder: "現在のローカルフォルダ/保存状態",
            stateReady: "準備完了",
            stateReconnect: "再接続が必要",
            stateNoFolder: "フォルダなし",
            statusLine: "{{state}} | フォルダ: {{folder}} | ターゲット: {{target}}",
            saveLocal: {
                label: "ローカルに保存",
                tooltipDesktop: "現在のローカルファイルに保存、または必要に応じてファイル名を入力",
                tooltipFolder: "作業フォルダに保存（フォルダが未設定の場合は場所を入力）",
                tooltipSaveBack: "{{name}}に保存し直す",
                tooltipSaveBackInFolder: "{{folder}}の{{name}}に保存し直す",
                tooltipSaveInto: "{{folder}}に保存（状況名を入力）",
                tooltipPrompt: "ローカル状況ファイルを保存（名前/場所を入力）",
                tooltipSaveTo: "現在の状況をローカルファイルに保存",
            },
            saveLocalAs: {
                label: "名前を付けてローカルに保存...",
                tooltipDesktop: "ローカル状況ファイルを新しいパスに保存",
                tooltipFolder: "ローカル状況ファイルを場所を選択して保存",
                tooltipInFolder: "現在の作業フォルダに新しいファイル名で保存",
                tooltipNewPath: "現在の状況を新しいローカルファイルパスに保存",
            },
            openLocal: {
                label: "ローカル状況を開く",
                labelShort: "ローカルを開く...",
                tooltipDesktop: "ディスクからローカル状況ファイルを開く",
                tooltipFolder: "現在の作業フォルダから状況ファイルを開く",
                tooltipCurrent: "別のローカル状況ファイルを開く（現在: {{name}}）",
                tooltipFromFolder: "{{folder}}から状況ファイルを開く",
            },
            selectFolder: {
                label: "ローカル状況フォルダを選択",
                tooltip: "ローカル保存/読み込み操作用の作業フォルダを選択",
            },
            reconnectFolder: {
                label: "フォルダを再接続",
                tooltip: "以前使用した作業フォルダへのアクセスを再許可",
            },
        },
        debug: {
            recalculateAll: "デバッグ: すべて再計算",
            dumpNodes: "デバッグ: ノードダンプ",
            dumpNodesBackwards: "デバッグ: ノード逆ダンプ",
            dumpRoots: "デバッグ: ルートノードダンプ",
        },
    },
    videoExport: {
        notAvailable: "映像エクスポートは利用できません",
        folder: {
            title: "映像レンダリング＆エクスポート",
            tooltip: "Sitrecビューまたはフルビューポートからの映像ファイルのレンダリングとエクスポートのオプション",
        },
        renderView: {
            label: "映像ビューのレンダリング",
            tooltip: "映像としてエクスポートするビューを選択",
        },
        renderSingleVideo: {
            label: "単一ビュー映像をレンダリング",
            tooltip: "選択したビューを全フレームの映像ファイルとしてエクスポート",
        },
        videoFormat: {
            label: "映像フォーマット",
            tooltip: "出力映像フォーマットを選択",
        },
        renderViewport: {
            label: "ビューポート映像をレンダリング",
            tooltip: "ビューポート全体を全フレームの映像ファイルとしてエクスポート",
        },
        renderFullscreen: {
            label: "フルスクリーン映像をレンダリング",
            tooltip: "ビューポート全体をフルスクリーンモードで全フレームの映像ファイルとしてエクスポート",
        },
        recordWindow: {
            label: "ブラウザウィンドウを録画",
            tooltip: "ブラウザウィンドウ全体（メニューとUIを含む）を固定フレームレートで映像として録画",
        },
        retinaExport: {
            label: "HD/Retinaエクスポート",
            tooltip: "Retina/HiDPI解像度でエクスポート（多くのディスプレイで2倍）",
        },
        includeAudio: {
            label: "音声を含む",
            tooltip: "利用可能な場合、ソース映像の音声トラックを含める",
        },
        waitForLoading: {
            label: "バックグラウンド読み込みを待機",
            tooltip: "有効にすると、各フレームのキャプチャ前に地形/建物/背景の読み込みを待機します",
        },
        exportFrame: {
            label: "映像フレームをエクスポート",
            tooltip: "現在の映像フレーム（エフェクト適用済み）をPNGファイルとしてエクスポート",
        },
    },
    tracking: {
        enable: {
            label: "自動トラッキングを有効化",
            disableLabel: "自動トラッキングを無効化",
            tooltip: "映像上の自動トラッキングカーソルの表示を切り替え",
        },
        start: {
            label: "自動トラッキングを開始",
            stopLabel: "自動トラッキングを停止",
            tooltip: "映像再生中にカーソル内のオブジェクトを自動追跡",
        },
        clearFromHere: {
            label: "ここからクリア",
            tooltip: "現在のフレームから最後までのすべてのトラッキング位置をクリア",
        },
        clearTrack: {
            label: "トラックをクリア",
            tooltip: "すべての自動トラッキング位置をクリアして最初からやり直す",
        },
        stabilize: {
            label: "スタビライズ",
            tooltip: "自動トラッキング位置を適用して映像を安定化",
        },
        stabilizeToggle: {
            enableLabel: "スタビライズを有効化",
            disableLabel: "スタビライズを無効化",
            tooltip: "映像の安定化のオン/オフを切り替え",
        },
        stabilizeCenters: {
            label: "中心に安定化",
            tooltip: "チェック時、安定化ポイントがビューの中心に固定されます。チェックなしの場合、初期位置に留まります。",
        },
        renderStabilized: {
            label: "安定化映像をレンダリング",
            tooltip: "安定化映像を元のサイズでエクスポート（トラッキングポイントが固定、端に黒が表示される場合あり）",
        },
        renderStabilizedExpanded: {
            label: "拡張安定化映像をレンダリング",
            tooltip: "ピクセルが失われないよう拡張キャンバスで安定化映像をエクスポート",
        },
        trackRadius: {
            label: "トラック半径",
            tooltip: "マッチングするテンプレートのサイズ（オブジェクトサイズ）",
        },
        searchRadius: {
            label: "検索半径",
            tooltip: "前の位置からどこまで検索するか（速い動きには増加）",
        },
        trackingMethod: {
            label: "トラッキング方式",
            tooltip: "テンプレートマッチ (OpenCV) またはオプティカルフロー (jsfeat Lucas-Kanade)",
        },
        centerOnBright: {
            label: "明るい部分で中心合わせ",
            tooltip: "明るいピクセルの重心を追跡（星/点光源に最適）",
        },
        centerOnDark: {
            label: "暗い部分で中心合わせ",
            tooltip: "暗いピクセルの重心を追跡",
        },
        brightnessThreshold: {
            label: "輝度しきい値",
            tooltip: "輝度しきい値 (0-255)。明るい/暗い部分での中心合わせモードで使用",
        },
        status: {
            loadingJsfeat: "jsfeatを読み込み中...",
            loadingOpenCv: "OpenCVを読み込み中...",
            sam2Connecting: "SAM2: 接続中...",
            sam2Uploading: "SAM2: アップロード中...",
        },
    },
    trackManager: {
        removeTrack: "トラックを削除",
        createSpline: "スプラインを作成",
        editTrack: "トラックを編集",
        constantSpeed: "等速",
        extrapolateTrack: "トラックを外挿",
        curveType: "カーブタイプ",
        altLockAGL: "AGL高度ロック",
        deleteTrack: "トラックを削除",
    },
    gpuMonitor: {
        enabled: "モニター有効",
        total: "合計メモリ",
        geometries: "ジオメトリ",
        textures: "テクスチャ",
        peak: "ピークメモリ",
        average: "平均メモリ",
        reset: "履歴をリセット",
    },
    situationSetup: {
        mainFov: {
            label: "メインFOV",
            tooltip: "メインビューカメラの視野角（垂直）",
        },
        lookCameraFov: "ルックカメラFOV",
        azimuth: "方位角",
        jetPitch: "ジェットピッチ",
    },
    featureManager: {
        labelText: "ラベルテキスト",
        latitude: "緯度",
        longitude: "経度",
        altitude: "高度 (m)",
        arrowLength: "矢印の長さ",
        arrowColor: "矢印の色",
        textColor: "テキスト色",
        deleteFeature: "フィーチャーを削除",
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "ルックパノラマをエクスポート",
            tooltip: "背景位置に基づいて全フレームのルックビューからパノラマ画像を作成",
        },
    },
    dateTime: {
        liveMode: {
            label: "ライブモード",
            tooltip: "ライブモードがオンの場合、再生は常に現在時刻に同期されます。\n一時停止またはタイムスクラブでライブモードが無効になります",
        },
        startTime: {
            tooltip: "映像の最初のフレームの開始時刻（UTC形式）",
        },
        currentTime: {
            tooltip: "映像の現在の時刻。下の日付と時刻はこれを指します",
        },
        year: { label: "年", tooltip: "現在のフレームの年" },
        month: { label: "月", tooltip: "月 (1-12)" },
        day: { label: "日", tooltip: "日" },
        hour: { label: "時", tooltip: "時 (0-23)" },
        minute: { label: "分", tooltip: "分 (0-59)" },
        second: { label: "秒", tooltip: "秒 (0-59)" },
        millisecond: { label: "ミリ秒", tooltip: "ミリ秒 (0-999)" },
        useTimeZone: {
            label: "UIでタイムゾーンを使用",
            tooltip: "上のUIでタイムゾーンを使用\n日付と時刻がUTCではなく選択したタイムゾーンで表示されます。\n映像やロケーションのローカルタイムゾーンなど、特定のタイムゾーンで日付と時刻を表示するのに便利です。",
        },
        timeZone: {
            label: "タイムゾーン",
            tooltip: "ルックビューの日付と時刻を表示するタイムゾーン\n「UIでタイムゾーンを使用」がチェックされている場合はUIにも適用",
        },
        simSpeed: {
            label: "シミュレーション速度",
            tooltip: "シミュレーション速度。1はリアルタイム、2は2倍速など\n映像の再生速度は変わらず、シミュレーションの時間計算にのみ影響します。",
        },
        sitchFrames: {
            label: "状況フレーム数",
            tooltip: "状況のフレーム数。映像がある場合は映像のフレーム数になりますが、フレームを追加したり映像なしで状況を使用する場合に変更できます",
        },
        sitchDuration: {
            label: "状況の長さ",
            tooltip: "状況の長さ（HH:MM:SS.sss形式）",
        },
        aFrame: {
            label: "Aフレーム",
            tooltip: "再生をAとBの間に制限（フレームスライダーで緑と赤で表示）",
        },
        bFrame: {
            label: "Bフレーム",
            tooltip: "再生をAとBの間に制限（フレームスライダーで緑と赤で表示）",
        },
        videoFps: {
            label: "映像FPS",
            tooltip: "映像のフレームレート。映像の再生速度を変更します（例: 30 fps、25 fpsなど）。個々のフレームの長さが変わるため、状況の長さにも影響します\n可能な場合は映像から取得されますが、速度を変更したい場合は変更できます",
        },
        syncTimeTo: {
            label: "時間同期先",
            tooltip: "映像の開始時間をオリジナルの開始時間、現在時刻、またはトラックの開始時間に同期（読み込み済みの場合）",
        },
    },
    jet: {
        frames: {
            time: {
                label: "時間（秒）",
                tooltip: "映像開始からの現在時間（秒）（フレーム / fps）",
            },
            frame: {
                label: "映像内フレーム",
                tooltip: "映像内の現在のフレーム番号",
            },
            paused: {
                label: "一時停止",
                tooltip: "一時停止状態を切り替え（スペースキーも可）",
            },
        },
        controls: {
            pingPong: "A-Bピンポン",
            podPitchPhysical: "ポッド（ボール）ピッチ",
            podRollPhysical: "ポッドヘッドロール",
            deroFromGlare: "デローテーション = グレア角度",
            jetPitch: "ジェットピッチ",
            lookFov: "ナローFOV",
            elevation: "仰角",
            glareStartAngle: "グレア開始角度",
            initialGlareRotation: "グレア初期回転",
            scaleJetPitch: "ロールに応じたジェットピッチスケール",
            horizonMethod: "ホライズン方式",
            horizonMethodOptions: {
                humanHorizon: "人間の水平線",
                horizonAngle: "水平線角度",
            },
            videoSpeed: "映像速度",
            podWireframe: "[B]ack ポッドワイヤーフレーム",
            showVideo: "[V]映像",
            showGraph: "[G]グラフ",
            showKeyboardShortcuts: "[K]キーボードショートカット",
            showPodHead: "[P]ポッドヘッドロール",
            showPodsEye: "ポッドの[E]目ビュー（デロ付き）",
            showLookCam: "[N]ARビュー（デロ付き）",
            showCueData: "[C]キューデータ",
            showGlareGraph: "グレアグラフ表示[o]",
            showAzGraph: "方位角グラフ[Z]",
            declutter: "[D]デクラッター",
            jetOffset: "ジェットYオフセット",
            tas: "TAS 真対気速度",
            integrate: "積分ステップ",
        },
    },
    motionAnalysis: {
        menu: {
            title: "モーション分析",
            analyzeMotion: {
                label: "モーション分析",
                tooltip: "映像上のリアルタイムモーション分析オーバーレイを切り替え",
            },
            createTrack: {
                label: "モーションからトラックを作成",
                tooltip: "全フレームを分析し、モーションベクトルから地上トラックを作成",
            },
            alignWithFlow: {
                label: "フローに整列",
                tooltip: "モーション方向が水平になるように画像を回転",
            },
            panorama: {
                title: "パノラマ",
                exportImage: {
                    label: "モーションパノラマをエクスポート",
                    tooltip: "モーショントラッキングオフセットを使用して映像フレームからパノラマ画像を作成",
                },
                exportVideo: {
                    label: "パノラマ映像をエクスポート",
                    tooltip: "映像フレームオーバーレイ付きのパノラマを4K映像で作成",
                },
                stabilize: {
                    label: "映像を安定化",
                    disableLabel: "安定化を無効化",
                    tooltip: "グローバルモーション分析を使用して映像を安定化（カメラの手ブレを除去）",
                },
                panoFrameStep: {
                    label: "パノラマフレームステップ",
                    tooltip: "パノラマフレーム間のフレーム数（1 = 毎フレーム）",
                },
                crop: {
                    label: "パノラマクロップ",
                    tooltip: "映像フレームの各端からクロップするピクセル数",
                },
                useMask: {
                    label: "パノラマでマスクを使用",
                    tooltip: "パノラマレンダリング時にモーショントラッキングマスクを透明度として適用",
                },
                analyzeWithEffects: {
                    label: "エフェクト付きで分析",
                    tooltip: "モーション分析に使用するフレームに映像調整（コントラストなど）を適用",
                },
                exportWithEffects: {
                    label: "エフェクト付きでエクスポート",
                    tooltip: "パノラマエクスポートに映像調整を適用",
                },
                removeOuterBlack: {
                    label: "外側の黒を除去",
                    tooltip: "各行の端の黒いピクセルを透明にする",
                },
            },
            trackingParameters: {
                title: "トラッキングパラメータ",
                technique: {
                    label: "テクニック",
                    tooltip: "モーション推定アルゴリズム",
                },
                frameSkip: {
                    label: "フレームスキップ",
                    tooltip: "比較間のフレーム数（大きい = 遅いモーションの検出）",
                },
                trackletLength: {
                    label: "トラックレット長",
                    tooltip: "トラックレット内のフレーム数（長い = より厳密な一貫性）",
                },
                blurSize: {
                    label: "ブラーサイズ",
                    tooltip: "マクロ特徴のガウシアンブラー（奇数）",
                },
                minMotion: {
                    label: "最小モーション",
                    tooltip: "最小モーション量（ピクセル/フレーム）",
                },
                maxMotion: {
                    label: "最大モーション",
                    tooltip: "最大モーション量",
                },
                smoothing: {
                    label: "スムージング",
                    tooltip: "方向のスムージング（大きい = より滑らか）",
                },
                minVectorCount: {
                    label: "最小ベクトル数",
                    tooltip: "有効なフレームに必要な最小モーションベクトル数",
                },
                minConfidence: {
                    label: "最小信頼度",
                    tooltip: "有効なフレームの最小コンセンサス信頼度",
                },
                maxFeatures: {
                    label: "最大特徴数",
                    tooltip: "追跡する最大特徴数",
                },
                minDistance: {
                    label: "最小距離",
                    tooltip: "特徴間の最小距離",
                },
                qualityLevel: {
                    label: "品質レベル",
                    tooltip: "特徴検出の品質しきい値",
                },
                maxTrackError: {
                    label: "最大トラックエラー",
                    tooltip: "トラッキングエラーの最大しきい値",
                },
                minQuality: {
                    label: "最小品質",
                    tooltip: "矢印を表示するための最小品質",
                },
                staticThreshold: {
                    label: "静止しきい値",
                    tooltip: "これ以下のモーションは静止とみなされます（HUD）",
                },
            },
        },
        status: {
            loadingOpenCv: "OpenCVを読み込み中...",
            stopAnalysis: "分析を停止",
            analyzingPercent: "分析中... {{pct}}%",
            creatingTrack: "トラックを作成中...",
            buildingPanorama: "パノラマを構築中...",
            buildingPanoramaPercent: "パノラマを構築中... {{pct}}%",
            loadingFrame: "フレーム{{frame}}を読み込み中... ({{current}}/{{total}})",
            loadingFrameSkipped: "フレーム{{frame}}を読み込み中... ({{current}}/{{total}}) ({{skipped}}スキップ)",
            renderingPercent: "レンダリング中... {{pct}}%",
            panoPercent: "パノラマ... {{pct}}%",
            renderingVideo: "映像をレンダリング中...",
            videoPercent: "映像... {{pct}}%",
            saving: "保存中...",
            buildingStabilization: "安定化を構築中...",
            exportProgressTitle: "パノラマ映像をエクスポート中...",
        },
        errors: {
            noVideoView: "映像ビューが見つかりません。",
            noVideoData: "映像データが見つかりません。",
            failedToLoadOpenCv: "OpenCVの読み込みに失敗しました: {{message}}",
            noOriginTrack: "起点トラックが見つかりません。開始位置を決定するにはターゲットまたはカメラのトラックが必要です。",
            videoEncodingUnsupported: "このブラウザでは映像エンコーディングがサポートされていません",
            exportFailed: "映像エクスポートに失敗しました: {{reason}}",
            panoVideoExportFailed: "パノラマ映像のエクスポートに失敗しました: {{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[ベータ] テキスト抽出",
            enable: {
                label: "テキスト抽出を有効化",
                disableLabel: "テキスト抽出を無効化",
                tooltip: "映像でのテキスト抽出モードを切り替え",
            },
            addRegion: {
                label: "領域を追加",
                drawingLabel: "映像上でクリック＆ドラッグ...",
                tooltip: "映像上でクリック＆ドラッグしてテキスト抽出領域を定義",
            },
            removeRegion: {
                label: "選択した領域を削除",
                tooltip: "現在選択されている領域を削除",
            },
            clearRegions: {
                label: "すべての領域をクリア",
                tooltip: "すべてのテキスト抽出領域を削除",
            },
            startExtract: {
                label: "抽出を開始",
                stopLabel: "抽出を停止",
                tooltip: "現在のフレームから最後まですべての領域でOCRを実行",
            },
            fixedWidthFont: {
                label: "固定幅フォント",
                tooltip: "固定幅フォントの文字ごとの検出を有効化（FLIR/センサーオーバーレイに最適）",
            },
            numChars: {
                label: "文字数",
                tooltip: "選択した領域の文字数（領域を均等に分割）",
            },
            learnTemplates: {
                label: "テンプレートを学習",
                activeLabel: "文字をクリックして学習...",
                tooltip: "文字セルをクリックして値を教える（テンプレートマッチング用）",
            },
            clearTemplates: {
                label: "テンプレートをクリア",
                tooltip: "学習済みの文字テンプレートをすべて削除",
            },
            useTemplates: {
                label: "テンプレートを使用",
                tooltip: "学習済みテンプレートをマッチングに使用（学習済みデータがあるとより高速で正確）",
            },
        },
        prompts: {
            learnCharacter: "セル{{index}}の文字を入力:",
        },
        errors: {
            failedToLoadTesseract: "Tesseract.jsの読み込みに失敗しました。インストール済みか確認してください: npm install tesseract.js",
            noVideoView: "テキスト抽出には映像ビューが必要です",
        },
    },
    custom: {
        settings: {
            title: "設定",
            tooltipLoggedIn: "ユーザー設定はサーバーに保存されます（cookieバックアップ付き）",
            tooltipAnonymous: "ユーザー設定はブラウザのcookieに保存されます",
            language: { label: "言語", tooltip: "インターフェース言語を選択。変更するとページが再読み込みされます。未保存の作業は失われますので、事前に保存してください！" },
            maxDetails: { label: "最大詳細度", tooltip: "地形サブディビジョンの最大詳細度レベル (5-30)" },
            fpsLimit: { label: "フレームレート制限", tooltip: "最大フレームレートを設定 (60、30、20、または15 fps)" },
            tileSegments: { label: "タイルセグメント", tooltip: "地形タイルのメッシュ解像度。高い値 = より詳細だが低速" },
            maxResolution: { label: "最大解像度", tooltip: "映像フレームの最大解像度（長辺）。GPUメモリ使用量を削減。新しく読み込まれたフレームに適用。" },
            aiModel: { label: "AIモデル", tooltip: "チャットアシスタントのAIモデルを選択" },
            centerSidebar: { label: "中央サイドバー", tooltip: "分割ビュー間の中央サイドバーを有効化（メニューを区切り線にドラッグ）" },
            showAttribution: { label: "帰属表示", tooltip: "マップと標高データソースの帰属表示オーバーレイを表示" },
        },
        balloons: {
            count: { label: "数", tooltip: "インポートする最寄り局の数" },
            source: { label: "ソース", tooltip: "uwyo = ワイオミング大学（PHPプロキシが必要）\nigra2 = NOAA NCEIアーカイブ（直接ダウンロード）" },
            getNearby: { label: "最寄りの気象ゾンデを取得", tooltip: "現在のカメラ位置に最も近いN個の気象ゾンデ観測をインポート。\n状況の開始時間+1時間前の最新の打ち上げを使用します。" },
            importSounding: { label: "サウンディングをインポート...", tooltip: "手動局選択: 局、日付、ソースを選択し、特定のサウンディングをインポート。" },
        },
        showHide: {
            keyboardShortcuts: { label: "[K]キーボードショートカット", tooltip: "キーボードショートカットオーバーレイの表示/非表示" },
            toggleExtendToGround: { label: "すべての地面まで[E]延長を切り替え", tooltip: "すべてのトラックの「地面まで延長」を切り替え\nいずれかがオンの場合すべてオフに\nすべてオフの場合すべてオンに" },
            showAllTracksInLook: { label: "ルックビューにすべてのトラックを表示", tooltip: "ルック/カメラビューにすべての航空機トラックを表示" },
            showCompassElevation: { label: "コンパス仰角を表示", tooltip: "方位角に加えてコンパス仰角（ローカル地面平面からの角度）を表示" },
            filterTracks: { label: "トラックフィルター", tooltip: "高度、方向、または視錐台交差に基づいてトラックの表示/非表示" },
            removeAllTracks: { label: "すべてのトラックを削除", tooltip: "シーンからすべてのトラックを削除\nオブジェクトは削除されません、トラックのみ\nファイルを再度ドラッグ＆ドロップして追加し直せます" },
        },
        objects: {
            globalScale: { label: "グローバルスケール", tooltip: "シーン内のすべての3Dオブジェクトに適用されるスケール係数 — 探し物に便利。実際のサイズには1に設定" },
        },
        admin: {
            dashboard: { label: "管理者ダッシュボード", tooltip: "管理者ダッシュボードを開く" },
            validateAllSitches: { label: "すべての状況を検証", tooltip: "ローカル地形を持つすべての保存済み状況を読み込んでエラーをチェック" },
            testUserID: { label: "テストユーザーID", tooltip: "このユーザーIDとして操作 (0 = 無効、1より大きい必要あり)" },
            addMissingScreenshots: { label: "欠落スクリーンショットを追加", tooltip: "スクリーンショットのない各状況を読み込み、レンダリングしてスクリーンショットをアップロード" },
            feature: { label: "おすすめ", tooltip: "現在読み込まれている状況のおすすめステータスを切り替え" },
        },
        viewPreset: { label: "ビュープリセット", tooltip: "異なるビュープリセットを切り替え\nサイドバイサイド、上下など" },
        subSitches: {
            folder: { tooltip: "この状況内の複数のカメラ/ビュー構成を管理" },
            updateCurrent: { label: "現在のサブを更新", tooltip: "現在選択されているサブ状況を現在のビュー設定で更新" },
            updateAndAddNew: { label: "現在を更新して新規追加", tooltip: "現在のサブ状況を更新してから、新しいサブ状況として複製" },
            discardAndAddNew: { label: "変更を破棄して新規追加", tooltip: "現在のサブ状況の変更を破棄し、現在の状態から新しいサブ状況を作成" },
            renameCurrent: { label: "現在のサブ名を変更", tooltip: "現在選択されているサブ状況の名前を変更" },
            deleteCurrent: { label: "現在のサブを削除", tooltip: "現在選択されているサブ状況を削除" },
            syncSaveDetails: { label: "サブ保存詳細を同期", tooltip: "サブ保存詳細で有効でないノードを現在のサブから削除" },
        },
        contextMenu: {
            setCameraAbove: "カメラを上方に設定",
            setCameraOnGround: "カメラを地上に設定",
            setTargetAbove: "ターゲットを上方に設定",
            setTargetOnGround: "ターゲットを地上に設定",
            dropPin: "ピンを配置 / フィーチャーを追加",
            createTrackWithObject: "オブジェクト付きトラックを作成",
            createTrackNoObject: "トラックを作成（オブジェクトなし）",
            addBuilding: "建物を追加",
            addClouds: "雲を追加",
            addGroundOverlay: "地面オーバーレイを追加",
            centerTerrain: "地形をここに中心合わせ",
            googleMapsHere: "Google Mapsで表示",
            googleEarthHere: "Google Earthで表示",
            removeClosestPoint: "最も近い点を削除",
            exitEditMode: "編集モードを終了",
        },
    },
    view3d: {
        northUp: { label: "ルックビュー北向き", tooltip: "ルックビューをワールドアップではなく北向きに設定。\n衛星ビューなど、真下を見下ろす場合に使用。\nPTZモードでは適用されません" },
        atmosphere: { label: "大気", tooltip: "地形と3Dオブジェクトを現在の空の色にブレンドする距離減衰" },
        atmoVisibility: { label: "大気視程 (km)", tooltip: "大気コントラストが約50%に低下する距離（小さい = より濃い大気）" },
        atmoHDR: { label: "大気HDR", tooltip: "ヘイズを通した明るい太陽反射のための物理ベースHDRフォグ/トーンマッピング" },
        atmoExposure: { label: "大気露出", tooltip: "ハイライトロールオフのためのHDR大気トーンマッピング露出倍率" },
        startXR: { label: "VR/XRを開始", tooltip: "テスト用WebXRセッションを開始（Immersive Web Emulatorで動作）" },
        effects: { label: "エフェクト", tooltip: "すべてのエフェクトを有効/無効化" },
        focusTrack: { label: "フォーカストラック", tooltip: "カメラがそのトラックを注視して周囲を回転するよう選択" },
        lockTrack: { label: "ロックトラック", tooltip: "カメラをトラックにロックして一緒に移動するよう選択" },
        debug: {
            clearBackground: "背景をクリア", renderSky: "空をレンダリング", renderDaySky: "昼の空をレンダリング",
            renderMainScene: "メインシーンをレンダリング", renderEffects: "エフェクトをレンダリング", copyToScreen: "画面にコピー",
            updateCameraMatrices: "カメラ行列を更新", mainUseLookLayers: "メイン: ルックレイヤーを使用",
            sRGBOutputEncoding: "sRGB出力エンコーディング", tileLoadDelay: "タイル読み込み遅延 (秒)",
            updateStarScales: "星のスケールを更新", updateSatelliteScales: "衛星のスケールを更新",
            renderNightSky: "夜空をレンダリング", renderFullscreenQuad: "フルスクリーンクアッドをレンダリング", renderSunSky: "太陽の空をレンダリング",
        },
        celestial: {
            raHours: "赤経（時）", decDegrees: "赤緯（度）", magnitude: "等級",
            noradNumber: "NORAD番号", name: "名前",
        },
    },
    nightSky: {
        loadLEO: { label: "日付でLEO衛星を読み込み", tooltip: "設定されたシミュレーター日時のLEO衛星TLEデータを取得。インターネットからデータをダウンロードするため、数秒かかる場合があります。\n夜空での衛星表示も有効になります。" },
        loadStarlink: { label: "現在のStarlinkを読み込み", tooltip: "現在の（過去ではなく、リアルタイムの）Starlink衛星位置を取得。インターネットからデータをダウンロードするため、数秒かかる場合があります。\n" },
        loadActive: { label: "アクティブ衛星を読み込み", tooltip: "現在の（過去ではなく、リアルタイムの）アクティブ衛星位置を取得。インターネットからデータをダウンロードするため、数秒かかる場合があります。\n" },
        loadSlow: { label: "（実験的）低速衛星を読み込み", tooltip: "設定されたシミュレーター日時の低速衛星TLEデータを取得。インターネットからデータをダウンロードするため、数秒かかる場合があります。\n夜空での衛星表示も有効になります。最近の日付ではタイムアウトの可能性あり" },
        loadAll: { label: "（実験的）全衛星を読み込み", tooltip: "設定されたシミュレーター日時のすべての衛星のTLEデータを取得。インターネットからデータをダウンロードするため、数秒かかる場合があります。\n夜空での衛星表示も有効になります。最近の日付ではタイムアウトの可能性あり" },
        flareAngle: { label: "フレア角度範囲", tooltip: "フレアが見える反射ビューベクトルの最大角度\nつまり、衛星から太陽へのベクトルと、カメラから衛星への衛星底面（地面に平行）で反射されたベクトルとの角度範囲" },
        penumbraDepth: { label: "地球の半影深度", tooltip: "衛星が地球の影に入るときにフェードアウトする垂直深度（メートル）" },
        sunAngleArrows: { label: "太陽角度矢印", tooltip: "グレアが検出された場合、カメラから衛星、衛星から太陽への矢印を表示" },
        celestialFolder: { tooltip: "夜空に関連するもの" },
        vectorsOnTraverse: { label: "トラバース上のベクトル", tooltip: "チェック時、ベクトルはトラバースオブジェクトに対して相対的に表示されます。それ以外はルックカメラに対して相対的に表示されます。" },
        vectorsInLookView: { label: "ルックビューのベクトル", tooltip: "チェック時、ベクトルがルックビューに表示されます。それ以外はメインビューのみに表示されます。" },
        showSatellitesGlobal: { label: "衛星を表示（グローバル）", tooltip: "マスタートグル: すべての衛星の表示/非表示" },
        showStarlink: { label: "Starlink", tooltip: "SpaceX Starlink衛星を表示" },
        showISS: { label: "ISS", tooltip: "国際宇宙ステーションを表示" },
        celestrackBrightest: { label: "Celestrakの明るい衛星", tooltip: "Celestrakの最も明るい衛星リストを表示" },
        otherSatellites: { label: "その他の衛星", tooltip: "上記カテゴリに含まれない衛星を表示" },
        list: { label: "リスト", tooltip: "可視衛星のテキストリストを表示" },
        satelliteArrows: { label: "衛星矢印", tooltip: "衛星の軌跡を示す矢印を表示" },
        flareLines: { label: "フレアライン", tooltip: "フレアしている衛星とカメラ・太陽を結ぶ線を表示" },
        satelliteGroundArrows: { label: "衛星地上矢印", tooltip: "各衛星の直下の地面への矢印を表示" },
        satelliteLabelsLook: { label: "衛星ラベル（ルックビュー）", tooltip: "ルック/カメラビューに衛星名ラベルを表示" },
        satelliteLabelsMain: { label: "衛星ラベル（メインビュー）", tooltip: "メイン3Dビューに衛星名ラベルを表示" },
        labelFlaresOnly: { label: "フレアのみラベル", tooltip: "現在フレアしている衛星のみにラベルを表示" },
        labelLitOnly: { label: "照射のみラベル", tooltip: "太陽に照らされている（地球の影にない）衛星のみにラベルを表示" },
        labelLookVisibleOnly: { label: "ルック内可視のみラベル", tooltip: "ルックビューカメラの視錐台内に見える衛星のみにラベルを表示" },
        flareRegion: { label: "フレア領域", tooltip: "衛星フレアが見える空の領域を表示" },
        flareBand: { label: "フレアバンド", tooltip: "衛星トラックからのフレアが通過する地上のバンドを表示" },
        filterTLEs: { label: "TLEフィルター", tooltip: "高度、位置、軌道パラメータ、または名前で可視衛星をフィルタリング" },
        clearTLEFilter: { label: "TLEフィルターをクリア", tooltip: "すべてのTLE空間/軌道フィルターを削除し、カテゴリベースの可視性を復元" },
        maxLabelsDisplayed: { label: "最大ラベル表示数", tooltip: "同時にレンダリングする衛星ラベルの最大数" },
        starBrightness: { label: "星の明るさ", tooltip: "星の明るさのスケール係数。1は通常、0は非表示、2は2倍の明るさなど" },
        starLimit: { label: "星の限界等級", tooltip: "表示する星の明るさの限界" },
        planetBrightness: { label: "惑星の明るさ", tooltip: "惑星（太陽と月を除く）の明るさのスケール係数。1は通常、0は非表示、2は2倍の明るさなど" },
        lockStarPlanetBrightness: { label: "星と惑星の明るさを連動", tooltip: "チェック時、星の明るさと惑星の明るさのスライダーが連動します" },
        satBrightness: { label: "衛星の明るさ", tooltip: "衛星の明るさのスケール係数。1は通常、0は非表示、2は2倍の明るさなど" },
        flareBrightness: { label: "フレアの明るさ", tooltip: "フレアしている衛星の追加明るさのスケール係数。0はなし" },
        satCutOff: { label: "衛星カットオフ", tooltip: "このレベル以下に暗くなった衛星は表示されません" },
        displayRange: { label: "表示範囲 (km)", tooltip: "この距離を超える衛星の名前や矢印は表示されません" },
        equatorialGrid: { label: "赤道座標グリッド", tooltip: "天球赤道座標グリッドを表示" },
        constellationLines: { label: "星座線", tooltip: "星座の星を結ぶ線を表示" },
        renderStars: { label: "星をレンダリング", tooltip: "夜空に星を表示" },
        equatorialGridLook: { label: "ルックビューの赤道グリッド", tooltip: "ルック/カメラビューに赤道グリッドを表示" },
        flareRegionLook: { label: "ルックビューのフレア領域", tooltip: "ルックカメラビューにフレア領域コーンを表示" },
        satelliteEphemeris: { label: "衛星暦" },
        skyPlot: { label: "天球図" },
        celestialVector: { label: "{{name}}ベクトル", tooltip: "{{name}}への方向ベクトルを表示" },
    },
    synthClouds: {
        name: { label: "名前" },
        visible: { label: "表示" },
        editMode: { label: "編集モード" },
        altitude: { label: "高度" },
        radius: { label: "半径" },
        cloudSize: { label: "雲のサイズ" },
        density: { label: "密度" },
        opacity: { label: "不透明度" },
        brightness: { label: "明るさ" },
        depth: { label: "深度" },
        edgeWiggle: { label: "エッジの揺らぎ" },
        edgeFrequency: { label: "エッジ周波数" },
        seed: { label: "シード" },
        feather: { label: "フェザー" },
        windMode: { label: "風モード" },
        windFrom: { label: "風向 (\u00b0)" },
        windKnots: { label: "風速（ノット）" },
        deleteClouds: { label: "雲を削除" },
    },
    synthBuilding: {
        name: { label: "名前" },
        visible: { label: "表示" },
        editMode: { label: "編集モード" },
        roofEdgeHeight: { label: "軒先の高さ" },
        ridgelineHeight: { label: "棟の高さ" },
        ridgelineInset: { label: "棟のインセット" },
        roofEaves: { label: "屋根の軒" },
        type: { label: "タイプ" },
        wallColor: { label: "壁の色" },
        roofColor: { label: "屋根の色" },
        opacity: { label: "不透明度" },
        transparent: { label: "透明" },
        wireframe: { label: "ワイヤーフレーム" },
        depthTest: { label: "深度テスト" },
        deleteBuilding: { label: "建物を削除" },
    },

    groundOverlay: {
        name: { label: "名前" },
        visible: { label: "表示" },
        editMode: { label: "編集モード" },
        lockShape: { label: "形状をロック" },
        freeTransform: { label: "自由変形" },
        showBorder: { label: "境界線を表示" },
        properties: { label: "プロパティ" },
        imageURL: { label: "画像URL" },
        rehostLocalImage: { label: "ローカル画像を再ホスト" },
        north: { label: "北" },
        south: { label: "南" },
        east: { label: "東" },
        west: { label: "西" },
        rotation: { label: "回転" },
        altitude: { label: "高度 (ft)" },
        wireframe: { label: "ワイヤーフレーム" },
        opacity: { label: "不透明度" },
        cloudExtraction: { label: "雲の抽出" },
        extractClouds: { label: "雲を抽出" },
        cloudColor: { label: "雲の色" },
        fuzziness: { label: "ぼかし度" },
        feather: { label: "フェザー" },
        gotoOverlay: { label: "オーバーレイに移動" },
        deleteOverlay: { label: "オーバーレイを削除" },
    },

    videoView: {
        folders: {
            videoAdjustments: "映像調整",
            videoProcessing: "映像処理",
            forensics: "フォレンジック",
            errorLevelAnalysis: "エラーレベル分析",
            noiseAnalysis: "ノイズ分析",
            grid: "グリッド",
        },
        currentVideo: { label: "現在の映像" },
        videoRotation: { label: "映像の回転" },
        setCameraToExifGps: { label: "EXIF GPSでカメラを設定" },
        expandOutput: {
            label: "出力を拡張",
            tooltip: "ELA出力のダイナミックレンジを拡張する方法",
        },
        displayMode: {
            label: "表示モード",
            tooltip: "ノイズ分析結果の可視化方法",
        },
        convolutionFilter: {
            label: "畳み込みフィルター",
            tooltip: "適用する空間畳み込みフィルターの種類",
        },
        resetVideoAdjustments: {
            label: "映像調整をリセット",
            tooltip: "すべての映像調整をデフォルト値にリセット",
        },
        makeVideo: {
            label: "映像を作成",
            tooltip: "現在のすべてのエフェクトを適用した処理済み映像をエクスポート",
        },
        gridShow: {
            label: "表示",
            tooltip: "映像にグリッドオーバーレイを表示",
        },
        gridSize: {
            label: "サイズ",
            tooltip: "グリッドセルサイズ（ピクセル）",
        },
        gridSubdivisions: {
            label: "分割数",
            tooltip: "各グリッドセル内の分割数",
        },
        gridXOffset: {
            label: "Xオフセット",
            tooltip: "グリッドの水平オフセット（ピクセル）",
        },
        gridYOffset: {
            label: "Yオフセット",
            tooltip: "グリッドの垂直オフセット（ピクセル）",
        },
        gridColor: {
            label: "色",
            tooltip: "グリッド線の色",
        },
    },

    floodSim: {
        flood: {
            label: "洪水",
            tooltip: "洪水パーティクルシミュレーションの有効/無効を切り替え",
        },
        floodRate: {
            label: "洪水レート",
            tooltip: "フレームごとに生成されるパーティクル数",
        },
        sphereSize: {
            label: "球サイズ",
            tooltip: "各水パーティクルの表示半径",
        },
        dropRadius: {
            label: "投下半径",
            tooltip: "パーティクルが生成される投下ポイント周辺の半径",
        },
        maxParticles: {
            label: "最大パーティクル数",
            tooltip: "アクティブな水パーティクルの最大数",
        },
        method: {
            label: "方式",
            tooltip: "シミュレーション方式: HeightMap（グリッド）、Fast（パーティクル）、またはPBF（位置ベース流体）",
        },
        waterSource: {
            label: "水源",
            tooltip: "Rain: 時間経過で水を追加。DamBurst: 投下半径内でターゲット高度の水位を維持",
        },
        speed: {
            label: "速度",
            tooltip: "フレームあたりのシミュレーションステップ数 (1-20x)",
        },
        manningN: {
            label: "マニングのN",
            tooltip: "底面の粗さ: 0.01=滑らか、0.03=自然水路、0.05=粗い氾濫原、0.1=密な植生",
        },
        edge: {
            label: "エッジ",
            tooltip: "ブロッキング: 水がグリッドの端で反射。ドレイン: 水が流出して除去",
        },
        waterColor: {
            label: "水の色",
            tooltip: "水の色",
        },
        reset: {
            label: "リセット",
            tooltip: "すべてのパーティクルを削除してシミュレーションを再開",
        },
    },

    flowOrbs: {
        number: {
            label: "数",
            tooltip: "表示するフローオーブの数。多いとパフォーマンスに影響する場合があります。",
        },
        spreadMethod: {
            label: "分布方法",
            tooltip: "カメラのルックベクトルに沿ってオーブを分布させる方法。\n「Range」はニアとファーの距離間に均等に分布。\n「Altitude」は低い高度と高い絶対高度（MSL）の間に均等に分布",
        },
        near: {
            label: "ニア (m)",
            tooltip: "オーブ配置のカメラからの最短距離",
        },
        far: {
            label: "ファー (m)",
            tooltip: "オーブ配置のカメラからの最長距離",
        },
        high: { label: "上限 (m)" },
        low: { label: "下限 (m)" },
        colorMethod: {
            label: "色付け方法",
            tooltip: "フローオーブの色の決定方法。\n「Random」は各オーブにランダムな色を割り当て。\n「User」はすべてのオーブにユーザー選択の色を割り当て。\n「Hue From Altitude」はオーブの高度に基づく色を割り当て。\n「Hue From Distance」はカメラからの距離に基づく色を割り当て。",
        },
        userColor: {
            label: "ユーザー色",
            tooltip: "色付け方法が「User」の場合のフローオーブの色を選択。",
        },
        hueRange: {
            label: "色相範囲",
            tooltip: "「Hue From Altitude/Range」色付け方法でフルスペクトルの色を得る範囲。",
        },
        windWhilePaused: {
            label: "一時停止中も風を適用",
            tooltip: "チェック時、シミュレーションが一時停止中でも風がフローオーブに影響します。風のパターンの可視化に便利。",
        },
    },

    osdController: {
        seriesName: {
            label: "名前",
        },
        seriesType: {
            label: "タイプ",
        },
        seriesShow: {
            label: "表示",
        },
        seriesLock: {
            label: "ロック",
        },
        removeTrack: {
            label: "トラックを削除",
        },
        folderTitle: {
            label: "OSDトラッカー",
            tooltip: "ユーザー定義のフレームごとテキスト用オンスクリーンディスプレイテキストトラッカー",
        },
        addNewTrack: {
            label: "新規OSDデータシリーズを追加",
            tooltip: "フレームごとのテキストオーバーレイ用に新しいOSDデータシリーズを作成",
        },
        makeTrack: {
            label: "トラックを作成",
            tooltip: "表示中/ロック解除済みのOSDデータシリーズ（MGRSまたは緯度/経度）から位置トラックを作成",
        },
        showAll: {
            label: "すべて表示",
            tooltip: "すべてのOSDデータシリーズの表示を切り替え",
        },
        exportAllData: {
            label: "全データをエクスポート",
            tooltip: "すべてのOSDデータシリーズをZIPファイル内のCSVとしてエクスポート",
        },
        graphShow: {
            label: "表示",
            tooltip: "OSDデータグラフビューの表示/非表示",
        },
        xAxis: {
            label: "X軸",
            tooltip: "水平軸のデータシリーズ",
        },
        y1Axis: {
            label: "Y1軸",
            tooltip: "左垂直軸のデータシリーズ",
        },
        y2Axis: {
            label: "Y2軸",
            tooltip: "右垂直軸のデータシリーズ",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "映像情報表示",
            tooltip: "フレームカウンター、タイムコード、タイムスタンプの映像情報表示コントロール",
        },
        showVideoInfo: {
            label: "映像情報を表示",
            tooltip: "マスタートグル — すべての映像情報表示を有効/無効化",
        },
        frameCounter: {
            label: "フレーム番号",
            tooltip: "現在のフレーム番号を表示(映像がパッチ適用済みの場合は仮想フレーム)",
        },
        sourceFrame: {
            label: "ソースフレーム番号",
            tooltip: "デコード元のソースフレーム番号を表示(映像がパッチ適用済みでホールド中の場合、フレーム番号と異なる)",
        },
        offsetFrame: {
            label: "オフセットフレーム",
            tooltip: "オフセット値を加えた現在のフレーム番号を表示",
        },
        offsetValue: {
            label: "オフセット値",
            tooltip: "現在のフレーム番号に加算するオフセット値",
        },
        timecode: {
            label: "タイムコード",
            tooltip: "HH:MM:SS:FF形式でタイムコードを表示",
        },
        timestamp: {
            label: "タイムスタンプ",
            tooltip: "HH:MM:SS.SS形式でタイムスタンプを表示",
        },
        dateLocal: {
            label: "日付（ローカル）",
            tooltip: "選択したタイムゾーンで現在の日付を表示",
        },
        timeLocal: {
            label: "時刻（ローカル）",
            tooltip: "選択したタイムゾーンで現在の時刻を表示",
        },
        dateTimeLocal: {
            label: "日時（ローカル）",
            tooltip: "選択したタイムゾーンで日付と時刻を表示",
        },
        dateUTC: {
            label: "日付 (UTC)",
            tooltip: "UTCで現在の日付を表示",
        },
        timeUTC: {
            label: "時刻 (UTC)",
            tooltip: "UTCで現在の時刻を表示",
        },
        dateTimeUTC: {
            label: "日時 (UTC)",
            tooltip: "UTCで日付と時刻を表示",
        },
        fontSize: {
            label: "フォントサイズ",
            tooltip: "情報テキストのフォントサイズを調整",
        },
    },

    terrainUI: {
        mapType: {
            label: "マップタイプ",
            tooltip: "地形テクスチャのマップタイプ（標高データとは別）",
        },
        elevationType: {
            label: "標高タイプ",
            tooltip: "地形の高さデータの標高データソース",
        },
        lat: {
            tooltip: "地形の中心の緯度",
        },
        lon: {
            tooltip: "地形の中心の経度",
        },
        zoom: {
            tooltip: "地形のズームレベル。2は世界全体、15は数ブロック",
        },
        nTiles: {
            tooltip: "地形のタイル数。多いほど詳細だが読み込みが遅い。(NxN)",
        },
        refresh: {
            label: "更新",
            tooltip: "現在の設定で地形を更新。読み込み失敗を起こした可能性のあるネットワーク障害時に使用",
        },
        debugGrids: {
            label: "デバッググリッド",
            tooltip: "地表テクスチャ（緑）と標高データ（青）のグリッドを表示",
        },
        elevationScale: {
            tooltip: "標高データのスケール係数。1は通常、0.5は半分の高さ、2は2倍の高さ",
        },
        terrainOpacity: {
            label: "地形の不透明度",
            tooltip: "地形の不透明度。0は完全に透明、1は完全に不透明",
        },
        textureDetail: {
            tooltip: "テクスチャサブディビジョンの詳細度。高い値 = より詳細。1は通常、0.5はより少ない詳細、2はより多い詳細",
        },
        elevationDetail: {
            tooltip: "標高サブディビジョンの詳細度。高い値 = より詳細。1は通常、0.5はより少ない詳細、2はより多い詳細",
        },
        disableDynamicSubdivision: {
            label: "動的サブディビジョンを無効化",
            tooltip: "地形タイルの動的サブディビジョンを無効化。現在の詳細度レベルで地形を固定。デバッグに便利。",
        },
        dynamicSubdivision: {
            label: "動的サブディビジョン",
            tooltip: "グローブスケール表示のためのカメラ適応タイルサブディビジョン",
        },
        showBuildings: {
            label: "3D建物",
            tooltip: "Cesium IonまたはGoogleの3D建物タイルを表示",
        },
        buildingEdges: {
            label: "建物エッジ",
            tooltip: "3D建物タイルにワイヤーフレームエッジを表示",
        },
        oceanSurface: {
            label: "海面（ベータ）",
            tooltip: "実験的: Google Photorealisticタイルがアクティブ時に海面水面（固定EGM96 MSL）をレンダリング",
        },
        buildingsSource: {
            label: "建物ソース",
            tooltip: "3D建物タイルのデータソース",
        },
        useEllipsoid: {
            label: "楕円体地球モデルを使用",
            tooltip: "球: 高速レガシーモデル。楕円体: 正確なWGS84形状（高緯度で最も効果的）。",
        },
        layer: {
            label: "レイヤー",
            tooltip: "現在のマップタイプの地形テクスチャのレイヤー",
        },
    },

    displayTrack: {
        visible: {
            tooltip: "このトラックの表示/非表示",
        },
        extendToGround: {
            label: "地面まで延長",
            tooltip: "トラックから地面までの垂直線を描画",
        },
        displayStep: {
            label: "表示ステップ",
            tooltip: "表示するトラックポイント間のフレームステップ (1 = 毎フレーム)",
        },
        contrail: {
            label: "飛行機雲",
            tooltip: "このトラックの後ろに風を考慮した飛行機雲リボンを表示",
        },
        contrailSecs: {
            label: "飛行機雲の秒数",
            tooltip: "飛行機雲の持続時間（秒）",
        },
        contrailWidth: {
            label: "飛行機雲の幅 m",
            tooltip: "飛行機雲リボンの最大幅（メートル）",
        },
        contrailInitialWidth: {
            label: "飛行機雲の初期幅 m",
            tooltip: "排気ポイントでの飛行機雲の幅（メートル）",
        },
        contrailRamp: {
            label: "飛行機雲のランプ m",
            tooltip: "飛行機雲の幅が増加する距離（メートル）",
        },
        contrailSpread: {
            label: "飛行機雲の拡散 m/s",
            tooltip: "飛行機雲が外側に広がる速度（m/s）",
        },
        lineColor: {
            label: "線の色",
            tooltip: "トラック線の色",
        },
        polyColor: {
            label: "ポリゴン色",
            tooltip: "垂直地面延長ポリゴンの色",
        },
        altLockAGL: {
            label: "AGL高度ロック",
        },
        gotoTrack: {
            label: "トラックに移動",
            tooltip: "メインカメラをこのトラックの位置に中心合わせ",
        },
    },

    ptzUI: {
        panAz: {
            label: "パン（方位角）",
            tooltip: "カメラの方位角/パン角度（度）",
        },
        tiltEl: {
            label: "チルト（仰角）",
            tooltip: "カメラの仰角/チルト角度（度）",
        },
        zoomFov: {
            label: "ズーム (FOV)",
            tooltip: "カメラの垂直視野角（度）",
        },
        roll: {
            label: "ロール",
            tooltip: "カメラのロール角度（度）",
        },
        xOffset: {
            label: "Xオフセット",
            tooltip: "カメラの中心からの水平オフセット",
        },
        yOffset: {
            label: "Yオフセット",
            tooltip: "カメラの中心からの垂直オフセット",
        },
        nearPlane: {
            label: "ニアプレーン (m)",
            tooltip: "カメラのニアクリッピングプレーン距離（メートル）",
        },
        relative: {
            label: "相対",
            tooltip: "絶対角度ではなく相対角度を使用",
        },
        satellite: {
            label: "サテライト",
            tooltip: "サテライトモード: 天底からのスクリーンスペースパン。\nロール = 方位、Az = 左/右、El = 上/下 (-90 = 天底)",
        },
        rotation: {
            label: "回転",
            tooltip: "カメラのルック軸周りのスクリーンスペース回転",
        },
    },

    nodes3dObject: {
        modelOrGeometry: {
            label: "モデルまたはジオメトリ",
            tooltip: "このオブジェクトに3Dモデルまたは生成されたジオメトリを使用するか選択",
        },
        model: {
            label: "モデル",
            tooltip: "このオブジェクトに使用する3Dモデルを選択",
        },
        displayBoundingBox: {
            label: "バウンディングボックスを表示",
            tooltip: "寸法付きのオブジェクトのバウンディングボックスを表示",
        },
        forceAboveSurface: {
            label: "地表面の上に強制",
            tooltip: "オブジェクトを強制的に地表面の上に完全に配置",
        },
        exportToKML: {
            label: "KMLにエクスポート",
            tooltip: "この3DオブジェクトをGoogle Earth用のKMLファイルとしてエクスポート",
        },
        startAnalysis: {
            label: "分析を開始",
            tooltip: "カメラからレイを放って反射方向を見つける",
        },
        gridSize: {
            label: "グリッドサイズ",
            tooltip: "反射グリッドの軸あたりのサンプルポイント数",
        },
        cleanUp: {
            label: "クリーンアップ",
            tooltip: "シーンからすべての反射分析矢印を削除",
        },
    },

    trackingOverlay: {
        showTracking: {
            label: "トラッキングを表示",
            tooltip: "トラッキングポイントとカーブオーバーレイの表示/非表示",
        },
        reset: {
            label: "リセット",
            tooltip: "手動トラッキングを空の状態にリセットし、すべてのキーフレームとドラッグ可能なアイテムを削除",
        },
        limitAB: {
            label: "AB制限",
            tooltip: "AフレームとBフレームを映像トラッキングキーフレームの範囲に制限。最初と最後のキーフレームを超えた外挿を防止します（常に望ましいとは限りません）。",
        },
        curveType: {
            label: "カーブタイプ",
            tooltip: "Splineは自然三次スプライン。Spline2はノットなしスプラインでより滑らかな端の挙動。Linearは直線セグメント。Perspectiveはちょうど3つのキーフレームが必要で、透視投影による線形運動をモデル化。",
        },
        minimizeGroundSpeed: {
            label: "地上速度を最小化",
            tooltip: "トラバースパスの地上移動距離を最小化するターゲット開始距離を求める",
        },
        minimizeAirSpeed: {
            label: "対気速度を最小化",
            tooltip: "空中移動距離（ターゲット風を考慮）を最小化するターゲット開始距離を求める",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "視錐台地面クアッド",
            tooltip: "カメラの視錐台と地面の交差を表示",
        },
        videoInFrustum: {
            label: "視錐台内の映像",
            tooltip: "カメラの視錐台遠平面に映像を投影",
        },
        videoOnGround: {
            label: "地面上の映像",
            tooltip: "地面に映像を投影",
        },
        groundVideoInLookView: {
            label: "ルックビューの地面映像",
            tooltip: "ルックビューに地面投影映像を表示",
        },
        matchVideoAspect: {
            label: "映像アスペクト比に合わせる",
            tooltip: "映像のアスペクト比に合わせてルックビューをクロップし、視錐台を調整",
        },
        videoOpacity: {
            label: "映像の不透明度",
            tooltip: "投影映像オーバーレイの不透明度",
        },
    },

    labels3d: {
        measurements: {
            label: "測定",
            tooltip: "距離と角度の測定ラベルと矢印を表示",
        },
        labelsInMain: {
            label: "メインビューのラベル",
            tooltip: "メイン3Dビューにトラック/オブジェクトのラベルを表示",
        },
        labelsInLook: {
            label: "ルックビューのラベル",
            tooltip: "ルック/カメラビューにトラック/オブジェクトのラベルを表示",
        },
        featuresInMain: {
            label: "メインビューのフィーチャー/ピン",
            tooltip: "メイン3Dビューにフィーチャーマーカー（ピン）を表示",
        },
        featuresInLook: {
            label: "ルックビューのフィーチャー",
            tooltip: "ルック/カメラビューにフィーチャーマーカーを表示",
        },
    },

    losFitPhysics: {
        folder: "物理フィット結果",
        model: {
            label: "モデル",
        },
        avgError: {
            label: "平均誤差 (rad)",
        },
        windSpeed: {
            label: "風速 (kt)",
        },
        windFrom: {
            label: "風向 (\u00B0)",
        },
    },

    misbData: {
        startTime: {
            label: "開始時刻",
            tooltip: "開始時刻を上書き（例: '10:30'、'Jan 15'、'2024-01-15T10:30:00Z'）。空欄の場合はグローバル開始時刻を使用。",
        },
        enableFilter: {
            label: "フィルターを有効化",
        },
        tryAltitudeFirst: {
            label: "高度を先に試行",
        },
        maxG: {
            label: "最大G",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "地表からの高度",
            tooltip: "高度は海面ではなく地表面からの相対高度",
        },
        lookup: {
            label: "検索",
            tooltip: "地名、緯度経度座標、またはMGRSを入力して移動",
        },
        geolocate: {
            label: "ブラウザで位置情報を取得",
            tooltip: "ブラウザの位置情報APIを使用して現在位置を設定",
        },
        goTo: {
            label: "上記の位置に移動",
            tooltip: "入力した緯度/経度/高度に地形とカメラを移動",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "停止フレーム",
            tooltip: "ターゲットトラックが続いていても、このフレームでカメラターゲットの移動を停止。移動ターゲットのロック喪失をシミュレートするのに便利。0で無効化。",
        },
        horizonMethod: {
            label: "ホライズン方式",
        },
        lookFOV: {
            label: "ルックFOV",
        },
        celestialObject: {
            label: "天体",
            tooltip: "カメラが追跡する天体の名前（例: 月、金星、木星）",
        },
    },

    spriteGroup: {
        visible: {
            label: "表示",
            tooltip: "フローオーブの表示/非表示",
        },
        size: {
            label: "サイズ (m)",
            tooltip: "直径（メートル）。",
        },
        viewSizeMultiplier: {
            label: "ビューサイズ倍率",
            tooltip: "メインビューでのフローオーブのサイズを調整しますが、他のビューのサイズは変更しません。",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "最適角度、全180度、精密化済み",
        },
        bestAngle5: {
            label: "現在から5\u00B0以内の最適角度",
        },
    },

    misc: {
        snapshotCamera: {
            label: "カメラスナップショット",
            tooltip: "「カメラリセット」で使用するための現在のカメラ位置と方向を保存",
        },
        resetCamera: {
            label: "カメラリセット",
            tooltip: "カメラをデフォルト、または最後のスナップショットの位置と方向にリセット\nテンキーの.でも可能。",
        },
        showMoonShadow: {
            label: "月の影を表示",
            tooltip: "日食の可視化のための月の影のコーン表示を切り替え。",
        },
        shadowSegments: {
            label: "影のセグメント",
            tooltip: "影のコーンのセグメント数（多い = より滑らかだが遅い）",
        },
        showEarthShadow: {
            label: "地球の影を表示",
            tooltip: "夜空での地球の影のコーン表示を切り替え。",
        },
        earthShadowAltitude: {
            label: "地球の影の高度",
            tooltip: "地球の影のコーンをレンダリングする平面までの地球中心からの距離（メートル）。",
        },
        exportTLE: {
            label: "TLEをエクスポート",
        },
        backgroundFlowIndicator: {
            label: "背景フローインジケーター",
            tooltip: "次のフレームで背景がどれだけ移動するかを示す矢印を表示。\nシミュレーションと映像の同期に便利（表示/映像オーバーレイを使用）",
        },
        defaultSnap: {
            label: "デフォルトスナップ",
            tooltip: "有効時、ドラッグ中にポイントがデフォルトで水平方向に整列します。\nShiftキーを押しながら（ドラッグ中）で逆の動作",
        },
        recalcNodeGraph: {
            label: "ノードグラフを再計算",
        },
        downloadVideo: {
            label: "映像をダウンロード",
        },
        banking: {
            label: "バンク",
            tooltip: "旋回時のオブジェクトのバンク/傾き方",
        },
        angularTraverse: {
            label: "角度トラバース",
        },
        smoothingMethod: {
            label: "スムージング方法",
            tooltip: "カメラトラックデータのスムージングに使用するアルゴリズム",
        },
        showInLookView: {
            label: "ルックビューに表示",
        },
        windFrom: {
            tooltip: "風が吹いてくる真方位 (0=北、90=東)",
        },
        windKnots: {
            tooltip: "風速（ノット）",
        },
        fetchWind: {
            tooltip: "この場所と時刻の実際の風データを気象サービスから取得",
        },
        debugConsole: {
            label: "デバッグコンソール",
            tooltip: "デバッグコンソール",
        },
        aiAssistant: {
            label: "AIアシスタント",
        },
        hide: {
            label: "非表示",
            tooltip: "このタブ付きキャンバスビューを非表示にする\n再表示するには「表示/非表示 -> ビュー」メニューを使用してください。",
        },
        notes: {
            label: "メモ",
            tooltip: "メモエディタの表示/非表示。メモは状況とともに保存され、クリック可能なハイパーリンクを含めることができます。",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "視線",
            tooltip: "カメラからターゲットへの視線を表示（切り替え: O）",
        },
        physicalPointer: {
            label: "フィジカルポインター",
        },
        jet: {
            label: "[J]ジェット",
        },
        horizonGrid: {
            label: "[H]ホライズングリッド",
        },
        wingPlaneGrid: {
            label: "[W]翼面グリッド",
        },
        sphericalBoresightGrid: {
            label: "[S]球面ボアサイトグリッド",
        },
        azimuthElevationGrid: {
            label: "[A]方位角/仰角グリッド",
        },
        frustumOfCamera: {
            label: "カメラの視錐台 [R]",
        },
        trackLine: {
            label: "[T]トラックライン",
        },
        globe: {
            label: "[G]地球儀",
        },
        showErrorCircle: {
            label: "エラーサークル",
        },
        glareSprite: {
            label: "グレアスプラ[I]ト",
        },
        cameraViewFrustum: {
            label: "カメラビュー視錐台",
            tooltip: "3Dシーンにカメラのビュー視錐台を表示",
        },
        zaineTriangulation: {
            label: "ゼイン三角測量",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "環境光強度",
            tooltip: "環境光の強度。0はなし、1は通常、2は2倍",
        },
        irAmbientIntensity: {
            label: "IR環境光強度",
            tooltip: "IR環境光の強度（IRビューポート用）",
        },
        sunIntensity: {
            label: "太陽光強度",
            tooltip: "太陽光の強度。0はなし、1は通常の最大太陽光、2は2倍",
        },
        sunScattering: {
            label: "太陽光散乱",
            tooltip: "太陽光の散乱量",
        },
        sunBoost: {
            label: "太陽光ブースト (HDR)",
            tooltip: "太陽DirectionalLightの強度倍率（HDR）。フォグを通したリアルな太陽反射のためにスペキュラハイライトの明るさを増加。",
        },
        sceneExposure: {
            label: "シーン露出 (HDR)",
            tooltip: "HDRトーンマッピングの露出補正。太陽光ブースト増加を補正するために下げてください。",
        },
        ambientOnly: {
            label: "環境光のみ",
            tooltip: "有効時、環境光のみが使用され、太陽光は使用されません",
        },
        daylightSky: {
            label: "昼空",
            tooltip: "昼空（青空）をレンダリングします。\nオフにすると昼空の寄与が除去され、昼間に星を見たり、夜空オブジェクトのデバッグに便利です。",
        },
        noMainLighting: {
            label: "メインビューのライティングなし",
            tooltip: "有効時、メインビューでライティングが使用されません。\nデバッグには便利ですが、通常使用には推奨されません",
        },
        noCityLights: {
            label: "地球儀に都市の光なし",
            tooltip: "有効時、地球儀に都市の光をレンダリングしません。",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "この時間と場所のADSBリプレイ",
            tooltip: "ADSB Exchange Replayへのリンクを生成",
        },
        googleMapsLink: {
            label: "この場所のGoogle Maps",
            tooltip: "現在位置へのGoogle Mapsリンクを作成",
        },
        inTheSkyLink: {
            label: "この時間と場所のIn-The-Sky",
            tooltip: "現在位置へのIn The Skyリンクを作成",
        },
    },
    nodeLabels: {
        focus: "デフォーカス",
        canvasResolution: "解像度",
        "Noise Amount": "ノイズ量",
        "TV In Black": "TV入力ブラック",
        "TV In White": "TV入力ホワイト",
        "TV Gamma": "TVガンマ",
        "Tv Out Black": "TV出力ブラック",
        "Tv Out White": "TV出力ホワイト",
        "JPEG Artifacts": "JPEGアーティファクト",
        pixelZoom: "ピクセルズーム %",
        videoBrightness: "明るさ",
        videoContrast: "コントラスト",
        videoBlur: "ブラー量",
        videoSharpenAmount: "シャープネス量",
        videoGreyscale: "グレースケール",
        videoHue: "色相シフト",
        videoInvert: "反転",
        videoSaturate: "彩度",
        startDistanceGUI: "開始距離",
        targetVCGUI: "ターゲット垂直速度",
        targetSpeedGUI: "ターゲット速度",
        lockWind: "ターゲット風をローカルにロック",
        jetTAS: "TAS",
        turnRate: "旋回率",
        totalTurn: "合計旋回",
        jetHeadingManual: "ジェット方位",
        headingSmooth: "方位スムージング",
        turnRateControl: "旋回率制御",
        cameraSmoothWindow: "カメラスムーズウィンドウ",
        targetSmoothWindow: "ターゲットスムーズウィンドウ",
        cameraFOV: "カメラFOV",
        "Tgt Start Dist": "ターゲット開始距離",
        "Target Speed": "ターゲット速度",
        "Tgt Relative Heading": "ターゲット相対方位",
        "KF Process": "KFプロセス",
        "KF Noise": "KFノイズ",
        "MC Num Trials": "MC試行回数",
        "MC LOS Uncertainty (deg)": "MC LOS不確実性 (deg)",
        "MC Polynomial Order": "MC多項式次数",
        "Physics Max Iterations": "物理: 最大反復回数",
        "Physics Wind Speed (kt)": "物理: 風速 (kt)",
        "Physics Wind From (\u00B0)": "物理: 風向 (\u00B0)",
        "Physics Initial Range (m)": "物理: 初期距離 (m)",
        "Tgt Start Altitude": "ターゲット開始高度",
        "Tgt Vert Spd": "ターゲット垂直速度",
        "Cloud Altitude": "雲の高度",
    },
};

export default ja;
