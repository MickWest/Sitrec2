# Nimitz "Tic Tac" Encounter Reconstruction

**Physics → Scenarios → Nimitz** builds an interactive 4D reconstruction of the 14 November 2004
USS Nimitz "Tic Tac" encounter as **verbally described** by CDR David Fravor and
LT Alex Dietrich. It deliberately does **not** reconstruct the later FLIR1 video
(that was Chad Underwood's separate sortie, ~an hour later — see `data/flir1/`).

Use it from the **custom** sitch:

1. Physics → Scenarios → Nimitz → **Load Nimitz Encounter (Nov 14, 2004)** — sets the date/time
   (1430 PST), relocates the scene to the Event Summary merge coordinates, places
   the ships and CAP marker, configures both jets and the tic-tac, and puts the
   look camera in Fravor's cockpit aimed at the object.
2. **Tic-Tac Hypothesis** switches what the object actually does:
   - *Object Maneuvers (as described)* — hover/jitter, mirroring climb, sub-second
     departure to the CAP point (Hypothesis A below).
   - *Stationary Object (parallax)* — the object stays near the disturbance,
     drifting slowly; all apparent motion in the pilot POV is the jet's own
     (Hypothesis B below).
3. **View: Fravor POV / Dietrich POV / Overhead** buttons, or the standard Camera
   menu switches ("Fravor's Jet" / "Dietrich's Jet" appear as Position sources,
   "Look At Tic-Tac" as a Heading source, "Nimitz Pilot" as an FOV source).
4. **Load Compressed Variant (~1 min)** — the same encounter on the compressed
   timeline (Event Summary narrative shape / Dietrich's timing; see below).
5. Video → Scripting has two injected presentation scripts, **"Nimitz: As
   Described"** and **"Nimitz: Parallax"**, which play the encounter near-real-time
   with captions and camera moves under each hypothesis (render to MP4 with
   "Render Video (1080P60)").

Every default number in the simulation is sourced below. Where tellings conflict
the sim uses the *recommended default* and exposes the disagreement as a slider
range or preset; conflicts are catalogued in §5. Values are **never averaged
across tellings**.

---

## 1. How each number is used in the sim

t = 0 is the FASTEAGLE flight tallying the whitewater, anchored to **1430 local**
(PST, UTC−8) by the contemporaneous CVW-11 Event Summary: *"FAST EAGLES SPOTTED
LARGE UNID OBJECT IN WATER AT 1430L."* All node ids are prefixed `nimitz`.

| Sim parameter (GUI) | Default | What it drives | Source (see §4 table + §6 links) |
|---|---|---|---|
| scenario date/time | 2004-11-14 22:30 UTC | `GlobalDateTimeNode` — sun position, lighting | [ES] "AT 1430L"; deck logs zone "+8U" |
| Disturbance (Locations) | 30.8467, −117.7817 | anchor of the encounter frame; terrain relocation | [ES] contact coords "N3050.8 W11746.9" |
| USS Nimitz (Locations) | 31.4883, −117.8800 | ship model position | [ES] "NIMITZ N3129.3 W11752.8" |
| USS Princeton (Locations) | 31.473, −118.047 | ship model position | hypothesis only — no Princeton deck log exists |
| CAP Bearing / CAP Distance | 180° / 60 nm | CAP beacon position; tic-tac departure direction | 60 nm: Fravor 2019–2023 sworn; bearing UNRESOLVED (S/E/N all attested — conflict #3) |
| Start Altitude (Fravor) | 20,000 ft | both jets' arrival altitude | [HOC23 sworn] "arrived at the location at approximately 20,000 feet" |
| Jet Speed | 300 kn | both jets throughout | [ER] "max endurance profile at approximately 300 knots ground speed" |
| Circle Radius (Fravor) | 2.5 nm | descending-spiral radius | derived: ~5-min engagement at 20–25° bank (conflict #9; 0.5 nm in compressed variant per [TTSA-F] "about a mile across") |
| Turn Direction | Right (clockwise) | spiral direction | [HOC23] "As we started clockwise"; every Fravor telling |
| Descent Start | 60 s | when the spiral begins | ~a minute watching the jinking object; [TTSA-F] "between probably nine and ten, I started an easy descent" |
| Cut Across | 270 s | when Fravor abandons the spiral | ~360° of spiral (90° to mirror onset + 270° more) at the default circle |
| Cut Across Altitude | 15,000 ft | Fravor's altitude at the cut | [HOC23] "Our altitude at this point was about 15,000 feet" |
| Intercept Turn Rate | 6°/s | how hard he rolls out and pursues | assumption (no telling gives bank/airspeed for the cut — critic-flagged) |
| Dietrich Altitude | 20,000 ft | wing's high-cover orbit | [ER] FASTEAGLE 02 stayed high; Dietrich "20–25 kft" (weakly sourced — see gaps) |
| Tic-Tac Length | 40 ft | capsule size (2.25:1 length:diameter per [MB-9829] scale-model proportions) | [HOC23 sworn] "40-foot flying Tic Tac… That is correct"; range 25–47 (conflict #8) |
| Hover Altitude | 50 ft | object's low phase | [NYT17] "Hovering 50 feet above the churn" (alternates to 4,000 ft — conflict #11) |
| Erratic Motion Size | 100 ft | jitter amplitude (deterministic multi-sine) | modeling assumption scaled to the patch — "no source quantifies" |
| Mirror Rise Altitude | 12,000 ft | altitude the object climbs to while mirroring | [HOC23] "a Tic Tac was about 12,000" |
| Departure Range | 0.5 nm | separation that triggers the departure | [HOC23] "As we pulled nose onto the object within about a half mile of it" |
| Departure Accel / Top Speed | 500 g / 6,000 kn | Hypothesis A departure run | derived: gone-in-≤2-s + 60 nm in 30–60 s (Mach 5.5–11 average) |
| CAP Arrival Altitude | 24,000 ft | departure climbs to this by the CAP | [ER] "had climbed to approximately 24,000 feet" |
| Drift Speed / Bearing | 15 kn / 170° | Hypothesis B slow drift | ≤30 kt wind-drift bound; radar track group drifted ~south at ~100 kt aloft |
| Disturbance Size | 130 ft | whitewater disc diameter | [60M21] "roiling whitewater the size of a Boeing 737" (60×80 ft to 100 m — conflict #6) |
| Pilot View FOV | 45° | look-view FOV | presentation choice (human central vision ballpark) |

**Emergent (not parameterized) behavior:** the departure fires at *closest
approach* — when the mirroring geometry brings the object across Fravor's nose —
or when separation drops under Departure Range, whichever first. This keeps the
beat timing self-consistent for any circle size (the research critic flagged
that fixed beat times only work for one circle diameter). Fravor's cut-across is
pure pursuit: since the mirrored object is always diametrically opposite, aiming
at it is exactly steering at the circle center, until inside his own turn radius
where the chase becomes geometrically futile and he flies straight through.

**Whitewater vanish:** in Hypothesis A the disc disappears ~30 s after the
departure ([HOC23] "we immediately turned back… it was gone also"); in
Hypothesis B it persists (a transient sea-surface event decoupled from the
object). Alternate timings exist (conflict #7).

---

## 2. Reconciled timeline (default: Fravor's stable modern telling)

Citation keys: **[ES]** CVW-11 Event Summary 14 Nov 2004 (contemporaneous, leaked
2007, authenticity unverified) · **[ER]** 2009 Executive Summary (leaked 2018) ·
**[TTSA-PR]** TTSA Pilot Report · **[TTSA-F]** Fravor TTSA-era telling ·
**[FS15]** Chierici, FighterSweep 2015 · **[NYT17]** NY Times Dec 2017 ·
**[ABC17]** ABC Dec 2017 · **[CNN17]** CNN OutFront Dec 2017 · **[FPP19]**
Fighter Pilot Podcast 2019 · **[JRE19]** Joe Rogan #1361 · **[LEX20]** Lex
Fridman #122 · **[60M21]** 60 Minutes May 2021 · **[AD-TW]** Dietrich tweets ·
**[AD-MW]** West–Dietrich conversation Jun 2021 · **[HOC23]** House Oversight
hearing Jul 26 2023 (sworn) · **[SCU19]** SCU Forensic Analysis · **[MB-*]**
Metabunk threads. Full URLs in §6.

| t (s) | Clock | Beat | Detail + quotes |
|---|---|---|---|
| ~ −12,600 | ~11:00 | Radar context | Princeton (SPY-1) had seen intermittent groups of 5–10 slow tracks for ~2 weeks; on the 14th picks the group up ~11:00. Drift due south at ~100 kt; descents from above the scan volume to low altitude "in a matter of seconds" [ER]; tracks auto-dropped as clutter — *"never obtained an accurate track… quickly 'dropped'"* [ER]. |
| −1,200 | 1410 | Vector | [ES]: real-world vector to a contact at *"160°/40 NM"*, reported *"100 KTS @ 25KFT ASL"*. Fravor's tellings: *"a vector of 270, at about sixty miles"* [FPP19]; BRA *"two seven zero thirty twenty thousand"* [LEX20]. (Transit arithmetic doesn't close at 300 kn — one anchor is soft; conflict #4.) |
| −60 | ~1429 | Merge plot | [HOC23]: *"We arrived at the location at approximately 20,000 feet and the controller called merge plot"* — jets and contact in the same radar cell; nothing visual yet. |
| **0** | **1430** | Whitewater | [ES] *"SPOTTED LARGE UNID OBJECT IN WATER AT 1430L"*; [HOC23] *"we noticed some whitewater off our right side"*; [60M21] *"roiling whitewater the size of a Boeing 737"*; ~2 mi lateral / 20,000 ft [JRE19]. Sea otherwise *"calm, almost glassy smooth"* [FS15]. |
| +10–30 | 1430:10 | Tic tac tallied | [HOC23] *"white Tic Tac object with a longitudinal axis pointing north south and moving very abruptly over the water like a ping pong ball"*; just above the water (0–50 ft); *"Not fast just kind of left right forward and back"* [TTSA-F]; no wings, windows, seams, plume. |
| +60 | 1431 | Spiral begins | [TTSA-F] *"between probably nine and ten, I started an easy descent"*; [HOC23] *"my WSO and I decided to go down… the other aircraft staying in high cover."* Sim: smooth 20,000→15,000 ft descent over the next 210 s (~1,430 ft/min average). |
| +90–150 | ~1431:30 | Mirroring | [HOC23] *"about 90 degrees from the start of our descent… the object suddenly shifted its longitudinal axis, aligned it with my aircraft, and began to climb"*; [CNN17] *"the object started to mirror us… both in a clockwise flow opposite circles"*. Sim: the object's horizontal position is Fravor's reflected through the circle center; altitude ramps 50 → 12,000 ft between +60 and +270 (~3,400 ft/min average). |
| +270 | ~1434:30 | Cut across | [HOC23] *"Our altitude at this point was about 15,000 feet and a Tic Tac was about 12,000"*; [CNN17] *"I'm at about the 8:00 position and the tick tack is about two. I cut across the circle."* |
| ~+300 | ~1435 | Closest approach & departure | [HOC23] *"As we pulled nose onto the object within about a half mile of it"* — then it accelerates across the nose: *"rapidly accelerates to the south in about two seconds and disappears"* (Fravor YouTube telling; ≤1 s [FPP19/JRE19], ≤0.5 s [LEX20]). Alternates: climbs past their altitude [ABC17]; [ES] *"PILOT ESTIMATED THAT CAPSULE ACHIEVED 600-700 KTS… LOST VISUAL ID OF CAPSULE IN HAZE… AT 14KFT HEADING DUE EAST."* Dietrich: *"I only had visual of Tic Tac for 8-10 sec from high cover"* [AD-TW]; *"No acceleration"* (60 Min Overtime). In the sim the exact moment is emergent (closest approach), landing ~t+305 with default parameters. |
| +310–330 | ~1435:30 | Whitewater gone | [HOC23] *"we immediately turned back to see where the whitewater was at, and it was gone also."* ([ER] alternate: it ceased during the maneuver.) |
| +330–360 | ~1435:30–1436 | CAP call | Princeton, first *"picture clean"*, then: *"you're not going to believe this, its at your CAP"* [ER]. Blip at ~24,000 ft [ER]. Distance 60 mi ([HOC23] *"Roughly 60 miles away. In less than a minute"*; 40 mi in [NYT17]). Model as a NEW discrete blip, not a tracked transit — SPY-1 was auto-dropping these tracks ([MB-9190 #44], West: *"they saw a blip somewhere, then they saw a blip somewhere else"*). |
| +600… | ~1440+ | RTB | The flight swings through the CAP, sees nothing, completes the exercise, returns. Underwood's FLIR1 sortie launches ~1500L — out of scope. |

**Compressed variant** (second preset button): t=0 tally → object seen +10 s →
one aggressive descending turn on a ~1-nm circle (needs 60°+ bank — [TTSA-F]
*"about a mile across the circle"*) → departure inside the first minute. This
fits the [ES] narrative shape, Dietrich's 8–10 s visual, and her reading that
the whole documented engagement could fit in ~10 s [AD-MW]. Fravor's concession,
relayed by Dietrich: *"Could have been less but it was way more than a few
seconds"* [AD-TW].

---

## 3. Hypothesis parameter sets

### A — "Object maneuvers as described" (Fravor-literal)

- Low phase: 50 ft, jitter over the patch (instant reversals imply ~10–100 g
  spikes — derived from *assumed* jitter numbers, not testimony).
- Mirror: climbs 0→12,000 ft over ~3.5 min opposite Fravor on the circle
  (~200–300 kt on the default 5-nm circle; scales with circle size).
- Departure: impulsive. To shrink a 12-m object below ~1 arcmin visual acuity
  from 0.5 nm in ~2 s it must recede to roughly 25 nm — average >20,000 kn.
  The sim's 500 g / 6,000 kn defaults make it *effectively* gone in about a
  second and cover the 60 nm to the CAP in ~40 s (Mach ~8 average, within the
  30–60 s window of the tellings), arriving at 24,000 ft.
- CAP link: SAME object transits to the CAP.
- Whitewater: vanishes shortly after departure.

### B — Parallax / misperception (West, [MB-10941])

- The object is small, low, and slow (≤30 kt drift, default 15 kt at 170°) — its
  true size/distance unconstrained by the observations (size-distance ambiguity
  over a featureless ocean).
- "Mirroring" = parallax of a slow or level object seen from a descending,
  turning platform; at 20 kft / ~2 nm slant the described jitter subtends only
  arcminutes.
- "Departure" = geometric loss of a small object (sightline sweep during the
  cut-across + haze), not an impulse — matching [ABC17] "climbs past our
  altitude and disappears" and [ES]'s gradual haze fade at 600–700 kt estimated.
- CAP link: INDEPENDENT — a separate radar target/clutter re-association, *"2
  signals from the radar, not one object moving at Mach 5"* (Miller).
- Whitewater: transient surface event (bait ball, whale, shoal look) decoupled
  from the object.

**GUI difference between A and B** is one switch (`Tic-Tac Hypothesis`); the
departure/drift sliders only affect their own mode. The presentation scripts
flip the switch via the scripted `set` command.

### C — further presets worth adding (not yet implemented)

- **C1 Event-Summary-literal:** capsule at 4,000 ft, course 300°, passes *under*
  Fravor 5 nm west of the water patch, out-climbs/out-turns at 600–700 kt, lost
  in haze eastbound at 14 kft. The most contemporaneous record [ES].
- **C2 Kurth's F/A-18** [MB-11776]: the "mirroring" object is Douglas Kurth's
  returning Hornet at misjudged range (he was the first aircraft over the
  disturbance; needs a Kurth track to render).
- **C3 missile/target drone** [MB-11838]: wingless white cylinder transiting at
  500–700 kt; jitter = parallax.
- **C4 EW/radar-spoofing test** [MB-11733]: affects only the radar overlay/CAP
  blip, composable with B/C2/C3.

---

## 4. Full parameter evidence table

| Parameter | Default | Range / alternates | Source + quote | Confidence |
|---|---|---|---|---|
| Event date | 2004-11-14 | fixed | [ES] header; [AD-CNN] "november 14 2004" | High |
| Time zone | UTC−8 | fixed | Nimitz deck logs "+8U" (no DST after Oct 31) | High |
| Vector time | 1410L | fixed anchor | [ES] "(1410L)" | High |
| Whitewater tally | 1430L | 1425–1435 | [ES] "AT 1430L" (vs "late morning" [FS15] — conflict #1) | High |
| Nimitz position | 31.4883, −117.88 | — | [ES] "NIMITZ N3129.3 W11752.8" | Medium |
| Encounter position | 30.8467, −117.7817 | TTSA cluster 31.33, −117.17 (43 nm away — conflict #2) | [ES] "(N3050.8 W11746.9)" | Medium |
| Princeton position | 31.473, −118.047 | free 10–40 nm from Nimitz | no deck log ever located (SCU/Basterfield) | Low |
| CAP distance | 60 nm | 40–60 | [HOC23] "Roughly 60 miles"; [NYT17] "at least 40 miles" | Medium |
| CAP bearing | 180° | S/E/N attested (conflict #3) | TTSA "southern CAP point" | Low |
| Jets altitude | 20,000 ft | 10,000–24,000 | [ER]; [HOC23] | Med-High |
| Jets speed | 300 kn | 250–350 | [ER] "approximately 300 knots ground speed" | Med-High |
| Circle radius | 2.5 nm | 0.5 nm variant | derived from 5 min @ 20–25° bank; [TTSA-F] "about a mile across" (conflict #9) | Low |
| Descent start | +60 s | +10 s compressed | [TTSA-F] "easy descent" from 9–10 o'clock | Medium |
| Cut across | +270 s / 15,000 ft | +45 s compressed | [HOC23] "about 15,000 feet" | Medium |
| Object at cut | 12,000 ft | separation 2,000–3,000 ft | [HOC23] "about 12,000"; [CNN17] | Medium |
| Closest approach | 0.5 nm | 0.5–1.0 | [HOC23] "within about a half mile" | Medium |
| Vanish duration | ~2 s → sim ~1 s | 0.5–2 s; haze fade [ES] | [CNN17] "less than two seconds"; [LEX20] "less than a half second" (monotonic compression 2017→2020) | Medium |
| Departure direction | south (= CAP bearing) | up [ABC17]; east [ES] | [CNN17] "rapidly accelerated to the south" | Low-Med |
| Tic tac length | 40 ft | 25–47 | [HOC23 sworn]; [ES] 25–30; [ER] ~46; [TTSA-F] 47 (conflict #8) | Medium |
| Tic tac proportions | 2.25:1 length:diameter | — | candy proportions per [MB-9829] method (assumption — no width in any telling) | Low |
| Hover altitude | 50 ft | 0–50; 500–1,000 (Fravor's own WSO, [ER]); 1,000–3,000 [TTSA-PR]; 4,000 [ES] (conflict #11) | [NYT17] "Hovering 50 feet above the churn" | Medium |
| Jitter amplitude / speed | 100 ft / (multi-sine) | 50–150 ft, 20–60 kt | modeling assumptions — "no source quantifies" | Low |
| Tic tac axis (low) | N–S horizontal | — | [HOC23] "longitudinal axis pointing north south" | High |
| Mirror climb | 50→12,000 ft over +60…+270 | — | derived from beat altitudes ([HOC23]) | Medium |
| Engagement duration | ~300 s | 30–60 s compressed | [60M21] "roughly about five minutes" vs [AD-TW] "8-10 sec" (conflict #12) | Medium |
| CAP reacquisition delay | 30–60 s | to "couple of minutes" [SCU19] | [JRE19] "maybe 30 40 seconds"; [HOC23] "less than a minute" | Medium |
| CAP blip altitude | 24,000 ft | only figure given | [ER] "climbed to approximately 24,000 feet" | Medium |
| Disturbance size | 130 ft | 60×80 ft [TTSA-PR] – 100 m [ER Kurth] | [60M21] "size of a Boeing 737" (conflict #6) | Medium |
| Sea state | calm/glassy | — | [FS15]; [NYT17] "It was calm that day" | High |
| Weather/haze | haze bounds unresolved | "50 miles visibility" (Fravor) vs [ES] "LOST … IN HAZE" | conflict #13 | Low |

---

## 5. Conflicts between tellings (what the presets encode)

1. **Time of day:** [ES] 1410/1430L vs "late morning" [FS15] vs TTSA-PR "1230".
   NYT ("that November afternoon") and History.com ("about 2 p.m.") side with
   the log. Sim uses 1430L.
2. **Location, 43 nm apart:** [ES] N30°50.8′ W117°46.9′ vs the TTSA/AATIP/
   FighterSweep cluster near N31°20′ W117°10′. [ES] is also internally
   inconsistent by ~10 nm against its own "160@40NM". Sim defaults to the [ES]
   coordinates. (Sitrec's FLIR1 sitch sits between the two clusters.)
3. **CAP direction — all compass points attested:** S (TTSA + southbound
   departure), E (Miller; Domzh "EAST, NOT WEST"), N (Wonderer). No primary
   coordinates exist ("predetermined and secret" — SCU). Sim default S, slider
   exposed. Note [JRE19] also says the CAP was "40 miles south of the ship",
   which would put it nearly AT the merge point — unresolvable.
4. **Vector range/heading:** 60 mi @ 270 [FPP19] vs 30 mi countdown [LEX20] vs
   [ES] 160°/40 nm from the ship; and the 1410→1430 transit doesn't close at
   300 kn over 40–60 nm (would take 8–12 min, not ~19).
5. **Contact altitude on the radio call:** 25 kft [ES] / 20 kft [Fravor] /
   24 kft hover [FS15] / 15–20 kft [ER].
6. **Whitewater size/shape:** 737-sized cross (Fravor 2019+) vs 60×80 ft oval
   (Dietrich, TTSA-PR) vs 50–100 m round (Kurth) vs "MUCH LARGER THAN A
   SUBMARINE" [ES]. The cross first appears in 2019 podcasts; the 737 in 2015.
7. **Whitewater vanish timing:** after departure [HOC23] vs during the maneuver
   [ER] vs as the jets arrived (Kurth, [FS15]).
8. **Tic tac length:** 25–30 [ES] / 30–40 [TTSA-PR] / 40 sworn [HOC23] / 46
   [ER] / 47 [TTSA-F] — a 2× spread; no width given anywhere.
9. **Circle over-constraint:** "about a mile across" [TTSA-F] + "roughly 5
   minutes" + fighter speeds cannot coexist (1-nm circle at 250–300 kn needs
   >60° bank and ~40 s/lap). The sim honors duration+easy-bank by default
   (5-nm circle) and offers the 1-nm circle in the compressed variant.
10. **Orbit direction:** Fravor clockwise (every telling) — but Dietrich
    recalls a LEFT bank with the object at her 10 o'clock low [AD-MW]. The sim
    currently orbits both jets the same direction (future: independent wing
    direction).
11. **Low-phase altitude:** surface/50 ft (Fravor, NYT) vs 500–1,000 ft at
    ~500 kt level — *Fravor's own WSO* ([ER]: "His report differs from CDR
    Fravor") vs 1,000–3,000 ft [TTSA-PR] vs 4,000 ft [ES].
12. **Engagement duration (~30×):** "roughly about five minutes" (Fravor,
    2017–2021, escalating to "over five minutes" 2023) vs Dietrich "8-10 sec…
    Maybe his 'time dilation' made 2-3 min feel like 5" [AD-TW]; the sworn 2023
    telling gives no duration at all.
13. **Departure character:** instant vanish south (≤2 s → ≤0.5 s, compressing
    2017→2020) vs climbs past their altitude [ABC17] vs [ES] "COULD NOT KEEP UP
    WITH THE RATE OF TURN AND THE GAIN OF ALTITUDE… LOST VISUAL ID OF CAPSULE IN
    HAZE… HEADING DUE EAST" at an estimated 600–700 kt. Dietrich: "No
    acceleration."
14. **CAP reacquisition:** 40 mi [NYT17, SCU App. I] vs 60 mi [JRE19/HOC23];
    "seconds" vs "<1 min" vs "couple of minutes" [SCU19 main text]. The two
    earliest records ([ER], [FS15]) give **no** distance or time — the speed
    claim first appears Dec 2017.
15. **Blip vs track:** Kevin Day's tracked-transit telling (and the 0.78-s
    descent figure, first appearing in his fictionalized 2008/09 anthology
    story) vs [ER] "never obtained an accurate track… quickly 'dropped'" — the
    Entropy-paper g-figures derive from Day's number, not independent data.
    Sim models the CAP reacquisition as a new discrete blip.
16. **Document provenance:** [ES] leaked 2007, authenticity unverified (SCU
    treated an unredacted copy as legitimate); [ER] anonymous, leaked 2018;
    Princeton's 2004 deck logs were never located.

### Known gaps / future work (from the research completeness critic)

- Dietrich's altitude and orbit direction are weakly sourced; her "8–10 s
  visual from high cover" geometry has not been validated in-sim.
- No winds-aloft data pulled for 14 Nov 2004 (NKX radiosonde would bound the
  Hypothesis-B drift and the 100-kt radar-track drift claim).
- C1/C2/C3 hypothesis presets (Event-Summary-literal, Kurth's jet, missile) are
  documented but not implemented; C2 needs a Kurth track.
- The Event Summary places the capsule 5 nm WEST of the water patch — the sim
  currently co-locates them.
- Jim Slaight (Fravor's WSO) has no usable primary telling integrated.
- Ship models are LCS placeholders scaled to length (no CVN-68/CG-59 models in
  `data/models/`).

---

## 6. Sources

**Primary / contemporaneous documents**
- CVW-11 Event Summary, 14 Nov 2004 (leaked 2007): http://www.nicap.org/reports2/2004_Navy%20event%20document%202004%20Nov%2014.pdf (transcription: https://thenimitzencounters.com/unofficial-cvw-11-air-wing-11-event-summary-of-nov-14-2004/)
- 2009 "Executive Summary" (leaked 2018): https://thenimitzencounters.com/uss-nimitz-uap-executive-summary-report/ (scan: https://www.documentcloud.org/documents/20743466-nimitz-unredacted/)
- Nimitz deck logs Nov 2004 (FOIA): https://thenimitzencounters.com/wp/wp-content/uploads/2018/10/CVN-68-Deck-Logs-November-2004.pdf
- TTSA Pilot Report: https://coi.tothestarsacademy.com/nimitz-report/
- House Oversight hearing 26 Jul 2023, official transcript (sworn): https://www.govinfo.gov/content/pkg/CHRG-118hhrg53022/html/CHRG-118hhrg53022.htm — Fravor written statement: https://oversight.house.gov/wp-content/uploads/2023/07/David-Fravor-Statement-for-House-Oversight-Committee.pdf

**Fravor tellings (chronological)**
- Chierici, "There I Was: The X-Files Edition", FighterSweep, Mar 2015 (earliest): https://fightersweep.com/1460/x-files-edition/
- NY Times, Dec 16 2017: https://www.nytimes.com/2017/12/16/us/politics/unidentified-flying-object-navy.html
- ABC News, Dec 2017: https://abcnews.com/US/navy-pilot-recalls-encounter-ufo-unlike/story?id=51856514
- CNN OutFront, Dec 19 2017 (transcript): http://transcripts.cnn.com/TRANSCRIPTS/1712/19/ebo.01.html
- Fighter Pilot Podcast, Jan 2019 (transcript): https://www.ufojoe.net/fravor-technology-not-developed-on-this-planet/?p=620/
- Joe Rogan Experience #1361, Oct 2019 (transcript): https://podscribe.app/feeds/http-joeroganexpjoeroganlibsynprocom-rss/episodes/d9e17c921e16426f9a7ed615813e6b65
- Lex Fridman #122, Sep 2020 (transcript): https://podcasts.happyscribe.com/lex-fridman-podcast-artificial-intelligence-ai/122-david-fravor-ufos-aliens-fighter-jets-and-aerospace-engineering
- 60 Minutes, May 16 2021: https://www.cbsnews.com/news/navy-ufo-sighting-60-minutes-2021-05-16/

**Dietrich tellings**
- "8-10 sec from high cover" tweet: https://twitter.com/DietrichVFA41/status/1404527229636382722 (and the relayed Fravor "roughly 5 minutes" text: https://twitter.com/DietrichVFA41/status/1404526369141399559)
- Mick West – Alex Dietrich conversation, Jun 15 2021: https://www.youtube.com/watch?v=uwZU6RiTEAw
- AC360, May 2021: https://www.youtube.com/watch?v=EBXR4fds2DE
- Tales From the Rabbit Hole #57, Aug 2023: https://www.youtube.com/watch?v=lyDaYcCbtrs

**Metabunk analysis**
- Parallax / comparing accounts (core Hypothesis-B thread): https://www.metabunk.org/threads/fravors-hypersonic-ufo-observation-parallax-illusion-comparing-accounts.10941/
- FLIR1 mega-thread (blip critique #44; deck-log posts by Wonderer #574/#584): https://www.metabunk.org/threads/2004-uss-nimitz-tic-tac-ufo-flir-footage-flir1.9190/
- Kevin Day's recollections: https://www.metabunk.org/threads/kevin-days-recollections-of-the-nimitz-encounters.11616/
- Kurth's-jet hypothesis: https://www.metabunk.org/threads/hypothesis-fravors-tic-tac-was-kurths-fa18.11776/
- Missile hypothesis: https://www.metabunk.org/threads/nimitz-tic-tac-fravor-dietrich-encounter-missile-hypothesis.11838/
- Radar-spoofing-test hypothesis: https://www.metabunk.org/threads/were-fravor-and-co-in-the-middle-of-a-test-of-radar-spoofing-tech.11733/
- Tic-tac scale models (proportions method): https://www.metabunk.org/threads/how-big-is-a-tic-tac-scale-models-of-the-nimitz-incident.9829/
- "Antennas" = compression artifacts: https://www.metabunk.org/threads/claim-navy-flir1-video-seems-to-show-tic-tac-antennas.12398/
- Thread index: https://www.metabunk.org/tags/nimitz/

**Secondary analysis**
- Parabunk (Executive-Report excerpts + cross-account tables): http://parabunk.blogspot.com/2018/05/the-2004-uss-nimitz-tic-tac-ufo.html
- Peter Miller, Medium (two-radar-signals reading): https://medium.com/@tgof137/the-nimitz-tic-tac-ufo-incident-a3ad5d748ccb
- SCU Forensic Analysis (270 pp): https://www.explorescu.org/post/2004-uss-nimitz-strike-navy-group-incident-report
- Knuth/Powell/Reali, Entropy 2019 (kinematics derived from Day's figures): https://www.mdpi.com/1099-4300/21/10/939
- Kurth interviews (Basterfield): https://ufos-scientificresearch.blogspot.com/2021/05/former-lt-col-douglas-kurth-speaks-out.html
- Popular Mechanics witness roundup: https://www.popularmechanics.com/military/research/a29771548/navy-ufo-witnesses-tell-truth/
- The Nimitz Encounters (Beaty documentary + documents index): https://thenimitzencounters.com/
