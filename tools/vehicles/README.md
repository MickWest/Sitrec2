# Vehicle Designer

Open **Sitrec → Extra Tools → Vehicle Designer**, or `tools/vehicles/index.html`
on a built Sitrec site. It fills the browser window, with collapsible parameter
folders on the left and a Three.js preview on the right. On narrow screens the
preview sits above the controls. The fullscreen button hides browser chrome where supported.

Choose one of 292 presets, then drag sliders or type exact values. Slider `input`
events update the mesh on the next animation frame, including during a drag.
Edits preserve the camera; **Fit** (or **F**) frames the new shape. Drag to orbit,
scroll to zoom, and right-drag to pan. The presets use approximate proportions
inspired by common vehicles, not manufacturer engineering geometry. Filter by vehicle
type or region, or search a name. The previous/next buttons cycle through the filtered
results, with wrapping. Left/right arrow keys (or [ and ]) also cycle when you are
not editing a control. Selecting an entry previews it immediately.

Folders cover the fuselage, cockpit glazing, wings, tail and canards, engines and propellers, and
livery and details. Winglets, biplanes, support struts, T-tails, V-tails, twin fins,
canards, unpowered gliders, and one to eight engines are supported. Wing tips can
be straight, blended/sharklet, split, fences, or raked. The tip size is vertical
height for winglets and horizontal extension per side for raked tips. Wing sweep is
leading-edge sweep. The **Main wing span** parameter excludes winglets; the
**Wingspan** readout includes them. The fuselage length excludes protruding parts.
Wing area and aspect ratio describe the main wing's tapered or cranked planform,
including the section through the body, excluding canards, tip extensions and a second wing.

**Cockpit glazing → Position** slides the windshield or canopy along the nose;
smaller values move it forward. Position and length are percentages of the nose
length, so they scale with the airframe. Width changes how far the glazing wraps
around the fuselage. Side setback, pane count and pillar width shape a paneled
windshield; canopy rise shapes a bubble canopy. Automatic uses a canopy for
gliders and jets with no cabin windows, a crown windshield for light aircraft,
and a six-pane front-and-side windscreen for other aircraft. The airliner layout
has two front, two sliding side and two aft panes. A separate four-pane layout
serves the 787 and A220 presets. The pane count follows the selected airliner
layout. A dark cockpit surround is available for the A350, A330neo and A220.
Those panes share a continuous wraparound outline; pillar width controls the thin
gaps between them without separating the front and side window bands.
Both styles stay attached to the fuselage as their position changes. The new
controls also save with the design; older parameter files receive suitable defaults.

## Cars, trucks and civil helicopters

The catalog adds 36 generic road classes and 15 civil helicopter families. Cars
include hatchbacks, sedans, wagons, sports cars, SUVs, taxis and patrol cars.
Trucks include pickups, vans, ambulances, box trucks, flatbeds, tippers, tankers,
tractors, fire/refuse trucks, buses and coaches. These are generic classes, not
named production vehicles. Road controls cover cabin proportions, conforming
windows, pillars, wheelbase, axles, tire size, steering, cargo bodies, tipper lift,
roof equipment and paint. Dimensions and wheelbase readouts update live.

Civil helicopter presets include R22/R44/R66, Bell 206/407/505, H125/130/135/145/160,
AW109/139, S-76 and S-92 families. The Airbus H130/H135/H145/H160 use enclosed tail
rotors. The military catalog also includes single, coaxial, tandem and tiltrotor
layouts. Rotor diameter and fuselage length are separate: neither is the full
turning-rotor envelope. Fuselage/glazing proportions remain family approximations.

## Drones, balloons and sky lanterns

**Drones** includes the existing fixed-wing drones and 29 multirotor examples:
DJI Mini, Air, Mavic, Phantom, Inspire, Neo, Avata, FPV, Matrice and Agras families;
Autel EVO, Parrot ANAFI, Skydio, Yuneec and Freefly; and generic FPV, hexacopter
and octocopter layouts. Body profile, motor spacing, propeller diameter, blade count,
coaxial pairs, guards, camera pitch/yaw, antennas, payload and gear are editable.
The frame expands when larger propellers need more clearance. Dimensions describe
the generated model, not a verified reproduction of the manufacturer's airframe.
The reference readout includes the swept rotor envelope; live overall dimensions
use the current blade positions. Status LEDs have editable visual defaults.

