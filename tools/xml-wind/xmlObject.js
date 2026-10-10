// xmlObject.js — Turn a parsed XML Document into the nested object that Sitrec's
// track-file handlers read, so the analyzer sees a file exactly as Sitrec does.
//
// SHARED: Sitrec's parseXml() (src/parseXml.js) is DOMParser plus this, and the XML
// Wind Profile Analyzer runs it in the page. A tool is served unbundled, so this file
// imports nothing.
//
// Each element becomes an object whose keys are its attributes (string values),
// its child elements (an object, or an array of objects when a tag repeats) and
// "#text". Comments and processing instructions leave an empty object and no text.

const TEXT_NODE = 3;

/**
 * @param {Document} document
 * @returns {Object}
 */
export function xmlToObject(document) {
    function visitNode(node, parentObject) {
        if (node.nodeType === TEXT_NODE) {
            if (node.nodeValue.trim()) {
                parentObject["#text"] = node.nodeValue;
            }
            return;
        }

        const entry = {};
        if (node.attributes) {
            for (let i = 0; i < node.attributes.length; i++) {
                entry[node.attributes[i].name] = node.attributes[i].value;
            }
        }
        for (let i = 0; i < node.childNodes.length; i++) {
            visitNode(node.childNodes[i], entry);
        }

        const tag = node.nodeName;
        const previous = parentObject[tag];
        if (previous === undefined) {
            parentObject[tag] = entry;
        } else if (Array.isArray(previous)) {
            previous.push(entry);
        } else {
            parentObject[tag] = [previous, entry];
        }
    }

    const result = {};
    for (let i = 0; i < document.childNodes.length; i++) {
        visitNode(document.childNodes[i], result);
    }
    return result;
}
