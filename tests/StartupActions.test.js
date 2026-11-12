import {
    isExplicitStartupAction,
    runStartupToolAction,
    STARTUP_ACTION_BOTBENCH,
    STARTUP_ACTION_BROWSE,
    STARTUP_ACTION_NEW,
    startScreenForAction,
    startupActionFromSearch,
} from "../src/StartupActions";

describe("startup URL actions", () => {
    test("reads the direct BOTBench route case-insensitively", () => {
        expect(startupActionFromSearch("?action=botbench")).toBe(STARTUP_ACTION_BOTBENCH);
        expect(startupActionFromSearch("?action=BOTBench&sitch=custom")).toBe(STARTUP_ACTION_BOTBENCH);
        expect(startupActionFromSearch("?action=%20botbench%20")).toBe(STARTUP_ACTION_BOTBENCH);
    });

    test("only known startup actions suppress normal startup", () => {
        expect(isExplicitStartupAction(STARTUP_ACTION_NEW)).toBe(true);
        expect(isExplicitStartupAction(STARTUP_ACTION_BOTBENCH)).toBe(true);
        expect(isExplicitStartupAction(startupActionFromSearch("?action=unknown"))).toBe(false);
        expect(isExplicitStartupAction(startupActionFromSearch(""))).toBe(false);
    });

    test("action=browse keeps the start screen and makes it the sitch browser", () => {
        const action = startupActionFromSearch("?action=Browse");
        expect(action).toBe(STARTUP_ACTION_BROWSE);
        // It must not be an explicit action: an explicit action stops the start screen.
        expect(isExplicitStartupAction(action)).toBe(false);
        expect(startScreenForAction(action)).toBe("browse");
    });

    test("the start screen shows the templates for an address with no action", () => {
        expect(startScreenForAction(startupActionFromSearch(""))).toBe("templates");
        expect(startScreenForAction(startupActionFromSearch("?action=unknown"))).toBe("templates");
    });

    test("opens BOTBench once after setup and ignores other actions", () => {
        const openBotBenchDialog = jest.fn(() => ({kind: "botbench"}));
        expect(runStartupToolAction(STARTUP_ACTION_BOTBENCH, {openBotBenchDialog})).toBe(true);
        expect(openBotBenchDialog).toHaveBeenCalledTimes(1);
        expect(runStartupToolAction(STARTUP_ACTION_NEW, {openBotBenchDialog})).toBe(false);
        expect(openBotBenchDialog).toHaveBeenCalledTimes(1);
    });
});