**Balloons & sky lanterns** adds 22 examples: hot-air and gas balloons, weather
and pilot balloons, latex party balloons, round/star/heart foil balloons, blimps,
a tethered aerostat, a solar tube, and round, square and tapered paper lanterns.
Change envelope dimensions, panel count, bulge, colors, rainbow/striped/checker
patterns, metallic finish, opacity, basket, radiosonde, gondola, fins and tether.
Lanterns have open lower rims, support frames, a flame and adjustable warm glow;
**Night** shows that glow clearly. Balloon models have no aircraft navigation lights.
These are visual models; lift, buoyancy and heating are not simulated.

The former `tools/aircraft/` URL redirects to `tools/vehicles/`, retaining query
parameters and fragments. Existing saved aircraft and vehicle files still open.

## Adaptive SITREC livery

In **SITREC livery**, select **SITREC · globe & lettering**. It applies a white and
blue identity with original SITREC lettering and a latitude/longitude globe.
Body markings fit airliners and helicopter cabins; slender jets and flying wings
use the wing surfaces. Road markings fit the lower body or cargo box. Fin globes
follow the fin surface. Drone markings fit the battery deck, and balloon markings
follow the envelope or inflated foil surface. Marking scale and blue color are editable. The identity
stays selected while cycling presets; Reset preset restores the original paint.
Artwork is mesh geometry, so GLB exports need no external font or texture files.

## Procedural vehicle lights

The **Lights** folder controls position lights, landing lights/headlights, beacons,
aircraft strobes, taxi lights, beam angle, aim, intensity, flash timing and road
indicators. **Night** changes the preview lighting, and **Flash lights** animates
beacons/strobes/indicators. Switching the procedural lights off leaves unlit lenses.

The implementation was compared with the repository's `PA28.glb` and
`B737Max8.glb` assets and Sitrec's light importer. Exports contain
`KHR_lights_punctual` point/spot lights and `strobeEvery`/`strobeLength` extras;
Sitrec detects these and creates its normal Lights controls. Landing beams point
forward with an adjustable downward angle. Only the vehicle lights are exported.
Preview light output is reduced for the studio; the exported intensities are
editable visual defaults, not calibrated photometry.

