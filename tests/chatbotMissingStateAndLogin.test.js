const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Two chatbot.php replies that hid what was wrong:
// - A continuation (tool results, no prompt) whose saved state was missing fell through to
//   the empty-prompt reply, "Please enter a message."
// - A logged-out user was told "Error: No models available for your account".
// chatbot.php runs under php-cgi with stub includes, so no configuration, login or provider
// is needed. Both paths return before any provider call.
const phpCgi = spawnSync('php-cgi', ['-v'], {encoding: 'utf8'}).status === 0 ? 'php-cgi' : null;

const STUBS = {
    'config.php': '<?php\n',
    'config_paths.php': "<?php $APP_PATH = '';\n",
    'user.php': `<?php
function getUserInfo() {
    return ['user_id' => (int)getenv('TEST_USER_ID'),
            'user_groups' => json_decode(getenv('TEST_USER_GROUPS') ?: '[]', true)];
}
`,
    'ai_models.php': `<?php
function getAvailableModels($userGroups) { return []; }
function getApiKeyForProvider($provider) { return ''; }
function economyModelFor($models) { return null; }
`,
    'ai_log.php': `<?php
function logAIRequest(...$args) { return null; }
function recordAISpend(...$args) {}
function recordDailyStats(...$args) {}
`,
};

(phpCgi ? describe : describe.skip)('chatbot.php missing continuation state and logged-out replies', () => {
    let root;
    let script;
    let logFile;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-chatbot-'));
        for (const dir of ['sitrecServer', 'tmp']) {
            fs.mkdirSync(path.join(root, dir));
        }
        script = path.join(root, 'sitrecServer/chatbot.php');
        fs.copyFileSync(path.join(__dirname, '../sitrecServer/chatbot.php'), script);
        fs.copyFileSync(path.join(__dirname, '../sitrecServer/chatbotSystemPrompt.txt'),
            path.join(root, 'sitrecServer/chatbotSystemPrompt.txt'));
        for (const [name, content] of Object.entries(STUBS)) {
            fs.writeFileSync(path.join(root, 'sitrecServer', name), content);
        }
        logFile = path.join(root, 'php.log');
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    function post(body, {userId = 0, groups = [], cookie = null} = {}) {
        const input = JSON.stringify(body);
        const env = {
            ...process.env,
            // sys_get_temp_dir() follows TMPDIR, which keeps any temp files in the fixture.
            TMPDIR: path.join(root, 'tmp'),
            REDIRECT_STATUS: '1',
            REQUEST_METHOD: 'POST',
            SCRIPT_FILENAME: script,
            CONTENT_TYPE: 'application/json',
            CONTENT_LENGTH: String(Buffer.byteLength(input)),
            TEST_USER_ID: String(userId),
            TEST_USER_GROUPS: JSON.stringify(groups),
        };
        if (cookie) env.HTTP_COOKIE = cookie;
        const result = spawnSync(phpCgi, [
            '-d', 'display_errors=0',
            '-d', 'log_errors=1',
            '-d', 'error_log=' + logFile,
        ], {encoding: 'utf8', timeout: 10000, env, input});
        const split = result.stdout.search(/\r?\n\r?\n/);
        const head = result.stdout.slice(0, split);
        const json = JSON.parse(result.stdout.slice(split).trim());
        const statusMatch = head.match(/^Status:\s*(\d+)/mi);
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
        return {head, json, status: statusMatch ? Number(statusMatch[1]) : 200, log};
    }

    const continuation = {
        continueSession: true,
        toolResults: [{fn: 'setMenuValue', args: {menu: 'terrain'}, result: {success: true}}],
        provider: 'openai',
        model: 'gpt-5-mini',
    };

    test('a continuation with no saved state says so instead of "Please enter a message."', () => {
        const {head, json, status, log} = post(continuation, {userId: 42, groups: [2],
            cookie: 'PHPSESSID=abcdef0123456789abcdef0123'});
        expect(status).toBe(409);
        expect(head).toMatch(/^Content-type: application\/json/mi);
        expect(json.text).toMatch(/lost track of this request/);
        expect(json.text).not.toMatch(/Please enter a message/);
        expect(json.apiCalls).toEqual([]);
        expect(json.debug).toEqual({error: 'continuation_state_missing'});
        // A session cookie is no help: the state is found only by its token.
        expect(log).toMatch(/continuation_state_missing user_id=42 toolResults=1 reason=no_token/);
        expect(log).not.toMatch(/Warning|Fatal|Deprecated/);
    });

    test('the log line says when the token was never issued', () => {
        const {json, status, log} = post({...continuation, continuationToken: 'ab'.repeat(32)},
            {userId: 42, groups: [2]});
        expect(status).toBe(409);
        expect(json.debug).toEqual({error: 'continuation_state_missing'});
        expect(log).toMatch(/continuation_state_missing user_id=42 toolResults=1 reason=unknown_token/);
    });

    test('an ordinary empty prompt still gets "Please enter a message."', () => {
        const {json, status, log} = post({prompt: '   '}, {userId: 42, groups: [2]});
        expect(status).toBe(200);
        expect(json.text).toBe('Please enter a message.');
        expect(json.debug.error).toBe('empty_prompt');
        expect(log).not.toMatch(/continuation_state_missing/);
    });

    test('a logged-out user is told to log in or use their own key', () => {
        const {json, status} = post({prompt: 'can you change the building colors?'});
        expect(status).toBe(200);
        expect(json.text).toMatch(/need you to be logged in/);
        expect(json.text).toMatch(/Sitrec → Settings → API Keys…/);
        expect(json.apiCalls).toEqual([]);
        expect(json.debug).toEqual({error: 'login_required'});
    });

    test('a logged-out user with a model saved from an earlier login gets the same reply', () => {
        const {json, status} = post({prompt: 'hello', provider: 'openai', model: 'gpt-5-mini'});
        expect(status).toBe(200);
        expect(json.debug).toEqual({error: 'login_required'});
    });

    test('a logged-in user with no models keeps the existing reply', () => {
        const {json, status, log} = post({prompt: 'hello'}, {userId: 42, groups: [2]});
        expect(status).toBe(200);
        expect(json.text).toBe('Error: No models available for your account');
        expect(json.debug).toEqual({error: 'No available models'});
        expect(log).not.toMatch(/Warning|Fatal|Deprecated/);
    });
});
