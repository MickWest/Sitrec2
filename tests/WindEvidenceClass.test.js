/** @jest-environment jsdom */
// What kind of evidence the loaded wind is, in the traverse balloon wind comparison.
// A source read from sounding profiles is an observation only if every profile is one;
// a profile from an XML weather file is a model unless its layout says it is measured.
jest.mock("three/addons/lines/LineMaterial.js", () => ({LineMaterial: class {}}), {virtual: true});
jest.mock("three/addons/lines/LineGeometry.js", () => ({LineGeometry: class {}}), {virtual: true});
jest.mock("three/addons/lines/Line2.js", () => ({Line2: class {}}), {virtual: true});
import {windSourceEvidenceClass} from "../src/AnalyzeTraverse";

const radiosonde = {evidenceClass: "observation"};
const xmlModel = {evidenceClass: "model"};
const xmlMeasured = {evidenceClass: "observation"};

test("a sounding source is an observation when every profile it reads is one", () => {
    expect(windSourceEvidenceClass({source: "uwyo"}, {profiles: [radiosonde, radiosonde]})).toBe("observation");
    expect(windSourceEvidenceClass({source: "track:TrackData_wx"}, {profiles: [xmlMeasured]})).toBe("observation");
});

test("an XML profile that is not declared measured makes the source a model", () => {
    expect(windSourceEvidenceClass({source: "track:TrackData_wx"}, {profiles: [xmlModel]})).toBe("model");
    expect(windSourceEvidenceClass({source: "manual-soundings"}, {profiles: [radiosonde, xmlModel]})).toBe("model");
});

test("other sources keep their own class", () => {
    expect(windSourceEvidenceClass({source: "gfs"}, null)).toBe("model");
    expect(windSourceEvidenceClass({source: "openmeteo"}, null)).toBe("model");
    expect(windSourceEvidenceClass({source: "custom"}, null)).toBe("model");
    expect(windSourceEvidenceClass({source: "manual"}, null)).toBe("assumption");
    expect(windSourceEvidenceClass({source: "track:TrackData_N12345"}, null)).toBe("unknown");
});
