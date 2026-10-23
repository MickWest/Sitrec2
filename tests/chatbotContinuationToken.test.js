const {spawn, spawnSync} = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A chat turn whose model asks for an action is finished by a second request, the
// continuation, after the browser has run the action. chatbot.php keeps the turn's state
// between the two in a file named by a hash of a token that the first reply carries and the
// continuation sends back. It used to keep it in $_SESSION, which never came back behind a
// proxy that strips cookies, so every continuation failed there.
//
// chatbot.php runs under php-cgi with stub includes. The provider is a file: the copy of
// chatbot.php under test reads the OpenAI reply from provider.json instead of the API, so
// each test sets what the "model" says next. No request here sends a cookie.
const phpCgi = spawnSync('php-cgi', ['-v'], {encoding: 'utf8'}).status === 0 ? 'php-cgi' : null;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// Not key-shaped on purpose: tests/ is published, and the bundle secret audit blocks a
// deploy on anything that looks like a real provider key.
const SERVER_KEY = 'fixture-server-provider-key-0123456789';
const USER_KEY = 'fixture-user-own-key-9876543210';

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
$OPENAI_API_KEY = getenv('OPENAI_API');
$ANTHROPIC_API_KEY = $GROQ_API_KEY = $GROK_API_KEY = $GEMINI_API_KEY = '';
function getAvailableModels($userGroups) {
    return empty($userGroups) ? [] : [['provider' => 'openai', 'model' => 'gpt-5-mini', 'label' => 'GPT-5 Mini']];
}
function getApiKeyForProvider($provider) { global $OPENAI_API_KEY; return $OPENAI_API_KEY; }
function economyModelFor($models) { return null; }
`,
    'ai_log.php': `<?php
