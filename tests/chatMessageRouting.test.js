import {beforeEach, expect, jest, test} from "@jest/globals";

jest.mock("../src/nodes/CNodeViewText", () => ({CNodeViewText: class {}}));
jest.mock("../src/Globals", () => ({Globals: {settings: {}}, guiMenus: {}, markSitchDirty: jest.fn()}));
jest.mock("../src/configUtils", () => ({}));
jest.mock("../src/CSitrecAPI", () => ({sitrecAPI: {}}));
jest.mock("../src/envUtils", () => ({getEnvBool: () => true}));
jest.mock("../src/nodes/CNode3DObject", () => ({ModelFiles: {}}));
jest.mock("../src/CClientNLU", () => ({clientNLU: {
    parse: jest.fn(), execute: jest.fn(), generateResponse: jest.fn(),
}}));
jest.mock("../src/i18n", () => ({t: (k) => k}));
jest.mock("../src/docsRegistry", () => ({}));
jest.mock("../src/linkify", () => ({}));
jest.mock("../src/MenuMirror", () => ({}));
jest.mock("../src/BYOKKeyStore", () => ({}));
jest.mock("../src/CLayoutManager", () => ({LayoutMan: {}}));
jest.mock("../src/BYOKModelCatalog", () => ({}));
jest.mock("../src/BYOKUsage", () => ({}));
jest.mock("../src/CDirectLLMClient", () => ({}));

import {clientNLU} from "../src/CClientNLU";
import {CNodeViewChat} from "../src/nodes/CNodeVIewChat";

let view;

beforeEach(() => {
    jest.clearAllMocks();
    view = Object.create(CNodeViewChat.prototype);
    Object.assign(view, {
        chatHistory: [],
        inputBox: {value: ""},
        addUserMessage(text) { this.chatHistory.push({role: "user", text}); },
        addSystemMessage(text) { this.chatHistory.push({role: "bot", text}); },
        addDebugMessage: jest.fn(),
        sendToLLM: jest.fn().mockResolvedValue(undefined),
    });
    clientNLU.parse.mockReturnValue({intent: "GO_TO", slots: {}, confidence: 0.95});
    clientNLU.execute.mockResolvedValue({success: true});
    clientNLU.generateResponse.mockReturnValue("Moved to Bingley");
});

test.each(["yes", "no", "okay", "thanks", "Bingley", "12PM", "use ESRI", "pause"])(
    'sends "%s" to AI after its question, without parsing or executing locally', async (reply) => {
        view.chatHistory = [
            {role: "user", text: "bit before noon"},
            {role: "bot", text: "Would 11:55 a.m. work? For which date and location?"},
        ];

        await view.submitMessage(reply);

        expect(view.sendToLLM).toHaveBeenCalledWith(reply);
        expect(clientNLU.parse).not.toHaveBeenCalled();
        expect(clientNLU.execute).not.toHaveBeenCalled();
        expect(view.chatHistory).toEqual([
            {role: "user", text: "bit before noon"},
            {role: "bot", text: "Would 11:55 a.m. work? For which date and location?"},
            {role: "user", text: reply},
        ]);
    },
);

test.each([
    "Which location? Bingley and London are both available.",
    "Which source?\n- ESRI\n- OSM",
    "Use the current location？",
])("recognizes a question followed by more text: %s", async (question) => {
    view.chatHistory = [{role: "bot", text: question}];
    await view.submitMessage("Bingley");
    expect(view.sendToLLM).toHaveBeenCalledWith("Bingley");
    expect(clientNLU.parse).not.toHaveBeenCalled();
});

test("resumes local commands once AI has answered, without reusing an older question", async () => {
    view.chatHistory = [
        {role: "bot", text: "Would 11:55 a.m. work?"},
        {role: "user", text: "yes"},
        {role: "bot", text: "Set the time to 11:55 a.m."},
    ];
    await view.submitMessage("Bingley");
    expect(clientNLU.parse).toHaveBeenCalledWith("Bingley");
    expect(clientNLU.execute).toHaveBeenCalledTimes(1);
    expect(view.sendToLLM).not.toHaveBeenCalled();
});

test("keeps new conversations eligible for local commands", async () => {
    await view.submitMessage("Bingley");
    expect(clientNLU.execute).toHaveBeenCalledTimes(1);
    expect(view.sendToLLM).not.toHaveBeenCalled();
});

test("still sends consent to AI after an offer without a question mark", async () => {
    view.chatHistory = [{role: "bot", text: "Say the word and I'll move the camera."}];
    clientNLU.parse.mockReturnValue({
        intent: "SMALL_TALK", slots: {couldBeConsent: true}, confidence: 1,
    });
    await view.submitMessage("okay");
    expect(view.sendToLLM).toHaveBeenCalledWith("okay");
    expect(clientNLU.execute).not.toHaveBeenCalled();
});

test("continues to route typed replies through an active voice session", async () => {
    view.chatHistory = [{role: "bot", text: "Which location?"}];
    view.voiceSession = {sendUserText: jest.fn().mockReturnValue(true)};
    await view.submitMessage("Bingley");
    expect(view.voiceSession.sendUserText).toHaveBeenCalledWith("Bingley");
    expect(view.sendToLLM).not.toHaveBeenCalled();
    expect(clientNLU.parse).not.toHaveBeenCalled();
});
