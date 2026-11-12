export const STARTUP_ACTION_NEW = "new";
export const STARTUP_ACTION_BOTBENCH = "botbench";
export const STARTUP_ACTION_TRACKBROWSER = "trackbrowser";
// "browse" does not start a sitch. It keeps the start screen, and makes that screen
// the sitch browser. So it is not one of the explicit actions below.
export const STARTUP_ACTION_BROWSE = "browse";

/** Read a case-insensitive startup action from a URL query string. */
export function startupActionFromSearch(search = "") {
    const value = new URLSearchParams(search).get("action");
    return value?.trim().toLowerCase() || null;
}

/** Actions that deliberately choose the initial screen and suppress the sitch browser. */
export function isExplicitStartupAction(action) {
    return action === STARTUP_ACTION_NEW || action === STARTUP_ACTION_BOTBENCH
        || action === STARTUP_ACTION_TRACKBROWSER;
}

/**
 * The screen that the start screen shows: the sitch browser for action=browse,
 * and the sitch templates for an address with no action.
 * @returns {"browse"|"templates"}
 */
export function startScreenForAction(action) {
    return action === STARTUP_ACTION_BROWSE ? "browse" : "templates";
}

/** Open a tool requested by the startup URL after Sitrec has finished setting up. */
export function runStartupToolAction(action, {openBotBenchDialog, openTrackBrowser}) {
    switch (action) {
        case STARTUP_ACTION_BOTBENCH:
            openBotBenchDialog();
            return true;
        case STARTUP_ACTION_TRACKBROWSER:
            openTrackBrowser();
            return true;
        default:
            return false;
    }
}
