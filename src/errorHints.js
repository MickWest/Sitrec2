/**
 * Known causes for failures that first-time testers of a self-hosted deployment hit.
 *
 * An error dialog that says only "HTTP 404" sends a tester into the code. The functions
 * here turn the facts the code already has (which source, which address, what the server
 * answered) into a sentence about the likely cause and what to do, in the words of the
 * settings and documents involved. They are pure so they can be unit-tested, and they
 * never throw: a hint is a courtesy, not a second failure.
 *
 * Read at compile time, the same way src/configUtils.js reads it, so this module has no
 * imports and can be tested without the application.
 */
const SECURE_BUILD = process.env.IS_SECURE_BUILD === 'true';

function hostOf(url, base) {
    try {
        const u = new URL(url, base);
        return { host: u.host, sameOrigin: base ? u.origin === new URL(base).origin : false, dir: u.href.slice(0, u.href.lastIndexOf('/') + 1) };
    } catch (e) {
        return { host: '', sameOrigin: false, dir: '' };
    }
}

/**
 * A hint for a map or elevation tile that failed to load.
 *
 * @param {Object} facts
 * @param {string} [facts.sourceName]   the source's display name (sourceDef.name)
 * @param {string} [facts.url]          the tile address that failed
 * @param {string} [facts.errorMessage] the error's message ("HTTP 404", "Failed to fetch", ...)
 * @param {string} [facts.pageUrl]      the page's address, to tell same-origin from remote (defaults to location.href)
 * @param {boolean} [facts.secureBuild] override for tests; defaults to the compile-time flag
 * @returns {string} one or more sentences, or "" when nothing useful can be said
 */
// One hint per (source, kind of failure) per page: a tile pyramid fails a dozen tiles at a
// time and retries them, and the same sentence a hundred times over hides the first one.
const hintsGiven = new Set();

/** Forget which hints were given (tests, and a source that was reconfigured). */
export function resetTileLoadHints() {
    hintsGiven.clear();
}

export function tileLoadHint({ sourceName, url, errorMessage, pageUrl, secureBuild = SECURE_BUILD } = {}) {
    const name = sourceName ? `"${sourceName}"` : "The selected";
    const message = String(errorMessage || '');
    const status = (/HTTP\s+(\d{3})/.exec(message) || [])[1];
    const kind = status || (/ServiceUnavailable/.test(message) ? 'unavailable' : message.slice(0, 40));
    const onceKey = `${sourceName || ''}|${kind}`;
    if (hintsGiven.has(onceKey)) return '';
    hintsGiven.add(onceKey);
    const base = pageUrl || (typeof location !== 'undefined' ? location.href : undefined);
    const { host, sameOrigin, dir } = hostOf(url || '', base);
    const lines = [];

    if (status === '404') {
        if ((url || '').includes('/sitrec-terrain/')) {
            lines.push(`${name} source reads pre-downloaded tiles from ${dir || 'the sitrec-terrain directory'}, and nothing is served there.`
                + ' On a server, place the tile directory beside the application as sitrec-terrain/;'
                + ' in a container, mount it at /var/www/html/sitrec-terrain;'
                + ' or set SITREC_TERRAIN_URL to where the tiles are.'
                + ' scripts/download_local_tiles.js builds the directory. See docs/dev/CustomTerrainSources.md.');
        } else if (sameOrigin) {
            lines.push(`${name} source is served by this site, but the tile path does not exist: ${url}.`
                + ' Check the source\'s URL template and that the files are in place.');
        } else {
            lines.push(`${name} source's provider at ${host || 'the remote host'} has no tile at that address.`
                + ' Check the source\'s URL template ({z}/{x}/{y} order and file extension) and its maximum zoom;'
                + ' for a custom source that is the SITREC_CUSTOM_MAP_<NAME>_URL and _MAX_ZOOM settings.');
        }
    } else if (status === '401' || status === '403') {
        lines.push(`${name} source's provider refused the request (${status}): the source needs a key or token that is missing, blank or expired,`
            + ' or the provider does not allow this site\'s origin.');
    } else if (status) {
        lines.push(`${name} source's provider answered HTTP ${status}.`);
    } else if (/ServiceUnavailable/.test(message)) {
        lines.push(`Earlier requests to ${name} source failed, so it was marked unavailable for the rest of this session;`
            + ' the first failure, above in the console, says why. Fix that cause and reload the page.');
    } else if (/failed to fetch|networkerror|load failed|network request failed|err_/i.test(message)) {
        lines.push(`No answer from ${host || 'the tile host'}: there is no route to it from this network, or the provider blocks this origin.`
            + ' On an isolated network only the deployment\'s own sources are reachable; point the source at a mirror'
            + ' (SITREC_CUSTOM_MAP_<NAME>_URL, SITREC_CUSTOM_ELEVATION_<NAME>_URL, or SITREC_TERRAIN_URL).');
    }

    if (secureBuild) {
        lines.push('This is the secure build: the built-in internet providers are disabled at compile time,'
            + ' so the map can show only the sources this deployment defines. See docs/dev/Secure-Build.md.');
    }

    return lines.join(' ');
}

/**
 * A hint for a shared or saved situation (`?custom=<url>`) that failed to load.
 *
 * @param {Object} facts
 * @param {string} [facts.url]          the situation file's address
 * @param {number|string} [facts.status] the HTTP status, if there was a response
 * @param {string} [facts.errorMessage] the error's message when there was no response
 * @param {string} [facts.pageUrl]      the page's address (defaults to location.href)
 * @returns {string} one or more sentences, or ""
 */
export function customSitchLoadHint({ url, status, errorMessage, pageUrl } = {}) {
    const base = pageUrl || (typeof location !== 'undefined' ? location.href : undefined);
    const { host, sameOrigin } = hostOf(url || '', base);
    const code = String(status || '');
    const message = String(errorMessage || '');
    const inUploadDir = /\/sitrec-upload\//.test(url || '');

    if (code === '404') {
        if (inUploadDir) {
            return 'The file was saved into the server\'s own upload directory, and it is no longer there.'
                + ' In a container that directory is scratch: it is emptied when the container is replaced or restarted,'
                + ' so a link into it outlives the file. For saves that must persist, save to object storage (SAVE_TO_S3)'
                + ' or mount a volume at /var/www/html/sitrec-upload. Otherwise the link is stale or was mistyped.';
        }
        return `${sameOrigin ? 'This site' : (host || 'The remote host')} has no file at that address: the link is stale, was mistyped, or the file was deleted.`;
    }
    if (code === '401' || code === '403') {
        return `${sameOrigin ? 'This site' : (host || 'The remote host')} refused to serve the file (${code}).`
            + (sameOrigin ? ' Under client certificate authentication the request must carry the certificate; a link opened without it, or by a user the file does not belong to, is refused.' : '');
    }
    if (code) {
        return `${sameOrigin ? 'This site' : (host || 'The remote host')} answered HTTP ${code} for the file.`;
    }
    if (/failed to fetch|networkerror|load failed|network request failed|err_/i.test(message)) {
        return `No answer from ${host || 'the host in the link'}: there is no route to it from this network, or it does not allow this site to fetch from it.`
            + ' A hardened deployment loads situations only from its own origin.';
    }
    return '';
}
