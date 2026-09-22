# Build the Mundane, Extreme, and Anomalies datasets

## Optional: build mundane_v1

`mundane_v1` uses **the same 300 target definitions as rock_v3**: 100 ordinary
balloons, 100 drones, and 100 weather balloons. It replaces the old platform
paths with the shared paths described below. Each target gets one platform
program, with 20 straight controls and 80 curved paths in each class. Target
sizes, winds, altitude distributions, and horizontal-range draws stay the same.

From the repository root, after `npm ci`, optionally run either or both:

```sh
npm run build-mundane-v1 -- --fps 1,10 --generic-names --out ..
npm run build-mundane-single-v1 -- --duration 120 --error 0.01 --fps 10 --generic-names --out ..
```

The full command creates `mundane_v1_1Hz` and `mundane_v1_10Hz`, each with
**18,900 scenarios**: 300 tracks × seven durations × nine pointing-error levels.
The single command creates `mundane_single_v1_120s_0.01deg_10Hz`, with **300
scenarios**. Together these add 38,100 scenarios and 190,500 CSV/sidecar files,
using about 12 GB of additional disk space.
Use `--fps 10` on the full command if only that rate is needed. Omit `--out ..`
to use `benchmarks/botbench/results`.

Every shorter clip is a centered subset of its 300-second master. The target
master is the original rock_v3 300-second track at 10 Hz; the 1 Hz version
subsamples it, preserving the balloon integration exactly. Unlike the old
rock_v3 clips, short mundane clips are centered windows rather than prefixes.
Platforms are at 7,000 m above the local ground plane. Ordinary balloons and
drones stay below them; weather balloons retain their original high-altitude
distribution and may be above them.

For a clean machine, use the setup recipe below and substitute these optional
commands, or add them beside the Extreme and Anomalies commands. The current
generator changes still need publication before a fresh public clone includes
them. All options in the parameter table apply to Mundane too.

## Extreme and Anomalies

Four Extreme/Anomalies selections are available for Sitrec's BOTBench and Track Browser:
**Extreme full**, **Anomalies full**, **Extreme single**, and **Anomalies single**.
All four use the same platform paths and generation rules. Full sets cover every
duration and pointing-error level. Single sets contain all target/platform
combinations at one chosen duration, error, and sample rate.

Extreme contains 20 target maneuvers across propeller drones, jet-powered drones,
fast aircraft, and hypersonic vehicles. Anomalies contains eight hypothetical
motions: high-g turns, acceleration and braking, sharp turns, a vertical drop,
erratic ping-pong motion, a vertical loop, a J-hook, and transmedium travel.

The generator creates CSVs, metadata, manifests, and a README with the exact
build command for each dataset. No existing dataset, README, or patch is needed
as an input.

## Build all four selections

From a checkout containing the current generator, install dependencies with
`npm ci`, then run these commands from the repository root. They place all
outputs beside the checkout. Single-set parameters are explicit even though
they are the defaults:

```sh
npm run build-extreme-full-v1 -- --fps 1,10 --generic-names --out ..
npm run build-anomalies-full-v1 -- --fps 1,10 --generic-names --out ..
npm run build-extreme-single-v1 -- --duration 120 --error 0.01 --fps 10 --generic-names --out ..
npm run build-anomalies-single-v1 -- --duration 120 --error 0.01 --fps 10 --generic-names --out ..
```

The full commands each produce two rate-specific folders; each single command
produces one. These four commands therefore create six folders:

| Output folder | Scenarios | Sample rate |
|---|---:|---:|
| `Extreme_full_v1_1Hz` | 12,600 | 1 Hz |
| `Extreme_full_v1_10Hz` | 12,600 | 10 Hz |
| `Anomalies_full_v1_1Hz` | 5,040 | 1 Hz |
| `Anomalies_full_v1_10Hz` | 5,040 | 10 Hz |
| `Extreme_single_v1_120s_0.01deg_10Hz` | 200 | 10 Hz |
| `Anomalies_single_v1_120s_0.01deg_10Hz` | 80 | 10 Hz |

Together these contain **35,560 scenarios** and **177,800 CSV/sidecar files**,
plus documentation and manifests. Allow roughly 11 GB for generated data,
plus space for the checkout, dependencies, and filesystem overhead.

Omit `--out ..` to write into `benchmarks/botbench/results` inside the checkout.
Single sets are generated directly; full sets do not need to exist first.
Matching settings and filename style produce identical CSVs and sidecars in a
single set and the corresponding cell of its full set.

## Clean-machine setup

Install **Git and Node.js 22 with npm** first. Use a POSIX shell on macOS, Linux,
or WSL, with an internet connection. No frontend build or server configuration
is required.

**Publication pending:** the current generator update must be committed and
pushed before this clean-machine recipe can build the datasets described here.
The older published generator uses different platform paths. After publication,
each generated dataset README will pin its source commit for exact reproduction.

Run from a directory where a new `tracksFolder` can be created. Its `sitrec`
subdirectory must not already exist:

