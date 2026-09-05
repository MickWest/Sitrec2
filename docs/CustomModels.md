To simulate a potential UAP, Sitrec can display a variety of 3D models. There's some built-in, like planes and aerostats. You can also create simple geometric shapes like spheres and boxes. For full flexibility, you can import a custom 3D model. 

To experiment with this functionality, start with the model inspector, found at Sitrec->Model Inspector. 

Once in the Model Inspector, you will get the default object, and two views on that object. You can double-click on a view to make it full screen. 

Most of the object-specific adjustments are done with the "Objects" menu. For convenience, you can drag this off the menu bar to keep it open. Here I've also opened the "Time" menu, which is used for setting the sun direction.

![model-inspector-with-menus.jpg](docimages/model-inspector-with-menus.jpg)

With "Model or Geometry" set to "Geometry" you can experiment with a variety of different shapes.

![model-viewer-cylinder-geometry.jpg](docimages/model-viewer-cylinder-geometry.jpg)

You can also adjust the material (the surface appearance of the object). There are various different types.
- Basic: No lighting, the object will simply appear all the same color
- Lambert: Simple illumination where the object is affected by the sunlight. There's an additional "emissive" color, which is how much light the object itself emits (i.e. if it's self-illuminating, like a lantern)
- Phong: Similar to Lambert  
- Physical: A more physically realistic material, with more parameters. 
- EnvMap: A reflective, environment-mapped material - mirror-like at low roughness, controlled by roughness and metalness.
- Gradient: A custom shader that maps a color gradient across the object, with thermal-imaging palettes (Ironbow, Black Hot, White Hot, etc.). Useful for approximating an IR/thermal appearance.
- Checkerboard: A simple two-color checkerboard pattern. 

When experimenting with these settings, use the "Lighting" and "Time" menus to experiment with different lighting situations. For example, here's a very rough approximation of a lantern with an orange glow illuminated by low sun.
![SuperEgg with low lighting.jpg](docimages/SuperEgg%20with%20low%20lighting.jpg)

### Built-in Models

There are also some built-in models. To use them, change the mode from "geometry" to "model" and select a model from the drop-down.

![model-drop-down-with-f-15.jpg](docimages/model-drop-down-with-f-15.jpg)

You can also apply the custom material to the object. This is a good way of quickly getting neutral color scheme. Here I'm using a physical material that's similar to the actual material, above. 
![apply-material-to-f-15.jpg](docimages/apply-material-to-f-15.jpg)

### Dimensions

The geometry specification are in meters. You can see the dimensions of the bounding box of an object by checking "Display Bounding Box" in the Object menu. This will display the dimensions in your default units (feet or meters).  

![Model Viewer dimensions.jpg](docimages/Model-Viewer-dimensions.jpg)

## Supported Model Formats

Sitrec supports two model file formats:

- **GLB** (.glb) — Binary glTF format. Includes geometry, materials, and textures in a single file. This is the primary format for authored models (aircraft, drones, etc.). Created via Blender or other 3D tools.
- **PLY** (.ply) — Polygon File Format. Sitrec handles three types of PLY content:
  - **Mesh PLY** (contains faces): Rendered as a standard lit mesh. Vertex colors are used if present.
  - **Gaussian Splat PLY** (header contains `scale_0…scale_2` and `rot_0…rot_3` properties): Rendered using instanced elliptical Gaussian splatting with back-to-front sorting. This is the format produced by 3D Gaussian Splatting tools.
  - **Point Cloud PLY** (vertices only, no faces or splat attributes): Rendered as a point cloud with size attenuation.

Both formats can be dragged and dropped into the Model Inspector or any moddable sitch.

### Filename Length Parameter

You can embed the real-world length of a model directly in its filename using the format `~L<value><units>~`. When Sitrec loads the model, it reads this parameter and automatically sets the model scale so the model's length along its forward (local Z) axis matches the specified length. Note this is the fore-aft length, not necessarily the longest dimension of the model.

**Format:** `modelname~L<number><units>~.glb` (or `.ply`)

**Supported units:**
- Meters: `m`, `meter`, `meters` — e.g. `shahed~L3.5m~.glb` (3.5 meters)
- Feet: `f`, `ft`, `feet` — e.g. `drone~L24.5ft~.glb` (24.5 feet)
- No unit defaults to feet — e.g. `thing~L100~.glb` (100 feet)

