<?php

session_start();

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

// Load API keys from environment
$OPENAI_API_KEY = getenv("OPENAI_API");
$ANTHROPIC_API_KEY = getenv("ANTHROPIC_API");
$GROQ_API_KEY = getenv("GROQ_API");
$GROK_API_KEY = getenv("GROK_API");

// Model permissions by user group
// Groups: admin=3, registered=2, verified=9, sitrec=14
$MODEL_PERMISSIONS = [
    3 => [ // admin - all models
        ['provider' => 'openai', 'model' => 'gpt-4o', 'label' => 'GPT-4o'],
        ['provider' => 'openai', 'model' => 'gpt-4o-mini', 'label' => 'GPT-4o Mini'],
        ['provider' => 'anthropic', 'model' => 'claude-sonnet-4-20250514', 'label' => 'Claude Sonnet 4'],
        ['provider' => 'anthropic', 'model' => 'claude-sonnet-4-5-20250929', 'label' => 'Claude Sonnet 4.5'],
        ['provider' => 'anthropic', 'model' => 'claude-haiku-4-5-20251001', 'label' => 'Claude Haiku 4.5'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
        ['provider' => 'groq', 'model' => 'llama-3.1-8b-instant', 'label' => 'Llama 3.1 8B (Groq)'],
        ['provider' => 'grok', 'model' => 'grok-2-latest', 'label' => 'Grok 2'],
    ],
    14 => [ // sitrec - premium models
        ['provider' => 'openai', 'model' => 'gpt-4o', 'label' => 'GPT-4o'],
        ['provider' => 'anthropic', 'model' => 'claude-sonnet-4-20250514', 'label' => 'Claude Sonnet 4'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
    9 => [ // verified - mid-tier models
        ['provider' => 'openai', 'model' => 'gpt-4o-mini', 'label' => 'GPT-4o Mini'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
    2 => [ // registered - basic models
        ['provider' => 'groq', 'model' => 'llama-3.1-8b-instant', 'label' => 'Llama 3.1 8B (Groq)'],
    ],
];

// Get available models for a user based on their groups
function getAvailableModels($userGroups) {
    global $MODEL_PERMISSIONS, $OPENAI_API_KEY, $ANTHROPIC_API_KEY, $GROQ_API_KEY, $GROK_API_KEY;
    
    $models = [];
    $seen = [];
    
    // Collect models from all user groups (higher privilege groups first)
    $groupOrder = [3, 14, 9, 2]; // admin, sitrec, verified, registered
    foreach ($groupOrder as $group) {
        if (in_array($group, $userGroups) && isset($MODEL_PERMISSIONS[$group])) {
            foreach ($MODEL_PERMISSIONS[$group] as $model) {
                $key = $model['provider'] . ':' . $model['model'];
                if (!isset($seen[$key])) {
                    // Only include if we have the API key for this provider
                    $hasKey = match($model['provider']) {
                        'openai' => !empty($OPENAI_API_KEY),
                        'anthropic' => !empty($ANTHROPIC_API_KEY),
                        'groq' => !empty($GROQ_API_KEY),
                        'grok' => !empty($GROK_API_KEY),
                        default => false
                    };
                    if ($hasKey) {
                        $models[] = $model;
                        $seen[$key] = true;
                    }
                }
            }
        }
    }
    
    return $models;
}

// Handle fetchModels request
if (isset($_GET['fetchModels'])) {
    header('Content-Type: application/json');
    $userInfo = getUserInfo();
    $models = getAvailableModels($userInfo['user_groups']);
    echo json_encode([
        'models' => $models,
        'userId' => $userInfo['user_id'],
        'userGroups' => $userInfo['user_groups']
    ]);
    exit;
}

// Rate limiting configuration by user group
// Groups: admin=3, registered=2, verified=9, sitrec=14
$RATE_LIMITS = [
    3 => ['minute' => 1000000, 'hour' => 1000000],  // admin - effectively unlimited
    14 => ['minute' => 20, 'hour' => 100],          // sitrec - premium
    9 => ['minute' => 10, 'hour' => 50],            // verified - mid tier
    2 => ['minute' => 5, 'hour' => 20],             // registered - basic
];
$RATE_LIMIT_DIR = sys_get_temp_dir() . '/sitrec_ratelimit/';
$AI_LOG_FILE = sys_get_temp_dir() . '/sitrec_ai_requests.json';

function logAIRequest($userId, $prompt, $model = null) {
    global $AI_LOG_FILE;
    
    $logs = [];
    if (file_exists($AI_LOG_FILE)) {
        $content = file_get_contents($AI_LOG_FILE);
        $logs = json_decode($content, true) ?: [];
    }
    
    $logs[] = [
        'timestamp' => time(),
        'user_id' => $userId,
        'prompt' => substr($prompt, 0, 500),
        'model' => $model,
    ];
    
    if (count($logs) > 500) {
        $logs = array_slice($logs, -500);
    }
    
    file_put_contents($AI_LOG_FILE, json_encode($logs), LOCK_EX);
}

function getRateLimitsForUser($userGroups) {
    global $RATE_LIMITS;
    $maxMinute = 5;  // default for unknown groups
    $maxHour = 20;
    
    foreach ($userGroups as $group) {
        if (isset($RATE_LIMITS[$group])) {
            $maxMinute = max($maxMinute, $RATE_LIMITS[$group]['minute']);
            $maxHour = max($maxHour, $RATE_LIMITS[$group]['hour']);
        }
    }
    return ['minute' => $maxMinute, 'hour' => $maxHour];
}

function checkRateLimit($userId, $limitPerMinute, $limitPerHour, $rateDir) {
    if ($userId <= 0) {
        return ['allowed' => false, 'error' => 'Authentication required to use the chatbot'];
    }
    
    if (!is_dir($rateDir)) {
        @mkdir($rateDir, 0755, true);
    }
    
    $file = $rateDir . "user_{$userId}.json";
    $now = time();
    
    $data = file_exists($file) ? json_decode(file_get_contents($file), true) : null;
    if (!$data || !isset($data['minute']) || !isset($data['hour'])) {
        $data = [
            'minute' => ['count' => 0, 'reset' => $now + 60],
            'hour' => ['count' => 0, 'reset' => $now + 3600]
        ];
    }
    
    if ($now > $data['minute']['reset']) {
        $data['minute'] = ['count' => 0, 'reset' => $now + 60];
    }
    if ($now > $data['hour']['reset']) {
        $data['hour'] = ['count' => 0, 'reset' => $now + 3600];
    }
    
    if ($data['minute']['count'] >= $limitPerMinute) {
        $waitSeconds = $data['minute']['reset'] - $now;
        return ['allowed' => false, 'error' => "Rate limit exceeded. Please wait {$waitSeconds} seconds."];
    }
    
    if ($data['hour']['count'] >= $limitPerHour) {
        $waitMinutes = ceil(($data['hour']['reset'] - $now) / 60);
        $remaining = $limitPerHour - $data['hour']['count'];
        return ['allowed' => false, 'error' => "Hourly limit ({$limitPerHour}) exceeded. Please wait {$waitMinutes} minutes."];
    }
    
    $data['minute']['count']++;
    $data['hour']['count']++;
    file_put_contents($file, json_encode($data), LOCK_EX);
    
    $remainingHour = $limitPerHour - $data['hour']['count'];
    $remainingMinute = $limitPerMinute - $data['minute']['count'];
    return ['allowed' => true, 'remainingHour' => $remainingHour, 'remainingMinute' => $remainingMinute];
}

$data = json_decode(file_get_contents('php://input'), true);

// Get user info early for rate limiting
$userInfo = getUserInfo();

// Check rate limits only if stats tracking is enabled
if (getenv('SITREC_TRACK_STATS')) {
    $userRateLimits = getRateLimitsForUser($userInfo['user_groups']);
    $rateLimitResult = checkRateLimit($userInfo['user_id'], $userRateLimits['minute'], $userRateLimits['hour'], $RATE_LIMIT_DIR);
    if (!$rateLimitResult['allowed']) {
        header('Content-Type: application/json');
        http_response_code(429);
        echo json_encode(['text' => $rateLimitResult['error'], 'apiCalls' => [], 'debug' => ['error' => 'rate_limited']]);
        exit;
    }
}

// Check if this is a session continuation with tool results
$toolResults = $data['toolResults'] ?? null;
$continueSession = isset($data['continueSession']) && $data['continueSession'];

if ($continueSession && $toolResults && isset($_SESSION['chatbot_pending'])) {
    $pendingState = $_SESSION['chatbot_pending'];
    unset($_SESSION['chatbot_pending']);
    
    $toolResultsText = "[Tool Results]\n";
    foreach ($toolResults as $tr) {
        $resultJson = json_encode($tr['result'] ?? null);
        $toolResultsText .= "Tool {$tr['fn']} returned: $resultJson\n";
    }
    
    $pendingState['history'][] = ['role' => 'user', 'text' => $toolResultsText];
    
    $result = runToolLoop(
        $pendingState['provider'],
        $pendingState['apiKey'],
        $pendingState['systemPrompt'],
        $pendingState['history'],
        $pendingState['tools'],
        $pendingState['model'],
        $pendingState['menuSummary'],
        $pendingState['available3DModels'],
        $pendingState['availableDocs'] ?? [],
        $pendingState['remainingIterations']
    );
    
    if (!empty($result['apiCalls'])) {
        $_SESSION['chatbot_pending'] = [
            'provider' => $pendingState['provider'],
            'apiKey' => $pendingState['apiKey'],
            'systemPrompt' => $pendingState['systemPrompt'],
            'history' => $result['history'],
            'tools' => $pendingState['tools'],
            'model' => $pendingState['model'],
            'menuSummary' => $pendingState['menuSummary'],
            'available3DModels' => $pendingState['available3DModels'],
            'availableDocs' => $pendingState['availableDocs'] ?? [],
            'remainingIterations' => max(1, $pendingState['remainingIterations'] - 1)
        ];
        $result['sessionContinue'] = true;
    }
    unset($result['history']);
    
    $result['debug']['sessionContinued'] = true;
    header('Content-Type: application/json');
    echo json_encode($result);
    exit;
}

// Validate and sanitize prompt
$prompt = $data['prompt'] ?? '';
$prompt = trim($prompt);
$maxPromptLength = 4000;
if (strlen($prompt) > $maxPromptLength) {
    $prompt = substr($prompt, 0, $maxPromptLength);
}
if (empty($prompt)) {
    header('Content-Type: application/json');
    echo json_encode(['text' => 'Please enter a message.', 'apiCalls' => [], 'debug' => ['error' => 'empty_prompt']]);
    exit;
}

// Validate and sanitize history
$rawHistory = $data['history'] ?? [];
$history = [];
$maxHistoryMessages = 20;
$maxHistoryMessageLength = 4000;
foreach (array_slice($rawHistory, -$maxHistoryMessages) as $msg) {
    if (isset($msg['role']) && in_array($msg['role'], ['user', 'bot']) && 
        isset($msg['text']) && is_string($msg['text'])) {
        $history[] = [
            'role' => $msg['role'],
            'text' => substr($msg['text'], 0, $maxHistoryMessageLength)
        ];
    }
}

$sitrecDoc = $data['sitrecDoc'] ?? [];
$menuSummary = $data['menuSummary'] ?? [];
$available3DModels = $data['availableModels'] ?? [];
$availableDocs = $data['availableDocs'] ?? [];
$date = $data['dateTime'] ?? date('Y-m-d H:i:s');
$simDateTime = $data['simDateTime'] ?? null;
$requestedProvider = $data['provider'] ?? null;
$requestedModel = $data['model'] ?? null;

function getHelpDocContent($docName, $availableDocs) {
    global $APP_PATH;

    if (!preg_match('/^[A-Za-z0-9_-]+$/', $docName)) {
        return ['error' => "Invalid doc name: $docName"];
    }

    if (!isset($availableDocs[$docName])) {
        return ['error' => "Unknown doc: $docName. Available: " . implode(', ', array_keys($availableDocs))];
    }

    $docPath = __DIR__ . '/' . $APP_PATH . 'docs/' . $docName . '.md';
    if (!file_exists($docPath)) {
        return ['error' => "Doc file not found: $docName. Tried path: $docPath, __DIR__=" . __DIR__ . ", APP_PATH=$APP_PATH"];
    }
    
    $content = file_get_contents($docPath);
    $content = preg_replace('/<!--[\s\S]*?-->/', '', $content);
    
    if (strlen($content) > 8000) {
        $content = substr($content, 0, 8000) . "\n\n[Content truncated - showing first 8000 characters]";
    }
    
    return ['content' => $content];
}

// Log AI request
if (getenv('SITREC_TRACK_STATS')) {
    logAIRequest($userInfo['user_id'], $prompt, $requestedModel);
}

// User info already retrieved above for rate limiting
$aiModels = getAvailableModels($userInfo['user_groups']);
$selectedProvider = null;
$selectedModel = null;

if ($requestedProvider && $requestedModel) {
    foreach ($aiModels as $m) {
        if ($m['provider'] === $requestedProvider && $m['model'] === $requestedModel) {
            $selectedProvider = $requestedProvider;
            $selectedModel = $requestedModel;
            break;
        }
    }
}

// Fall back to first available model if requested model not allowed
if (!$selectedProvider && !empty($aiModels)) {
    $selectedProvider = $aiModels[0]['provider'];
    $selectedModel = $aiModels[0]['model'];
}

// Build tools array from sitrecDoc (OpenAI format, will convert for Anthropic)
function buildToolsFromDoc($sitrecDoc, $menuSummary) {
    $tools = [];
    $addedNames = [];
    
    // Menu function names that we'll add manually with better schemas
    $menuFunctions = ['setMenuValue', 'getMenuValue', 'executeMenuButton', 'listMenus', 'listMenuControls'];
    
    // Parse sitrecDoc entries to extract function schemas
    foreach ($sitrecDoc as $fn => $desc) {
        // Skip menu functions - we'll add them with better schemas below
        if (in_array($fn, $menuFunctions)) {
            continue;
        }
        $tool = [
            "type" => "function",
            "function" => [
                "name" => $fn,
                "description" => $desc,
                "parameters" => [
                    "type" => "object",
                    "properties" => new stdClass(),
                    "required" => []
                ]
            ]
        ];
        
        // Try to extract parameters from description
        if (preg_match('/Parameters:\s*(.+)$/i', $desc, $matches)) {
            $paramsStr = $matches[1];
            preg_match_all('/(\w+)\s*\(([^)]+)\)/', $paramsStr, $paramMatches, PREG_SET_ORDER);
            
            $properties = [];
            $required = [];
            foreach ($paramMatches as $pm) {
                $paramName = $pm[1];
                $paramDesc = $pm[2];
                
                $type = "string";
                if (stripos($paramDesc, 'float') !== false || stripos($paramDesc, 'number') !== false) {
                    $type = "number";
                } elseif (stripos($paramDesc, 'int') !== false) {
                    $type = "integer";
                } elseif (stripos($paramDesc, 'bool') !== false) {
                    $type = "boolean";
                }
                
                $properties[$paramName] = [
                    "type" => $type,
                    "description" => $paramDesc
                ];
                
                if (stripos($paramDesc, 'optional') === false) {
                    $required[] = $paramName;
                }
            }
            
            if (!empty($properties)) {
                $tool["function"]["parameters"]["properties"] = $properties;
                $tool["function"]["parameters"]["required"] = $required;
            }
        }
        
        $tools[] = $tool;
    }
    
    // Build short menu list for tool descriptions (just menu IDs)
    $menuIds = !empty($menuSummary) ? implode(", ", array_keys($menuSummary)) : "view, camera, satellites, terrain";
    
    // Add menu control functions (keep descriptions short - full list is in system prompt)
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "setMenuValue",
            "description" => "Set a menu control's value. Available menus: $menuIds. See system prompt for full control list.",
            "parameters" => [
                "type" => "object",
                "properties" => [
                    "menu" => ["type" => "string", "description" => "Menu ID"],
                    "path" => ["type" => "string", "description" => "Control name or path with '/' for nested folders"],
                    "value" => ["description" => "New value (number, boolean, or string)"]
                ],
                "required" => ["menu", "path", "value"]
            ]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "getMenuValue",
            "description" => "Get the current value of a menu control.",
            "parameters" => [
                "type" => "object",
                "properties" => [
                    "menu" => ["type" => "string", "description" => "Menu ID"],
                    "path" => ["type" => "string", "description" => "Control name or path"]
                ],
                "required" => ["menu", "path"]
            ]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "executeMenuButton",
            "description" => "Click/execute a button control in a menu.",
            "parameters" => [
                "type" => "object",
                "properties" => [
                    "menu" => ["type" => "string", "description" => "Menu ID"],
                    "path" => ["type" => "string", "description" => "Button name or path"]
                ],
                "required" => ["menu", "path"]
            ]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "listMenus",
            "description" => "List all available menu IDs.",
            "parameters" => ["type" => "object", "properties" => new stdClass()]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "listMenuControls",
            "description" => "List all controls in a specific menu.",
            "parameters" => [
                "type" => "object",
                "properties" => ["menu" => ["type" => "string", "description" => "Menu ID to list controls for"]],
                "required" => ["menu"]
            ]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "getHelpDoc",
            "description" => "Read a help documentation file. Use this to answer questions about Sitrec features, what's new, or how to use specific functionality.",
            "parameters" => [
                "type" => "object",
                "properties" => ["docName" => ["type" => "string", "description" => "Name of the doc to read (e.g., 'WhatsNew', 'Starlink', 'UserInterface')"]],
                "required" => ["docName"]
            ]
        ]
    ];
    
    return $tools;
}

// Convert OpenAI tools format to Anthropic format
function convertToolsForAnthropic($tools) {
    $anthropicTools = [];
    foreach ($tools as $tool) {
        $anthropicTools[] = [
            "name" => $tool["function"]["name"],
            "description" => $tool["function"]["description"],
            "input_schema" => $tool["function"]["parameters"]
        ];
    }
    return $anthropicTools;
}

$tools = buildToolsFromDoc($sitrecDoc, $menuSummary);

// Build menu documentation for system prompt (limit size to avoid token limits)
$menuDocForPrompt = "";
if (!empty($menuSummary)) {
    $menuDocForPrompt = "\n\nAVAILABLE MENU CONTROLS:\n";
    $totalControls = 0;
    $maxControls = 9999; // Limit to prevent huge prompts (temporarily high for debugging)
    
    foreach ($menuSummary as $menuId => $controls) {
        if (!empty($controls) && $totalControls < $maxControls) {
            $menuDocForPrompt .= "\nMenu '$menuId':\n";
            foreach ($controls as $control) {
                if ($totalControls >= $maxControls) {
                    $menuDocForPrompt .= "  - (more controls available - use listMenuControls)\n";
                    break;
                }
                $menuDocForPrompt .= "  - $control\n";
                $totalControls++;
            }
        }
    }
    $menuDocForPrompt .= "\nUse setMenuValue with menu ID and control path (e.g., 'Flow Orbs/Visible' for nested). Use listMenuControls to see all controls in a menu.\n";
}

$systemPrompt = <<<EOT
You are a helpful assistant for the Sitrec app. 

You should reply in the same language as the user's prompt, unless instructed otherwise.

The user's current real date and time (not the simulation time) is: {$date}. Use the timezone specified here, or any specified in the prompt or location context.

The current SIMULATION date/time is: {$simDateTime}. This is the date the app is showing - satellites are loaded for this date. If this changes between requests, the user may need to reload satellites.

When giving a time, always use the user's local time, unless they specify UTC or another timezone.

When setting a time in conjunction with a location and date, use that location's time

You can answer questions about Sitrec and call functions to control the application.

Sitrec is a Situation Recreation application written by Mick West. It can:
- Show satellite positions in the sky (Starlink, ISS, LEO satellites, etc.)
- Show ADS-B aircraft positions from loaded track files
- Show astronomy objects (stars, planets, Sun, Moon, constellations)
- Visualize 3D terrain with various map and elevation sources
- Overlay video footage for comparison with the simulated view
- Set camera position, orientation, and field of view
- Display 3D objects (aircraft models, geometric shapes) along tracks
- Calculate and display lines of sight and traverse paths
The primary use is for resolving UAP sightings and other events by showing what was in the sky at a given time.

SATELLITE LOADING:
- "load satellites" or general satellite requests → use satellitesLoadLEO
- "load current starlink" specifically → use satellitesLoadCurrentStarlink
- After loading, filter with: showStarlink, showISS, showBrightest, showOtherSatellites

VISIBILITY CONTROLS:
- The "satellites" menu has "showSatelliteNames" (for look view) and "showSatelliteNamesMain" (for main view) to toggle satellite name labels.
- When the user asks to show satellite labels "in look" or "in the look view", use setMenuValue on the satellites menu with showSatelliteNames = true.
- Stars visibility: use setMenuValue on "showhide" menu with "Show Stars".
- Terrain/ground visibility: check the "terrain" menu for map type and elevation options.

3D OBJECTS:
- Use listAvailableModels to see aircraft/object models (jets, helicopters, drones, etc.)
- Use setObjectModel to set a specific object to use a 3D model
- Use setObjectGeometry to use procedural shapes (sphere, box, superegg, etc.)
- Use listAvailableGeometries to see geometry types and their dimension parameters
- Objects are organized in the "objects" menu with folders like "cameraObject", "targetObject"

LIGHTING:
- The "lighting" menu controls scene lighting (ambient, directional, sun position)
- "Ambient Only" mode available for silhouette-style views

When the user asks you to DO something (set, change, move, show, hide, point, go to, etc.):
- If you know the correct function or menu control, call it immediately.
- The system uses FLEXIBLE MATCHING - partial names and keywords work. For example, "frustum off" can use setMenuValue with path "frustum" and the system will find "Camera View Frustum".
- When the user uses a keyword that likely matches a control (like "frustum", "LOS", "labels"), TRY IT - the flexible matching will find the right control.
- Only say you don't know if you truly have no idea what the user is asking for.

CRITICAL RULE - MUST FOLLOW: When the user requests an action (like "load sats"), you MUST call the appropriate function. Do NOT just respond with text like "Loading..." - you must actually invoke the function tool. Even if you see the same request in the history, you MUST call the function again. The conversation history does NOT mean the action persists - each request requires a new function call.

If the user confirms with "yes", "ok", "sure", "do it", etc., EXECUTE the action you proposed by calling the function.

ALWAYS provide a brief text response describing what you did or are doing, even when making function calls. For example: "Loading LEO satellites..." or "Turned on satellite labels in look view." Never return an empty response.

Keep responses brief. Focus on being helpful.

Do not discuss anything unrelated to Sitrec, including people, events, or politics. But you can talk about Mick West.
EOT;

$systemPrompt .= $menuDocForPrompt;

if (!empty($availableDocs)) {
    $systemPrompt .= "\n\nAVAILABLE HELP DOCUMENTATION:\n";
    $systemPrompt .= "Use getHelpDoc to read these docs when answering questions about features or how to do things:\n";
    foreach ($availableDocs as $docName => $description) {
        $systemPrompt .= "- $docName: $description\n";
    }
    $systemPrompt .= "\nFor questions like 'what's new' or 'how do I do X', use getHelpDoc to get accurate information.\n";
}

// Call OpenAI API
function callOpenAI($apiKey, $systemPrompt, $history, $tools, $model = 'gpt-4o') {
    $messages = [["role" => "system", "content" => $systemPrompt]];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'assistant' : $msg['role'];
        $messages[] = ["role" => $role, "content" => $msg['text']];
    }
    
    $ch = curl_init("https://api.openai.com/v1/chat/completions");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer $apiKey",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode([
            "model" => $model,
            "messages" => $messages,
            "tools" => $tools,
            "tool_choice" => "auto",
            "temperature" => 0.2
        ])
    ]);
    
    $response = curl_exec($ch);
    curl_close($ch);
    
    $parsed = json_decode($response, true);
    $message = $parsed['choices'][0]['message'] ?? [];
    $text = $message['content'] ?? '';
    $calls = [];
    
    if (!empty($message['tool_calls'])) {
        foreach ($message['tool_calls'] as $tc) {
            $args = json_decode($tc['function']['arguments'], true);
            $calls[] = [
                "fn" => $tc['function']['name'],
                "args" => $args ?? []
            ];
        }
    }
    
    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'openai',
            'model' => $model,
            'hasToolCalls' => !empty($message['tool_calls']),
            'toolCallCount' => count($message['tool_calls'] ?? [])
        ]
    ];
}


