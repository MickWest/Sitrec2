#!/usr/bin/env node

import {exec, spawn} from 'child_process';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {WebSocketServer} from 'ws';
import {fileURLToPath} from 'url';
import {dirname} from 'path';
import fs from 'fs';
import {TEST_REGISTRY} from './test-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Apply rate limiting to all routes
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // generous limit for local test server
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);
const port = 3456;
const exitAfterTests = process.argv.includes('--exit') || process.env.TEST_VIEWER_EXIT === 'true';
const openBrowser = process.argv.includes('--open') || !exitAfterTests;
const RESULTS_FILE = __dirname + '/test-results.json';

// Parse --exclude=group1,group2,testid argument
let excludePatterns = [];
const excludeArg = process.argv.find(arg => arg.startsWith('--exclude='));
if (excludeArg) {
    excludePatterns = excludeArg.split('=')[1].split(',').map(s => s.trim().toLowerCase());
}

function getFilteredTests() {
    return TEST_REGISTRY.filter(t => {
        const groupLower = t.group.toLowerCase();
        const idLower = t.id.toLowerCase();
        return !excludePatterns.some(pattern => groupLower === pattern || idLower === pattern);
    });
}

function loadTestResults() {
    try {
        if (fs.existsSync(RESULTS_FILE)) {
            return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
        }
    } catch (e) {}
    return {};
}

