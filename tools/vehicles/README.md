# Custom Object Designer

The Custom Object Designer builds 3D models of aircraft, helicopters, drones,
cars, trucks, balloons, sky lanterns, kites and birds from presets and sliders.
Put a model on a Sitrec object, or export it as a GLB (binary glTF) 3D model
file. The models are procedural: code generates them from a set of parameters.
They are visual models, and they do not simulate flight or lift. The one
exception is a kite: its design has flight values that **Add Kite** in Sitrec
uses (see [Kites](#kites)). A bird beats its wings at the rate in its design
(see [Birds](#birds)).

This tool was named Vehicle Designer. Its address, `tools/vehicles/`, its design
files and its saved designs are not changed.

## Standalone editor

Open **Sitrec → Extra Tools → Custom Object Designer**, or `tools/vehicles/index.html`
on a built Sitrec site. It fills the browser window, with collapsible parameter
folders on the left and a Three.js preview on the right. On narrow screens the
preview sits above the controls. The fullscreen button hides browser chrome where supported.

Choose one of 347 presets, then drag sliders or type exact values. The model
updates live, including during a drag. Edits preserve the camera; **Fit** (or **F**) frames the new shape. Drag to orbit,
scroll to zoom, and right-drag to pan. The presets use approximate proportions
inspired by common vehicles, not manufacturer engineering geometry. Filter by object
type or region, or search a name. The previous/next buttons cycle through the filtered
results, with wrapping. Left/right arrow keys (or [ and ]) also cycle when you are
not editing a control. Selecting an entry previews it immediately.

Aircraft folders are **Airframe**, **Cockpit glazing**, **Wings**, **Tail & canards**,
**Engines & propellers**, **Rotors & mission details**, **Livery & details**,
**SITREC livery**, **Lights** and **Thermal**. Winglets, biplanes, support struts, T-tails,
V-tails, twin fins, canards, unpowered gliders, and 1, 2, 3, 4 or 8 engines are supported. Wing tips can
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
layout. **Dark surround / mask** is on by default for the A350, A330neo and A220
presets, and it works on any airliner, transport or helicopter windscreen.
Those panes share a continuous wraparound outline; pillar width controls the thin
gaps between them without separating the front and side window bands.
Both styles stay attached to the fuselage as their position changes. These
controls save with the design; older parameter files receive suitable defaults.

## Save and export

The editor has these file and preview controls:

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
  For a kite the box is **Move tails in a 12-knot wind**, and it is on when you choose a kite.
  For a bird the box is **Flap wings**, and it is on when you choose a bird.

## Use a procedural model in Sitrec

Each object in a sitch has a folder in the **Objects** menu (see
[Objects and 3D Models](https://github.com/MickWest/Sitrec2/blob/main/docs/CustomModels.md)).
Open the folder and select **Browse custom objects…**. The visual picker has all 347
presets, with search, type/region filters, Favorites, Recently used, and
**My models**. Select a tile to orbit its preview, then **Use this object**. The
object in the sitch changes to the chosen model. The preview of a kite moves its
tails as in a steady 12-knot wind, and the preview of a bird beats its wings.

**Customize…** opens the full live designer. **Apply to object** accepts the
draft, **Back** returns to the picker and keeps the draft, and **Cancel** leaves
the scene unchanged. **Edit design…** reopens the current object's parameters and
preserves its independent size and material settings. **Use file model** returns to the existing model selector.

Sitches save a complete parameter snapshot, its name and a generator revision.
They do not depend on the preset still existing, or on another user's library.
Save a design with **Save to My models** in the picker or **My models +** in the
editor. My models are stored locally in IndexedDB; use **Export design** / **Import
design…** to move editable recipes between browsers. **Import design…** only
selects the design, so save it to keep it in My models. Older standalone aircraft
and vehicle JSON files are accepted. Recipe previews and the catalog load only
when needed; opening an ordinary sitch does not load the designer.

**Freeze as GLB** stores generated geometry, materials and lights as an ordinary
sitch asset. Normal local-folder and shared-sitch saving includes that asset.
The parameter snapshot remains attached, so **Edit design…** can create a new
procedural version later. Frozen geometry can still load when its generator
revision is unavailable. For long-term exact geometry, keep a frozen copy.
Procedural strobes and moving parts use simulation-frame time, so scrubbing and
frame exports repeat the same pose. Light edits in the object's Lights folder
survive design edits and freezing.

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

## 737-800 paint reference

The **737-800 · British Airways reference** preset has a lowered radome, a low
six-pane windscreen, a cranked main wing, blended winglets, fuller tail, flattened
nacelles, cabin window rows, doors and overwing exits. The generated envelope is 39.47 m long and about 35.78 m across
the winglets, consistent with the rounded 39.5 m / 35.8 m dimensions in
[Boeing's 737NG specifications](https://www.boeing.com/commercial/737ng).
Pane contours and paint markings are hand-built procedural approximations. They are not manufacturer geometry or
official airline artwork. The red/navy ribbons and wordmark use mesh geometry,
so they export without fonts or texture files. Cabin window size, vertical level,
start/end positions and count remain editable.

## Military aircraft presets

The catalog includes 136 military presets. The other 211 presets appear under the
**Civil & general** region filter. Search by aircraft name or role, then filter by region. Region groups
refer to design families or the named operator scheme, not exclusive ownership.
The set covers modern and Cold War families; it is not an inventory of every
historical aircraft, subvariant or current fleet. Demonstrators are named as such.

| Region | Presets | Main families |
| --- | ---: | --- |
| US | 42 | F-14/15/16/18/22/35, F-4/5, A-10, B-1/2/52, C-5/17/130, KC-135/46, E-2/3/7, P-3/8, U-2, T-6/38, H-1/47/53/60/64, V-22, MQ-9, RQ-4 |
| Europe | 24 | Typhoon, Rafale, Mirage 2000, Gripen, Tornado, Harrier, Jaguar, A400M, C295, C-27J, A330 MRTT, Atlantique, GlobalEye, Hawk, M-346, PC-21, Tiger, NH90, H225M, AW101/159, nEUROn |
| China | 24 | J-7/8/10/11/15/16/20, JH-7, JF-17, H-6K, Y-8/9/20, YY-20, KJ-200/500, L-15, K-8, Z-8/10/19/20, Wing Loong II, CH-4 |
| Iran | 16 | F-14/4/5, MiG-29, Su-24, Saeqeh, Kowsar, C-130, P-3, Yak-130, Yasin, PC-7, CH-47, AH-1J, Shahed 129, Mohajer-6 |
| Russia (Soviet-origin types included) | 30 | MiG-21/23/29/31, Su-24/25/27/30/33/34/35/57, Tu-22M/95/160, Il-76/78, A-50, An-12/26/124, Yak-130, Mi-8/24/26/28, Ka-27/52, Orion, S-70 |

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

Other editable geometry includes:

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

## Cars, trucks and civil helicopters

The catalog has 36 generic road classes and 15 civil helicopter families. Cars
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

**Drones** has fixed-wing drones and 29 multirotor examples:
DJI Mini, Air, Mavic, Phantom, Inspire, Neo, Avata, FPV, Matrice and Agras families;
Autel EVO, Parrot ANAFI, Skydio, Yuneec and Freefly; and generic FPV, hexacopter
and octocopter layouts. Body profile, motor spacing, propeller diameter, blade count,
coaxial pairs, guards, camera pitch/yaw, antennas, payload and gear are editable.
The frame expands when larger propellers need more clearance. Dimensions describe
the generated model, not a verified reproduction of the manufacturer's airframe.
The reference readout includes the swept rotor envelope; live overall dimensions
use the current blade positions. Status LEDs have editable visual defaults.

**Balloons & sky lanterns** has 22 examples: hot-air and gas balloons, weather
and pilot balloons, latex party balloons, round/star/heart foil balloons, blimps,
a tethered aerostat, a solar tube, and round, square and tapered paper lanterns.
Change envelope dimensions, panel count, bulge, colors, rainbow/striped/checker
patterns, metallic finish, opacity, basket, radiosonde, gondola, fins and tether.
Lanterns have open lower rims, support frames, a flame and adjustable warm glow;
**Night** shows that glow clearly. Balloon models have no aircraft navigation lights.
These are visual models; lift, buoyancy and heating are not simulated.

## Kites

**Kites** has 15 examples of seven types: diamond, delta, rokkaku (hexagon), sled,
box, parafoil and octopus. A kite model has its nose toward +Z, which is the
direction the wind comes from, and its origin is the tow point, where the flying
line attaches. **Flying attitude, nose up** tilts the sail or the head.

The octopus is a soft ram-air kite: a wide head with open cells at its front and
eyes low on its sides, and eight inflated tentacles around its rear rim. The size
in a preset name is the total length. The head is about a quarter of it.

**Tails & tentacles** sets the number of tails, their type (flat ribbon or
inflated tube), length, width, taper, fan angle and droop. Each tail is a chain of
short joints. A wave runs along the chain to the tip, and it grows on the way. The
phase of the wave comes from the length of air that has passed the kite, so the
motion is faster in a stronger wind and slower for a longer tail:

- **Wave length · % of tail** is the length of one wave along the tail
- **Wave speed · % of wind speed** is how fast the wave moves along the tail. The
  default of 55% is an estimate, not a measurement
- **Droop in a 12-knot wind** is the angle below the horizontal at which a tail
  leaves the kite. It sags by as much again along its length. In a lighter wind
  the tails hang lower, and in a calm they do not move

The preview and the thumbnails use a steady wind of 6 m/s (about 12 knots). On a
kite from **Add Kite** in Sitrec, the tails use the wind at the kite on each frame.
The motion is a function of the frame, so scrubbing and frame exports repeat it.

**Flight** has the values that **Add Kite** uses to find where the kite flies:

| Field | What it is |
| --- | --- |
| **Mass · kg** | The mass of the kite, without its line |
| **Lifting area · m²** | The area that the lift and drag coefficients refer to. With 0, it comes from the shape: a fraction of width × length, which for the octopus is the plan area of the head |
| **Lift coefficient** | Lift = ½ × air density × wind speed² × area × this value |
| **Drag coefficient** | Drag, in the same way. It includes the tails and the bridle |

The line angle at the kite comes from tan(angle) = (lift − weight) / drag. The
read-outs under the preview show the **LIFTING AREA** and the **MINIMUM WIND**, at
which the lift equals the weight. The mass of each preset is an estimate from its
fabric area and frame. The lift and drag coefficients are estimates for each kite
type (for example 0.90 and 0.45 for a delta, and 0.55 and 0.60 for an octopus).
None of these values is a measurement of a real kite. See
[Kites](https://github.com/MickWest/Sitrec2/blob/main/docs/SceneObjects.md#kites)
for the flight model and the line.

Kites have no lights and no SITREC livery.

## Birds

**Birds** has 40 examples of common species in flight: gulls, pelicans, cranes, a
raven and a crow, pigeons and doves, geese, swans and a duck, eagles, a hawk and a
vulture, a heron, an egret and a stork, seabirds, an owl and small birds. Some species have
more than one plumage, for example an adult and a young herring gull, and four
colors of pigeon. A bird model has its bill toward +Z and its left wing toward
+X. Its origin is on the body axis, between the wing roots.

**Bird** sets the body. **Length, bill tip to tail tip** is the length of the
model in its flight pose. All the other sizes of the body are percentages of it,
so one value changes the size of the bird. **Neck in flight** is stretched
forward (a crane, a goose, a swan) or drawn back (a heron, a pelican). A bird
with its neck drawn back is shorter in flight than the length in a field guide,
which is for a bird with its neck straight: the length of those presets is an
estimate. **Legs in flight** are tucked in, or they trail behind the tail, and
**Feet beyond the tail tip** sets how far. The legs are not part of the length.

**Wings** sets the wingspan, which is for flat wings, and the shape of the wing.
Each wing has an inner part and an outer part that join at the wrist, which is
the bend at the front edge of the wing:

- **Wing chord · % of wingspan** is the width of the wing from front to rear
- **Inner wing · % of wing length** is the share of the wing that is inside the
  wrist. It is small for a swift and large for an albatross
- **Outer wing swept back** is the angle of the bend at the wrist. It gives a
  gull its M shape
- **Outer wing droop** lowers the outer wing in a glide
- **Wing tip** is pointed, rounded, or separate feathers that fan out, as on an
  eagle, a crane or a raven

**Tail** sets the length of the tail, the angle of its fan and its shape:
rounded, square, wedge (a raven), long and pointed (a mourning dove) or forked (a
swallow, a frigatebird).

### Wing motion

| Field | What it is |
| --- | --- |
| **Flight** | **Flapping**, **Gliding · wings held still**, or **Flap, then glide** |
| **Wingbeats per second** | The number of complete wingbeats (down and up) in one second |
| **Flap angle, up and down** | How far the wing goes above and below the middle of its stroke |
| **Wing fold on the upstroke** | How much the outer wing bends down and folds back while the wing goes up. It is large for a pigeon and small for a goose |
| **Wing angle in a glide, + is up** | The angle of the held wing above the horizontal. A turkey vulture holds its wings in a V |
| **Wingbeats before each glide** | For **Flap, then glide**: the number of wingbeats in each burst |
| **Length of each glide · s** | For **Flap, then glide**: the time that the wings are still after each burst |

Each wing moves at two joints. The shoulder moves the whole wing up and down
and turns its front edge down on the downstroke. The wrist bends the outer wing
down and back on the upstroke, a little after the inner wing. The body moves
down a small distance while the wings go up, and up while they go down. With
**Flap, then glide** the wings leave the glide position and go back to it in
half a wingbeat.

The preview beats the wings in real time. The **WINGBEAT** read-out under the
preview shows the rate. In Sitrec the wings move with the sitch time, so
scrubbing and frame exports repeat the same wing position, and **Freeze as GLB**
keeps the motion. With **Animate moving parts** off in Sitrec, the wings are in
the glide position. At the 30 frames per second of most video, a wingbeat of
6 per second has only five frames, so a fast wingbeat does not look smooth, as in
a real video.

### Sizes and wingbeat rates of the presets

The length and the wingspan of a preset are the middle of the range on the
species page that its **Reference ↗** link opens. The two pelicans, the heron and
the egret fly with the neck drawn back, so their length is an estimate of the
length in flight: 85% of that value for the pelicans, and 75% for the heron and
the egret.

A rate with a source is the mean of the measured values in that source. A rate
marked **Estimate** is not a measurement: no measured value was found, and the
rate was set by comparison with measured species of similar size and wing shape.
For example, the two crows are set from the hooded crow, at 3.84 per second in
Pennycuick 2001. A gliding preset keeps its rate, which it uses when you change
its **Flight** to flapping.

| Preset | Length · m | Wingspan · m | Flight | Wingbeats per second | Source of the rate |
| --- | ---: | ---: | --- | ---: | --- |
| Herring gull · adult | 0.60 | 1.40 | Flapping | 3.05 | Pennycuick 1990 |
| Herring gull · first year, brown | 0.60 | 1.40 | Flapping | 3.05 | Pennycuick 1990 |
| Ring-billed gull | 0.48 | 1.11 | Flapping | 3.2 | Estimate |
| Laughing gull · black hood | 0.39 | 1.04 | Flapping | 2.74 | Pennycuick 1990 |
| Black-headed gull · brown hood | 0.37 | 1.05 | Flapping | 3.27 | Pennycuick 2001 |
| Great black-backed gull | 0.71 | 1.60 | Flapping | 2.9 | Pennycuick 1990 |
| American white pelican | 1.32 | 2.70 | Flap, then glide | 2.5 | Estimate |
| Brown pelican | 1.07 | 2.15 | Flap, then glide | 3.01 | Pennycuick 1990 |
| Sandhill crane | 1.20 | 2.00 | Flapping | 2.8 | Estimate |
| Whooping crane | 1.32 | 2.15 | Flapping | 2.6 | Estimate |
| Common crane | 1.15 | 2.10 | Flapping | 2.7 | Estimate |
| Common raven | 0.63 | 1.35 | Flapping | 3.3 | Estimate |
| American crow | 0.46 | 0.93 | Flapping | 3.8 | Estimate |
| Rock pigeon · blue-gray, two bars | 0.33 | 0.65 | Flapping | 5.48 | Taylor et al. 2019 |
| Rock pigeon · dark checker | 0.33 | 0.65 | Flapping | 5.48 | Taylor et al. 2019 |
| Rock pigeon · red and white | 0.33 | 0.65 | Flapping | 5.48 | Taylor et al. 2019 |
| White dove · release dove | 0.33 | 0.65 | Flapping | 5.48 | Taylor et al. 2019 |
| Mourning dove | 0.31 | 0.41 | Flapping | 7.5 | Estimate |
| Eurasian collared dove | 0.32 | 0.51 | Flapping | 6.5 | Estimate |
| Canada goose | 0.93 | 1.56 | Flapping | 4 | Estimate |
| Snow goose | 0.76 | 1.50 | Flapping | 4.3 | Estimate |
| Mute swan | 1.50 | 2.20 | Flapping | 3.38 | Pennycuick 2001 |
| Tundra swan | 1.32 | 1.90 | Flapping | 3.6 | Estimate |
| Mallard · male | 0.58 | 0.90 | Flapping | 8.4 | Williamson, Dial & Biewener 2001, in slow flight |
| Bald eagle · adult | 0.86 | 2.05 | Flap, then glide | 2.72 | Pennycuick 1990 |
| Bald eagle · young, dark | 0.86 | 2.05 | Flap, then glide | 2.72 | Pennycuick 1990 |
| Golden eagle | 0.84 | 2.07 | Gliding | 2.5 | Laurent et al. 2021, as given by Gupta et al. 2024 |
| Red-tailed hawk | 0.55 | 1.28 | Gliding | 3.5 | Estimate |
| Turkey vulture | 0.72 | 1.75 | Gliding | 2.99 | Pennycuick 1990 |
| Great blue heron | 0.86 | 1.84 | Flapping | 2.55 | Pennycuick 1990 |
| Great egret | 0.69 | 1.50 | Flapping | 2.79 | Pennycuick 1990 |
| White stork | 1.08 | 1.85 | Flap, then glide | 2.8 | Estimate |
| Magnificent frigatebird | 1.02 | 2.30 | Gliding | 2.24 | Pennycuick 1990 |
| Laysan albatross | 0.81 | 1.99 | Gliding | 3 | Estimate |
| Northern gannet | 0.94 | 1.75 | Flap, then glide | 3.53 | Pennycuick 1990 |
| Double-crested cormorant | 0.80 | 1.19 | Flapping | 5.03 | Pennycuick 1990 |
| Barn owl | 0.34 | 0.88 | Flapping | 4.4 | Krishnan et al. 2022 |
| European starling | 0.21 | 0.37 | Flapping | 10.6 | Pennycuick 2001 |
| Common swift | 0.17 | 0.39 | Flap, then glide | 8.6 | Henningsson, Spedding & Hedenström 2008 |
| Barn swallow | 0.18 | 0.33 | Flap, then glide | 7 | Estimate |

The sources:

- **Pennycuick 1990**: C. J. Pennycuick, "Predicting wingbeat frequency and
  wavelength of birds", Journal of Experimental Biology 150, 171–185, Table 3.
  Birds in level cruising flight in Florida.
- **Pennycuick 2001**: C. J. Pennycuick, "Speeds and wingbeat frequencies of
  migrating birds compared with calculated benchmarks", Journal of Experimental
  Biology 204, 3283–3294, Table 2. Migrating birds at Falsterbo, Sweden.
- **Krishnan et al. 2022**: Journal of the Royal Society Interface 19, 20220168,
  Table 2. Wild birds with accelerometers.
- **Taylor et al. 2019**: PLoS Biology 17, e3000299. Homing pigeons in flights
  alone, with accelerometers.
- **Henningsson, Spedding & Hedenström 2008**: Journal of Experimental Biology
  211, 717. One swift in a wind tunnel, from 8.3 to 9.1 per second at air speeds
  from 9.2 to 8.0 m/s.
- **Williamson, Dial & Biewener 2001**: Journal of Experimental Biology 204, 495.
  Only the abstract was read. It gives 8.4 per second in slow level flight and
  8.9 in ascending flight. No rate for cruising flight was found.
- **Laurent et al. 2021**: Proceedings of the National Academy of Sciences. The
  paper was not read: the value of about 2.5 per second is as Gupta et al. 2024
  (arXiv 2412.00231) give it.

The two Pennycuick papers give the rate while the bird flaps, not an average
that includes its glides. That is the rate that **Flap, then glide** uses in
each burst. Two sources do not agree for the northern gannet (3.53 in Pennycuick
1990, 3.9 in Krishnan et al. 2022) and for the rock pigeon (5.2 to 5.5 in free
flight, 6.7 in a wind tunnel). The number of wingbeats in each burst and the
length of each glide are estimates for every preset.

### Plumage

**Plumage** has the colors of the back, the breast and belly, the head, the neck,
the upper wing, the underwing, the tail, the bill, the legs and the eye. The
back color changes to the belly color on the sides of the body.

- **Head mark** adds a cap, a cheek patch (a Canada goose), a neck ring (a
  mallard) or a mark on the back of the neck (a collared dove), in the **Head
  mark color**
- **Wing marks** puts the **Wing mark color** on the wing tips (a gull, a snow
  goose), on the flight feathers at the rear of the wing (a white pelican, a
  white stork), on the flight feathers of the underside only (a turkey
  vulture), or on two bars across the inner wing and the tips (a rock pigeon).
  **Wing mark size** sets how far the mark reaches
- **Tail tip band** sets the size and the color of a band at the end of the
  tail (a rock pigeon, a mourning dove)

The plumage is vertex colors on one material, so a bird is five meshes: the body,
and an inner and an outer part of each wing.

The sizes are typical values for each species. The shapes and the colors are
estimates from photographs, and they are not measurements of a bird. Birds have
no lights and no SITREC livery. In the IR preview a bird has the temperature of
the air: the heat of its body is not modeled. The tail and the legs do not move,
and the bird does not bank or steer: in Sitrec its path and its speed come from
the track of its object.

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
aircraft strobes, taxi lights (with **Landing gear extended** on), beam angle, aim,
intensity, flash timing and road indicators. **Night** changes the preview lighting,
and **Flash lights** animates beacons/strobes/indicators. Switching the procedural lights off leaves unlit lenses.

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

## Infrared preview

Choose **IR preview** under Preview mode, then the **IR view**:

- **Near** uses the normal view's camera: the same position, direction and field
  of view, so both preview modes show the same picture. Drag to orbit, scroll to
  zoom, use the view buttons, or type the **Distance to the vehicle**; the
  camera is shared, so the normal view follows. The image keeps the selected
  sensor's detector rows, pixel pitch and f-number at this field of view (the
  focal length follows the field and the aperture follows the f-number); the
  detector columns follow the preview's shape. **Digital zoom** has no effect
  in this view.
- **Far** places the sensor at a range and aspect around the vehicle, as below.

Both views use the real distance for the atmospheric path and as the
point-response range (PSF source range). In the near view that range follows the
distance once a zoom has stopped.

For an example far view, use **A340-600**, range **125000 m**, aspect azimuth
**0°** and elevation **0°** for a direct rear view.
Positive aspect elevation puts the sensor above the vehicle. Azimuth turns from
the tail toward the port side. These are body-relative viewing angles; the
atmospheric ray elevation and sensor altitude are independent environment inputs.
The default MX-15 class sensor uses 675 mm focal length, a 640 × 512 detector
and 0.869° vertical optical field: about **3.704 m per detector pixel at 125 km**.
The readout shows the current field and metres per detector pixel.
The image keeps the detector aspect ratio inside the available preview area.
Optical field/focal length and digital zoom are separate. The far view hides the
view buttons and **Fit**; use the range and aspect controls to change the
physical view.

The **Thermal** recipe folder contains propulsion/material profile, power,
local ambient temperature, Mach and skin emissivity. These scalar parameters
save with the design and GLB recipe metadata. Old designs receive defaults without changing their visible geometry. Camera, atmosphere,
processing and display controls persist separately in this browser and do not
travel with the design. The sensor menu is generated from the shared thermal
schema, including units, tooltips and each preset value's published, measured,
calculated or estimated status. An edited preset value is marked **Edited**.

The picture comes from surface photon radiance, atmospheric transfer, diffraction
and scatter, native detector sampling, exposure, noise and 14-bit conversion,
then gain/level and 8-bit display processing. Choose manual, automatic, plateau
equalization or fixed radiometric gain, black/white hot polarity, and radiance
or detector-count diagnostics. Automatic gain is the initial preview setting.
The readout shows the detector count under the pointer and the full detector
frame's minimum, maximum and median. Pointer coordinates include digital zoom;
statistics include pixels outside the displayed crop. With detector noise on,
the preview draws a new noise frame at the sensor frame rate, and the readout
updates after an edit or a camera move and when the pointer moves. With noise
off, the preview draws only after a change. **Snapshot** saves the
selected mode. Library thumbnails and the preset picker use the normal view.

Vehicle surface temperatures, emissivities and their equilibrium power response
are family estimates. The hot aperture at the rear of the A340 engine is about
630 K at the preset's default **Thermal** values. It changes with power, Mach and
ambient temperature, and it is not a measured engine operating point.
Podded engines on a **Streamlined jet** body reuse the visible rear disc, with an
estimated radius of 0.28 times nacelle diameter, and add a short nozzle wall and
rim only for IR. Other podded jet engines, including the A340-600, replace that
disc in IR with an estimated fan duct, core nozzle, plug and pylon shield, scaled
from the nacelle diameter. Integrated exhausts use their visible opening. The
heated rear nacelle occupies its rear quarter.
Propeller stacks and helicopter outlets are approximate placements derived from
the generated engine/cabin dimensions. Road hood regions and exhaust outlets,
electric motor/controller/battery covers, and balloon envelopes carry distinct
zones. Internal brakes and concealed engine parts are not exposed as hot skins.
Paint markings are omitted in IR so they do not add a second emitting surface.
The lantern flame is a crude continuum proxy supplied by the shared signature model; it is not a resolved gas flame.

Aperture, scatter, exposure and electronics remain estimates where the preset
says so. The atmosphere is a reduced transfer model. By default the background
comes from that model and changes with ray elevation, and rays below the horizon
meet the sea model. Set **Sky source** to **Manual temperature** for one uniform
brightness temperature. Plumes, trails, transient cooling and material spectra
are not modeled here. Sensor nonuniformity is limited to the estimated **Edge
shading** and **Residual fixed pattern** controls, which are on by default. Gain
and blur can merge the four engine sources into two broad groups; a display match
alone does not establish source size, temperature or detector saturation. The
preview is not compared with any video.
The renderer requires WebGL 2 with floating-point color targets. Allocation or
render errors appear above the image; reduce optical sampling/support if needed.

## Limits

The generator permits unusual combinations; it does not check structural
feasibility, aerodynamics, or component interference. The geometry is intended
for visual reconstruction and prototyping. Glazing is opaque and there is no
interior.

## Standalone copy

There are no runtime network services or CDN dependencies. For a standalone
copy, start from a built site, not from the source tree: only the build has the
`vendor/` modules and license, and the version stamps in `index.html`. Copy these
built directories and keep them beside each other so relative imports resolve:

- **`tools/vehicles/`**, including `vendor/` and `thumbnails/`
- **`tools/thermal/`**
- **`tools/psf/`**: the IR preview imports its `fft.js`

Open the standalone copy over HTTP(S), not `file://`, so browser module loading
works.

## Development

Both entry points use the same editor markup, styles, parameter controls and
model code. Shared modules live in `tools/vehicles/`: `generator.js` prepares
models and metadata, `exportGLB.js` handles clean exports, `studio.js` handles
preview rendering and camera fitting, `motion.js` poses moving parts, and
`catalog.js` / `files.js` handle filtering and recipe files. `kiteFlight.js` has
the flight values and the line statics of a kite, with no imports, so Sitrec can
use it without the model generator. `bird.js` builds a bird, and puts a
`vehicleFlap` record on each joint that moves; `motion.js` reads only those
records, so a frozen GLB copy moves in the same way. The Sitrec modules
adapt these to object controls, scene persistence and the model library.
Keep vehicle behavior in the shared modules; the standalone entry point only
mounts the editor. GLB export and Freeze as GLB use the same exporter and retain
the same recipe, light and motion metadata.

The normal webpack build copies these files, stamps the import map in
`index.html` with the build version, and adds a matching Three.js renderer,
OrbitControls and GLTFExporter from the installed dependency, with its license.
Thermal code loads on first use, including in the embedded editor's separate
webpack chunk.

On `localhost`, `127.0.0.1`, `[::1]` and `local.metabunk.org` only, enabling IR
exposes `window.vehicleThermal`, which includes `pipeline`, current `settings`
(including sensor range and aspect), `set(key, value)`, and
`readDetectorCounts()`. It is removed when the editor closes and is not exposed
on other hosts. Counts are native-grid 14-bit values in bottom-row-first order.

The former `tools/aircraft/` URL redirects to `tools/vehicles/`, retaining query
parameters and fragments.