// Current antropic models:
// Claude Sonnet 4.5	claude-sonnet-4-5-20250929	Recommended - best balance
// Claude Haiku 4.5	    claude-haiku-4-5-20251001	Fastest, cheapest
// Claude Opus 4.5	    claude-opus-4-5-20251101	Most intelligent, higher cost

// Call Anthropic (Claude) API
function callAnthropic($apiKey, $systemPrompt, $history, $tools, $model = 'claude-sonnet-4-20250514') {
    $messages = [];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'assistant' : 'user';
        $messages[] = ["role" => $role, "content" => $msg['text']];
    }
    
    // Anthropic requires at least one message
    if (empty($messages)) {
        return [
            'text' => 'Error: No messages to send',
            'apiCalls' => [],
            'debug' => ['provider' => 'anthropic', 'model' => $model, 'error' => 'No messages']
        ];
    }
    
    $anthropicTools = convertToolsForAnthropic($tools);
    
    $requestBody = [
        "model" => $model,
        "max_tokens" => 1024,
        "system" => $systemPrompt,
        "messages" => $messages,
        "tools" => $anthropicTools
    ];
    
    $ch = curl_init("https://api.anthropic.com/v1/messages");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "x-api-key: $apiKey",
            "anthropic-version: 2023-06-01",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode($requestBody)
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    
    // Check for curl errors
    if ($curlError) {
        return [
            'text' => "Error: $curlError",
            'apiCalls' => [],
            'debug' => ['provider' => 'anthropic', 'curlError' => $curlError]
        ];
    }
    
    $parsed = json_decode($response, true);
    
    // Check for API errors
    if (isset($parsed['error'])) {
        return [
            'text' => "Anthropic API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => [
                'provider' => 'anthropic',
                'httpCode' => $httpCode,
                'error' => $parsed['error']
            ]
        ];
    }
    
    $content = $parsed['content'] ?? [];
    
    $text = '';
    $calls = [];
    
    foreach ($content as $block) {
        if ($block['type'] === 'text') {
            $text .= $block['text'];
        } elseif ($block['type'] === 'tool_use') {
            $calls[] = [
                "fn" => $block['name'],
                "args" => $block['input'] ?? []
            ];
        }
    }
    
    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'anthropic',
            'model' => $model,
            'hasToolCalls' => !empty($calls),
            'toolCallCount' => count($calls),
            'stopReason' => $parsed['stop_reason'] ?? null,
            'httpCode' => $httpCode
        ]
    ];
}

