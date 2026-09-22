# Panoramic Camera

Open **Camera → FOV (Zoom) → Panoramic Camera** and enable **Panoramic Camera**
to show a swept panorama in the look view.

- **Panorama HFOV °** sets the horizontal span from **1° to 360°**.
- **Panorama VFOV °** sets the vertical span from **1° to 180°**.
- The look-view scroll wheel and pinch zoom both spans together, keeping their ratio.

The two fields are independent of the normal camera FOV. Disabling panorama restores
the normal projection, and saved sitches retain the panorama settings. Enabling
Fisheye turns panorama off, and enabling panorama turns Fisheye off.

The projection spaces horizontal and vertical angles evenly across the image
(equirectangular). A 360° horizontal span wraps behind the camera; a 180° vertical
span reaches both poles. To match a wide panorama photograph, use a wide look-view
pane and adjust the two fields separately. The camera's heading, tilt and roll set
the panorama's orientation.

Terrain and 3D buildings load across the selected angular window. Tile detail follows
the number of pixels each angle occupies, so widening the view covers more ground
without requesting the old zoom level everywhere. Water reflections and sky labels
follow the panorama as well.

The experimental ray-traced refraction pass and headset rendering use perspective
cameras. Panorama uses the normal terrain-refraction model and the desktop look view.
