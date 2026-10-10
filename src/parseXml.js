import {xmlToObject} from "../tools/xml-wind/xmlObject.js";

// Parse an XML string into a nested JavaScript object (see xmlToObject for its shape).
export function parseXml(xml) {
    return xmlToObject(new DOMParser().parseFromString(xml, "text/xml"));
}