// Groq models (OpenAI-compatible API, very fast inference):
// llama-3.3-70b-versatile - Best quality
// llama-3.1-8b-instant - Fastest
// mixtral-8x7b-32768 - Good balance

// Call Groq API (OpenAI-compatible)
function callGroq($apiKey, $systemPrompt, $history, $tools, $model = 'llama-3.3-70b-versatile') {
    $messages = [["role" => "system", "content" => $systemPrompt]];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'assistant' : $msg['role'];
        $messages[] = ["role" => $role, "content" => $msg['text']];
    }
    
    $ch = curl_init("https://api.groq.com/openai/v1/chat/completions");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer $apiKey",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode([
            "model" => $model,
            "messages" => $messages,
            "tools" => $tools,
            "tool_choice" => "auto",
            "temperature" => 0.2
        ])
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    
    if ($curlError) {
        return [
            'text' => "Error: $curlError",
            'apiCalls' => [],
            'debug' => ['provider' => 'groq', 'curlError' => $curlError]
        ];
    }
    
    $parsed = json_decode($response, true);
    
    if (isset($parsed['error'])) {
        return [
            'text' => "Groq API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => ['provider' => 'groq', 'httpCode' => $httpCode, 'error' => $parsed['error']]
        ];
    }
    
    $message = $parsed['choices'][0]['message'] ?? [];
    $text = $message['content'] ?? '';
    $calls = [];
    
    if (!empty($message['tool_calls'])) {
        foreach ($message['tool_calls'] as $tc) {
            $args = json_decode($tc['function']['arguments'], true);
            $calls[] = [
                "fn" => $tc['function']['name'],
                "args" => $args ?? []
            ];
        }
    }
    
    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'groq',
            'model' => $model,
            'hasToolCalls' => !empty($message['tool_calls']),
            'toolCallCount' => count($message['tool_calls'] ?? []),
            'httpCode' => $httpCode
        ]
    ];
}

