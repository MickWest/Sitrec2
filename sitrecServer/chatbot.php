<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';

// Load API key from environment or config
$OPENAI_API_KEY = getenv("OPENAI_API");

$S3 = getenv("S3_ACCESS_KEY_ID");

$data = json_decode(file_get_contents('php://input'), true);
$prompt = $data['prompt'] ?? '';
// --- Accept history from client ---
$history = $data['history'] ?? [];
// get API documentation from client
$sitrecDoc = $data['sitrecDoc'] ?? [];

// get client time, or use current server time
$date = $data['dateTime'] ?? date('Y-m-d H:i:s');

//$timezoneOffset= $data['timeZoneOffset'] ?? 0;

$systemPrompt = <<<EOT
You are a helpful assistant for the Sitrec app. 

You should reply in the same language as the user's prompt, unless instructed otherwise.

The user's current real date and time (not the simulation time) is: {$date}. Use the timezone specified here, or any specified in the prompt.

When giving a time, always use the user's local time, unless they specify UTC or another timezone.

You can answer questions about Sitrec and issue JSON API calls.

Sitrec is a Situation Recreation application written by Mick West. It can:
- Show satellite positions in the sky
- Show ADS-B aircraft positions
- Show astronomy objects in the sky
- Set the camera to follow or track objects
The primary use is for resolving UAP sightings and other events by showing what was in the sky at a given time.

Avoid mentioning technical details about the API or how it works. Focus on providing useful information and API calls.

If you do NOT issue an API call, you should provide a concise answer to the user's question if possible, or explain why you cannot answer it or why an API call is not needed or posible.

When you respond, you must:

You must:
- Only respond with plain text and a list of API calls at the end.
- only give API calls that are relevant to the last user message in the context of the chat history, 
- Repeat previous API calls if they ask the same thing.
- Not discuss anything unrelated to Sitrec, including people, events, or politics. But you can talk about Mick West
- Stay focused on satellite tracking, astronomy, ADS-B, and related tools.
- Concisely show your work in the text for each parameter and choice of API call (unless there are no API calls
- Return your API calls in a JSON block with this example structure:
```json
{
  "apiCalls": [
    { "fn": "gotoLLA", "args": { lat: 0.32324, lon: 15.23223, alt: 2 } }
  ]
}
- Do not mention the API, or say "Here's the API call". Just show the JSON block at the end.
- Do not return anything except the plain text explanation and the JSON block at the end of your response.
- Check that if you say you are going to issue an API call, that you actually do so, and that the API call is relevant to the last user message in the context of the chat history.
- If the API JSON block is empty, explain why it is empty, or why no API calls are needed.

Always reply in plain text. Do not use Markdown, LaTeX, or code blocks.

Available API functions (function name followed by description and parameter list):
EOT;

$systemPrompt .= ":\n\n";

foreach ($sitrecDoc as $fn => $desc) {
    $systemPrompt .= "- {$fn}: {$desc}\n";
}

// --- Build messages array from history ---
$messages = [["role" => "system", "content" => $systemPrompt]];
if (is_array($history)) {
    foreach ($history as $msg) {
        // Map 'user'/'bot' to OpenAI roles
        $role = $msg['role'] === 'bot' ? 'assistant' : $msg['role'];
        $messages[] = [
            "role" => $role,
            "content" => $msg['text']
        ];
    }
}

// Call OpenAI
$ch = curl_init("https://api.openai.com/v1/chat/completions");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer $OPENAI_API_KEY",
        "Content-Type: application/json"
    ],
    CURLOPT_POSTFIELDS => json_encode([
        "model" => "gpt-4o",
        "messages" => $messages,
        "temperature" => 0.2
    ])
]);

$response = curl_exec($ch);
curl_close($ch);

$parsed = json_decode($response, true);
$content = $parsed['choices'][0]['message']['content'] ?? '';

$text = '';
$calls = [];

// Extract JSON block if present and remove it from content
$calls = [];
if (preg_match('/```json\s*(\{.*?\})\s*```/s', $content, $matches)) {
    $json = json_decode($matches[1], true);
    if (isset($json['apiCalls'])) {
        $calls = $json['apiCalls'];
    }
    // Remove JSON block from content
    //$content = preg_replace('/```json\s*\{.*?\}\s*```/s', '', $content);
}

$text = trim($content);

header('Content-Type: application/json');
echo json_encode([
    'text' => $text,
    'apiCalls' => $calls
]);
