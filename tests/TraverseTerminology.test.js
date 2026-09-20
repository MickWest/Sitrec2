/** @jest-environment jsdom */
import {explainTraverseTerms, explainTraverseHTML, traverseGlossaryHTML} from "../src/TraverseTerminology";
import {windComparisonHTML} from "../src/TraverseWindPresentation";
import {assembleTraverseReport} from "../src/TraverseReport";

test("wind headers explain fixed, independently fitted and corrected wind", () => {
    const h = {key: "lantern", name: "Balloon (supplied wind)", windMode: "supplied", track: [1],
        errDeg: 0.01, params: {}, windSamples: [{u: 0, v: 0}]};
    document.body.innerHTML = windComparisonHTML([h], {}, {interactive: true});
    const headers = [...document.querySelectorAll("th")];
    expect(headers.map(h => h.textContent)).toEqual(["Interpretation", "Supplied wind", "Fitted wind", "Supplied + correction"]);
    expect(headers[1].title).toContain("held fixed");
    expect(headers[2].title).toContain("independently of the supplied wind");
    expect(headers[3].title).toContain("horizontal vector adjustment");
    for (const header of headers) {
        expect(header.tabIndex).toBe(0);
        expect(header.getAttribute("scope")).toBe("col");
        expect(header.getAttribute("aria-label")).toContain(header.title);
    }
    const button = document.querySelector("[data-wind-hypothesis] button");
    const handler = jest.fn();
    button.addEventListener("click", handler);
    explainTraverseTerms(document.body);
    const los = button.querySelector('[data-traverse-term="LOS"]');
    expect(los.title).toContain("Line of sight");
    los.click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(button.closest("td").dataset.windHypothesis).toBe("0");
});

test("annotation preserves markup, text and existing specific help without nesting", () => {
    document.body.innerHTML = '<h3>Mean LOS error</h3><p>LOS from a &lt;fake&gt; sensor: 4 kt. CAS/FW and geodetic altitude.</p>'
        + '<button title="Select this result">Horizontal air speed</button><span title="Specific score calculation">BOT Score</span>'
        + '<a href="/LOS">LOS</a><pre>LOS code</pre><script type="application/json">{"label":"LOS"}</script>';
    const textBefore = document.body.textContent;
    const used = explainTraverseTerms(document.body);
    expect(document.body.textContent).toBe(textBefore);
    expect(document.querySelector("fake")).toBeNull();
    expect(document.querySelector("h3 abbr").dataset.traverseTerm).toBe("Mean LOS error");
    expect(document.querySelector("h3 abbr").tabIndex).toBe(0);
    expect(document.querySelector("button abbr").hasAttribute("tabindex")).toBe(false);
    expect(document.querySelector("a").getAttribute("href")).toBe("/LOS");
    expect(document.querySelector('span[title="Specific score calculation"]').innerHTML).toBe("BOT Score");
    expect(document.querySelectorAll("pre abbr, script abbr")).toHaveLength(0);
    expect(document.querySelectorAll('[data-traverse-term="FROM"]')).toHaveLength(0);
    expect(used).toEqual(new Set(["Mean LOS error", "LOS", "kt", "CAS/FW", "Geodetic", "Horizontal air speed"]));
    const once = document.body.innerHTML;
    explainTraverseTerms(document.body);
    expect(document.body.innerHTML).toBe(once);
});

test("static report tooltips and the printable glossary contain only terms actually used", () => {
    const used = new Set();
    expect(explainTraverseHTML('<p>6 NM; NM is distance.</p>', used)).toContain('title="Nautical mile: exactly 1,852 meters.');
    const glossary = traverseGlossaryHTML(used);
    expect(glossary.match(/<dt>/g)).toHaveLength(1);
    expect(glossary).not.toContain("Kalman");
    const html = assembleTraverseReport({title: "Example", generated: "test", metaHTML: "", summaryHTML: '<p>Fitted wind has a prior.</p>',
        sections: [{id: "details", title: "Details", html: '<p>Slant range: 6 NM</p>'}]});
    const report = new DOMParser().parseFromString(html, "text/html");
    expect(report.querySelector('#summary [data-traverse-term="Fitted wind"]').title).toContain("not an independent weather measurement");
    expect(report.querySelector('nav a[href="#terminology"]')).not.toBeNull();
    const definitions = [...report.querySelectorAll("#terminology dt")].map(n => n.textContent);
    expect(definitions.sort()).toEqual(["Fitted wind", "NM", "Prior", "Slant range"].sort());
    expect(report.querySelectorAll("#terminology .traverse-term")).toHaveLength(0);
    expect(html).toContain("@media print");
});
