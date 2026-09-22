export const STARTUP_ACTION_NEW = "new";
export const STARTUP_ACTION_BOTBENCH = "botbench";
export const STARTUP_ACTION_TRACKBROWSER = "trackbrowser";

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
