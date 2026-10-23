// The chat view sends back the continuationToken that chatbot.php returns with its tool
// calls, so the server can find the turn's saved state without a session cookie. Each
// continuation uses the token of the reply it continues, not the first one. sendToLLM and
// continueSession are the real methods; the view's display and tool execution are stubbed.
import {beforeEach, expect, jest, test} from "@jest/globals";

jest.mock("../src/nodes/CNodeViewText", () => ({CNodeViewText: class {}}));
jest.mock("../src/Globals", () => ({
    GlobalDateTimeNode: {timeWithTimeZone: () => "2026-10-23 12:00 PDT", dateNow: null},
    Globals: {settings: {chatModel: "openai:gpt-5-mini"}},
    guiMenus: {},
    markSitchDirty: () => {},
    withTestUser: (url) => url,
}));
jest.mock("../src/configUtils", () => ({
    SITREC_APP: "/sitrec/", SITREC_SERVER: "/sitrec/sitrecServer/", isNLULoggingUser: () => false,
}));
jest.mock("../src/CSitrecAPI", () => ({
    sitrecAPI: {getLLMDocumentation: () => ({}), getMenuSummary: () => ({})},
}));
jest.mock("../src/envUtils", () => ({getEnvBool: () => true}));
jest.mock("../src/nodes/CNode3DObject", () => ({ModelFiles: {}}));
jest.mock("../src/CClientNLU", () => ({clientNLU: {}}));
jest.mock("../src/i18n", () => ({t: (k) => k}));
jest.mock("../src/docsRegistry", () => ({AI_DOC_CHAR_LIMIT: 80000, getChatAvailableDocs: () => ({})}));
jest.mock("../src/linkify", () => ({linkifyToHTML: (s) => s}));
jest.mock("../src/MenuMirror", () => ({mirrorMenuItem: () => {}}));
jest.mock("../src/BYOKKeyStore", () => ({getKey: async () => null, getEndpoint: () => null}));
jest.mock("../src/CLayoutManager", () => ({LayoutMan: {}}));
jest.mock("../src/BYOKModelCatalog", () => ({
    probeEndpointResidency: async () => ({}), DEFAULT_VOICE_MODEL: "voice",
}));
jest.mock("../src/BYOKUsage", () => ({formatTurnUsage: () => "", recordUsage: () => {}}));
jest.mock("../src/CDirectLLMClient", () => ({
    buildSystemPromptParts: () => ({}),
    buildToolSet: () => ({tools: [], specialistTools: {}}),
    chat: async () => ({}),
    isBYOKProvider: () => false,
    keyProviderForBYOK: (p) => p,
}));

import {CNodeViewChat} from "../src/nodes/CNodeVIewChat";

const TOKEN_1 = "1".repeat(64);
const TOKEN_2 = "2".repeat(64);
const call = (value) => ({fn: "getMenuValue", args: {menu: "terrain", path: "Elevation Scale", value}});

let view;
let requests;

function serverReplies(replies) {
    requests = [];
    global.fetch = jest.fn(async (url, init) => {
        requests.push({url, body: JSON.parse(init.body), init});
        return {json: async () => replies.shift()};
    });
}

beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    view = Object.create(CNodeViewChat.prototype);
    Object.assign(view, {
        chatHistory: [],
        startThinkingIndicator() {},
        stopThinkingIndicator() {},
        endTurn() {},
        addDebugMessage() {},
        addSystemMessage: jest.fn(),
        logUnhandledLLMCall() {},
        // A read, so the model needs its result and the view must continue.
        handleAPICalls: async (calls) => ({
            toolResults: calls.map((c) => ({fn: c.fn, args: c.args, result: {value: 1}})),
            changesSerializedState: false,
            allSucceeded: true,
            actionOnly: false,
        }),
    });
});

test("each continuation sends the token from the reply it continues", async () => {
    serverReplies([
        {text: "", apiCalls: [call(1)], sessionContinue: true, continuationToken: TOKEN_1},
        {text: "", apiCalls: [call(2)], sessionContinue: true, continuationToken: TOKEN_2},
        {text: "The scale is 2.", apiCalls: []},
    ]);

    await view.sendToLLM("what is the elevation scale?");

    expect(requests).toHaveLength(3);
    expect(requests[0].body.continuationToken).toBeUndefined();
    expect(requests[1].body).toEqual({
        continueSession: true,
        continuationToken: TOKEN_1,
        toolResults: [{fn: "getMenuValue", args: call(1).args, result: {value: 1}}],
        provider: "openai",
        model: "gpt-5-mini",
    });
    expect(requests[2].body.continuationToken).toBe(TOKEN_2);
    for (const {url, init} of requests) {
        expect(url).toBe("/sitrec/sitrecServer/chatbot.php");
        expect(init.method).toBe("POST");
        expect(init.credentials).toBe("include");
    }
    expect(view.addSystemMessage).toHaveBeenCalledWith("The scale is 2.");
});

test("a reply without a token continues with none, so the server can say what is missing", async () => {
    serverReplies([
        {text: "", apiCalls: [call(1)], sessionContinue: true},
        {text: "The assistant lost track of this request on the server.", apiCalls: []},
    ]);

    await view.sendToLLM("what is the elevation scale?");

    expect(requests).toHaveLength(2);
    expect(requests[1].body.continueSession).toBe(true);
    expect(requests[1].body.continuationToken).toBeNull();
});