Aircraft use red port, green starboard and white rear position lights following
the [FAA night operations handbook](https://www.faa.gov/sites/faa.gov/files/regulations_policies/handbooks_manuals/aviation/airplane_handbook/12_afh_ch11.pdf).
Transport defaults use wing-root landing lights, light aircraft/helicopters use
nose lights, and fighters use nose-gear lights when their gear is extended. These
are family defaults, not a claim about the exact lamp fit of every variant.
Helicopter position lights attach to the cabin rather than rotating blades.
Road vehicles use headlights, red tail lights and selectable amber indicators;
service presets can add flashing roof lamps. See [reference review](ReferenceReview.md)
for the source coverage and remaining geometry limits.

## Boeing and Airbus presets

There are 39 airliner presets plus 15 regional, propeller, light and special
configurations. The selector groups airliners by manufacturer and family:

| Family | Variants |
| --- | --- |
| Boeing 737 NG | -700, -800, -900ER; an additional -800 paint-reference preset |
| Boeing 737 MAX | 7, 8, 9, 10, with split tips |
| Boeing 747 | -400 and -8 Intercontinental, with short upper decks |
| Boeing 757 | -200 and -300, original tips |
| Boeing 767 | -200ER, -300ER, -400ER |
| Boeing 777 / 777X | -200ER, -200LR, -300ER, -9 with tips extended |
| Boeing 787 | -8, -9, -10 |
| Airbus A220 | -100, -300 |
| Airbus A320 family | A319/A320/A321 ceo with fences, and neo with sharklets |
| Airbus A330 | -200, -300, -800neo, -900neo |
| Airbus A340 | -300, -600 |
| Airbus A350 | -900, -1000 |
| Airbus A380 | -800, full double deck |

Each airliner displays its **preset reference** length/span, configuration notes
and a manufacturer source link. These are the original preset targets; edited
dimensions appear in the live preview metrics. Stretches preserve the physical
nose and tail sections rather than stretching the entire airframe. The generated
airliner length and span are checked against those targets (span within 0.10 m,
including the thickness of the tips). Other contours, engine shapes, door
positions and window counts remain visual approximations, not engineering data.
Window counts do not represent a particular airline seating plan.

Airframe controls include an upper-deck hump and its length. Upper-deck window
start/end, count and level are independent, allowing a short 747 deck or a full
A380 deck. Door arrangements include overwing exits and four/five doors per side.
Landing gear remains a simplified generic layout. The 777-9 is shown with tips
extended; the presets do not simulate a folding mechanism. Published design
dimensions do not imply certification or service status.

Research checked September 24, 2026: [Boeing 737 NG](https://www.boeing.com/commercial/737ng),
[737 MAX](https://www.boeing.com/commercial/737max), [777](https://www.boeing.com/commercial/777),
[777X](https://www.boeing.com/commercial/777x), [787](https://www.boeing.com/commercial/787),
and the dimension drawings in [Boeing's airport planning manuals](https://www.boeing.com/commercial/airports/plan-manuals)
for the 747/757/767. Airbus dimensions and configurations come from its
[aircraft characteristics manuals](https://www.aircraft.airbus.com/en/customer-care/fleet-wide-care/airport-operations-and-aircraft-characteristics/aircraft-characteristics)
and individual model specifications linked in the selector. The 757/767 use the
plan-view overall lengths in their manuals. A320ceo presets use the original
34.10 m fence configuration; neo presets use the 35.80 m sharklet configuration.

## Military aircraft presets

The catalog includes 136 military presets in addition to the 54 civil and general
presets. Search by aircraft name or role, then filter by region. Region groups
refer to design families or the named operator scheme, not exclusive ownership.
The set covers modern and Cold War families; it is not an inventory of every
historical aircraft, subvariant or current fleet. Demonstrators are named as such.

| Region | Presets | Main families |
| --- | ---: | --- |
| US | 42 | F-14/15/16/18/22/35, F-4/5, A-10, B-1/2/52, C-5/17/130, KC-135/46, E-2/3/7, P-3/8, U-2, T-6/38, H-1/47/53/60/64, V-22, MQ-9, RQ-4 |
| Europe | 24 | Typhoon, Rafale, Mirage 2000, Gripen, Tornado, Harrier, Jaguar, A400M, C295, C-27J, A330 MRTT, Atlantique, GlobalEye, Hawk, M-346, PC-21, Tiger, NH90, H225M, AW101/159, nEUROn |
| China | 24 | J-7/8/10/11/15/16/20, JH-7, JF-17, H-6K, Y-8/9/20, YY-20, KJ-200/500, L-15, K-8, Z-8/10/19/20, Wing Loong II, CH-4 |
| Iran | 16 | F-14/4/5, MiG-29, Su-24, Saeqeh, Kowsar, C-130, P-3, Yak-130, Yasin, PC-7, CH-47, AH-1J, Shahed 129, Mohajer-6 |
| Russia / Soviet-origin | 30 | MiG-21/23/29/31, Su-24/25/27/30/33/34/35/57, Tu-22M/95/160, Il-76/78, A-50, An-12/26/124, Yak-130, Mi-8/24/26/28, Ka-27/52, Orion, S-70 |

Antonov presets identify their Ukrainian design origin in their notes. Iranian
imported types reuse the appropriate family geometry with generic colors, not
a verified unit livery or a claim about present serviceability.

The reference panel links to manufacturer pages, museum collections, operator
publications, or public photographic references. **Approximate dimensions · visual
reference** means the linked source supports identification/proportions, but does
not establish an engineering dimension sheet for that exact variant. Even where
length and span are published, body cross-sections, pane contours, cabin-window
counts and component placements are visual estimates. Reference dimensions stay
fixed while the live readouts show edits. Helicopters state fuselage length and
one main rotor diameter separately; neither is the overall turning-rotor envelope.

Additional editable geometry includes:

- Framed single and tandem canopies; tall transport and helicopter windscreens
  with two, four, six or eight panes, upper cockpit windows, and lower navigator glazing.
- Round portholes, rectangular cabin windows and shortened cabin rows. Drones
  have no cockpit or cabin windows. The H-6K uses a solid nose, while the Il-76
  includes lower nose glazing. The Su-34 has a wide side-by-side flight deck.
- Single, coaxial, tandem and tilting rotors. **Tiltrotor forward tilt** changes
  the nacelles and rotor axes live. Main wings can be disabled for helicopters.
- Flying wings, root extensions, four-fin tails, twin booms, integrated exhausts,
  chin/side/dorsal intakes, paired engine pods and contra-rotating propellers.
- Dorsal radar discs/beams, under-nose sensor turrets, tanker booms and skid gear.

Research and representative photo/drawing review: September 24, 2026. Examples
include [Boeing B-52 dimensions and eight-engine layout](https://www.boeing.com/defense/fighters-and-bombers/b-52),
[Lockheed Martin C-130 photographs](https://www.lockheedmartin.com/en-us/products/c130.html),
[Dassault Rafale imagery](https://www.dassault-aviation.com/en/defense/rafale/),
[Airbus A400M brochure, dimension drawing on pages 24–25](https://image.contactad.airbus.com/lib/fe2d1171756404747c1678/m/1/7f52cf78-0b6e-49b2-8028-4cc0b85158bd.pdf),
[AVIC-supplied Wing Loong II photograph](https://www.ecns.cn/2017/02-28/247122.shtml),
[Iran Press Yasin unveiling photograph](https://iranpress.ir/content/14903/iran-army-unveils-yasin-jet-trainer),
[Ka-52 photographs by Fedor Leukhin](https://commons.wikimedia.org/wiki/File:Russian_Air_Force_Kamov_Ka-52_(19009439283).jpg),
and [UAC's aircraft catalog](https://uacrussia.ru/en/aircraft/lineup/military/).
These are reference links; photographs are not bundled or used as textures.

Variable-sweep aircraft start with wings forward; the sweep slider changes the
procedural planform rather than simulating a real pivot mechanism. Tiltrotors
have a true geometric tilt control. Air intakes, exhausts, landing gear, sensor
fairings and helicopter fuselages are simplified. Separate stepped cockpit tubs,
exact camouflage, markings, folding blades/wings and external stores are not
modeled. Flying-wing area is an approximate planform area. No aerodynamic or
operational performance is simulated.

## 737-800 paint reference

The **737-800 · British Airways reference** preset follows the supplied visual
reference with a lowered radome, a low six-pane windscreen, a cranked main wing,
blended winglets, fuller tail, flattened nacelles, cabin window rows, doors and
overwing exits. The generated envelope is 39.47 m long and about 35.78 m across
the winglets, consistent with the rounded 39.5 m / 35.8 m dimensions in
[Boeing's 737NG specifications](https://www.boeing.com/commercial/737ng).
The screenshot supplies the visual reference; pane contours and paint markings
are hand-built procedural approximations. They are not manufacturer geometry or
official airline artwork. The red/navy ribbons and wordmark use mesh geometry,
so they export without fonts or texture files. Cabin window size, vertical level,
start/end positions and count remain editable.

The generator permits unusual combinations; it does not check structural
feasibility, aerodynamics, or component interference. The geometry is intended
for visual reconstruction and prototyping. Glazing is opaque and there is no
interior. Procedural lights include exportable point and spot lights as described below.

- **Save design / Open** round-trip a versioned `.vehicle.json` parameter file. Legacy `.aircraft.json` files still open.
  The last design also restores from browser storage when available. Preset
  selection replaces the current parameters; save a design before switching if
  you want to retain it. **Reset preset** restores the selected built-in preset.
- **Export GLB** downloads only the vehicle, including materials, vehicle lights and parameter
  metadata. The grid, camera, studio lights and preview effects are excluded.
  Coordinates are metres, +Y up, +Z forward, +X port. The filename includes the
  actual model length as `~L…m~` for Sitrec's model import. Load it via
  **File → Import File** or drop the GLB into Sitrec.
- **Snapshot** saves the current 3D view as a PNG, excluding the control panel.
- **Spin rotors / props** (or **Spin wheels**) animates the relevant assemblies; GLB exports retain their static design pose.

There are no runtime network services or CDN dependencies. The normal webpack
build copies these files and a matching Three.js renderer, OrbitControls and
GLTFExporter from the installed dependency. The resulting `tools/vehicles/`
folder can also be hosted on its own static web server. Open it over HTTP(S), not
`file://`, so browser module loading works. The import map versions the complete
module graph, and the bundled dependency includes its license.