function saveTestResults(results) {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

app.use('/test-results', express.static(__dirname + '/test-results'));
app.use('/tests_regression', express.static(__dirname + '/tests_regression'));

app.get('/api/tests', (req, res) => {
    const results = loadTestResults();
    const tests = TEST_REGISTRY.map(t => ({
        ...t,
        status: results[t.id] || 'unknown'
    }));
    res.json(tests);
});

app.get('/', (req, res) => {
    let lastGroup = '';
    const testListHtml = TEST_REGISTRY.map(t => {
        let html = '';
        if (t.group !== lastGroup) {
            html += `<div class="group-header" onclick="toggleGroup('${t.group}')">${t.group}</div>`;
            lastGroup = t.group;
        }
        html += `
        <div class="test-row" data-id="${t.id}" data-group="${t.group}">
            <input type="checkbox" class="test-checkbox" data-id="${t.id}">
            ${t.url ? `<a class="test-name" href="https://local.metabunk.org/sitrec${t.url}" target="_blank">${t.name}</a>` : `<span class="test-name">${t.name}</span>`}
            <span class="test-status" id="status-${t.id}">-</span>
            <button class="reset-btn" onclick="resetTest('${t.id}')" title="Reset regression data">R</button>
        </div>`;
        return html;
    }).join('');

    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Sitrec Test Viewer</title>
    <style>
        body {
            margin: 0;
            padding: 10px;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            background: #1e1e1e;
            color: #d4d4d4;
        }
        #container {
            width: 100%;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        h1 {
            color: #4ec9b0;
            margin: 0 0 10px 0;
            font-size: 20px;
        }
        .status {
            margin-bottom: 10px;
            padding: 10px;
            background: #2d2d30;
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .status.running { border-left: 4px solid #4ec9b0; }
        .status.complete { border-left: 4px solid #6a9955; }
        .status.error { border-left: 4px solid #f48771; }
        .status.idle { border-left: 4px solid #569cd6; }
        #workers {
            display: flex;
            gap: 8px;
            flex: 1;
            overflow: hidden;
        }
        .worker-column {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: #252526;
            border: 1px solid #3e3e42;
            border-radius: 4px;
            overflow: hidden;
        }
        .worker-header {
            background: #2d2d30;
            padding: 8px;
            font-weight: bold;
            font-size: 12px;
            border-bottom: 1px solid #3e3e42;
            color: #4ec9b0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .worker-timer {
            color: #9cdcfe;
            font-weight: normal;
            font-size: 11px;
            white-space: nowrap;
        }
        .worker-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
            margin-right: 8px;
        }
        .worker-output {
            flex: 1;
            padding: 10px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
            font-size: 11px;
            line-height: 1.4;
        }
        .network-log {
            height: 120px;
            min-height: 80px;
            max-height: 200px;
            padding: 6px;
            overflow-y: auto;
            font-size: 10px;
            line-height: 1.3;
            background: #1a1a1c;
            border-top: 1px solid #3e3e42;
        }
        .network-log-header {
            font-size: 10px;
            color: #569cd6;
            padding: 4px 6px;
            background: #252526;
            border-top: 1px solid #3e3e42;
        }
        .net-entry {
            padding: 1px 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .net-entry.pending { color: #9cdcfe; }
        .net-entry.success { color: #6a9955; }
        .net-entry.error { color: #f48771; }
        .net-url { color: #d4d4d4; }
        .passed { color: #6a9955; }
        .failed { color: #f48771; }
        .test-line { color: #4ec9b0; }
        button {
            background: #0e639c;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        button:hover { background: #1177bb; }
        button:disabled {
            background: #3e3e42;
            cursor: not-allowed;
        }
        #testList {
            width: 200px;
            min-width: 200px;
            display: flex;
            flex-direction: column;
            background: #252526;
            border: 1px solid #3e3e42;
            border-radius: 4px;
            overflow: hidden;
        }
        .test-list-header {
            background: #2d2d30;
            padding: 8px;
            font-weight: bold;
            font-size: 12px;
            border-bottom: 1px solid #3e3e42;
            color: #4ec9b0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .test-list-content {
            flex: 1;
            overflow-y: auto;
            padding: 4px;
        }
        .group-header {
            font-size: 10px;
            font-weight: bold;
            color: #569cd6;
            padding: 4px 4px 2px 4px;
            margin-top: 4px;
            border-bottom: 1px solid #3e3e42;
            cursor: pointer;
            user-select: none;
        }
        .group-header:hover {
            background: #3e3e42;
        }
        .group-header:first-child {
            margin-top: 0;
        }
        .test-row {
            display: flex;
            align-items: center;
            padding: 0px 4px;
            line-height: 1;
            border-radius: 2px;
            margin-bottom: 0px;
        }
        .test-row:hover {
            background: #3e3e42;
        }
        .test-checkbox {
            margin-right: 6px;
            cursor: pointer;
        }
        .test-name {
            flex: 1;
            font-size: 11px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        a.test-name {
            color: #569cd6;
            text-decoration: none;
        }
        a.test-name:hover {
            text-decoration: underline;
        }
        .test-status {
            width: 20px;
            text-align: center;
            font-size: 18px;
            font-weight: bold;
            margin-right: 4px;
        }
        .test-status.passed { color: #4ec9b0; }
        .test-status.failed { color: #ff6b6b; }
        .test-status.running { color: #4ec9b0; }
        .reset-btn {
            padding: 2px 6px;
            font-size: 10px;
            background: #3e3e42;
        }
        .reset-btn:hover {
            background: #f48771;
        }
        .select-btns {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            padding: 0 4px;
        }
        .select-btns button {
            flex: 1;
            padding: 4px 8px;
            font-size: 10px;
        }
        #startBtn {
            margin: 8px 4px;
            background: #6a9955;
        }
        #startBtn:hover {
            background: #7cb668;
        }
        #startBtn:disabled {
            background: #3e3e42;
        }
    </style>
</head>
<body>
    <div id="container">
        <h1>🧪 Sitrec Test Viewer</h1>
        <div id="status" class="status idle">
            <span id="statusText">Ready - Select tests and click Start</span>
            <span id="elapsedTime" style="margin-left: 20px; color: #9cdcfe;"></span>
            <div>
                <button id="abortBtn" onclick="abortTests()" style="background: #f48771; margin-right: 8px;" disabled>Abort</button>
                <button id="clearBtn" onclick="clearOutput()">Clear</button>
            </div>
        </div>
        <div id="workers">
            <div class="worker-column" id="column-0">
                <div class="worker-header"><span class="worker-name" id="name-0">Idle</span><span class="worker-timer" id="timer-0"></span></div>
                <div class="worker-output" id="worker-1"></div>
                <div class="network-log-header">Network</div>
                <div class="network-log" id="netlog-0"></div>
            </div>
            <div class="worker-column" id="column-1">
                <div class="worker-header"><span class="worker-name" id="name-1">Idle</span><span class="worker-timer" id="timer-1"></span></div>
                <div class="worker-output" id="worker-2"></div>
                <div class="network-log-header">Network</div>
                <div class="network-log" id="netlog-1"></div>
            </div>
            <div class="worker-column" id="column-2">
                <div class="worker-header"><span class="worker-name" id="name-2">Idle</span><span class="worker-timer" id="timer-2"></span></div>
                <div class="worker-output" id="worker-3"></div>
                <div class="network-log-header">Network</div>
                <div class="network-log" id="netlog-2"></div>
            </div>
            <div class="worker-column" id="column-3">
                <div class="worker-header"><span class="worker-name" id="name-3">Idle</span><span class="worker-timer" id="timer-3"></span></div>
                <div class="worker-output" id="worker-4"></div>
                <div class="network-log-header">Network</div>
                <div class="network-log" id="netlog-3"></div>
            </div>
            <div id="testList">
                <div class="test-list-header">
                    <span>Tests</span>
                </div>
                <div class="select-btns">
                    <button onclick="selectAll()">All</button>
                    <button onclick="selectNone()">None</button>
                    <button onclick="selectFailed()">Failed</button>
                </div>
                <button id="startBtn" onclick="startTests()">▶ Start Tests</button>
                <div class="test-list-content">
                    ${testListHtml}
                </div>
            </div>
        </div>
    </div>
    <script>
        const status = document.getElementById('status');
        const statusText = document.getElementById('statusText');
        const elapsedTimeEl = document.getElementById('elapsedTime');
        const abortBtn = document.getElementById('abortBtn');
        const startBtn = document.getElementById('startBtn');
        const workers = [
            document.getElementById('worker-1'),
            document.getElementById('worker-2'),
            document.getElementById('worker-3'),
            document.getElementById('worker-4')
        ];
        
        const netlogs = [
            document.getElementById('netlog-0'),
            document.getElementById('netlog-1'),
            document.getElementById('netlog-2'),
            document.getElementById('netlog-3')
        ];
        
        const netlogAutoScroll = [true, true, true, true];
        
        netlogs.forEach((netlog, idx) => {
            netlog.addEventListener('scroll', () => {
                const atBottom = netlog.scrollHeight - netlog.scrollTop <= netlog.clientHeight + 20;
                netlogAutoScroll[idx] = atBottom;
            });
        });
        
        function addNetworkEntry(workerIdx, url, status) {
            const netlog = netlogs[workerIdx];
            if (!netlog) return;
            
            const shortUrl = url;
            const statusClass = status === 'pending' ? 'pending' : (status >= 200 && status < 400) ? 'success' : 'error';
            const statusText = status === 'pending' ? '⟳' : status;
            
            const entry = document.createElement('div');
            entry.className = 'net-entry ' + statusClass;
            entry.innerHTML = '<span>' + statusText + '</span> <span class="net-url">' + shortUrl + '</span>';
            entry.title = url;
            entry.dataset.url = url;
            
            netlog.appendChild(entry);
            
            if (netlogAutoScroll[workerIdx]) {
                netlog.scrollTop = netlog.scrollHeight;
            }
            
            return entry;
        }
        
        function updateNetworkEntry(workerIdx, url, status) {
            const netlog = netlogs[workerIdx];
            if (!netlog) return;
            
            const entries = netlog.querySelectorAll('.net-entry');
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].dataset.url === url) {
                    const statusClass = (status >= 200 && status < 400) ? 'success' : 'error';
                    entries[i].className = 'net-entry ' + statusClass;
                    entries[i].querySelector('span').textContent = status;
                    break;
                }
            }
        }
        
        const workerTimers = [
            document.getElementById('timer-0'),
            document.getElementById('timer-1'),
            document.getElementById('timer-2'),
            document.getElementById('timer-3')
        ];
        
        const workerNames = [
            document.getElementById('name-0'),
            document.getElementById('name-1'),
            document.getElementById('name-2'),
            document.getElementById('name-3')
        ];
        
        const workerAutoScroll = [true, true, true, true];
        const workerStartTimes = [null, null, null, null];
        let globalStartTime = null;
        let timerInterval = null;
        let ws = null;
        let testsRunning = false;
        
        function formatTime(ms) {
            const seconds = Math.floor(ms / 1000);
            const minutes = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return minutes > 0 ? minutes + 'm ' + secs + 's' : secs + 's';
        }
        
        function updateTimers() {
            const now = Date.now();
            if (globalStartTime) {
                elapsedTimeEl.textContent = 'Total: ' + formatTime(now - globalStartTime);
            }
            for (let i = 0; i < 4; i++) {
                if (workerStartTimes[i]) {
                    workerTimers[i].textContent = formatTime(now - workerStartTimes[i]);
                }
            }
        }
        
        function setVisibleWorkers(count) {
            for (let i = 0; i < 4; i++) {
                const col = document.getElementById('column-' + i);
                if (col) {
                    col.style.display = i < count ? 'flex' : 'none';
                }
            }
        }
        
        workers.forEach((worker, idx) => {
            worker.addEventListener('scroll', () => {
                const atBottom = worker.scrollHeight - worker.scrollTop <= worker.clientHeight + 50;
                workerAutoScroll[idx] = atBottom;
            });
        });

        function loadTestStatuses() {
            fetch('/api/tests')
                .then(r => r.json())
                .then(tests => {
                    tests.forEach(t => {
                        updateTestStatus(t.id, t.status);
                    });
                });
        }

        function updateTestStatus(id, testStatus) {
            const el = document.getElementById('status-' + id);
            if (!el) return;
            el.className = 'test-status';
            el.dataset.status = testStatus;
            if (testStatus === 'passed') {
                el.textContent = '✓';
                el.classList.add('passed');
            } else if (testStatus === 'failed') {
                el.textContent = '✗';
                el.classList.add('failed');
            } else if (testStatus === 'running') {
                el.textContent = '⟳';
                el.classList.add('running');
            } else {
                el.textContent = '-';
            }
        }

        function selectAll() {
            document.querySelectorAll('.test-checkbox').forEach(cb => cb.checked = true);
        }

        function selectNone() {
            document.querySelectorAll('.test-checkbox').forEach(cb => cb.checked = false);
        }

        function selectFailed() {
            document.querySelectorAll('.test-checkbox').forEach(cb => {
                const id = cb.dataset.id;
                const statusEl = document.getElementById('status-' + id);
                cb.checked = statusEl && statusEl.classList.contains('failed');
            });
        }

        function toggleGroup(group) {
            const groupCheckboxes = document.querySelectorAll('.test-row[data-group="' + group + '"] .test-checkbox');
            const allChecked = Array.from(groupCheckboxes).every(cb => cb.checked);
            groupCheckboxes.forEach(cb => cb.checked = !allChecked);
        }

        function getSelectedTests() {
            const selected = [];
            document.querySelectorAll('.test-checkbox:checked').forEach(cb => {
                selected.push(cb.dataset.id);
            });
            return selected;
        }

        function startTests() {
            const selected = getSelectedTests();
            if (selected.length === 0) {
                alert('Please select at least one test');
                return;
            }

            testsRunning = true;
            startBtn.disabled = true;
            abortBtn.disabled = false;
            status.className = 'status running';
            statusText.textContent = 'Starting tests...';
            globalStartTime = Date.now();
            timerInterval = setInterval(updateTimers, 1000);

            // Save previous statuses and mark selected as pending
            const previousStatuses = {};
            selected.forEach(id => {
                const statusEl = document.getElementById('status-' + id);
                previousStatuses[id] = statusEl ? statusEl.dataset.status : 'unknown';
                updateTestStatus(id, 'unknown');
            });

            workers.forEach(w => w.innerHTML = '');
            netlogs.forEach(n => n.innerHTML = '');
            workerNames.forEach(n => n.textContent = 'Waiting...');
            workerTimers.forEach(t => t.textContent = '');
            
            const visibleWorkers = Math.min(selected.length, 4);
            setVisibleWorkers(visibleWorkers);

            ws = new WebSocket('ws://localhost:${port}');
            
            ws.onopen = () => {
                ws.send(JSON.stringify({ type: 'start', tests: selected }));
            };
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                
                if (data.type === 'workerName') {
                    const workerIdx = data.worker;
                    const testName = data.name;
                    workerNames[workerIdx].textContent = testName;
                    workerStartTimes[workerIdx] = Date.now();
                    workerTimers[workerIdx].textContent = '0s';
                } else if (data.type === 'output') {
                    let line = data.text;
                    const workerIdx = data.worker || 0;
                    
                    if (line.includes('✓')) {
                        line = '<span class="passed">' + line + '</span>';
                    } else if (line.includes('✗') || line.includes('failed')) {
                        line = '<span class="failed">' + line + '</span>';
                    } else if (line.includes('›')) {
                        line = '<span class="test-line">' + line + '</span>';
                    }
                    
                    workers[workerIdx].innerHTML += line + '\\n';
                    
                    if (workerAutoScroll[workerIdx]) {
                        workers[workerIdx].scrollTop = workers[workerIdx].scrollHeight;
                    }
                } else if (data.type === 'status') {
                    if (data.total > 0) {
                        if (data.current === 0) {
                            statusText.textContent = '🧪 Starting ' + data.total + ' test' + (data.total > 1 ? 's' : '') + '...';
                        } else {
                            statusText.textContent = '🧪 Running test ' + data.current + '/' + data.total + '...';
                        }
                    }
                } else if (data.type === 'testStarted') {
                    updateTestStatus(data.id, 'running');
                } else if (data.type === 'testResult') {
                    updateTestStatus(data.id, data.passed ? 'passed' : 'failed');
                } else if (data.type === 'complete') {
                    testsRunning = false;
                    const hasFailures = data.code !== 0;
                    status.className = hasFailures ? 'status error' : 'status complete';
                    const totalTime = globalStartTime ? ' (' + formatTime(Date.now() - globalStartTime) + ')' : '';
                    statusText.textContent = hasFailures 
                        ? '❌ Tests completed with failures' + totalTime
                        : '✅ All tests passed!' + totalTime;
                    abortBtn.disabled = true;
                    startBtn.disabled = false;
                    if (timerInterval) clearInterval(timerInterval);
                } else if (data.type === 'aborted') {
                    testsRunning = false;
                    status.className = 'status error';
                    statusText.textContent = '🛑 Tests aborted by user';
                    abortBtn.disabled = true;
                    startBtn.disabled = false;
                    if (timerInterval) clearInterval(timerInterval);
                    // Restore previous status for tests that never ran or were still running
                    for (const id in previousStatuses) {
                        const statusEl = document.getElementById('status-' + id);
                        if (statusEl && (statusEl.dataset.status === 'unknown' || statusEl.dataset.status === 'running')) {
                            updateTestStatus(id, previousStatuses[id]);
                        }
                    }
                } else if (data.type === 'error') {
                    status.className = 'status error';
                    statusText.textContent = '❌ Error: ' + data.message;
                    workers[0].innerHTML += '<span class="failed">ERROR: ' + data.message + '</span>\\n';
                } else if (data.type === 'imageDiff') {
                    window.open(data.expected, '_blank');
                    window.open(data.actual, '_blank');
                    window.open(data.diff, '_blank');
                } else if (data.type === 'network') {
                    const workerIdx = data.worker || 0;
                    if (data.status === 'pending') {
                        addNetworkEntry(workerIdx, data.url, 'pending');
                    } else {
                        updateNetworkEntry(workerIdx, data.url, data.status);
                    }
                }
            };
            
            ws.onerror = () => {
                status.className = 'status error';
                statusText.textContent = '❌ Connection error';
                testsRunning = false;
                startBtn.disabled = false;
            };
            
            ws.onclose = () => {
                if (testsRunning) {
                    status.className = 'status error';
                    statusText.textContent = '❌ Connection closed unexpectedly';
                    testsRunning = false;
                    startBtn.disabled = false;
                }
            };
        }

        function clearOutput() {
            workers.forEach(worker => worker.innerHTML = '');
            netlogs.forEach(netlog => netlog.innerHTML = '');
            setVisibleWorkers(4);
        }

        function abortTests() {
            if (ws && confirm('Are you sure you want to abort the tests?')) {
                ws.send(JSON.stringify({ type: 'abort' }));
                statusText.textContent = '⏳ Aborting tests...';
                abortBtn.disabled = true;
            }
        }

        function resetTest(id) {
            if (confirm('Reset regression data for ' + id + '?')) {
                fetch('/api/reset/' + id, { method: 'POST' })
                    .then(r => r.json())
                    .then(result => {
                        if (result.success) {
                            updateTestStatus(id, 'unknown');
                        } else {
                            alert('Reset failed: ' + result.error);
                        }
                    });
            }
        }

        // Connect on page load to check for auto-start (exit mode)
        function initConnection() {
            const initWs = new WebSocket('ws://localhost:${port}');
            initWs.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'autoStart') {
                    initWs.close();
                    // Auto-select and start the specified tests
                    selectNone();
                    data.tests.forEach(id => {
                        const cb = document.querySelector('.test-checkbox[data-id="' + id + '"]');
                        if (cb) cb.checked = true;
                    });
                    setTimeout(() => startTests(), 100);
                }
            };
        }

        loadTestStatuses();
        initConnection();
    </script>
</body>
</html>
    `);
});

app.post('/api/reset/:id', (req, res) => {
    const id = req.params.id;
    const test = TEST_REGISTRY.find(t => t.id === id);
    if (!test) {
        return res.json({ success: false, error: 'Test not found' });
    }

    let deleted = 0;

    if (test.snapshot) {
        const baseName = test.snapshot;
        const snapshotDirs = [
            __dirname + '/tests_regression/regression.test.js-snapshots',
            __dirname + '/tests_regression/ui-playwright.test.js-snapshots',
        ];

        for (const dir of snapshotDirs) {
            if (!fs.existsSync(dir)) continue;
            // Match all files starting with the base snapshot name (handles all platform suffixes)
            const files = fs.readdirSync(dir).filter(f => f.startsWith(baseName) && f.endsWith('.png'));
            for (const file of files) {
                const fullPath = dir + '/' + file;
                try {
                    fs.unlinkSync(fullPath);
                    deleted++;
                    console.log(`Deleted: ${fullPath}`);
                } catch (e) {
                    console.error(`Failed to delete ${fullPath}:`, e);
                }
            }
        }
    }

    const results = loadTestResults();
    delete results[id];
    saveTestResults(results);

    res.json({ success: true, deleted });
});

function startServer() {
    const server = app.listen(port, () => {
        console.log(`\n🧪 Test Viewer running at http://localhost:${port}\n`);

        if (openBrowser) {
            console.log(`Opening browser...\n`);
            const open = (url) => {
                const cmd = process.platform === 'darwin' ? 'open' :
                            process.platform === 'win32' ? 'start' : 'xdg-open';
                exec(`${cmd} ${url}`);
            };
            setTimeout(() => open(`http://localhost:${port}`), 500);
        }

        setupWebSocket(server);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\n❌ Port ${port} is already in use. Killing existing process...`);
            exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, () => {
                setTimeout(() => startServer(), 1000);
            });
        } else {
            console.error('Server error:', err);
            process.exit(1);
        }
    });
}

function setupWebSocket(server) {
    const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('Client connected\n');

    let testProcess = null;
    let isAborting = false;
    let selectedTests = [];
    const testResults = loadTestResults();

    // In exit mode, tell the client to auto-start filtered tests
    if (exitAfterTests) {
        const filteredTests = getFilteredTests();
        const testIds = filteredTests.map(t => t.id);
        console.log(`Auto-starting ${testIds.length} tests (exit mode)\n`);
        ws.send(JSON.stringify({ type: 'autoStart', tests: testIds }));
    }
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'start') {
                selectedTests = data.tests || [];
                if (selectedTests.length === 0) {
                    ws.send(JSON.stringify({ type: 'error', message: 'No tests selected' }));
                    return;
                }
                
                console.log(`Starting tests: ${selectedTests.join(', ')}\n`);
                runTests(selectedTests);
            } else if (data.type === 'abort' && testProcess && !isAborting) {
                console.log('\n🛑 Abort requested by user\n');
                isAborting = true;
                testProcess.kill('SIGTERM');
                ws.send(JSON.stringify({ type: 'aborted' }));
            }
        } catch (err) {
            console.error('Error handling message:', err);
        }
    });
    
    function runTests(testIds) {
        exec('find tests_regression -name "*.png" -exec xattr -d com.apple.quarantine {} \\; 2>/dev/null', { cwd: __dirname }, () => {});
        
        const grepPatterns = testIds.map(id => {
            const test = TEST_REGISTRY.find(t => t.id === id);
            return test ? test.grep : null;
        }).filter(Boolean);

        if (grepPatterns.length === 0) {
            ws.send(JSON.stringify({ type: 'error', message: 'No valid tests found' }));
            return;
        }

        const grepArg = grepPatterns.join('|');
        const escapedGrep = `'${grepArg.replace(/'/g, "'\\''")}'`;
        
        // Clear previous results for selected tests
        for (const id of testIds) {
            delete testResults[id];
        }
        
        // Local-terrain mode is the default in regression.test.js; opt out by
        // launching the viewer with REGRESSION_LOCAL_TERRAIN=0.
        //
        // Workers default to 2 here (vs. 4 for the headless runner) — the
        // viewer is for interactive single-machine use, where SwiftShader
        // shader-link failures under workers=4 produce flaky red diffs in
        // the ocean / gimbal / other GPU-heavy tests. Override with
        // PLAYWRIGHT_WORKERS=N to run faster when GPU contention is known
        // not to be an issue (e.g. fewer tests selected).
        const childEnv = { ...process.env, FORCE_COLOR: '0' };
        if (childEnv.PLAYWRIGHT_WORKERS === undefined) {
            childEnv.PLAYWRIGHT_WORKERS = '2';
        }

        testProcess = spawn('npx', ['playwright', 'test', '--reporter=line', '-g', escapedGrep], {
            cwd: __dirname,
            shell: true,
            env: childEnv,
        });

        let totalTests = 0;
        let currentTest = 0;
        let lastSeenWorker = 0;
        let lastTestName = null;
        const workerTestNames = new Map();
        const runningTests = new Set();
        const failedTests = new Set();
        
        function findMatchingTest(testDesc) {
            const descLower = testDesc.toLowerCase();
            let bestMatch = null;
            let bestMatchLen = 0;
            
            for (const t of TEST_REGISTRY) {
                if (!testIds.includes(t.id)) continue;
                const grepLower = t.grep.toLowerCase();
                
                if (descLower === grepLower) {
                    return t;
                }
                
                if (descLower.includes(grepLower) && grepLower.length > bestMatchLen) {
                    bestMatch = t;
                    bestMatchLen = grepLower.length;
                }
            }
            return bestMatch;
        }

        testProcess.stdout.on('data', (data) => {
            const text = data.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
            process.stdout.write(text);
            
            const testIdStarted = text.match(/\[TEST:([a-z0-9-]+):STARTED\]/g);
            if (testIdStarted) {
                for (const match of testIdStarted) {
                    const id = match.match(/\[TEST:([a-z0-9-]+):STARTED\]/)[1];
                    if (testIds.includes(id) && !runningTests.has(id) && !testResults[id]) {
                        console.log(`TEST STARTED (ID): ${id}`);
                        runningTests.add(id);
                        ws.send(JSON.stringify({ type: 'testStarted', id }));
                    }
                }
            }
            
            const testIdPassed = text.match(/\[TEST:([a-z0-9-]+):PASSED\]/g);
            if (testIdPassed) {
                for (const match of testIdPassed) {
                    const id = match.match(/\[TEST:([a-z0-9-]+):PASSED\]/)[1];
                    if (testIds.includes(id) && !testResults[id]) {
                        console.log(`TEST PASSED (ID): ${id}`);
                        runningTests.delete(id);
                        failedTests.delete(id);
                        testResults[id] = 'passed';
                        saveTestResults(testResults);
                        ws.send(JSON.stringify({ type: 'testResult', id, passed: true }));
                    }
                }
            }
            
            const testIdFailed = text.match(/\[TEST:([a-z0-9-]+):FAILED\]/g);
            if (testIdFailed) {
                for (const match of testIdFailed) {
                    const id = match.match(/\[TEST:([a-z0-9-]+):FAILED\]/)[1];
                    if (testIds.includes(id) && !testResults[id]) {
                        console.log(`TEST FAILED (ID): ${id}`);
                        runningTests.delete(id);
                        failedTests.add(id);
                        testResults[id] = 'failed';
                        saveTestResults(testResults);
                        ws.send(JSON.stringify({ type: 'testResult', id, passed: false }));
                    }
                }
            }
            
            const netMatches = text.matchAll(/\[WORKER-(\d+)\].*?\[NET:(.+):(\d+|pending)\]/g);
            for (const match of netMatches) {
                const worker = parseInt(match[1]);
                const url = match[2];
                const status = match[3] === 'pending' ? 'pending' : parseInt(match[3]);
                ws.send(JSON.stringify({ type: 'network', worker, url, status }));
            }
            
            const bareTestMatch = text.match(/^\[chromium\]\s+›.*?›\s+([^›]+?)\s*$/m);
            if (bareTestMatch) {
                lastTestName = bareTestMatch[1].trim();
            }
            
            const workerMatch = text.match(/\[WORKER-(\d+)\]/);
            let targetWorker = lastSeenWorker;
            
            if (workerMatch) {
                targetWorker = parseInt(workerMatch[1]);
                lastSeenWorker = targetWorker;
                
                if (lastTestName) {
                    const prevTestName = workerTestNames.get(targetWorker);
                    
                    // If worker was running a different test, that test completed
                    if (prevTestName && prevTestName !== lastTestName) {
                        const t = findMatchingTest(prevTestName);
                        if (t && runningTests.has(t.id) && !failedTests.has(t.id) && !testResults[t.id]) {
                            console.log(`TEST PASSED (worker ${targetWorker} switched): ${t.id}`);
                            runningTests.delete(t.id);
                            testResults[t.id] = 'passed';
                            saveTestResults(testResults);
                            ws.send(JSON.stringify({ type: 'testResult', id: t.id, passed: true }));
                        }
                    }
                    
                    workerTestNames.set(targetWorker, lastTestName);
                    ws.send(JSON.stringify({ 
                        type: 'workerName', 
                        worker: targetWorker,
                        name: lastTestName
                    }));
                    lastTestName = null;
                }
            }
            
            const countMatch = text.match(/Running (\d+) tests? using/);
            if (countMatch) {
                totalTests = parseInt(countMatch[1]);
                ws.send(JSON.stringify({ type: 'status', current: 0, total: totalTests }));
                // Don't return early - continue to check for startMatch in the same chunk
            }

            const startMatch = text.match(/\[(\d+)\/(\d+)\]\s+\[chromium\][^\n]+/m);
            if (startMatch) {
                const testNum = parseInt(startMatch[1]);
                const total = parseInt(startMatch[2]);
                const fullLine = startMatch[0];
                const parts = fullLine.split(/\s*›\s*/);
                let testDesc = parts[parts.length - 1].trim();
                if (total > totalTests) totalTests = total;
                ws.send(JSON.stringify({ type: 'status', current: testNum, total: totalTests }));

                // Find which test is starting and mark it as running
                const t = findMatchingTest(testDesc);
                if (t && !runningTests.has(t.id) && !failedTests.has(t.id) && !testResults[t.id]) {
                    console.log(`TEST STARTED: ${t.id} (${testDesc})`);
                    runningTests.add(t.id);
                    ws.send(JSON.stringify({ type: 'testStarted', id: t.id }));
                }

                for (let i = 0; i < 4; i++) {
                    ws.send(JSON.stringify({ type: 'output', text, worker: i }));
                }
                return;
            }

            // If countMatch matched but startMatch didn't, still send output
            if (countMatch) {
                for (let i = 0; i < 4; i++) {
                    ws.send(JSON.stringify({ type: 'output', text, worker: i }));
                }
                return;
            }
            
            // Detect individual test failure: "  N) [chromium] › file:line › Suite › test name"
            const failMatch = text.match(/^\s*\d+\)\s+\[chromium\]\s*›.*?›\s*.*?›\s*(.+?)\s*$/m);
            if (failMatch) {
                const testDesc = failMatch[1].trim();
                console.log(`FAILURE DETECTED: ${testDesc}`);
                
                const t = findMatchingTest(testDesc);
                if (t) {
                    console.log(`  -> Matched failed test: ${t.id}`);
                    runningTests.delete(t.id);
                    failedTests.add(t.id);
                    testResults[t.id] = 'failed';
                    saveTestResults(testResults);
                    ws.send(JSON.stringify({ type: 'testResult', id: t.id, passed: false }));
                }
            }
            
            // Detect summary line with passed count - mark remaining running tests as passed
            const passedMatch = text.match(/(\d+)\s+passed/);
            if (passedMatch) {
                console.log(`SUMMARY PASSED: ${passedMatch[1]}`);
                for (const t of TEST_REGISTRY) {
                    if (testIds.includes(t.id) && !testResults[t.id] && !failedTests.has(t.id)) {
                        console.log(`  -> Marking as passed: ${t.id}`);
                        runningTests.delete(t.id);
                        testResults[t.id] = 'passed';
                        ws.send(JSON.stringify({ type: 'testResult', id: t.id, passed: true }));
                    }
                }
                saveTestResults(testResults);
            }
            
            if (text.match(/\d+\s+(passed|failed)/)) {
                for (let i = 0; i < 4; i++) {
                    ws.send(JSON.stringify({ type: 'output', text, worker: i }));
                }
                return;
            }
            
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('Expected:') && i + 2 < lines.length) {
                    const expectedPath = line.replace('Expected:', '').trim();
                    const receivedLine = lines[i + 1].trim();
                    const diffLine = lines[i + 2].trim();
                    
                    if (receivedLine.startsWith('Received:') && diffLine.startsWith('Diff:')) {
                        const actualPath = receivedLine.replace('Received:', '').trim();
                        const diffPath = diffLine.replace('Diff:', '').trim();
                        
                        ws.send(JSON.stringify({
                            type: 'imageDiff',
                            expected: `http://localhost:${port}/${expectedPath}`,
                            actual: `http://localhost:${port}/${actualPath}`,
                            diff: `http://localhost:${port}/${diffPath}`
                        }));
                    }
                }
            }
            
            const filteredText = text.split('\n').filter(line => !line.includes('[NET:')).join('\n');
            if (filteredText.trim()) {
                ws.send(JSON.stringify({ type: 'output', text: filteredText, worker: targetWorker }));
            }
        });

        testProcess.stderr.on('data', (data) => {
            const text = data.toString();
            process.stderr.write(text);
            ws.send(JSON.stringify({ type: 'output', text }));
        });

        testProcess.on('close', (code) => {
            if (isAborting) {
                console.log(`\nTests aborted by user\n`);
                if (exitAfterTests) {
                    setTimeout(() => process.exit(1), 2000);
                }
                return;
            }
            
            console.log(`\nTests completed with code ${code}\n`);
            ws.send(JSON.stringify({ type: 'complete', code }));
            
            if (exitAfterTests) {
                setTimeout(() => process.exit(code === 0 ? 0 : code), 2000);
            }
        });

        testProcess.on('error', (err) => {
            console.error('Failed to start test process:', err);
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
        });
    }
});
}

console.log('Starting Sitrec Test Viewer...');
if (excludePatterns.length > 0) {
    console.log(`Excluding: ${excludePatterns.join(', ')}`);
}
if (exitAfterTests) {
    const filteredTests = getFilteredTests();
    console.log(`Exit mode: will auto-run ${filteredTests.length} tests when browser connects\n`);
}
startServer();
