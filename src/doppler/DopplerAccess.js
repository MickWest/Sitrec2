// Who can use Doppler geolocation. This small file is part of Sitrec startup, with the
// loader; the tool itself is fetched when the user opens it.
import {isAdmin} from "../configUtils";
import {hasServerLogin} from "../Globals";

/**
 * True for an administrator, and for a user who is logged in.
 * A visitor with no login does not get the menu item or the tool. That includes every user
 * of a build that has no login, and a visitor whose login check failed: each has a fixed
 * user ID that is not a login (hasServerLogin in Globals.js).
 * @returns {boolean}
 */
export function canUseDopplerGeolocation() {
    return isAdmin() || hasServerLogin();
}