```sh
set -eu
mkdir -p tracksFolder
cd tracksFolder
git clone --filter=blob:none https://github.com/MickWest/Sitrec2.git sitrec
cd sitrec
npm ci
npm run build-extreme-full-v1 -- --fps 1,10 --generic-names --out ..
npm run build-anomalies-full-v1 -- --fps 1,10 --generic-names --out ..
npm run build-extreme-single-v1 -- --duration 120 --error 0.01 --fps 10 --generic-names --out ..
npm run build-anomalies-single-v1 -- --duration 120 --error 0.01 --fps 10 --generic-names --out ..
```

Everything required comes from the repository and npm. The generated READMEs
are outputs of the source template, rather than prerequisites.

## Script parameters

Put options after npm's `--` separator. The same parameters apply to Mundane,
Extreme, and Anomalies:

| Option | Default | Meaning |
|---|---|---|
| `--fps` | Full: `1,10`; single: `10` | Full sets accept `1`, `10`, or `1,10`. Single sets accept one rate, `1` or `10`. Use a comma without spaces for both rates. |
| `--duration SECONDS` | Single: `120` | Single sets only. Any whole number from 20 through 300 seconds, cropped from the same 300-second master. Short crops can contain partial maneuvers. |
| `--error DEGREES` | Single: `0.01` | Single sets only. Any finite amplitude from 0 through 2 degrees; `0` gives clean bearings. This is the operator pointing deadband amplitude. |
| `--generic-names` | Off | Use numbered filenames such as `mundane001.csv`, `extreme001.csv`, and `anomaly001.csv`. Without it, Mundane retains rock_v3 class/index names; Extreme and Anomalies name the target and platform. |
| `--out DIRECTORY` | `benchmarks/botbench/results` in the checkout | Parent directory for dataset folders. Relative paths resolve from the current working directory. Quote paths containing spaces. |
| `--readme-only` | Off | Refresh existing datasets' READMEs and source provenance in their root manifests. Requires existing manifests; does not regenerate tracks. |

Supply each option once, with values separated by a space. Full sets use the
fixed duration/error grid; use a single-set command to choose one duration and
error. Platform paths are the default for all six commands, with no platform
selection flag or extra folder-name suffix. Seeds, target maneuvers, and
platform altitude are fixed in the source.

Both command types use `benchmarks/botbench/run-motion-full-v1.mjs`. The npm
targets supply `--set mundane_v1`, `--set Extreme_full_v1`, or `--set Anomalies_full_v1`, plus
`--single` for a single selection. An equivalent direct invocation is:

```sh
node benchmarks/botbench/run-motion-full-v1.mjs --set Extreme_full_v1 --single --duration 120 --error 0.01 --fps 10 --generic-names --out ..
```

## Other selections

Build the full sets at **10 Hz only**, along with the default single sets, to
produce exactly four output folders:

```sh
npm run build-extreme-full-v1 -- --fps 10 --generic-names --out ..
npm run build-anomalies-full-v1 -- --fps 10 --generic-names --out ..
npm run build-extreme-single-v1 -- --duration 120 --error 0.01 --fps 10 --generic-names --out ..
npm run build-anomalies-single-v1 -- --duration 120 --error 0.01 --fps 10 --generic-names --out ..
```

Build a **90-second Anomalies single set at 0.03 degrees and 1 Hz**:

```sh
npm run build-anomalies-single-v1 -- --duration 90 --error 0.03 --fps 1 --generic-names --out ..
```

This creates `Anomalies_single_v1_90s_0.03deg_1Hz`. A single selection can use
duration/error values between those in the full grid.

Build **300-second Extreme single tracks** at the default error and rate:

```sh
npm run build-extreme-single-v1 -- --duration 300 --error 0.01 --fps 10 --generic-names --out ..
```

The 120-second set is exactly seconds 90 through 210 of these 300-second tracks.
Relative CSV time starts at zero in each clip, while absolute timestamps and
corresponding target/platform positions and sightlines match.

Build into another parent folder, or omit `--generic-names` for descriptive names:

```sh
npm run build-extreme-single-v1 -- --duration 120 --error 0.01 --fps 10 --out "$HOME/Track Data"
```

Use a fresh output location for each example if the selected dataset already
exists.

## Platform paths and coverage

Extreme and Anomalies pair every target with ten platform programs: **two straight
controls and eight curved paths**. Mundane assigns one of these programs per
target, cycling through all ten by the target's index (1–100) within each class.
Each class uses every program ten times. In the central 120-second window, the curved paths are left/right
versions of a 60-degree bend, a 120-degree bend, a 60-then-120-degree turn, and a
120-then-60-degree turn. Paired turns continue in the same direction, with a
short straight section between them.

Initial headings, individual turn rates, and intermediate straight durations
are seeded. Curved segments are slower than the 3-degree/second standard rate.
There are no reversing doglegs or full-circle arcs. Each curved 300-second
master has an additional 60-degree turn before and after its central 120 seconds.
No individual arc exceeds 120 degrees, and total heading change over a master
is at most 300 degrees. The two straight controls remain straight.