// xAI Grok models (OpenAI-compatible API):
// grok-2-latest - Latest Grok 2
// grok-beta - Beta version

// Call xAI Grok API (OpenAI-compatible)
function callGrok($apiKey, $systemPrompt, $history, $tools, $model = 'grok-2-latest') {
    $messages = [["role" => "system", "content" => $systemPrompt]];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'assistant' : $msg['role'];
        $messages[] = ["role" => $role, "content" => $msg['text']];
    }
    
    $ch = curl_init("https://api.x.ai/v1/chat/completions");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer $apiKey",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode([
            "model" => $model,
            "messages" => $messages,
            "tools" => $tools,
            "tool_choice" => "auto",
            "temperature" => 0.2
        ])
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    
    if ($curlError) {
        return [
            'text' => "Error: $curlError",
            'apiCalls' => [],
            'debug' => ['provider' => 'grok', 'curlError' => $curlError]
        ];
    }
    
    $parsed = json_decode($response, true);
    
    if (isset($parsed['error'])) {
        return [
            'text' => "Grok API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => ['provider' => 'grok', 'httpCode' => $httpCode, 'error' => $parsed['error']]
        ];
    }
    
    $message = $parsed['choices'][0]['message'] ?? [];
    $text = $message['content'] ?? '';
    $calls = [];
    
    if (!empty($message['tool_calls'])) {
        foreach ($message['tool_calls'] as $tc) {
            $args = json_decode($tc['function']['arguments'], true);
            $calls[] = [
                "fn" => $tc['function']['name'],
                "args" => $args ?? []
            ];
        }
    }
    
    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'grok',
            'model' => $model,
            'hasToolCalls' => !empty($message['tool_calls']),
            'toolCallCount' => count($message['tool_calls'] ?? []),
            'httpCode' => $httpCode
        ]
    ];
}

