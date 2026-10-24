/**
 * @jest-environment jsdom
 */
// checkLogin() is awaited at the top level of index.js while the app starts. With
// rehostRequiresLogin on (the default config), any failure of rehost.php?getuser=1 -
// a network error, or a PHP error page that is not JSON - used to be rethrown, which
// rejected the whole module and left every visitor, logged in or not, on a blank page.
// A failed check now means "logged out"; only the login-gated features are lost.
// So that a member knows why, a failed check also shows a notice over the main view.
// It is a view message, not a dialog: startup does not wait on it and no click clears it.

import {Globals, setNodeMan} from "../src/Globals";
import {asyncCheckLogin, checkLogin} from "../src/login";

jest.mock("../src/runtimeConfig", () => ({configParams: {rehostRequiresLogin: true}}));
jest.mock("../src/configUtils", () => ({isServerless: false, SITREC_SERVER: "https://example.test/sitrecServer/"}));

const NOTICE = "Could not check your login. Reload the page to try again.";

const failures = [
    ["the server cannot be reached", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["rehost.php returns an HTML error page", () => Promise.resolve({
        json: () => Promise.reject(new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON")),
    })],
];

let warn, mainView;

// The main view as startup makes it, after the login check: a node with a positioned div.
function makeMainView() {
    const div = document.createElement("div");
    div.style.position = "absolute";
    document.body.appendChild(div);
    mainView = {id: "mainView", div};
    setNodeMan({get: id => (id === "mainView" ? mainView : undefined)});
}

const notices = () => [...document.querySelectorAll("[role=status]")]
    .filter(el => el.textContent === NOTICE);

beforeEach(() => {
    jest.useFakeTimers();
    delete Globals.userID;
    delete Globals.userData;
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    setNodeMan(undefined);
    mainView = null;
    document.body.innerHTML = "";
});
afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.fetch;
    delete window._mcpDebug;
});

test.each(failures)("startup carries on logged out when %s", async (_, response) => {
    global.fetch = jest.fn(response);
    await expect(checkLogin()).resolves.toBeUndefined();
    expect(Globals.userID).toBe(0);
    expect(Globals.userData).toEqual({userID: 0, userGroups: []});
    expect(warn).toHaveBeenCalled();
});

test("a successful check still sets the user", async () => {
    global.fetch = jest.fn(() => Promise.resolve({json: () => Promise.resolve({userID: 42, userGroups: [2]})}));
    await checkLogin();
    expect(Globals.userID).toBe(42);
    expect(Globals.userData).toEqual({userID: 42, userGroups: [2]});
});

test("asyncCheckLogin() itself still reports the failure to its other callers", async () => {
    // The File menu's login flow decides what to do from this; only startup swallows it.
    global.fetch = jest.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(asyncCheckLogin()).rejects.toThrow("Failed to fetch");
});

describe("the notice for a failed login check", () => {
    test.each(failures)("is shown once over the main view when %s", async (_, response) => {
        global.fetch = jest.fn(response);
        await checkLogin();
        // Startup has not made the main view yet, so there is nowhere to show it.
        expect(notices()).toHaveLength(0);

        makeMainView();
        jest.advanceTimersByTime(500);
        expect(notices()).toHaveLength(1);
        expect(notices()[0].parentElement).toBe(mainView.div);

        // It goes away by itself (faded out and emptied), and does not come back.
        jest.advanceTimersByTime(60000);
        const shown = mainView.div.querySelectorAll("[role=status]");
        expect(shown).toHaveLength(1);
        expect(shown[0].style.opacity).toBe("0");
        expect(shown[0].textContent).toBe("");
    });

    test("does not block the app or an MCP session", async () => {
        window._mcpDebug = true;
        makeMainView();
        global.fetch = jest.fn(failures[0][1]);
        // Resolves at once: startup goes on loading while the notice is up.
        await expect(checkLogin()).resolves.toBeUndefined();
        const [notice] = notices();
        expect(notice).toBeDefined();
        // Clicks pass through it, and no modal overlay was added to the page.
        expect(notice.style.pointerEvents).toBe("none");
        expect(document.body.children).toHaveLength(1);
        expect(document.body.firstElementChild).toBe(mainView.div);
    });

    test.each([
        ["the server answers that the visitor is logged out", {userID: 0}],
        ["the visitor is logged in", {userID: 42, userGroups: [2]}],
    ])("is not shown when %s", async (_, answer) => {
        makeMainView();
        global.fetch = jest.fn(() => Promise.resolve({json: () => Promise.resolve(answer)}));
        await checkLogin();
        jest.advanceTimersByTime(60000);
        expect(notices()).toHaveLength(0);
        expect(document.querySelectorAll("[role=status]")).toHaveLength(0);
    });
});
