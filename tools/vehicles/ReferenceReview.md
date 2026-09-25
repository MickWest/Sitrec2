# Vehicle reference review

The catalog contains 292 editable visual presets. All were rendered in groups
to check their generated silhouettes, glazing, attachments and SITREC markings.
Reference research is strongest for the Boeing/Airbus dimensioned airliners;
the other named aircraft use family photographs and published specifications.
This is a review of procedural approximations, not a claim that every variant
has been matched to an engineering drawing or an individual airframe.

## Coverage

| Set | Coverage and limits |
| --- | --- |
| 39 Boeing/Airbus airliners | Manufacturer dimensions, cockpit pane families, upper decks and wingtip configurations. Linked sources and target dimensions appear beside each preset. Cabin layouts remain representative. |
| 136 military presets | Published dimensions where available; otherwise explicitly marked estimates. Family review covers canopy arrangement, cabin/navigator glazing, wing/tail configuration, engine count and mounting, and rotor layout. Operator variants inherit the reviewed family geometry. |
| 15 general aircraft | Editable family-style examples or generic configurations. They are not replicas of a specified aircraft serial number. |
| 15 civil helicopters | Manufacturer family references and rotor dimensions; approximate fuselages, cabins and equipment. Length excludes the turning rotor envelope. |
| 36 road vehicles | Generic body classes, not named makes or model years. Cab, glazing, wheel openings, axles and cargo geometry are checked for visual consistency. There is no single definitive reference for these generic designs. |
| 29 multirotor drones | Named manufacturer families plus generic FPV, six-arm and eight-arm examples. Rotor layout, guards, camera lens count and equipment distinguish families. Body contours and motor spacing are editable approximations; status LEDs are generic visual defaults. |
| 22 balloons and lanterns | Generic envelope classes and color schemes. Hot-air gores, suspended equipment, inflated foil outlines, blimp fins and open lantern rims are modeled. No particular balloon registration or lantern product is replicated. |

Some public Chinese, Iranian and Russian material supplies photographs without
reliable dimensions or lamp diagrams. Those presets retain estimate labels. A
manufacturer family page is evidence for that family, not proof of every variant's
dimensions. Exact glazing outlines, surface curvature, landing gear assemblies,
intakes, nozzle sections and equipment remain simplified throughout the catalog.

## Corrections made during the review

