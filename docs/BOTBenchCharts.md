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

**Open it from a finished BOTBench run** with the **Charts** button. The rows are
built from the run itself: the clip length, the target class, the class outcome
and the parallax aperture all come from the analysis and the file name, so no
sidecar is needed for them.

The one thing that does need a sidecar is the pointing error. It is declared in
the scenario sidecar, and the analysed CSV does not carry it. In the interchange
layout the sidecars sit in a `meta` folder beside `All`, so choosing `All` on its
own leaves them behind. The charts still draw, and say the pointing error is
unstated. Choose the folder above `All`, with Recursive on, to pair them.

## The figures

Which figures appear depends on the rows. A run over one folder is a single cell,
one clip length at one pointing error, so it is compared across target classes.
A set that spans several rungs or clip lengths is compared along them instead, and
never pooled into a by-class figure that would mix its rungs together.

A figure with one panel per clip length uses the lengths it was designed around
(20 s and 120 s) when the set has them, and otherwise the lengths the set does
have. So a sweep of the pointing-error ladder at one clip length still gets its
rung figures. The figures that compare clip lengths need at least two.

| Figure | What it shows |
|---|---|
| Error by target class | One cell: the blind top candidate's error, one box per target class |
| Within tolerance, by target class | One cell: the share inside 5% and 1% of true range, with exact 95% intervals |
| What the verdict says, by target class | One cell: true class viable, only other classes viable, or nothing viable |
| Verdict code, by target class | One cell: the executive verdict mix per class |
| First-ranked hypothesis, by target class | One cell: which hypothesis family the ranking placed first |
| Error by clip length | The blind top candidate's error against clip length, one panel per target class and pointing-error rung |
| Error by pointing error | The same error against the pointing-error ladder, one panel per class and clip length |
| Error by clip length, per sensor turn | Median error against clip length, one line per sensor-turn level, with quartile bars. A flat line means a longer clip does not help at that amount of turn |
| Error by sensor turn, per clip length | The same medians against the turn level, one line per clip length |
| Within tolerance, by length | Share of tracks inside 5% and 1% of true range, against clip length, with exact 95% intervals |
| Within tolerance, by pointing error | The same shares against the pointing-error rung |
| Error by solver | Every candidate's error against truth, one box per solver, for each class and pointing-error rung, whether or not the ranking chose it |
| Error against geometry | Error against parallax aperture and against true range, with a median trend line over equal-count bins |
| What the verdict says about the class | True class viable, only other classes viable, or nothing viable |
| Verdict code | The executive verdict by rung, ordered by how far it narrows the answer |
| First-ranked hypothesis | Which hypothesis family the ranking placed first without seeing truth |
| Cost of blind ranking | The chosen candidate against the candidate that was closest to truth |

Every figure carries its own caption, and every number in that caption is
computed from the rows on screen rather than written in by hand.

Every error/range axis is labelled in powers of ten, one label per decade.

Hovering a dot that stands for one track names the track by its path under the
folder that was scanned, so files with the same name in different folders can be
told apart. Rows loaded from a JSONL file give the file name only. When the run made a
scenario screenshot for it (**Scenario screenshots** in BOTBench), the screenshot
shows beside the label. Rows loaded from a JSONL file have no screenshots.

Two choices above the figure apply to every error figure at once:

- **Candidate** picks whose error is plotted: the candidate the blind ranking put
  first (the default), the candidate closest to truth, which is an oracle pick, or
  any one solver's candidate on every track.
- **Error** picks the unit: the mean 3D error as a share of the mean true range (the
  default), the same distance in metres, the mean angle between the candidate and
  the truth as seen from the sensor, the mean 2D heading error in degrees, or the
  mean 3D velocity error in metres per second. The two motion units compare the
  tracks frame by frame: velocities are the differences between consecutive
  positions times the frame rate, the velocity error is the mean magnitude of the
  3D velocity difference, and the heading error is the mean absolute difference
  between the two horizontal headings, 0 to 180 degrees, over the frames where both
  tracks move faster than 0.5 m/s across the ground (a slower track has no heading).
  A range error along the sightline scales a track's speed with its distance, so the
  velocity error carries the range error; the heading error does not, which makes it
  a comparison of shape alone. The heading error is bounded, so its figures use a
  fixed linear axis from 0 to 180 degrees in steps of 25, with the box whiskers
  computed on the values themselves; the other units use a log axis that the data
  sets, with a drawing floor.

