import {isLocal, SITREC_SERVER} from "./configUtils";
import {withTestUser} from "./Globals";
import {showError} from "./showError";

export function writeToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        console.log('Text copied to clipboard');
    }).catch((error) => {
        showError('Error copying text to clipboard: ', error);
    });
}

export async function getShortURL(url) {

    if (isLocal) {
        // comment out the following line to test the shortener locally
        return url;
    }

// URL-encode the original URL
    var encoded_url = encodeURIComponent(url);

// Construct the URL for the PHP shortener
    var shortenerUrl = SITREC_SERVER + "shortener.php?url=" + encoded_url;

// Fetch the shortened URL
    return fetch(withTestUser(shortenerUrl))
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok: ' + response.statusText);
            }
            return response.text();
        })
}