This is particularly useful for models that don't have a consistent internal scale, or when you want to quickly try different sizes without editing the model. The length parameter is applied when the model loads — you can still adjust the "Model Length" slider in the Objects menu afterward.

## Custom Models using Blender

The geometries are only intended for simple tests. For more flexibility you can create or import a custom model.

Models are typically authored in GLB format. You don't need to use Blender to make them, but that's the only documented pipeline. Other tools should be similar.

Internally, Sitrec uses the metric system. So you need to set this in Blender if you want your models to be consistently sized.
![blender-units.jpg](docimages/blender-units.jpg)

### Blender Orientation and scale

When creating a model, such as an aircraft, the forward direction should be along the negative y-axis. This makes it consistent with the OpenGL coordinate system used by Sitrec. In Blender, you can see the directions of the axes with the axes widget. RGB, Red, Green, and Blue are X, Y, and Z. 

The aircraft should be centered so its center of gravity is at the origin. This generally means the Y-axis will pass through the nose.

The aircraft should be level, as if it is wheels down. Angle of attack adjustments are done at run-time. This usually means the wings and horizontal stabilizers are level.

The size of the object can be seen in the bounding box dimensions. Ensure this matches expectations. The bounding box only works for single objects, so if your object is multi-part then you'll have to use another method. 

![blender-dimensions.jpg](docimages/blender-dimensions.jpg)

### Blender materials 

Blender commonly uses the "Principled BSDF" material, an industry standard "physical" material which is largely supported in WebGL, and hence in Sitrec. For more details, see:
<https://docs.blender.org/manual/en/2.80/addons/io_scene_gltf2.html>

If you import a model from a format like FBX, Collada, or Wavefront/OBJ, you might need to adjust the material in Blender before exporting. If a material is opaque and you expected it to be transparent, then you might simply need to set the Blend Mode to "Alpha Blend"

### Blender Exporting

You will edit the model in Blender and save to a .blend file. For Sitrec, export as .glb, which is the binary version of glTF, including both geometry and materials in a single file.
To export a file, use File->Export-> glTF 2.0 (.glb/.gltf).

Click on "Remember Export Settings" and then ensure the following are set:
![Blender-glb-export.jpg](docimages/Blender-glb-export.jpg)

Then export the file. If you want to embed a known real-world length, rename the file to include a length parameter (e.g. `my-drone~L3.5m~.glb`). You should now be able to drag and drop this into the Sitrec model inspector, or any moddable sitch that supports it (e.g. FLIR1).

### Aircraft navigation lights

Include working navigation lights when authoring aircraft models. A red or green lens mesh, even with an emissive material, is only visible geometry. **Sitrec's light glows, flashing controls, and long-exposure light trails require actual Blender light objects exported into the GLB.** Keep the small lens meshes for close views and put the corresponding light objects at their exposed surfaces.

#### Placement and orientation

Use the aircraft's left and right as seen by its pilot looking forward. With the Blender orientation documented above, **nose −Y and up +Z**, the port/left wing is **+X**, and the starboard/right wing is **−X**. After the normal Y-up glTF export, coordinates map as `(x, y, z) Blender → (x, z, −y) glTF`: forward becomes +Z, up becomes +Y, and port remains +X. Do not reverse the navigation colors based on the side of a screenshot.

| Light | Placement | Color | Behavior |
|---|---|---|---|
| Left position | Port wingtip, Blender +X | Red `(1, 0, 0)` | Steady |
| Right position | Starboard wingtip, Blender −X | Green `(0, 1, 0)` | Steady |
| Tail position | Aft-facing tail position appropriate to the aircraft | White `(1, 1, 1)` | Steady |
| Anti-collision beacon | Fin, fuselage top and/or belly, according to the aircraft | Red | Flashes |
| Strobes | Wingtip and/or tail locations appropriate to the aircraft | White | Short flashes |
| Landing/taxi lights, if included | Actual lamp positions; aim spotlights forward | White | Steady; switch visibility in Sitrec as needed |

This is an authoring convention for a recognizable aircraft light layout, not a simulation of certified visibility sectors or a claim that every aircraft has the same equipment. Use references for the particular variant. A fictional craft can use this convention if requested, but identify those lights as added visualization equipment rather than historical detail.

