#!/usr/bin/env node

/**
 * sitrec-comms — Shared MCP server for inter-agent communication.
 *
 * Each Claude Code session spawns its own instance via stdio.
 * All instances share state through a JSON file on disk, giving
 * every agent a view of what the others are doing.
 *
 * State file: ~/.claude/sitrec-comms/state.json
 *
 * Tools:
 *   comms_checkin   — Register/update what this agent is working on
 *   comms_list      — See all active agents and their status
 *   comms_send      — Send a message to another agent (or broadcast)
 *   comms_inbox     — Check for messages addressed to this agent
 *   comms_clear     — Clear this agent's inbox
 *   comms_checkout  — Unregister this agent (on session end)
 */

import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import os from "os";

// ── Config ──────────────────────────────────────────────────────────

const STATE_DIR = path.join(os.homedir(), ".claude", "sitrec-comms");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const STALE_MINUTES = 30; // agents not seen in this long are pruned
const log = (msg) => process.stderr.write(`[sitrec-comms] ${msg}\n`);

// ── Agent identity ──────────────────────────────────────────────────
// Derive agent name from cwd: worktrees conventionally end in /sitrec-agents/<name>,
// main repo is "main". Falls back to the basename of cwd.

function deriveAgentName() {
    const cwd = process.cwd();
    const agentsDir = path.join(os.homedir(), "sitrec-agents");
    if (cwd.startsWith(agentsDir + path.sep)) {
        return cwd.slice(agentsDir.length + 1).split(path.sep)[0];
    }
    // Check if it's the main sitrec repo
    if (cwd.includes("sitrec-dev/sitrec") && !cwd.includes("sitrec-agents")) {
        return "main";
    }
    return path.basename(cwd);
}

const AGENT_NAME = deriveAgentName();

// ── State management ────────────────────────────────────────────────

function readState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, "utf-8");
        return JSON.parse(raw);
    } catch {
        return {agents: {}, messages: []};
    }
}

function writeState(state) {
    fs.mkdirSync(STATE_DIR, {recursive: true});
    // Write atomically via rename to avoid partial reads
    const tmp = STATE_FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
}

function pruneStale(state) {
    const cutoff = Date.now() - STALE_MINUTES * 60 * 1000;
    let pruned = 0;
    for (const [name, agent] of Object.entries(state.agents)) {
        if (agent.lastSeen < cutoff) {
            delete state.agents[name];
            pruned++;
        }
    }
    // Also prune old messages (older than stale threshold)
    const before = state.messages.length;
    state.messages = state.messages.filter(m => m.timestamp > cutoff);
    return pruned;
}

function touchAgent(state) {
    if (state.agents[AGENT_NAME]) {
        state.agents[AGENT_NAME].lastSeen = Date.now();
    }
}

function formatTimestamp(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", {hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"});
}

