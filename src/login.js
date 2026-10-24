// check if logged in
// The URL https://www.metabunk.org/sitrec/sitrecServer/rehost.php?getuser=1
// will return a string of the user ID (0 if not logged in)
// if we are not logged in, then we can't rehost files
// so we don't show the rehost button

import {Globals, withTestUser} from "./Globals";
import {configParams} from "./runtimeConfig";
import {isServerless, SITREC_SERVER} from "./configUtils";

export async function checkLogin()  {
    try {
        await asyncCheckLogin();
    } catch (err) {
        // Startup awaits this, so a failed check (network error, or an HTML error page
        // from rehost.php) must not stop the app loading. Carry on logged out, which
        // only turns off the login-gated features.
        console.warn("Login check failed, continuing as logged out", err);
        Globals.userID = 0;
        Globals.userData = { userID: 0, userGroups: [] };
    }
}

export function asyncCheckLogin() {
    // In serverless mode, we don't have access to rehost.php, so just use a default ID
    if (isServerless) {
        console.log("Serverless mode: using default user ID")
        Globals.userID = 88888888;
        Globals.userData = { userID: 88888888 };
        return Promise.resolve();
    }

    const url = SITREC_SERVER + "rehost.php?getuser=1"
    console.log("Checking login at " + url)
    return fetch(withTestUser(url), {mode: 'cors'})
        .then(response => response.json())
        .then(data => {
            Globals.userData = data;
            Globals.userID = data.userID;
            console.log("User ID is " + Globals.userID)
        })
        .catch(err => {
            if (!configParams.rehostRequiresLogin) {
                console.warn("Login check failed, using fallback user ID", err);
                Globals.userID = 12345678;
                Globals.userData = { userID: 12345678, userGroups: [] };
                return;
            }
            throw err;
        });
}