// Simulate query-type tool calls on the server side
// Returns [handled => bool, result => mixed] - if handled, result is the tool response
function simulateToolCall($fn, $args, $menuSummary, $availableModels, $availableDocs = []) {
    
    switch ($fn) {
        case 'listMenus':
            return ['handled' => true, 'result' => array_keys($menuSummary)];
        case 'listMenuControls':
            $menu = $args['menu'] ?? '';
            if (isset($menuSummary[$menu])) {
                return ['handled' => true, 'result' => $menuSummary[$menu]];
            }
            return ['handled' => true, 'result' => ['error' => "Menu '$menu' not found"]];
        case 'listAvailableModels':
            return ['handled' => true, 'result' => $availableModels];
        case 'getHelpDoc':
            $docName = $args['docName'] ?? '';
            $result = getHelpDocContent($docName, $availableDocs);
            return ['handled' => true, 'result' => $result];
        case 'listObjectFolders':
            return ['handled' => false, 'result' => null];
        default:
            return ['handled' => false, 'result' => null];
    }
}

// Tool use loop - allows AI to make multiple tool calls
function runToolLoop($provider, $apiKey, $systemPrompt, $history, $tools, $model, $menuSummary, $availableModels, $availableDocs = [], $maxIterations = 5) {
    $allApiCalls = [];  // Action calls to send to client
    $debugInfo = [];
    $finalText = '';
    $currentHistory = $history;
    
    for ($iteration = 0; $iteration < $maxIterations; $iteration++) {
        // Call the appropriate provider
        if ($provider === 'anthropic') {
            global $ANTHROPIC_API_KEY;
            $result = callAnthropic($ANTHROPIC_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
        } elseif ($provider === 'groq') {
            global $GROQ_API_KEY;
            $result = callGroq($GROQ_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
        } elseif ($provider === 'grok') {
            global $GROK_API_KEY;
            $result = callGrok($GROK_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
        } else {
            global $OPENAI_API_KEY;
            $result = callOpenAI($OPENAI_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
        }
        
        $debugInfo['iteration_' . $iteration] = $result['debug'];
        $debugInfo['iteration_' . $iteration]['toolResults'] = [];
        
        // Collect any text response
        if (!empty($result['text'])) {
            $finalText .= ($finalText ? "\n" : '') . $result['text'];
        }
        
        // No tool calls - we're done
        if (empty($result['apiCalls'])) {
            break;
        }
        
        // Process tool calls
        $handledCalls = [];
        $pendingActionCalls = [];
        
        foreach ($result['apiCalls'] as $call) {
            $simResult = simulateToolCall($call['fn'], $call['args'], $menuSummary, $availableModels, $availableDocs);
            if ($simResult['handled']) {
                // Query tool - we can simulate it
                $handledCalls[] = [
                    'fn' => $call['fn'],
                    'args' => $call['args'],
                    'result' => $simResult['result']
                ];
                $debugInfo['iteration_' . $iteration]['toolResults'][] = [
                    'fn' => $call['fn'],
                    'args' => $call['args'],
                    'result' => $simResult['result']
                ];
            } else {
                // Action tool - needs client execution
                $pendingActionCalls[] = $call;
            }
        }
        
        // If we have action calls, return them to client (don't continue loop)
        if (!empty($pendingActionCalls)) {
            $allApiCalls = array_merge($allApiCalls, $pendingActionCalls);
            break;
        }
        
        // If we handled query calls, add results to history and continue loop
        if (!empty($handledCalls)) {
            // Build a response showing tool results
            $toolResultsText = '';
            foreach ($handledCalls as $hc) {
                $resultJson = json_encode($hc['result']);
                $toolResultsText .= "Tool {$hc['fn']} returned: $resultJson\n";
            }
            
            // Add assistant's tool call and simulated tool response to history
            $currentHistory[] = ['role' => 'bot', 'text' => "Calling tools: " . json_encode(array_column($handledCalls, 'fn'))];
            $currentHistory[] = ['role' => 'user', 'text' => "[Tool Results]\n$toolResultsText"];
        }
    }
    
    return [
        'text' => $finalText,
        'apiCalls' => $allApiCalls,
        'history' => $currentHistory,
        'debug' => array_merge(
            ['provider' => $provider, 'model' => $model, 'iterations' => $iteration + 1],
            count($debugInfo) === 1 ? $debugInfo['iteration_0'] : $debugInfo
        )
    ];
}

// Call the appropriate provider with tool loop
if (!$selectedProvider) {
    $result = [
        'text' => 'Error: No models available for your account',
        'apiCalls' => [],
        'debug' => ['error' => 'No available models']
    ];
} else {
    $apiKey = match($selectedProvider) {
        'anthropic' => $ANTHROPIC_API_KEY,
        'groq' => $GROQ_API_KEY,
        'grok' => $GROK_API_KEY,
        default => $OPENAI_API_KEY
    };
    $result = runToolLoop($selectedProvider, $apiKey, $systemPrompt, $history, $tools, $selectedModel, $menuSummary, $available3DModels, $availableDocs, 5);
    
    if (!empty($result['apiCalls'])) {
        $_SESSION['chatbot_pending'] = [
            'provider' => $selectedProvider,
            'apiKey' => $apiKey,
            'systemPrompt' => $systemPrompt,
            'history' => $result['history'],
            'tools' => $tools,
            'model' => $selectedModel,
            'menuSummary' => $menuSummary,
            'available3DModels' => $available3DModels,
            'availableDocs' => $availableDocs,
            'remainingIterations' => 4
        ];
        $result['sessionContinue'] = true;
    }
    unset($result['history']);
}

header('Content-Type: application/json');
echo json_encode($result);