function timeAgo(ts) {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

// ── Tool definitions ────────────────────────────────────────────────

const TOOLS = [
    {
        name: "comms_checkin",
        description: `Register or update what this agent (${AGENT_NAME}) is working on. Call this when you start a task or change focus.`,
        inputSchema: {
            type: "object",
            properties: {
                task: {
                    type: "string",
                    description: "Brief description of current task",
                },
                status: {
                    type: "string",
                    description: "Status: active, blocked, done, idle",
                    enum: ["active", "blocked", "done", "idle"],
                },
            },
            required: ["task"],
        },
    },
    {
        name: "comms_list",
        description: "List all active agents and what they're working on.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "comms_send",
        description: "Send a message to another agent (by name) or broadcast to all.",
        inputSchema: {
            type: "object",
            properties: {
                to: {
                    type: "string",
                    description: 'Target agent name, or "all" to broadcast',
                },
                message: {
                    type: "string",
                    description: "The message to send",
                },
                priority: {
                    type: "string",
                    description: "Message priority",
                    enum: ["normal", "urgent"],
                },
            },
            required: ["to", "message"],
        },
    },
    {
        name: "comms_inbox",
        description: `Check for messages addressed to this agent (${AGENT_NAME}).`,
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "comms_clear",
        description: `Clear all messages from this agent's (${AGENT_NAME}) inbox.`,
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "comms_checkout",
        description: `Unregister this agent (${AGENT_NAME}). Call when done with work.`,
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
];

// ── Tool handlers ───────────────────────────────────────────────────

function handleCheckin(args) {
    const state = readState();
    pruneStale(state);
    state.agents[AGENT_NAME] = {
        task: args.task,
        status: args.status || "active",
        lastSeen: Date.now(),
        checkinTime: state.agents[AGENT_NAME]?.checkinTime || Date.now(),
        pid: process.pid,
    };
    writeState(state);
    return `Checked in as "${AGENT_NAME}": ${args.task} [${args.status || "active"}]`;
}

function handleList() {
    const state = readState();
    pruneStale(state);
    writeState(state); // persist prune

    const agents = Object.entries(state.agents);
    if (agents.length === 0) {
        return "No agents currently registered.";
    }

    const lines = agents.map(([name, a]) => {
        const marker = name === AGENT_NAME ? " (you)" : "";
        const statusIcon = {active: "●", blocked: "⊘", done: "✓", idle: "○"}[a.status] || "?";
        return `  ${statusIcon} ${name}${marker} — ${a.task} [${a.status}] (seen ${timeAgo(a.lastSeen)})`;
    });

    // Count pending messages per agent
    const inboxCounts = {};
    for (const msg of state.messages) {
        const target = msg.to;
        if (target === "all") {
            for (const name of Object.keys(state.agents)) {
                inboxCounts[name] = (inboxCounts[name] || 0) + 1;
            }
        } else {
            inboxCounts[target] = (inboxCounts[target] || 0) + 1;
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const name = agents[i][0];
        const count = inboxCounts[name] || 0;
        if (count > 0) {
            lines[i] += ` [${count} msg]`;
        }
    }

    return `Agents (${agents.length}):\n${lines.join("\n")}`;
}

function handleSend(args) {
    const state = readState();
    pruneStale(state);
    touchAgent(state);

    const msg = {
        from: AGENT_NAME,
        to: args.to,
        message: args.message,
        priority: args.priority || "normal",
        timestamp: Date.now(),
    };

    state.messages.push(msg);
    writeState(state);

    const target = args.to === "all" ? "all agents" : `"${args.to}"`;
    return `Message sent to ${target}: "${args.message}"`;
}

function handleInbox() {
    const state = readState();
    pruneStale(state);
    touchAgent(state);
    writeState(state);

    const myMessages = state.messages.filter(
        m => m.to === AGENT_NAME || m.to === "all"
    );

    if (myMessages.length === 0) {
        return "No messages.";
    }

    const lines = myMessages.map(m => {
        const pri = m.priority === "urgent" ? " [URGENT]" : "";
        const target = m.to === "all" ? " (broadcast)" : "";
        return `  [${formatTimestamp(m.timestamp)}] from ${m.from}${target}${pri}: ${m.message}`;
    });

    return `Inbox (${myMessages.length}):\n${lines.join("\n")}`;
}

function handleClear() {
    const state = readState();
    const before = state.messages.length;
    state.messages = state.messages.filter(
        m => m.to !== AGENT_NAME && m.to !== "all"
    );
    // For broadcast messages, we can't remove them (other agents need them).
    // Instead, track which agents have read broadcasts.
    writeState(state);
    const removed = before - state.messages.length;
    return `Cleared ${removed} message(s) from inbox.`;
}

function handleCheckout() {
    const state = readState();
    delete state.agents[AGENT_NAME];
    // Remove direct messages to this agent
    state.messages = state.messages.filter(m => m.to !== AGENT_NAME);
    writeState(state);
    return `Agent "${AGENT_NAME}" unregistered.`;
}

// ── MCP server setup ────────────────────────────────────────────────

const server = new Server(
    {name: "sitrec-comms", version: "1.0.0"},
    {capabilities: {tools: {}}},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: TOOLS}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const {name, arguments: args} = request.params;

    try {
        let result;
        switch (name) {
            case "comms_checkin":  result = handleCheckin(args); break;
            case "comms_list":    result = handleList(); break;
            case "comms_send":    result = handleSend(args); break;
            case "comms_inbox":   result = handleInbox(); break;
            case "comms_clear":   result = handleClear(); break;
            case "comms_checkout": result = handleCheckout(); break;
            default:
                return {
                    content: [{type: "text", text: `Unknown tool: ${name}`}],
                    isError: true,
                };
        }
        return {content: [{type: "text", text: result}]};
    } catch (e) {
        log(`Error in ${name}: ${e.message}`);
        return {
            content: [{type: "text", text: `Error: ${e.message}`}],
            isError: true,
        };
    }
});

// ── Lifecycle ───────────────────────────────────────────────────────

// Auto-checkin on startup with a minimal entry so the agent appears in the list
function autoCheckin() {
    const state = readState();
    pruneStale(state);
    if (!state.agents[AGENT_NAME]) {
        state.agents[AGENT_NAME] = {
            task: "(just connected)",
            status: "idle",
            lastSeen: Date.now(),
            checkinTime: Date.now(),
            pid: process.pid,
        };
    } else {
        state.agents[AGENT_NAME].lastSeen = Date.now();
        state.agents[AGENT_NAME].pid = process.pid;
    }
    writeState(state);
}

// Auto-checkout on exit
function autoCheckout() {
    try {
        const state = readState();
        delete state.agents[AGENT_NAME];
        state.messages = state.messages.filter(m => m.to !== AGENT_NAME);
        writeState(state);
        log(`Auto-checkout: ${AGENT_NAME}`);
    } catch {
        // Best effort — process may be exiting
    }
}

// Periodic heartbeat to keep lastSeen fresh
const heartbeatInterval = setInterval(() => {
    try {
        const state = readState();
        if (state.agents[AGENT_NAME]) {
            state.agents[AGENT_NAME].lastSeen = Date.now();
            writeState(state);
        }
    } catch {
        // Ignore — file may be locked by another instance
    }
}, 60_000); // every minute
heartbeatInterval.unref();

// Detect stdin close (Claude Code exited)
process.stdin.on("end", () => { autoCheckout(); process.exit(0); });
process.stdin.on("close", () => { autoCheckout(); process.exit(0); });
process.on("SIGTERM", () => { autoCheckout(); process.exit(0); });
process.on("SIGINT", () => { autoCheckout(); process.exit(0); });

// Orphan detection safety net
const orphanCheck = setInterval(() => {
    if (process.stdin.destroyed) {
        autoCheckout();
        process.exit(0);
    }
}, 30_000);
orphanCheck.unref();

// ── Start ───────────────────────────────────────────────────────────

async function main() {
    autoCheckin();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log(`Agent "${AGENT_NAME}" connected (pid ${process.pid})`);
}

main().catch((e) => {
    log(`Fatal error: ${e.message}`);
    process.exit(1);
});