**Every shorter track is a centered subset of the same 300-second track.**
Positions, speeds, turn rates, and timestamps are preserved. Longer clips reveal
further turns; shorter clips can contain partial bends. Every curved variant
includes a turn even in a 20-second clip. The 1 Hz samples are exact subsamples
of the 10 Hz version, including the pointing-error trace.

| Setting | Coverage |
|---|---|
| Full-set durations | 20, 40, 60, 120, 180, 240, and 300 seconds |
| Full-set pointing-error amplitudes | 0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, and 2 degrees |
| Single-set defaults | 120 seconds, 0.01 degrees, 10 Hz |
| Platform speed and altitude | 70 m/s; 7,000 m above the local ground plane |
| Wind | Extreme/Anomalies: zero. Mundane: rock_v3's original per-target winds; balloon targets drift with them. |
| Sample count | Duration × sample rate + 1, including both endpoints |

The duration/error grid matches `rock_v3`. Error values specify operator pointing
deadband amplitude, rather than Gaussian standard deviation or measured RMS
error. Field of view starts at 3 degrees and widens to four times the error
amplitude where needed. A 120-second clip has 121 samples at 1 Hz or 1,201 at
10 Hz.

Platforms generally look down. Weather balloons, large vertical excursions, and
high-altitude hypersonic paths can place targets above the platform. These are prescribed
synthetic trajectories in a flat local frame; Earth curvature, atmospheric
flight dynamics, and sensor slew limits are not simulated. Anomalies are
hypothetical motions, not evidence of reported events. Extreme and Anomalies peak
metrics are evaluated at 1,000 Hz; short events can be undersampled at 1 Hz. Transmedium
tracks retain underwater truth but omit underwater sightlines. Each generated
README gives the maneuvers and model limitations. Mundane preserves rock_v3's
ordinary motion models: wind-drifting balloons, rising weather balloons in
sheared and veering winds, and ground-referenced drone circles, racetracks, and
rounded squares. Balloon integrations use a fixed 10 Hz step at both output rates.

## Files and importing

Full datasets contain seven duration folders, each with nine error folders.
Single sets use the same layout with just the selected duration/error cell:

```text
Extreme_single_v1_120s_0.01deg_10Hz/
    README.md
    manifest.json
    timing.json
    batch_120sec/
        0.01deg/
            Input/extreme001.csv
            Truth/extreme001.csv
            All/extreme001.csv
            meta/extreme001.scenario.json
            meta/extreme001.truth.json
            manifest.json
            ...
```

`Input` holds platform positions and measured sightlines. `Truth` holds true
target positions. `All` combines input and truth. The `meta` sidecars describe
coordinates, timing, sensor settings, motion, and event windows. Manifests list
scenarios, paths, and file hashes. `timing.json` records generation time.

Generic names run from `extreme001` through `extreme200`, and from `anomaly001`
through `anomaly080`, within each duration/error cell. Mundane uses `mundane001`
through `mundane300`: 001–100 ordinary balloons, 101–200 drones, and 201–300
weather balloons. Without `--generic-names`, Mundane uses `balloon_001` through
`balloon_100`, `drone_001` through `drone_100`, and `weather_balloon_001` through
`weather_balloon_100`. The same number identifies
the same target/platform combination across full/single selections, durations,
errors, and rates. Keep enclosing folders to distinguish clips. Manifests and
sidecars retain identities even with generic filenames.

Descriptive filenames use target/platform names and role suffixes:
`.input.csv`, `.truth.csv`, and `.all.csv`.

Select the dataset root in BOTBench or Track Browser with **Recursive** enabled
so matching metadata is included. See [BOTBench](BOTBench.md) for analysis
controls and interpretation.

## Repeat builds and documentation refresh

Generation refuses to overwrite a nonempty selected dataset folder. Use another
`--out` location for a repeat build or after an interrupted run. There is no
overwrite or resume option.

To refresh documentation without regenerating tracks, use the same generator
revision that created the dataset:

```sh
npm run build-extreme-full-v1 -- --fps 1,10 --readme-only --out ..
npm run build-anomalies-full-v1 -- --fps 1,10 --readme-only --out ..
npm run build-extreme-single-v1 -- --duration 120 --error 0.01 --fps 10 --readme-only --out ..
npm run build-anomalies-single-v1 -- --duration 120 --error 0.01 --fps 10 --readme-only --out ..
```

Select only rates that exist. Filename style is read from each manifest, so
`--generic-names` is unnecessary for refreshes. Refresh updates source provenance
as well as the README; do not run it from unrelated or modified generator code.

Extreme and Anomalies record generator revision `motion-full-v1.1`, which distinguishes
the current shared platform paths from earlier v1 outputs. Mundane records
`mundane-v1.0`. Its documentation can also be refreshed by appending
`--readme-only` to either optional command at the start of this guide. Generation time in
`timing.json` naturally varies between runs.
