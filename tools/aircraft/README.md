# Aircraft Designer

Open **Sitrec → Extra Tools → Aircraft Designer**, or `tools/aircraft/index.html`
on a built Sitrec site. It fills the browser window, with collapsible parameter
folders on the left and a Three.js preview on the right. On narrow screens the
preview sits above the controls. The fullscreen button hides browser chrome where supported.

Choose one of 54 presets, then drag sliders or type exact values. Slider `input`
events update the mesh on the next animation frame, including during a drag.
Edits preserve the camera; **Fit** (or **F**) frames the new shape. Drag to orbit,
scroll to zoom, and right-drag to pan. The presets use approximate proportions
inspired by common aircraft, not manufacturer engineering geometry.

Folders cover the fuselage, cockpit glazing, wings, tail and canards, engines and propellers, and
livery and details. Winglets, biplanes, support struts, T-tails, V-tails, twin fins,
canards, unpowered gliders, and one to four engines are supported. Wing tips can
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
interior. Navigation lights are colored emissive lenses, not operational lights.

- **Save design / Open** round-trip a versioned `.aircraft.json` parameter file.
  The last design also restores from browser storage when available. Preset
  selection replaces the current parameters; save a design before switching if
  you want to retain it. **Reset preset** restores the selected built-in preset.
- **Export GLB** downloads only the aircraft, including materials and parameter
  metadata. The grid, camera, studio lights and preview effects are excluded.
  Coordinates are metres, +Y up, +Z forward, +X port. The filename includes the
  actual model length as `~L…m~` for Sitrec's model import. Load it via
  **File → Import File** or drop the GLB into Sitrec.
- **Snapshot** saves the current 3D view as a PNG, excluding the control panel.
- **Spin props** animates the preview propellers; GLB exports have static blades.

There are no runtime network services or CDN dependencies. The normal webpack
build copies these files and a matching Three.js renderer, OrbitControls and
GLTFExporter from the installed dependency. The resulting `tools/aircraft/`
folder can also be hosted on its own static web server. Open it over HTTP(S), not
`file://`, so browser module loading works. The import map versions the complete
module graph, and the bundled dependency includes its license.
