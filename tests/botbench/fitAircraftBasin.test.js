/**
 * P2 regression: fitAircraft must find the better basin on bb-2af6154e.
 *
 * With the pre-P2 defaults (3 deterministic runs, pop 60 / gens 150) every
 * run converged on a cost-13.69 basin while a ~9.97 basin existed inside the
 * same bounds (found at pop 120 / gens 300 — denser search, not more
 * restarts). The adaptive escalation is expected to trigger here (the best
 * default-run cost is mediocre-but-not-hopeless) and land the fit below
 * 10.5. If this fails, either the escalation trigger or its budget has
 * regressed — a finite-but-wrong fixed-wing candidate mis-ranks the whole
 * gallery for aircraft-like scenes.
 */
import {setSit} from "../../src/Globals";
import {buildAllScenarioEntries} from "../../benchmarks/botbench/lib/blocks";
import {generateAllScenarios} from "../../benchmarks/botbench/lib/runner";
import {toTraverseDataset} from "../../benchmarks/botbench/lib/adapters";
import {fitAircraft, fitPlausibleBestRange} from "../../src/TraverseAnalysis";

const TARGET_ID = "bb-2af6154e";

// Noisy RECOVERABLE-NOISE bird cells whose pure-smoothness solutions dive to
// the ~120 m soft range floor: the floor penalty, not the data, builds their
// low wall, and P1's gate briefly certified that as geometry (forced-slow,
// ~0.5 NM on multi-NM truths). The floorActive guard must route them to the
// speed prior.
const FLOOR_SHAPED_IDS = [
    // Floor-shaped CENTERS: the certified solutions themselves ran at
    // 113-118 m minimum range.
    "bb-3ef7abf1", "bb-e72e8c1f", "bb-521474a5",
    // Floor-BUILT WALLS around floor-free centers: the low wall at ~424 m
    // exists only under the floor penalty (score 3.77 with, 1.19 without),
    // certifying geometry at the 926 m bracket edge for a 5,590 m truth.
    "bb-a0e148d4", "bb-fb134139", "bb-519dab17",
];

let scenarios = null;
beforeAll(() => {
    setSit({name: "botbench", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
    scenarios = generateAllScenarios(buildAllScenarioEntries());
});

const findScenario = (id) => scenarios.find(
    (sc) => sc.scenarioId === id || sc.id === id) ?? null;

test("fitAircraft escalation finds the better basin on bb-2af6154e (P2)", async () => {
    const scenario = findScenario(TARGET_ID);
    expect(scenario).not.toBeNull();

    const fit = await fitAircraft(toTraverseDataset(scenario), {});
    // The wrong basin is 13.69; the known better basin is ~9.97-10.0.
    expect(fit.cost).toBeLessThan(10.5);
    expect(fit.escalated).toBe(true);
}, 600000);

test("floor-shaped valleys defer to the speed prior (P1 guard)", () => {
    for (const id of FLOOR_SHAPED_IDS) {
        const scenario = findScenario(id);
        expect(scenario).not.toBeNull();
        const fit = fitPlausibleBestRange(toTraverseDataset(scenario), {});
        expect(fit.usedSpeedTarget).toBe(true);
    }
}, 600000);

test("the floor guard does not depend on where rangeMin sits (P1 guard)", () => {
    // Review defeated a bracket-edge proxy gate by simply moving rangeMin:
    // at rangeMin=400 the same false valley sat "interior" (553 m for a
    // 5,590 m truth) and geometry was certified 90% low. The
    // descent-through-the-wall test is setting-independent — the cell must
    // defer to the prior at ANY bracket.
    const scenario = findScenario("bb-a0e148d4");
    expect(scenario).not.toBeNull();
    const fit = fitPlausibleBestRange(toTraverseDataset(scenario), {rangeMin: 400});
    expect(fit.usedSpeedTarget).toBe(true);
}, 600000);
