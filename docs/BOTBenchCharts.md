# BOTBench Result Charts

Interactive charts of a BOTBench result set, and the same figures exported for a
paper. Open them from **File → File Analysis → Result Charts...**.

The charts answer questions a table of numbers cannot: how accuracy changes with
clip length, how it decays along the pointing-error ladder, what the executive
verdict actually concluded, and how much the blind ranking cost against the best
candidate it had on offer.

## Getting data in

The window needs one row per analysed scenario. There are two ways to give it
some.

**Drop a joined results file on the window**, or use **Load JSONL…**. This is a
JSON Lines file with one flattened result per line, the format the offline
pipeline writes. Each line carries the analysis result together with the
generation-side inputs it is being judged against, so the charts can group by
target class, clip length and pointing-error rung.

**Open it from a finished BOTBench run.** The rows are adapted from the run in
memory. A little less is available this way, because the offline pipeline joins
against the scenario generator's manifest and the app only has the file, its
result and its truth sidecar. A figure that needs a field that is missing simply
leaves those rows out rather than drawing something wrong.

## The figures

| Figure | What it shows |
|---|---|
| Error by clip length | The blind top candidate's error against clip length, one panel per target class and pointing-error rung |
| Error by pointing error | The same error against the pointing-error ladder, one panel per class and clip length |
| Within tolerance, by length | Share of tracks inside 5% and 1% of true range, against clip length, with exact 95% intervals |
| Within tolerance, by pointing error | The same shares against the pointing-error rung |
| Error against geometry | Error against parallax aperture and against true range, with a median trend line over equal-count bins |
| What the verdict says about the class | True class viable, only other classes viable, or nothing viable |
| Verdict code | The executive verdict by rung, ordered by how far it narrows the answer |
| First-ranked hypothesis | Which hypothesis family the ranking placed first without seeing truth |
| Cost of blind ranking | The chosen candidate against the candidate that was closest to truth |

Every figure carries its own caption, and every number in that caption is
computed from the rows on screen rather than written in by hand.

## How to read a box

The boxes are drawn from statistics computed before the chart is built, not by
the charting library, because two conventions here are deliberate.

**Quartiles and the median come from the raw values.** The median of an even
count is the mean of the two middle values.

**The whiskers use Tukey's rule applied in log space.** The fence is 1.5 box
heights beyond the quartiles, but measured on the base-10 logarithm rather than
on the raw values, so that it is symmetric on the log axis it is drawn on. A
whisker reaches the last observation still inside that fence, never the fence
itself. Computing the fence on raw values instead would put the lower whisker
almost on the box and the upper one far away, which tells the reader nothing.

**Every observation is drawn as a dot**, jittered sideways so they do not stack.
Because every point is already there, no separate outlier marks are drawn. A
hollow dot means the top candidate came from the range-blind polynomial family.

**A drawing floor is applied only when drawing.** Values below the floor are
drawn at it so the axis stays readable, and each caption says how many were
moved. The statistics behind the box never see the floor.

## Confidence intervals

The within-tolerance figures use exact Clopper-Pearson intervals at 95%. They
are conservative by construction, meaning their true coverage is at least 95%
and usually a little more. They are wider than the score intervals often used
for the same job, which is the price of never overstating certainty on a small
count. A track whose top candidate has no range at all counts as outside the
tolerance rather than being dropped.

## Exporting for a paper

**Export SVG** gives vector output with the text still text, which is what a
journal wants and what lets a typesetter restyle labels.

**Export PNG** gives a raster at three times the layout size, about 4500 pixels
wide, which is past 300 dpi for a full-page figure.

Both run in the browser you already have open. Neither needs any extra tool.

## The command-line renderer

Optional, for producing the figures unattended, in a build or across several
result sets at once.

```bash
npm run bot-charts -- --input <joined-results.jsonl> --out-dir <dir> --format both --index
```

| Option | Meaning |
|---|---|
| `--input <file>` | The joined results JSONL. Required. |
| `--out-dir <dir>` | Where images go. Defaults to a folder beside the notes. |
| `--format svg\|png\|both` | Defaults to SVG. |
| `--scale <n>` | PNG pixel multiplier, default 3. |
| `--only <keys>` | Comma-separated figure keys. Defaults to all. |
| `--index` | Also write an `index.html` showing every figure. |
| `--list` | Print the figure keys and exit. |

This path drives a headless browser, because Plotly has no server-side
renderer: its only static export routes are a real browser or a Python tool that
itself requires one. The browser it uses is the Playwright Chromium the
repository already installs for its regression tests, so there is no new
dependency, but it does make the command-line path slower and heavier than the
in-app export. **Prefer the in-app export unless a script has to do the work.**

## Where the code lives

| File | Role |
|---|---|
| `src/analysis/charts/ChartStats.js` | The statistics: quantiles, box statistics, Clopper-Pearson intervals, equal-count binning. No charting library, no DOM. |
| `src/analysis/charts/RockV3ChartSpecs.js` | Each figure as a plain specification object. No charting library import. |
| `src/analysis/charts/PlotlyLoader.js` | Fetches the charting library on first use, so nothing is downloaded until a chart is opened. |
| `src/analysis/charts/RockV3ChartsUI.js` | The window, the data adapters and the export buttons. |
| `benchmarks/botbench/render-charts.mjs` | The command-line renderer. |

The specifications are plain data with no library import, which is what lets the
app, the export and the command-line tool all draw the same figure from one
definition.

The charting library is loaded on demand as its own download of about 1.5 MB. It
is not part of the main application bundle, so a session that never opens a
chart never pays for it.

## Checking the numbers

These figures were ported from a reference implementation that used a different
language and a different plotting library, and that reference is kept so the two
can be compared. The port is checked two ways.

A unit test pins the statistics to the reference libraries: quantiles against
numpy's default method, and Clopper-Pearson intervals against scipy, to nine
decimal places.

A parity probe rebuilds every figure from a real result set and compares the
medians, within-tolerance counts, class outcome tallies, ranking-cost counts and
binned trends against the numbers the reference run produced. It compares
meaning rather than pixels, since the two libraries will never draw identically
and that was never the goal.