The tolerance figures always use a share of range, for the chosen candidate. The
solver figure already shows every candidate, so only the unit applies to it. The
cost of blind ranking compares the chosen candidate with the best one, so it is not
drawn when the best candidate is the choice. A solver's own error, the angle and the
two motion units come from the candidate lists a BOTBench run keeps, so rows loaded
from a JSONL file offer the top and best candidates only, in a share of range or in
metres. A run cached before these units existed rebuilds its rows once, from the
stored fits, to add them.

**Turn level** appears above the figure when the rows hold more than one
sensor-turn level, as rock_v3 does. Choosing one level limits every figure to it,
and the figure's title and exported file name say which level it shows. The two
sensor-turn figures always use every level, since comparing the levels is their
purpose. A row's level comes from its answer key, so rows loaded from a JSONL file
have none.

Two check boxes mark the dots in every figure that draws one dot per track. Both
start off, when every dot is a circle of one size in its target class color.

- **Area by clip length** gives each dot an area in proportion to its clip length.
  The scale is set once from all the rows, so a 300 s dot has 15 times the area of
  a 20 s dot in every figure, and the middle clip length keeps the usual size.
- **Straight as black squares** draws a track whose sensor flew straight as a
  black square: its turn level is 0, or, without a level, its sensor turned less
  than 1 degree. A square has the same area as the circle it replaces, so only
  the shape and color change. Tracks that turned keep their circles.

A caption says which marks are on.

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

The solver figure also has a **drawing ceiling**: a thousand times the mean true
range, 10,000 km in metres, or 180 degrees. A candidate past it is drawn at the
ceiling, the caption counts it, and its hover label gives the value itself. So one
runaway fit cannot stretch the axis to 10^59.

## Confidence intervals

The within-tolerance figures use exact Clopper-Pearson intervals at 95%. They
are conservative by construction, meaning their true coverage is at least 95%
and usually a little more. They are wider than the score intervals often used
for the same job, which is the price of never overstating certainty on a small
count. A track whose top candidate has no range at all counts as outside the
tolerance rather than being dropped.

## Full size

**Full size** shows the figure on its own, drawn to fill the browser window.
The panels grow with the window and the caption re-wraps to its width; the
title, legend and caption keep their size. The toolbar keeps only the choices
the figure reads: the candidate and the unit on the error figures, the
candidate alone on the tolerance figures (which always use a share of range),
the sensor-turn level on the figures that take one, and the dot marks on the
figures whose points are tracks. The figure picker and the file loader are
hidden until **Exit full size**. Resizing the window redraws the figure, and
the exports are unchanged: they still render at the figure's own layout size.

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
| `--turn <deg>` | Limit the figures to one sensor-turn level, as the window's Turn level does; the sensor-turn figures always use every level. |
| `--marks area,straight` | The dot marks: area by clip length, straight tracks as black squares. |
| `--suffix <text>` | Added to every file name, so variants of one figure can sit side by side. |
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
| `src/analysis/charts/PlotlyLoader.js` | Loads the charting library from `libs/` on first use, so nothing is downloaded until a chart is opened. |
| `src/analysis/charts/BotBenchChartRows.js` | Builds chart rows from a finished run or a JSONL file, including the parallax aperture measured from the run's own positions. No DOM. |
| `src/analysis/charts/RockV3ChartsUI.js` | The window and the export buttons. |
| `benchmarks/botbench/render-charts.mjs` | The command-line renderer. |

The specifications are plain data with no library import, which is what lets the
app, the export and the command-line tool all draw the same figure from one
definition.

The charting library is loaded on demand as its own download of about 1.5 MB. It
is not part of the main application bundle, so a session that never opens a
chart never pays for it. The build copies it to `libs/plotly-cartesian-<version>.min.js`,
a name that carries only the library's version. So a page that was already open
when Sitrec was rebuilt or updated can still open its charts; only an upgrade of
the charting library changes the name.

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
