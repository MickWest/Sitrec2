// checkLogin() is awaited at the top level of index.js while the app starts. With
// rehostRequiresLogin on (the default config), any failure of rehost.php?getuser=1 -
// a network error, or a PHP error page that is not JSON - used to be rethrown, which
// rejected the whole module and left every visitor, logged in or not, on a blank page.
// A failed check now means "logged out"; only the login-gated features are lost.

import {Globals} from "../src/Globals";
import {asyncCheckLogin, checkLogin} from "../src/login";

jest.mock("../src/runtimeConfig", () => ({configParams: {rehostRequiresLogin: true}}));
jest.mock("../src/configUtils", () => ({isServerless: false, SITREC_SERVER: "https://example.test/sitrecServer/"}));

let warn;
beforeEach(() => {
    delete Globals.userID;
    delete Globals.userData;
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
});

test.each([
    ["the server cannot be reached", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["rehost.php returns an HTML error page", () => Promise.resolve({
        json: () => Promise.reject(new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON")),
    })],
])("startup carries on logged out when %s", async (_, response) => {
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
