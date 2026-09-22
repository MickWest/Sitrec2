# Panoramic Camera

Open **Camera → FOV (Zoom) → Panoramic Camera** and enable **Panoramic Camera**
to show a swept panorama in the look view.

- **Panorama HFOV °** sets the horizontal span from **1° to 360°**.
- **Panorama VFOV °** is read-only. It follows HFOV and the view's aspect ratio,
  keeping the same pixels per degree horizontally and vertically.
- At the **180°** vertical limit, black bars fill any extra height rather than
  stretching the image. A full **360° × 180°** panorama has a **2:1** image ratio.
- The look-view scroll wheel and pinch adjust HFOV; VFOV follows automatically.

Panorama HFOV is independent of the normal camera FOV. Disabling panorama restores
the normal projection, and saved sitches retain the panorama settings. Enabling
Fisheye turns panorama off, and enabling panorama turns Fisheye off.
Only the active projection's settings are shown. The Fisheye and Panoramic Camera
switches remain available so you can change modes or return to the normal camera.

The projection spaces horizontal and vertical angles evenly across the image
(equirectangular). A 360° horizontal span wraps behind the camera; a 180° vertical
span reaches both poles. To match a wide panorama photograph, use a wide look-view
pane and adjust HFOV. Resizing the pane updates VFOV automatically. The camera's heading, tilt and roll set
the panorama's orientation.

Terrain and 3D buildings load across the selected angular window. Tile detail follows
the number of pixels each angle occupies, so widening the view covers more ground
without requesting the old zoom level everywhere. Water reflections and sky labels
follow the panorama as well.

The experimental ray-traced refraction pass and headset rendering use perspective
cameras. Panorama uses the normal terrain-refraction model and the desktop look view.
