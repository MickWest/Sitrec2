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
$GEMINI_API_KEY = getenv("GEMINI_API"); // Google Gemini; models hidden until this is set

// SECURITY: Derive API key from provider name so we never store keys in session
function getApiKeyForProvider($provider) {
    global $OPENAI_API_KEY, $ANTHROPIC_API_KEY, $GROQ_API_KEY, $GROK_API_KEY, $GEMINI_API_KEY;
    return match($provider) {
        'anthropic' => $ANTHROPIC_API_KEY,
        'groq' => $GROQ_API_KEY,
        'grok' => $GROK_API_KEY,
        'gemini' => $GEMINI_API_KEY,
        default => $OPENAI_API_KEY
    };
}

// Model permissions by user group
// Groups: admin=3, registered=2, verified=9, sitrec=14, sitrec-plus=19
$MODEL_PERMISSIONS = [
    // NOTE on cost/value (per 1M tokens, in/out, mid-2026): gpt-5-mini $0.25/$2 is the
    // best-value default (big upgrade over the old gpt-4o at lower cost); gpt-5-nano
    // $0.05/$0.40 and gemini-2.5-flash-lite $0.10/$0.40 are the cheapest capable models;
    // claude-haiku-4-5 $1/$5 is higher quality with strong prompt caching; sonnet 4.6
    // ($3/$15) and opus 4.8 ($5/$25) are admin-only premium. The FIRST entry in a user's
    // highest tier is their default model. grok-4-fast may alias to pricier Grok-4.3 —
    // kept admin-only. Gemini entries are hidden until GEMINI_API is set (see shared.env).
    3 => [ // admin - all models
        ['provider' => 'openai', 'model' => 'gpt-5-mini', 'label' => 'GPT-5 Mini'],
        ['provider' => 'openai', 'model' => 'gpt-5-nano', 'label' => 'GPT-5 Nano'],
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'anthropic', 'model' => 'claude-haiku-4-5-20251001', 'label' => 'Claude Haiku 4.5'],
        ['provider' => 'anthropic', 'model' => 'claude-sonnet-4-6', 'label' => 'Claude Sonnet 4.6'],
        ['provider' => 'anthropic', 'model' => 'claude-opus-4-8', 'label' => 'Claude Opus 4.8'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
        ['provider' => 'grok', 'model' => 'grok-4-fast', 'label' => 'Grok 4 Fast'],
    ],
    19 => [ // sitrec-plus - same models as sitrec, 10x rate limits
        ['provider' => 'openai', 'model' => 'gpt-5-mini', 'label' => 'GPT-5 Mini'],
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'anthropic', 'model' => 'claude-haiku-4-5-20251001', 'label' => 'Claude Haiku 4.5'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
    14 => [ // sitrec - premium models
        ['provider' => 'openai', 'model' => 'gpt-5-mini', 'label' => 'GPT-5 Mini'],
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'anthropic', 'model' => 'claude-haiku-4-5-20251001', 'label' => 'Claude Haiku 4.5'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
    9 => [ // verified - cheapest capable models (default = cheapest available)
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'openai', 'model' => 'gpt-5-nano', 'label' => 'GPT-5 Nano'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
    2 => [ // registered - same as verified
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'openai', 'model' => 'gpt-5-nano', 'label' => 'GPT-5 Nano'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
];

// Get available models for a user based on their groups
function getAvailableModels($userGroups) {
    global $MODEL_PERMISSIONS, $OPENAI_API_KEY, $ANTHROPIC_API_KEY, $GROQ_API_KEY, $GROK_API_KEY, $GEMINI_API_KEY;

    $models = [];
    $seen = [];
    
    // Collect models from all user groups (higher privilege groups first)
    $groupOrder = [3, 19, 14, 9, 2]; // admin, sitrec-plus, sitrec, verified, registered
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
                        'gemini' => !empty($GEMINI_API_KEY),
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
// Groups: admin=3, registered=2, verified=9, sitrec=14, sitrec-plus=19
$RATE_LIMITS = [
    3 => ['minute' => 1000000, 'hour' => 1000000],  // admin - effectively unlimited
    19 => ['minute' => 200, 'hour' => 1000],        // sitrec-plus - 10x sitrec
    14 => ['minute' => 20, 'hour' => 100],          // sitrec - premium
    9 => ['minute' => 10, 'hour' => 50],            // verified - mid tier
    2 => ['minute' => 10, 'hour' => 50],            // registered - same as verified
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
        getApiKeyForProvider($pendingState['provider']),
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
        // Loop guard: if the LLM is re-issuing exactly the same fn+args we just sent it
        // a successful result for, drop the duplicate calls and stop continuing. Without
        // this, a model that ignores [Tool Results] semantics will burn through the
        // continuation budget repeating itself.
        $priorCallSig = [];
        foreach ($toolResults as $tr) {
            $priorCallSig[] = $tr['fn'] . '|' . json_encode($tr['args'] ?? null);
        }
        $filteredCalls = [];
        $droppedDuplicates = [];
        foreach ($result['apiCalls'] as $call) {
            $sig = $call['fn'] . '|' . json_encode($call['args'] ?? null);
            if (in_array($sig, $priorCallSig, true)) {
                $droppedDuplicates[] = $call['fn'];
            } else {
                $filteredCalls[] = $call;
            }
        }
        $result['apiCalls'] = $filteredCalls;
        if (!empty($droppedDuplicates)) {
            $result['debug']['droppedDuplicateCalls'] = $droppedDuplicates;
            if (empty($result['text'])) {
                $result['text'] = "Done.";
            }
        }
    }

    if (!empty($result['apiCalls'])) {
        $newRemaining = $pendingState['remainingIterations'] - 1;
        if ($newRemaining > 0) {
            $_SESSION['chatbot_pending'] = [
                'provider' => $pendingState['provider'],
                'systemPrompt' => $pendingState['systemPrompt'],
                'history' => $result['history'],
                'tools' => $pendingState['tools'],
                'model' => $pendingState['model'],
                'menuSummary' => $pendingState['menuSummary'],
                'available3DModels' => $pendingState['available3DModels'],
                'availableDocs' => $pendingState['availableDocs'] ?? [],
                'remainingIterations' => $newRemaining
            ];
            $result['sessionContinue'] = true;
        }
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
    
    if (strlen($content) > 20000) {
        $content = substr($content, 0, 20000) . "\n\n[Content truncated - showing first 20000 characters]";
    }
    
    return ['content' => $content];
}

// Log AI request
if (getenv('SITREC_TRACK_STATS')) {
    logAIRequest($userInfo['user_id'], $prompt, $requestedModel);
    require_once __DIR__ . '/stats_history.php';
    recordDailyStats(['ai_requests' => 1]);
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

    // SECURITY (B1): never advertise JS-executing functions to the LLM. The client already
    // sends the filtered getLLMDocumentation(), but re-deny here so a tampered/legacy client
    // sending the full doc still can't expose these. Keep in sync with the CSitrecAPI entries
    // tagged llmCallable:false.
    $llmDenied = ['setScriptedVideoScript', 'previewScriptedVideo'];

    // Parse sitrecDoc entries to extract function schemas
    foreach ($sitrecDoc as $fn => $desc) {
        // Skip menu functions - we'll add them with better schemas below
        if (in_array($fn, $menuFunctions)) {
            continue;
        }
        // Skip functions that must never be callable from chat (JS execution).
        if (in_array($fn, $llmDenied, true)) {
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
                } elseif (preg_match('/\binteger\b|\bint\b/i', $paramDesc)) {
                    $type = "integer";
                } elseif (stripos($paramDesc, 'bool') !== false) {
                    $type = "boolean";
                } elseif (stripos($paramDesc, 'array') !== false) {
                    $type = "array";
                }
                
                $prop = [
                    "type" => $type,
                    "description" => $paramDesc
                ];
                // For array types, add items schema so LLMs know element type
                if ($type === "array") {
                    $prop["items"] = ["type" => "string"];
                }
                $properties[$paramName] = $prop;
                
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

// Convert the OpenAI-style tools array into Gemini's tools.functionDeclarations form.
function convertToolsForGemini($tools) {
    $decls = [];
    foreach ($tools as $tool) {
        $decls[] = [
            "name" => $tool["function"]["name"],
            "description" => $tool["function"]["description"],
            "parameters" => $tool["function"]["parameters"]
        ];
    }
    return [["functionDeclarations" => $decls]];
}

// Call Google Gemini (generativelanguage REST). Same contract as the other providers:
// take the text chat history + OpenAI-style tools, return {text, apiCalls, debug}. The
// chatbot's tool loop feeds tool *results* back as plain text messages (see runToolLoop),
// so we only parse the model's function CALLS here — no native functionResponse threading
// is needed. Hidden from users unless GEMINI_API is set (see getAvailableModels()).
function callGemini($apiKey, $systemPrompt, $history, $tools, $model = 'gemini-2.5-flash-lite') {
    $contents = [];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'model' : 'user';
        $contents[] = ["role" => $role, "parts" => [["text" => $msg['text']]]];
    }

    if (empty($contents)) {
        return [
            'text' => 'Error: No messages to send',
            'apiCalls' => [],
            'debug' => ['provider' => 'gemini', 'model' => $model, 'error' => 'No messages']
        ];
    }

    $requestBody = [
        "system_instruction" => ["parts" => [["text" => $systemPrompt]]],
        "contents" => $contents,
        "tools" => convertToolsForGemini($tools),
        "generationConfig" => ["maxOutputTokens" => 1024]
    ];

    $url = "https://generativelanguage.googleapis.com/v1beta/models/" . rawurlencode($model) . ":generateContent";
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "x-goog-api-key: $apiKey",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode($requestBody)
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($curlError) {
        return [
            'text' => "Error: $curlError",
            'apiCalls' => [],
            'debug' => ['provider' => 'gemini', 'curlError' => $curlError]
        ];
    }

    $parsed = json_decode($response, true);

    if (isset($parsed['error'])) {
        return [
            'text' => "Gemini API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => ['provider' => 'gemini', 'httpCode' => $httpCode, 'error' => $parsed['error']]
        ];
    }

    $parts = $parsed['candidates'][0]['content']['parts'] ?? [];
    $text = '';
    $calls = [];
    foreach ($parts as $part) {
        if (isset($part['text'])) {
            $text .= $part['text'];
        } elseif (isset($part['functionCall'])) {
            $calls[] = [
                "fn" => $part['functionCall']['name'],
                "args" => $part['functionCall']['args'] ?? []
            ];
        }
    }

    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'gemini',
            'model' => $model,
            'hasToolCalls' => !empty($calls),
            'toolCallCount' => count($calls),
            'finishReason' => $parsed['candidates'][0]['finishReason'] ?? null,
            'httpCode' => $httpCode
        ]
    ];
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

You are NOT automatically given the current real-world (wall-clock) date and time. If a request depends on the actual present moment (e.g. "right now", "tonight", "in an hour"), or you need the user's local timezone, call the getCurrentDateTime function — it returns the real date/time as an ISO 8601 string with the user's timezone offset. (Keeping this out of the prompt by default lets the request prefix be cached; fetch it on demand.)

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

CAMERA POINTING vs LOCKING (read carefully — these are NOT interchangeable):
- "point at" / "look at" / "show me" / "aim at" = ONE-SHOT pointing. Camera moves once and stays still. MUST use pointCameraAtNamedObject (planets/Sun/Moon) or pointCameraAtRaDec (stars/deep-sky). NEVER use a lock* function for these phrases.
- "lock on" / "lock onto" / "track" / "follow" / "keep on" = CONTINUOUS tracking. Camera follows the object as time advances. MUST use lockCameraOnObject (planets/Sun/Moon) or lockCameraOnRaDec (stars/deep-sky). NEVER use a point* function for these phrases.
- "unlock" / "stop tracking" / "release" = stop any active lock. Use unlockCamera.
- Picking the wrong family (point vs lock) is a serious error. If the user says "point" but you call lock*, the camera will track the target instead of staying still — that is wrong. When in doubt, default to point*.
- For stars/asterisms/constellations/galaxies/nebulae the user names that you don't have coordinates memorized for, recall the RA/Dec from your knowledge and call the appropriate RaDec variant. Examples: M45 (Pleiades) RA=3h47m Dec=+24d07m; Orion (Betelgeuse) RA=5h55m Dec=+7d24m; Polaris RA=2h32m Dec=+89d16m; Sirius RA=6h45m Dec=-16d43m; Phoenix constellation (center) RA=1h00m Dec=-48d00m.
- RA is in hours (0-24), Dec is in degrees (-90 to +90). Both pointCameraAtRaDec and lockCameraOnRaDec accept decimal or sexagesimal ("3h47m", "3:47", "+24d07m"). Double-check the sign on Dec — southern-sky objects (Phoenix, Sirius, etc.) have NEGATIVE declination.

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

CRITICAL RULE - MUST FOLLOW: When the user makes a NEW request for an action (like "load sats"), you MUST call the appropriate function. Do NOT just respond with text like "Loading..." - you must actually invoke the function tool. If the user repeats a previous request as a NEW user message, call the function again — the conversation history alone does not mean the action persists.

MULTI-PART REQUESTS (CRITICAL): A single user message often asks for MORE THAN ONE action, e.g. "12:21pm today, New York" = (1) set the date/time AND (2) move the camera. You MUST perform ALL parts. Emit ALL the needed function calls together in one turn when you can. Never report the task as done while any part is still unperformed — check the user's request against the calls you have actually made before writing your final confirmation.

HOW TO READ "[Tool Results]" MESSAGES (CRITICAL — read carefully):
- A user-role message that begins with "[Tool Results]" is NOT a new user request. It is a system-generated report of what happened when you previously called a tool. Treat it as informational only.
- When you see "[Tool Results]\nTool X returned: {\"success\":true,...}", that means THAT call succeeded. DO NOT call X again with the same args. But a tool result does NOT mean you should stop: if other parts of the user's request are still unperformed (a query tool like getCurrentDateTime returning is NOT the task being done), CONTINUE by calling the remaining functions now. Only when every part of the request has a successful tool result do you respond with brief confirmation TEXT (one sentence, no tool calls) — for example "Pointed at the Phoenix asterism." or "Done."
- When you see "[Tool Results]\nTool X returned: {\"success\":false,\"error\":\"...\"}", the action failed. You may either (a) try a corrected call (different args) ONCE, or (b) respond with a brief text apology explaining the failure. Do not retry with the SAME args — that will just fail the same way.
- NEVER emit the same fn + args combination as the most recent tool call you see in the history. That is always wrong: either it already succeeded (so respond with text) or it already failed (so try different args or give up with text).

If the user confirms with "yes", "ok", "sure", "do it", etc., EXECUTE the action you proposed by calling the function.

ALWAYS provide a brief text response describing what you did or are doing, even when making function calls. For example: "Loading LEO satellites..." or "Turned on satellite labels in look view." Never return an empty response.

Keep responses brief. Focus on being helpful.

Do not discuss anything unrelated to Sitrec, including people, events, or politics. But you can talk about Mick West.
EOT;

$systemPrompt .= $menuDocForPrompt;

if (!empty($availableDocs)) {
    $systemPrompt .= "\n\nAVAILABLE HELP DOCUMENTATION:\n";
    $systemPrompt .= "Use getHelpDoc to read these docs when answering questions about features or how to do things. Each doc's link is shown in parentheses:\n";
    foreach ($availableDocs as $docName => $description) {
        $systemPrompt .= "- $docName (docs/$docName.html): $description\n";
    }
    $systemPrompt .= "\nFor questions like 'what's new' or 'how do I do X', use getHelpDoc to get accurate information.\n";
    $systemPrompt .= "When your answer uses or refers to one of these docs, include its link (the docs/<Name>.html path shown above) as a plain URL — inline where you first mention the doc, and again in a short 'See also:' list at the end of your answer. Use the exact path from the list; never invent a link or link to a doc that is not listed.\n";
}

// Call OpenAI API
function callOpenAI($apiKey, $systemPrompt, $history, $tools, $model = 'gpt-5-mini') {
    $messages = [["role" => "system", "content" => $systemPrompt]];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'assistant' : $msg['role'];
        $messages[] = ["role" => $role, "content" => $msg['text']];
    }
    
    $requestBody = [
        "model" => $model,
        "messages" => $messages,
        "tools" => $tools,
        "tool_choice" => "auto",
    ];
    // GPT-5 and o-series are reasoning models that only accept the DEFAULT temperature
    // (1) and reject a custom value with a 400. Older chat models (gpt-4o, etc.) accept
    // 0.2. So only send a custom temperature for models that support it — otherwise the
    // request 400s and (without the error check below) comes back as empty text.
    if (!preg_match('/^(gpt-5|o\d)/i', $model)) {
        $requestBody["temperature"] = 0.2;
    }
    // GPT-5 reasoning models default to "medium" effort (~10-15s per call), which makes
    // the multi-step tool loop slow enough to hit PHP/proxy timeouts, and burns reasoning
    // tokens. But "minimal" effort skips the reasoning pass that drives tool calling —
    // gpt-5-mini at minimal effort narrates actions ("moving camera now...") WITHOUT
    // emitting the tool calls, silently doing nothing. "low" is the floor when tools
    // are involved: still fast (~2-4s), but the model actually calls the functions.
    if (preg_match('/^gpt-5/i', $model)) {
        $requestBody["reasoning_effort"] = "low";
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
        CURLOPT_POSTFIELDS => json_encode($requestBody)
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $parsed = json_decode($response, true);

    // Surface API errors instead of silently returning empty text.
    if (isset($parsed['error'])) {
        return [
            'text' => "OpenAI API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => ['provider' => 'openai', 'model' => $model, 'httpCode' => $httpCode, 'error' => $parsed['error']]
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
function callAnthropic($apiKey, $systemPrompt, $history, $tools, $model = 'claude-haiku-4-5-20251001') {
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

    // ── PARITY WITH THE BROWSER BYOK CLIENT ───────────────────────────────────────────
    // This Anthropic request-shaping logic has a sibling in the client-side BYOK path:
    // src/CDirectLLMClient.js (callAnthropic() + chat()). The two MUST stay behaviorally
    // in sync — when you change the prompt-caching breakpoints, the system-prompt
    // structure, or the tool loop here, mirror the change there (and update its Jest
    // tests in tests/CDirectLLMClient.test.js), and vice-versa. Both paths now carry
    // the same two cache_control breakpoints and the same getCurrentDateTime tool /
    // "no wall-clock time in the prompt" convention — keep them aligned.
    // ──────────────────────────────────────────────────────────────────────────────────
    //
    // Prompt caching uses up to two prefix breakpoints (max 4 allowed). Caching is a
    // prefix match over the rendered request, whose block order is tools -> system ->
    // messages, so a breakpoint caches everything from the start of the prompt up to it.
    //
    // Breakpoint 1 (system block): because tools render before system, this one marker
    // caches the tools+system prefix together. That prefix is large and byte-identical
    // across turns, so repeated turns pay ~10% (cache read) instead of full input price.
    $systemBlocks = [["type" => "text", "text" => $systemPrompt, "cache_control" => ["type" => "ephemeral"]]];

    // Breakpoint 2 (last message): one user message fans out to up to 5 tool-loop
    // iterations (see runToolLoop maxIterations), and each iteration re-sends the GROWING
    // message history. Without a marker here that history is re-billed at full price every
    // iteration. Marking the final message caches the conversation prefix too, so each
    // iteration reads the prior one's messages at ~0.1x (the 5-min ephemeral TTL stays warm
    // because the iterations are seconds apart). cache_control requires block-form content,
    // so convert just the final message; earlier messages stay plain strings (allowed).
    $lastIdx = count($messages) - 1;
    if (is_string($messages[$lastIdx]['content']) && $messages[$lastIdx]['content'] !== '') {
        $messages[$lastIdx]['content'] = [[
            "type" => "text",
            "text" => $messages[$lastIdx]['content'],
            "cache_control" => ["type" => "ephemeral"],
        ]];
    }

    $requestBody = [
        "model" => $model,
        "max_tokens" => 1024,
        "system" => $systemBlocks,
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
            'httpCode' => $httpCode,
            // Cache verification: if cacheReadTokens stays 0 across repeated turns, a silent
            // invalidator is changing the prefix (e.g. the menu-doc system prompt differs
            // between turns). inputTokens is the UNCACHED remainder only — the full prompt
            // size is inputTokens + cacheWriteTokens + cacheReadTokens.
            'cacheReadTokens' => $parsed['usage']['cache_read_input_tokens'] ?? null,
            'cacheWriteTokens' => $parsed['usage']['cache_creation_input_tokens'] ?? null,
            'inputTokens' => $parsed['usage']['input_tokens'] ?? null,
            'outputTokens' => $parsed['usage']['output_tokens'] ?? null
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
function callGrok($apiKey, $systemPrompt, $history, $tools, $model = 'grok-4-fast') {
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
        case 'getCurrentDateTime':
            // Real-world "now" as reported by the client in this request's payload
            // ($date = $data['dateTime'], an ISO 8601 string with timezone offset).
            // Handled server-side as a query so the result feeds straight back into
            // the tool loop. (The BYOK path implements this client-side in CSitrecAPI.)
            global $date;
            return ['handled' => true, 'result' => [
                'dateTime' => $date,
                'note' => "Real-world current date/time reported by the client. Distinct from the simulation time.",
            ]];
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
        } elseif ($provider === 'gemini') {
            global $GEMINI_API_KEY;
            $result = callGemini($GEMINI_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
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
    $apiKey = getApiKeyForProvider($selectedProvider);
    $result = runToolLoop($selectedProvider, $apiKey, $systemPrompt, $history, $tools, $selectedModel, $menuSummary, $available3DModels, $availableDocs, 5);

    if (!empty($result['apiCalls'])) {
        $_SESSION['chatbot_pending'] = [
            'provider' => $selectedProvider,
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