Use **Point** lights for position lights, strobes, and beacons. A **Spot** light can represent a landing beam. A Blender spotlight emits along its local −Z axis; aim that axis toward the aircraft's forward direction. Sitrec currently also creates a visible glow for a spotlight, and that glow does not obey the spotlight's beam angle.

Keep each lamp a separate light object. Mesh joining must include only the exterior meshes, not the lamps. Give both the object and its Light data a meaningful, stable name, such as `Left_Position_Red`, `Right_Strobe_White`, or `Beacon_Top_Red`. Unique names make the Lights menu understandable and avoid changes to generated light IDs and flash phases when re-exporting.

**Hierarchy matters:** export lights as unparented objects at their final model-space positions, alongside the aircraft meshes, with no transformed enclosing Empty. Ordinary Blender collections are fine. The current billboard implementation copies the imported light's *local* position into the owning Sitrec object's group; it does not reconstruct arbitrary nested parent transforms. A light under a rotated, scaled, or translated parent can therefore illuminate from one position while its visible glow appears elsewhere. Bake the aircraft's orientation and scale, then position the lights in that same coordinate system. Verify placement after import, not just in Blender.

#### Flash timing: custom properties on the Light data

Select a light and open **Light Data Properties → Custom Properties** (the light-bulb tab). Add numeric floating-point properties with these exact, case-sensitive names:

| Property | Meaning | Example |
|---|---|---|
| `strobeEvery` | Seconds from the start of one flash cycle to the next | `1.0` |
| `strobeLength` | Seconds the light stays on in each cycle | `0.1` |

Use positive values with `strobeLength < strobeEvery`. For a steady light, omit both properties. A missing or zero `strobeEvery` is treated as steady. When `strobeEvery` is present and nonzero, a missing or zero `strobeLength` falls back to **0.1 seconds** on import. Store numbers, not strings such as `"1 second"`.

The preferred location is the **Light data**, not its mesh lens, collection, material, or scene. In Python, this means `lamp.data["strobeEvery"]`, not `lens["strobeEvery"]`. With **Custom Properties** enabled during export, Blender writes Light-data properties into `KHR_lights_punctual.lights[].extras`; Three.js copies them into the imported light's `userData`, where Sitrec reads them. Properties on the light *object* can also work when that exported node is the light itself—the built-in 737 uses node extras—but Light-data properties avoid depending on whether the exporter inserts a wrapper node.

Sitrec generates `strobeOffset` from a hash of the complete light node ID, giving each flashing light a repeatable phase between 0 and approximately 5 seconds. **A Blender custom property named `strobeOffset` is not used by the current importer.** Adjust **Strobe Offset (s)** in Sitrec to align or stagger flashes. Equal periods do not imply synchronized flashes. Changing an object/light name can change its initial phase.

Flashing runs against simulation time (`par.time`), not Blender keyframes or wall-clock time. No animation export is required. During playback, Sitrec has a fallback to keep very short flashes from disappearing between sampled frames. Consequently, an extremely short flash can occupy one displayed frame; the long-exposure renderer instead integrates its actual duty cycle between samples. The present model supports one rectangular on-window per period, not a double-flash pattern.

#### Power and exporter settings

The working PA-28 reference uses **10 W** for its steady red/green position lights and **50 W** for white strobes, with `strobeEvery = 1.0` and `strobeLength = 0.01`. These are useful established Sitrec settings, not measured lamp specifications. The built-in 737 provides another convention: about **10 W** for position lights and white strobes (2.0 s period, 0.1 s flash), and **20 W** for its red belly beacon (1.0 s period, 0.1 s flash).

For a straightforward Blender 5.2 light, use constant color and Power, **Normalize enabled**, **Exposure 0**, and no custom light shader node network. Export with the glTF lighting mode **Standard** (`export_import_convert_lighting_mode='SPEC'`). The standard point/spot conversion is:

`glTF intensity = Blender Power × 683 / (4π)`

| Blender Power | Exported intensity, approximately |
|---|---:|
| 10 W | 543.514 |
| 20 W | 1087.028 |
| 50 W | 2717.571 |

Different exporter lighting modes, Exposure, non-normalized lights, and light shader nodes can change this conversion. Check the exported value instead of assuming Blender's Power number is Sitrec's Intensity number. Blender's light radius is also not Sitrec's **Radius** control: the latter controls the solid core of the glow.

