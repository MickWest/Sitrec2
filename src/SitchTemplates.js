/**
 * Sitch templates: the labels, and the server calls that read and change them.
 *
 * A template is a saved sitch that has a template label. There are two labels:
 *   - "Global Template": every user sees it. It is on a shared server list
 *     (metadata/templates.json) that only an administrator can change.
 *   - "Local Template": only its owner sees it. It is a normal label in the
 *     owner's own label file (metadata/<userID>.json).
 *
 * The label is the only record that a sitch is a template. The sitch file does
 * not change when a sitch becomes a template or stops being one.
 */
import {SITREC_SERVER} from "./configUtils";
import {getEffectiveUserID, withTestUser} from "./Globals";

export const GLOBAL_TEMPLATE_LABEL = "Global Template";
export const LOCAL_TEMPLATE_LABEL = "Local Template";
export const GLOBAL_TEMPLATE_COLOR = "#12b5cb";
export const LOCAL_TEMPLATE_COLOR = "#7cb342";

export function isTemplateLabel(labelName) {
    return labelName === GLOBAL_TEMPLATE_LABEL || labelName === LOCAL_TEMPLATE_LABEL;
}

/**
 * The global templates, in the order the server stores them.
 * Needs no login. Throws if the server does not return a list.
 * @returns {Promise<Array<{name: string, userID: number, screenshotUrl: string, date: string}>>}
 */
export async function fetchGlobalTemplates() {
    const response = await fetch(SITREC_SERVER + "metadata.php?templates=1", {mode: "cors"});
    if (!response.ok) throw new Error(`template list returned ${response.status}`);
    const data = await response.json();
    // An answer with no list is not "no templates". The save check uses this list,
    // and it must not take a bad answer as permission to write.
    if (!Array.isArray(data?.sitches)) throw new Error("template list is not valid");
    return data.sitches;
}

/**
 * The current user's label file: {labels, sitchLabels, screenshotVersions}.
 * Throws if the server does not return it. A caller that writes the file back
 * must not continue after a failed read, because the write replaces the whole file.
 */
export async function fetchUserMetadata() {
    const response = await fetch(withTestUser(SITREC_SERVER + "metadata.php"), {mode: "cors"});
    if (!response.ok) throw new Error(`metadata.php returned ${response.status}`);
    const metadata = await response.json();
    if (!metadata || typeof metadata !== "object" || metadata.error) {
        throw new Error(metadata?.error || "metadata.php returned no metadata");
    }
    return metadata;
}

/**
 * The template labels that one of the current user's own sitches has.
 * An empty array means the name is not one of the user's templates.
 *
 * This asks the server each time. The answer decides if a save can write to
 * that name, and a label can change in a different tab.
 *
 * @param {string} name - sitch name
 * @returns {Promise<string[]>}
 */
export async function ownTemplateLabels(name) {
    const userID = getEffectiveUserID();
    if (!name || !(userID > 0)) return [];
    const [globalTemplates, metadata] = await Promise.all([fetchGlobalTemplates(), fetchUserMetadata()]);
    const labels = [];
    if (globalTemplates.some(entry => entry.name === name && Number(entry.userID) === Number(userID))) {
        labels.push(GLOBAL_TEMPLATE_LABEL);
    }
    const sitchLabels = metadata.sitchLabels;
    if (sitchLabels && !Array.isArray(sitchLabels) && sitchLabels[name]?.includes(LOCAL_TEMPLATE_LABEL)) {
        labels.push(LOCAL_TEMPLATE_LABEL);
    }
    return labels;
}

/**
 * The address of a sitch that opened from a template: "?template=<name>".
 * It has the name only, not a version, so it always opens the latest version.
 * @param {string} appAddress - the address of the app, with no query
 * @param {{name: string}} templateSource - Sit.templateSource
 * @returns {string}
 */
export function templateAddress(appAddress, templateSource) {
    return appAddress + "?template=" + encodeURIComponent(templateSource.name);
}

/**
 * Find the template with this name, for "?template=<name>".
 *
 * A global template comes first, because the address must open the same sitch
 * for every user. Then come the current user's own local templates. The name
 * must be exact.
 *
 * Throws if the server does not answer.
 * @param {string} name
 * @returns {Promise<?{name: string, userID: number}>} null when there is no template with this name
 */
export async function findTemplateByName(name) {
    if (!name) return null;
    const globalTemplates = await fetchGlobalTemplates();
    const globalTemplate = globalTemplates.find(entry => entry.name === name);
    if (globalTemplate) return {name, userID: Number(globalTemplate.userID)};

    const userID = getEffectiveUserID();
    if (!(userID > 0)) return null;
    const sitchLabels = (await fetchUserMetadata()).sitchLabels;
    const labels = (sitchLabels && !Array.isArray(sitchLabels)) ? sitchLabels[name] : null;
    // The template screen does not show a deleted template, so its address does not open it.
    if (Array.isArray(labels) && labels.includes(LOCAL_TEMPLATE_LABEL) && !labels.includes("Deleted")) {
        return {name, userID};
    }
    return null;
}

/**
 * Add entries to, and remove entries from, the global template list.
 * The server applies the change to its stored list. Administrators only.
 * @param {{add?: Array<{name: string, userID: number}>, remove?: Array<{name: string, userID: number}>}} change
 * @returns {Promise<void>}
 */
export async function updateGlobalTemplates({add = [], remove = []} = {}) {
    const response = await fetch(withTestUser(SITREC_SERVER + "metadata.php"), {
        method: "POST", mode: "cors",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({updateTemplates: true, add, remove}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
        throw new Error(data.error || `template list update returned ${response.status}`);
    }
}

/**
 * Give one of the current user's own sitches the "Local Template" label.
 * Reads the label file, adds the label, and writes the file back.
 * @param {string} name - sitch name
 * @returns {Promise<void>}
 */
export async function addLocalTemplateLabel(name) {
    const metadata = await fetchUserMetadata();
    const labels = Array.isArray(metadata.labels) ? metadata.labels : [];
    if (!labels.some(label => label.name === LOCAL_TEMPLATE_LABEL)) {
        labels.push({name: LOCAL_TEMPLATE_LABEL, color: LOCAL_TEMPLATE_COLOR});
    }
    const sitchLabels = (metadata.sitchLabels && !Array.isArray(metadata.sitchLabels)) ? metadata.sitchLabels : {};
    const current = sitchLabels[name] || [];
    if (current.includes(LOCAL_TEMPLATE_LABEL)) return;
    sitchLabels[name] = [...current, LOCAL_TEMPLATE_LABEL];

    const response = await fetch(withTestUser(SITREC_SERVER + "metadata.php"), {
        method: "POST", mode: "cors",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({...metadata, labels, sitchLabels, updateSitches: [name]}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
        throw new Error(data.error || `metadata.php returned ${response.status}`);
    }
}
