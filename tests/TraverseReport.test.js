/** @jest-environment jsdom */
jest.mock("three/addons/lines/LineMaterial.js", () => ({LineMaterial: class {}}), {virtual: true});
jest.mock("three/addons/lines/LineGeometry.js", () => ({LineGeometry: class {}}), {virtual: true});
jest.mock("three/addons/lines/Line2.js", () => ({Line2: class {}}), {virtual: true});
import {assembleTraverseReport, constantAirReportCases} from "../src/TraverseReport";
import {buildTraverseReportHTML} from "../src/AnalyzeTraverse";

test("CAS report keeps the two wind searches and their selected candidates separate", () => {
    const supplied = {key: "constAir", windMode: "supplied", track: [1], params: {range: 2214, regime: "slow"}};
    const fitted = {key: "constAir", windMode: "fitted", track: [2], params: {range: 222}};
    const sweep = {best: {startDist: 200}}, sweepFreeWind = {best: {startDist: 222}};
    const cases = constantAirReportCases({hypotheses: [fitted, supplied], sweep, sweepFreeWind});
    expect(cases.map(c => c.short)).toEqual(["CAS/SW", "CAS/FW"]);
    expect(cases[0].hypothesis).toBe(supplied);
    expect(cases[0].hypothesis.params.range).toBe(2214);
    expect(cases[0].sweep).toBe(sweep);
    expect(cases[1].hypothesis).toBe(fitted);
    expect(cases[1].sweep).toBe(sweepFreeWind);
    const older = constantAirReportCases({hypotheses: [fitted, supplied], sweep});
    expect(older[1].hypothesis).toBe(fitted);
    expect(older[1].sweep).toBeUndefined(); // never reuse the supplied-wind grid
});

test("a partial run gets a complete navigable report without requiring CAS or aircraft", () => {
    const n = 10, S = new Float64Array(n * 3), D = new Float64Array(n * 3), W = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) D[f * 3 + 1] = 1;
    const html = buildTraverseReportHTML({sitName: "Partial run", dataset: {n, fps: 2, S, D, W},
        hypotheses: [], windText: "calm", speedTarget: 10, failures: [{method: "Aircraft", error: "Unavailable"}]});
    document.documentElement.innerHTML = html;
    expect(document.querySelector('#summary').textContent).toContain('Unavailable');
    expect(document.querySelector('#cas-searches').textContent).toContain('No constant-air-speed search was run');
    expect(document.querySelector('#candidate-details')).not.toBeNull();
    expect(document.querySelector('#inputs')).not.toBeNull();
    expect(document.querySelector('#audit')).not.toBeNull();
});

test("the standalone report leads with findings and provides valid static anchor links", () => {
    const html = assembleTraverseReport({title: 'Example <scene>', generated: 'test', metaHTML: '<p>Input</p>',
        summaryHTML: '<p>Finding</p>', sections: [{id: 'wind', title: 'Wind', html: '<p>Result</p>'},
            {id: 'details', title: 'Candidate details', html: '<p>More</p>'}], manifest: {label: '</script><script>bad()</script>'}});
    document.documentElement.innerHTML = html;
    expect(document.querySelector('h1').textContent).toContain('Example <scene>');
    expect(document.querySelector('main > section').id).toBe('summary');
    const links = [...document.querySelectorAll('nav a')];
    expect(links.map(a => a.getAttribute('href'))).toEqual(['#summary', '#wind', '#details']);
    for (const a of links) expect(document.querySelector(a.getAttribute('href'))).not.toBeNull();
    expect(JSON.parse(document.querySelector('#run-manifest').textContent).label).toContain('</script>');
    expect(document.querySelectorAll('script')).toHaveLength(2);
    expect(html).not.toMatch(/grid-template-columns|column-count|columns:\s*\d/);
    expect(html).toContain('@media print');
    expect(html).toContain('display:table-header-group');
    expect(html).toContain('Print / Save PDF');
});