In **File → Export → glTF 2.0**, enable:

- **Punctual Lights** (`export_lights=True`), which writes `KHR_lights_punctual`.
- **Custom Properties** (`export_extras=True`), which preserves flash timing.
- **Selected Objects** (`use_selection=True`), with the aircraft meshes **and** operational lights selected.
- **Active Scene** (`use_active_scene=True`), especially when the Blender file contains multiple aircraft scenes. Selection alone can include selected objects from other scenes.
- **+Y Up** (`export_yup=True`) and the Standard lighting mode above.

Exclude studio lights, cameras, ground planes, and other presentation objects from the selection. Hiding them in the viewport is not a reliable export filter. In particular, do not export a studio Point or Sun light under an arbitrary name: Sitrec would treat it as part of the model's light system.

This minimal Python example assumes the current scene is already in meters with the documented axes. The coordinates are illustrative; move the lamps to the actual lenses before exporting:

```python
import bpy

# Select the aircraft's exterior meshes before running this example.
aircraft_meshes = [obj for obj in bpy.context.selected_objects if obj.type == 'MESH']
if not aircraft_meshes:
    raise RuntimeError('Select the aircraft exterior meshes first')

def aircraft_light(name, position, color, watts=10.0, every=None, length=0.1):
    data = bpy.data.lights.new(name=name, type='POINT')
    data.color = color
    data.energy = watts
    data.normalize = True
    data.exposure = 0.0
    if every is not None:
        data['strobeEvery'] = float(every)
        data['strobeLength'] = float(length)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    return obj

nav_left = aircraft_light('Left_Position_Red', (5.4, 0.2, 0.15), (1, 0, 0))
nav_right = aircraft_light('Right_Position_Green', (-5.4, 0.2, 0.15), (0, 1, 0))
nav_tail = aircraft_light('Tail_Position_White', (0, 4.95, 0), (1, 1, 1))
strobe_left = aircraft_light('Left_Strobe_White', (5.4, 0.3, 0.15),
                             (1, 1, 1), watts=50, every=1.0, length=0.01)
strobe_right = aircraft_light('Right_Strobe_White', (-5.4, 0.3, 0.15),
                              (1, 1, 1), watts=50, every=1.0, length=0.01)
beacon = aircraft_light('Beacon_Tail_Red', (0, 4.4, 1.11),
                         (1, 0, 0), watts=20, every=1.0, length=0.1)

lamps = [nav_left, nav_right, nav_tail, strobe_left, strobe_right, beacon]
bpy.ops.object.select_all(action='DESELECT')
for obj in aircraft_meshes + lamps:
    obj.select_set(True)
bpy.ops.export_scene.gltf(
    filepath='/absolute/output/path/aircraft~L7.32m~.glb',
    export_format='GLB',
    use_selection=True,
    use_active_scene=True,
    export_yup=True,
    export_lights=True,
    export_extras=True,
    export_import_convert_lighting_mode='SPEC',
    export_cameras=False,
    export_animations=False,
)
```

#### What Sitrec does with the lights

`CNode3DObject.extractLightsFromModel()` discovers imported Three.js lights, initially disables their illumination, and makes an **Objects → [model] → Lights** folder. Each light gets its own `CNode3DLight`, a camera-facing glow, and controls:

| Control | Effect |
|---|---|
| Light Visible | Enables the glow and permits illumination; defaults on |
| Light Illuminates | Allows the actual light to illuminate scene surfaces; defaults off |
| Intensity | Imported glTF intensity; also changes the glow's base size (`intensity / 100`) |
| Color | Changes both the light and its glow |
| Radius | Changes the glow's bright central core, not a physical lamp radius |
| Strobe Every / Length / Offset (s) | Timing controls, present only when flashing was enabled on import |

The live glow faces each view's camera, grows with viewing distance/FOV to remain visible, and is reduced by daylight. It is a display aid, not a physically exact inverse-square lamp image. A point light is omnidirectional; the code does not apply the red/green/aft angular sectors of a real navigation-light assembly. Do not describe a colored point-light layout as a verified angular-visibility simulation.

The names `Sky_Dome`, `Light`, `Moon_Light`, `Lensflare_Source`, and `Sun_light` are explicitly ignored. This is a short, case-sensitive list, not a general studio-light detector. Avoid these names for operational lamps and exclude studio lighting from the GLB altogether. Name substrings such as "strobe" or "beacon" do **not** enable flashing; only the custom properties do that.

