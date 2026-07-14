# Football (Physics → Football)

Launch a football (soccer ball) from a point on any track, with real ballistic
physics — quadratic drag, Magnus lift from spin, ground bounces — plus a
Spidercam-style cable cam whose four support wires are drawn and checked for
collision with the ball, a regulation pitch ground overlay, and a fixed
"broadcast" camera view. Built to investigate the 2026 World Cup
England–Norway "Wire-gate" goal kick (Hard Rock Stadium, 2026-07-11, 45+2'),
but usable as a general projectile-vs-cable-cam tool.

All code lives in `src/Football.js`; nodes are created per-sitch by
`setupFootball()` (called from `CCustomManager.setup()`), so the feature is
available in any custom sitch. Everything serializes through the standard
mods mechanism — Save/Save As round-trips all parameters, switch choices,
cable-cam keyframes, and the pitch overlay.

## One-click replication

**Physics → Football → "Load England-Norway Goal Kick (WC 2026)"** sets up
the whole incident: Hard Rock Stadium terrain, pitch frame aligned to the
satellite imagery (heading 96°), match date/time (for correct sun), the kick
(35 m/s, 42°, 300 rpm backspin from the Norway goal area), the spidercam
racing downfield from behind the goal, the wire strike (~23 m up, just short
of halfway, tens of meters from the camera), the drop in front of the
benches, the pitch overlay, and the look camera riding the cable cam.

## Manual setup

1. Start a **Custom** sitch (New Sitch → Custom).
2. **Pitch frame** — Physics → Football → *Pitch Location*: set Pitch Center
   lat/lon (altitude is MSL) and *Pitch Heading (°)* = compass bearing of the
   long axis. All cable-cam and scenario geometry is defined in this frame.
3. **Launch point** — move the Target (hold X and drag, or Target menu
   lat/lon) to the kick spot. *Launch From Track* defaults to **Target**;
   any imported track (KML/MISB drop) also appears as an option.
4. **Kick** — set *Launch Frame* (or click *Set Launch Frame = Now*), *Kick
   Heading*, *Elevation Angle*, *Speed*, *Spin* (+backspin/−topspin), *Spin
   Axis Tilt* (0 = backspin, ±90 = sidespin curving left/right), and *Air
   Drag Cd* (~0.2–0.25). Enable **Show Football** for the ball + trajectory.
5. **Cable cam** — set *Anchor Dist Long/Wide* and *Anchor Height* (the four
   wire anchors sit at (±long, ±wide, height) in the pitch frame), *Wire
   Sag*, and enable **Show Cable Cam** (dolly, path, wires). The dolly path
   and operator aim point are keyframed tracks (`{f, along, across, height}`
   in the pitch frame); currently edited via the scenario or console:
   `NodeMan.get("footballCableCamTrack").setMotion([...])` and
   `NodeMan.get("footballCableCamAim").setMotion([...])`.
6. **Ride the spidercam** — Camera menu: *Position* = **Cable Cam**,
   *Camera Heading* = **Cable Cam Aim**, *Camera FOV* = **Cable Cam** (with
   the *Cable Cam FOV* slider). The look view then reproduces the spidercam
   feed.
7. **Collisions** — *Ball Bounces Off Wires* makes the ball deflect
   (inelastic; *Wire Bounce* sets restitution); off = pass-through but
   contacts still detected. Both outcomes are always simulated: the
   non-selected one draws as a thin grey "what if" line (with deflection on,
   the grey line is the unimpeded flight; off, it's the deflected path),
   with a 50%-transparent ghost ball riding it. *Wire Hit Offset (%)* is how far to the *side*
   of the ball's center the wire strikes (as a % of the radius): 0 = dead
   center (kills the momentum), +100 = grazes the ball's right side
   (deflecting it left), −100 = the left side. A side hit keeps most of the
   ball's speed — including its climb. Whether the wire strikes the top or
   the underside of the ball follows from the flight direction (a climbing
   ball is struck on its upper face, a dropping one underneath). The *Wire
   Contact* line reports the hit frame and wire, or the closest approach.
   Contacts are marked with red spheres. While *Show Football* is on, a
   **Ball G-Force** series (IMU-style proper acceleration per frame) is
   available to Custom Graphs; the scenario adds one as a rolling 2-second
   strip chart (any custom graph can set *Show Last (secs)* to plot a
   scrolling window instead of the whole clip; the x span stays a constant
   N seconds and the y scale is fixed from the entire timeline, so the trace
   scrolls under stable axes). Impacts are converted from
   their Δv over the ball's ~10 ms contact-deformation time, so the kick
   reads as a one-frame ~360 g spike, a wire graze as a few tens of g, and
   the in-flight baseline (~1.5 g at 35 m/s, decaying) is aerodynamic drag.
8. **Pitch overlay** — **Show Pitch Overlay** drapes a regulation 105×68 m
   pitch texture (`data/images/footballPitch.png`, regenerate with a
   different look if desired) centered on the pitch frame. It follows Pitch
   Center / Heading edits automatically.
9. **Broadcast view** — **Show Broadcast View** opens a fixed camera-1 style
   view that follows the ball; position it via *Broadcast Camera Position*
   and *Broadcast FOV*. (Renders capped at 720p to keep three-view setups
   fast.)
10. **Video comparison** — drop a broadcast clip on the sitch; the sitch
    refits to the video timeline. Kick-relative scenario timing survives
    fps/frame-count changes; the ball physics uses `simSpeed/fps` per frame,
    so slow-motion clips stay physical.

## Physics notes

FIFA size-5 ball (m = 0.430 kg, r = 0.110 m), ρ = 1.225 kg/m³. Magnus lift
uses Cl = 0.62·S^0.7 (Goff & Carré) with S = rω/v. Integration is
semi-implicit Euler at 480 Hz substeps; wire contact uses swept
segment-vs-polyline distance with an anchor-chord coarse gate. The
simulation is a pure function of its GUI inputs and skips identical
re-computation (fingerprint), so cascades from unrelated recalculation are
free.