| Feature | Correction and reference |
| --- | --- |
| Airliner cockpit | Continuous wraparound windshield outline, with narrow adjustable pillars. Six-pane and four-pane layouts are separate. [Boeing planning drawings](https://www.boeing.com/commercial/airports/plan-manuals), [Airbus characteristics](https://www.aircraft.airbus.com/en/customer-care/fleet-wide-care/airport-operations-and-aircraft-characteristics/aircraft-characteristics). |
| Fighter joints | Fin roots embed in the sampled fuselage. Engine fairings share their exhaust joint exactly; intake fairings terminate inside the skin. This prevents floating parts during normal parameter edits; it is overlapping geometry, not a boolean solid. |
| An-124 | Conventional low tailplane replaces an inherited T-tail. [Antonov family reference](https://www.antonov.com/en/history/an-124-ruslan), [EUROCONTROL dimensions](https://contentzone.eurocontrol.int/aircraftperformance/details.aspx?GroupFilter=3&ICAO=A124). |
| H130/H135/H145/H160 | Enclosed tail rotors replace open ones. H145 uses five main blades; H160 tail-rotor diameter is 1.20 m. Fin details and rotor cant remain simplified. [Airbus Fenestron history](https://www.airbus.com/en/newsroom/stories/2022-07-safety-innovation-2-the-fenestron). |
| Flying-wing drones | A separate lambda planform replaces the shared B-2 sawtooth outline. [Dassault nEUROn](https://www.dassault-aviation.com/en/defense/neuron/), [B-2 dimensions](https://www.northropgrumman.com/what-we-do/aircraft/b-2-stealth-bomber/technical-details). |
| Harrier | Four side nozzles replace a conventional rear jet exhaust. Adjustable nozzle tilt and tailplane anhedral are available. [Museum of Flight Harrier](https://www.museumofflight.org/exhibits-and-events/aircraft/mcdonnell-douglas-av-8c-harrier), [RAF Museum GR7 family reference](https://www.rafmuseum.org.uk/harrier-gr7/). |
| H-6K | Wing-root engine arrangement replaces rear fighter exhausts; retains a solid radar nose. [Public H-6K reference](https://eng.mod.gov.cn/xb/Home/Focus/4901926.html). |
| J-7 | Separate horizontal tailplanes replace an inherited tailless delta configuration. |
| General F-16-style example | Integrated exhaust and chin intake replace the rear-pod defaults. [Manufacturer family reference](https://www.lockheedmartin.com/en-us/products/f-16.html). |
| Concorde-style example | Small framed cockpit and paired engines replace generic canopy/separate-pod defaults. Ogival wing curvature, visor and droop mechanism remain simplified. [Heritage Concorde restoration and engineering reference](https://www.heritageconcorde.com/airframe-structure). |

## Lights

The local PA28 and B737Max8 models establish the existing Sitrec import convention:
named point/spot lights with `strobeEvery` and `strobeLength` extras. The procedural
737 export was loaded through Sitrec's model loader and produced its normal
Lights folder with ten lights, including five flashing lights and two landing
spotlights. These local models are compatibility references, not evidence that
all PA-28 or 737 variants have an identical exterior light installation.

Position-light colors follow the [FAA night operations handbook](https://www.faa.gov/sites/faa.gov/files/regulations_policies/handbooks_manuals/aviation/airplane_handbook/12_afh_ch11.pdf).
Light locations are chosen by vehicle family and follow the generated body,
wings or extended gear. Intensities, flash sequences and beam angles are editable
visual defaults. They are not certified photometric or variant-specific layouts.

The SITREC identity is original procedural artwork, loosely inspired by classic
blue-and-white globe airline liveries. It is not copied airline artwork and makes
no claim about a real operator's markings.

## Drone and balloon reference scope

Published drone dimensions mix folded bodies, unfolded frames and rotating-propeller
envelopes. The tool therefore labels its dimensions as generated envelope estimates,
with separate motor-center spacing and rotor diameter. Sources used for family
layout and dimension conventions include [DJI Mini 4 Pro](https://www.dji.com/mini-4-pro/specs),
[DJI Air 3S](https://www.dji.com/support/product/air-3s),
[DJI Inspire 3](https://www.dji.com/inspire-3/specs),
[DJI Avata 2](https://www.dji.com/avata-2/specs),
[Parrot ANAFI](https://www.parrot.com/en/drones/technical-specifications-anafi-fpv),
[Skydio X10](https://www.skydio.com/x10/technical-specs), and
[Freefly Alta X](https://freeflysystems.com/alta-x/specs).
Mini/Air/Mavic derivatives share a compact body generator. Inspire uses a long spine
and booms; Phantom uses a smooth shell; FPV decks, guarded frames, multiple camera
lenses and paired agricultural rotors are separate options. Folding mechanisms,
individual sensor apertures and exact molded contours remain simplified.

[Cameron's envelope families](https://cameronballoons.com/envelopes/) and
[N-type gores](https://cameronballoons.com/n-type/) inform the hot-air examples.
[Vaisala sounding systems](https://www.vaisala.com/en/sounding-systems-radiosondes)
provide the weather-balloon/payload family reference. Party balloons, solar tubes,
foil outlines and paper lanterns are generic visual designs. Their sizes and colors
are example values, with no manufacturer performance claim. Spherical envelopes
use rounded poles; foil markings follow the inflated surface instead of floating
on a rectangular decal. Sky lantern glow and burner lights are artistic defaults.