With **HDR Point Sources** enabled, [Long Exposure](LongExposure.md) replaces the live glows with photometric point sources. The current conversion is `effective candela = imported intensity × 0.2 × Light Brightness`, followed by inverse-square falloff and atmospheric extinction. It preserves the light color and integrates flash duty cycles, producing dashed strobe trails. `Light Visible` still gates the source; `Light Illuminates` need not be on for it to appear in the exposure.

#### Verification before delivering a model

1. Inspect the saved `.blend`: count operational lights, check left/right colors from the pilot's perspective, confirm final coordinates, and read flash properties from each Light data block. Save the file with the lights included.
2. Parse the **exported GLB**. Confirm `extensionsUsed` contains `KHR_lights_punctual`; check every light's type, color, intensity and extras; confirm its node has the intended translated position. Ensure there are no studio lights or extra aircraft scenes. Do not infer success from the Blender preview.
3. Load it with Three.js `GLTFLoader`, the same loader family Sitrec uses. Verify the resulting light objects have numeric `userData.strobeEvery` and `userData.strobeLength`, and that local positions already match model-space positions. A property on a parent Group is not sufficient.
4. Drag the GLB into **Model Inspector** or a new custom sitch. Open **Lights**, verify the expected names, inspect from both sides and behind, and play at dusk/night so daylight suppression does not hide the result. Toggle an individual light to check it is attached to the correct lens; check both views and change Model Length to verify the lights stay attached.
5. Check at least one flashing light at an on-time and an off-time. If synchrony matters, set matching Strobe Offset values in Sitrec and save the sitch. For long-exposure work, verify steady colored trails and dashed white/red flashes with HDR Point Sources enabled.

Common failures are missing Punctual Lights, missing Custom Properties, selecting only the joined mesh, placing timing properties on a lens mesh, reversed port/starboard colors, a lamp named `Light`, nested transforms, and exporting a preview light by accident.

#### Reference files and implementation

The inspected `PA28-181 Fixed textures.blend` contains only a default Point light named `Light`, which Sitrec ignores. The adjacent **`PA28-181 No interior.blend`** contains the working red/green and strobe setup described above. Its adjacent `PA28-181 No interior.glb` has no punctual lights, while the repository's **`data/models/PA28.glb`** contains five: two position lights, two strobes, and a landing spotlight. These files are different export states; always inspect the actual delivered GLB. The source `.blend` also contains a separate front landing Point light that is absent from that built-in GLB.

For agents checking or extending the pipeline, read the current implementation rather than assuming all fields in Blender are supported:

- [`CNode3DObject.js`](https://github.com/MickWest/Sitrec2/blob/main/src/nodes/CNode3DObject.js): `lightNamesToIgnore` and `extractLightsFromModel()`.
- [`CNode3DLight.js`](https://github.com/MickWest/Sitrec2/blob/main/src/nodes/CNode3DLight.js): custom-property handling, phase generation, controls, flashing, and camera-facing glow placement/scaling.
- [`LongExposure.js`](https://github.com/MickWest/Sitrec2/blob/main/src/LongExposure.js): `LIGHT_CANDELA_PER_INTENSITY`, `strobeOnFraction()`, and model-light integration.
- The installed Three.js `GLTFLoader.js`: `GLTFLightsExtension._loadLight()` and `assignExtrasToUserData()`.
- The installed Blender glTF exporter's `blender/exp/lights.py`: property export and power conversion. Exporter behavior described here was checked against Blender 5.2.1 LTS.

### PLY Files

PLY files don't go through the Blender export pipeline. They are typically produced by:
- **3D scanning** software (mesh or point cloud output)
- **Gaussian Splatting** training tools (e.g. from COLMAP → 3DGS training)
- **Point cloud** capture tools (LiDAR, photogrammetry)

Sitrec auto-detects which type of PLY it is by inspecting the file header. If the PLY has face elements, it's loaded as a mesh. If it has `scale_0`/`rot_0` attributes, it's treated as a Gaussian splat. Otherwise it's rendered as a point cloud.

Gaussian splat PLY files are rendered with proper elliptical splatting and per-frame back-to-front sorting for correct transparency. The filename length parameter (`~L...~`) works with PLY files too.