function logAIRequest(...$args) { return null; }
function recordAISpend(...$args) {}
function recordDailyStats(...$args) {}
function normalizeAIUsage(...$args) { return null; }
function emptyAIUsage() { return []; }
function addAIUsage($into, $add) { return $into; }
`,
};

function toolCallReply(fn, args) {
    return {choices: [{finish_reason: 'tool_calls', message: {content: null, tool_calls: [
        {id: 'call_1', type: 'function', function: {name: fn, arguments: JSON.stringify(args)}},
    ]}}]};
}
const TEXT_REPLY = {choices: [{finish_reason: 'stop', message: {content: 'All set.'}}]};

(phpCgi ? describe : describe.skip)('chatbot.php continuation token', () => {
    let root;
    let script;
    let logFile;
    let pendingDir;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrec-chatbot-token-'));
        for (const dir of ['sitrecServer', 'tmp']) {
            fs.mkdirSync(path.join(root, dir));
        }
        script = path.join(root, 'sitrecServer/chatbot.php');
        const source = fs.readFileSync(path.join(__dirname, '../sitrecServer/chatbot.php'), 'utf8');
        expect(source.split(OPENAI_URL)).toHaveLength(2);
        fs.writeFileSync(script, source.replace(OPENAI_URL, 'file://' + path.join(root, 'provider.json')));
        fs.copyFileSync(path.join(__dirname, '../sitrecServer/chatbotSystemPrompt.txt'),
            path.join(root, 'sitrecServer/chatbotSystemPrompt.txt'));
        for (const [name, content] of Object.entries(STUBS)) {
            fs.writeFileSync(path.join(root, 'sitrecServer', name), content);
        }
        logFile = path.join(root, 'php.log');
        pendingDir = path.join(root, 'tmp', 'sitrec_chat_pending');
    });

    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

    function phpRequest(body, {userId = 42, groups = [2]} = {}) {
        const input = JSON.stringify(body);
        const env = {
            ...process.env,
            // sys_get_temp_dir() follows TMPDIR, which keeps the state files in the fixture.
            TMPDIR: path.join(root, 'tmp'),
            REDIRECT_STATUS: '1',
            REQUEST_METHOD: 'POST',
            SCRIPT_FILENAME: script,
            CONTENT_TYPE: 'application/json',
            CONTENT_LENGTH: String(Buffer.byteLength(input)),
            TEST_USER_ID: String(userId),
            TEST_USER_GROUPS: JSON.stringify(groups),
            OPENAI_API: SERVER_KEY,
        };
        delete env.HTTP_COOKIE;
        const args = ['-d', 'display_errors=0', '-d', 'log_errors=1', '-d', 'error_log=' + logFile];
        return {args, env, input};
    }

    function parseReply(stdout) {
        const split = stdout.search(/\r?\n\r?\n/);
        const head = stdout.slice(0, split);
        const json = JSON.parse(stdout.slice(split).trim());
        const statusMatch = head.match(/^Status:\s*(\d+)/mi);
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
        return {head, json, status: statusMatch ? Number(statusMatch[1]) : 200, log};
    }

    function post(body, providerReply, opts) {
        if (providerReply) fs.writeFileSync(path.join(root, 'provider.json'), JSON.stringify(providerReply));
        const {args, env, input} = phpRequest(body, opts);
        return parseReply(spawnSync(phpCgi, args, {encoding: 'utf8', timeout: 10000, env, input}).stdout);
    }

    // The same request, without waiting for it, so several can run at once.
    function postAsync(body, opts) {
        const {args, env, input} = phpRequest(body, opts);
        return new Promise((resolve, reject) => {
            const child = spawn(phpCgi, args, {env});
            let stdout = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.on('error', reject);
            child.on('close', () => resolve(parseReply(stdout)));
            child.stdin.end(input);
        });
    }

    const firstTurn = {
        prompt: 'make the terrain taller',
        history: [{role: 'user', text: 'make the terrain taller'}],
        sitrecDoc: {pointCameraAt: 'Point the camera at a target. Parameters: target (string)'},
        menuSummary: {terrain: ['Elevation Scale (number)']},
        provider: 'openai',
        model: 'gpt-5-mini',
        // Not a field the browser sends; here to show a stray credential is not stored.
        apiKey: USER_KEY,
    };
    const action = {menu: 'terrain', path: 'Elevation Scale', value: 2};

    function startTurn(opts) {
        const reply = post(firstTurn, toolCallReply('setMenuValue', action), opts);
        expect(reply.status).toBe(200);
        expect(reply.json.apiCalls).toEqual([{fn: 'setMenuValue', args: action}]);
        expect(reply.json.sessionContinue).toBe(true);
        return reply;
    }

    function continuation(token, args = action) {
        return {
            continueSession: true,
            continuationToken: token,
            toolResults: [{fn: 'setMenuValue', args, result: {success: true}}],
            provider: 'openai',
            model: 'gpt-5-mini',
        };
    }

    const stateFile = (token) =>
        path.join(pendingDir, crypto.createHash('sha256').update(token).digest('hex') + '.json');
    const pendingFiles = () => (fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : []);

    test('a tool-call reply carries a token, and the state file is named by its hash', () => {
        const {head, json, log} = startTurn();
        expect(json.continuationToken).toMatch(/^[0-9a-f]{64}$/);
        expect(head).not.toMatch(/^Set-Cookie:/mi);
        expect(pendingFiles()).toEqual([path.basename(stateFile(json.continuationToken))]);
        expect(fs.statSync(pendingDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(stateFile(json.continuationToken)).mode & 0o777).toBe(0o600);
        const saved = JSON.parse(fs.readFileSync(stateFile(json.continuationToken), 'utf8'));
        expect(saved.user_id).toBe(42);
        expect(Math.abs(saved.created - Date.now() / 1000)).toBeLessThan(60);
        expect(saved.state.provider).toBe('openai');
        expect(saved.state.remainingIterations).toBe(4);
        expect(log).not.toMatch(/Warning|Fatal|Deprecated/);
    });

    test('a continuation with the token and no cookie finishes the turn, once', () => {
        const {json: first} = startTurn();
        const token = first.continuationToken;

        const done = post(continuation(token), TEXT_REPLY);
        expect(done.status).toBe(200);
        expect(done.json.text).toBe('All set.');
        expect(done.json.apiCalls).toEqual([]);
        expect(done.json.debug.sessionContinued).toBe(true);
        expect(done.json.sessionContinue).toBeUndefined();
        expect(done.json.continuationToken).toBeUndefined();
        expect(pendingFiles()).toEqual([]);

        const again = post(continuation(token), TEXT_REPLY);
        expect(again.status).toBe(409);
        expect(again.json.text).toMatch(/lost track of this request/);
        expect(again.json.debug).toEqual({error: 'continuation_state_missing'});
        expect(again.log).toMatch(/continuation_state_missing user_id=42 toolResults=1 reason=unknown_token/);
        expect(again.log).not.toMatch(/Warning|Fatal|Deprecated/);
    });

    // A retried or duplicated request can send one continuation twice at the same time.
    // Only one of them may have the state. Several rounds, because a race does not show
    // every time. Group 3 has no practical rate limit, so all these provider calls fit.
    test('of continuations racing on one token, exactly one gets the state', async () => {
        const unlimited = {groups: [3]};
        for (let round = 0; round < 24; round++) {
            const token = startTurn(unlimited).json.continuationToken;
            fs.writeFileSync(path.join(root, 'provider.json'), JSON.stringify(TEXT_REPLY));
            const replies = await Promise.all(
                Array.from({length: 8}, () => postAsync(continuation(token), unlimited)));
            expect(replies.map((reply) => reply.status).sort()).toEqual([200, ...Array(7).fill(409)]);
            expect(pendingFiles()).toEqual([]);
        }
    }, 60000);

    test("another user's token is refused, and still works for its owner", () => {
        const {json: first} = startTurn();
        const token = first.continuationToken;

        const other = post(continuation(token), TEXT_REPLY, {userId: 43});
        expect(other.status).toBe(409);
        expect(other.json.debug).toEqual({error: 'continuation_state_missing'});
        expect(other.log).toMatch(/continuation_state_missing user_id=43 toolResults=1 reason=other_user/);

        const owner = post(continuation(token), TEXT_REPLY);
        expect(owner.status).toBe(200);
        expect(owner.json.text).toBe('All set.');
    });

    test('an expired token is refused and its file removed', () => {
        const {json: first} = startTurn();
        const token = first.continuationToken;
        const file = stateFile(token);
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        saved.created -= 16 * 60;
        fs.writeFileSync(file, JSON.stringify(saved));

        const late = post(continuation(token), TEXT_REPLY);
        expect(late.status).toBe(409);
        expect(late.json.debug).toEqual({error: 'continuation_state_missing'});
        expect(late.log).toMatch(/continuation_state_missing user_id=42 toolResults=1 reason=expired_token/);
        expect(fs.existsSync(file)).toBe(false);
    });

    test('two turns in flight keep their own state', () => {
        const a = startTurn().json.continuationToken;
        const b = startTurn().json.continuationToken;
        expect(a).not.toBe(b);
        expect(pendingFiles()).toHaveLength(2);
        expect(post(continuation(a), TEXT_REPLY).json.text).toBe('All set.');
        expect(post(continuation(b), TEXT_REPLY).json.text).toBe('All set.');
        expect(pendingFiles()).toEqual([]);
    });

    test('a continuation that asks for another action gets a new token, with the tools intact', () => {
        const {json: first} = startTurn();
        const firstSaved = fs.readFileSync(stateFile(first.continuationToken), 'utf8');
        expect(firstSaved).toContain('"properties":{}');

        const next = post(continuation(first.continuationToken),
            toolCallReply('setMenuValue', {...action, value: 3}));
        expect(next.status).toBe(200);
        expect(next.json.apiCalls).toEqual([{fn: 'setMenuValue', args: {...action, value: 3}}]);
        expect(next.json.sessionContinue).toBe(true);
        expect(next.json.continuationToken).toMatch(/^[0-9a-f]{64}$/);
        expect(next.json.continuationToken).not.toBe(first.continuationToken);

        // The tools went through the file and back. An empty schema object must still be
        // an object, or the provider rejects the next request.
        const nextSaved = JSON.parse(fs.readFileSync(stateFile(next.json.continuationToken), 'utf8'));
        expect(nextSaved.state.remainingIterations).toBe(3);
        expect(nextSaved.state.tools).toEqual(JSON.parse(firstSaved).state.tools);
        expect(JSON.stringify(nextSaved.state.tools)).toContain('"properties":{}');
        expect(JSON.stringify(nextSaved.state.tools)).not.toContain('"properties":[]');
    });

    test('no state file holds a key or the raw token', () => {
        const {json: first} = startTurn();
        const next = post(continuation(first.continuationToken),
            toolCallReply('setMenuValue', {...action, value: 3}));
        startTurn();
        const tokens = [first.continuationToken, next.json.continuationToken];
        const names = pendingFiles();
        expect(names).toHaveLength(2);
        for (const name of names) {
            const text = fs.readFileSync(path.join(pendingDir, name), 'utf8');
            expect(text).not.toContain(SERVER_KEY);
            expect(text).not.toContain(USER_KEY);
            for (const token of tokens) {
                expect(name).not.toContain(token);
                expect(text).not.toContain(token);
            }
        }
    });

    test('a save removes state files that have expired, and keeps fresh ones', () => {
        const fresh = startTurn().json.continuationToken;
        const stale = path.join(pendingDir, 'f'.repeat(64) + '.json');
        fs.writeFileSync(stale, '{}');
        const old = new Date(Date.now() - 16 * 60 * 1000);
        fs.utimesSync(stale, old, old);

        const newer = startTurn().json.continuationToken;
        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(stateFile(fresh))).toBe(true);
        expect(fs.existsSync(stateFile(newer))).toBe(true);
    });

    // The state of an action-only turn is never continued, so it must not wait for the
    // next tool call to be removed: any later chat request does it.
    test('a chat request that saves nothing also removes expired state files', () => {
        const fresh = startTurn().json.continuationToken;
        const stale = path.join(pendingDir, 'f'.repeat(64) + '.json');
        fs.writeFileSync(stale, '{}');
        const old = new Date(Date.now() - 16 * 60 * 1000);
        fs.utimesSync(stale, old, old);

        const reply = post(firstTurn, TEXT_REPLY);
        expect(reply.json.text).toBe('All set.');
        expect(reply.json.continuationToken).toBeUndefined();
        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(stateFile(fresh))).toBe(true);
    });
});
