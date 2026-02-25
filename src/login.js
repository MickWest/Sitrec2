// check if logged in
// The URL https://www.metabunk.org/sitrec/sitrecServer/rehost.php?getuser=1
// will return a string of the user ID (0 if not logged in)
// if we are not logged in, then we can't rehost files
// so we don't show the rehost button

import {Globals} from "./Globals";
import {_configParams} from "../config/config";
import {isServerless, SITREC_SERVER} from "./configUtils";

export const configParams = _configParams;

export async function checkLogin()  {
    await asyncCheckLogin();
}

export function asyncCheckLogin() {

    // if configParams.rehostRequiresLogin is false, then we don't need to check
    // so we can just return a promise that resolves to 12345678
    if (!configParams.rehostRequiresLogin) {
        console.log("Rehost attempt does not require login")
        Globals.userID = 12345678;
        Globals.userData = { userID: 12345678 };
        return Promise.resolve();
    }


    // In serverless mode, we don't have access to rehost.php, so just use a default ID
    if (isServerless) {
        console.log("Serverless mode: using default user ID")
        Globals.userID = 88888888;
        Globals.userData = { userID: 88888888 };
        return Promise.resolve();
    }

    const url = SITREC_SERVER + "rehost.php?getuser=1"
    console.log("Checking login at " + url)
    return fetch(url, {mode: 'cors'})
        .then(response => response.json())
        .then(data => {
            Globals.userData = data;
            Globals.userID = data.userID;
            console.log("User ID is " + Globals.userID)
        });
}

