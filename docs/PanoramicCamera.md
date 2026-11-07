# Panoramic Camera

Panoramic Camera draws the look view (the view from the simulated camera) as one wide image,
up to the full 360° around the camera. Use it to see the whole horizon from one place, or to
compare the 3D scene with a wide panorama photograph. It does not change a loaded video.

Sitrec draws the image live from the 3D scene, at the current frame, from one camera position
and direction. To build a panorama across the frames of a sitch, see **Export Look Panorama** in
[Rendering and Exporting Video](Video.md) and the **Video → Motion Analysis → Panorama** tools
in [Motion Analysis](MotionAnalysis.md#d-panoramas).

Panoramic Camera is available in custom sitches only. To turn it on, open
**Camera → FOV (Zoom) → Panoramic Camera** and tick **Panoramic Camera**, the checkbox on the
folder title.

![A 360-degree panorama from above the South Rim of the Grand Canyon, as a wide rectangle with black bars above and below it. A straight horizon runs across the middle, blue sky fills the top half, and the canyon is at the center. The Sun is a wide, flat bright patch at the upper right. The Panoramic Camera folder floats at the top left, set to Panorama HFOV 360 and Panorama VFOV 180.0](docimages/panoramic-camera-360.jpg)

The look view, enlarged to fill the window, with the **Panoramic Camera** folder dragged out of its menu. **Panorama HFOV °** is 360 and **Panorama VFOV °** is 180, so the image has a 2:1 ratio, and black bars fill the extra height of the pane. The camera is above the South Rim of the Grand Canyon. It points at the canyon, which is at the center of the image. The left and right edges show the same direction, behind the camera. With the camera level, the top edge is straight up and the bottom edge is straight down. Each row of the image covers the full 360°, so anything far from the center line stretches sideways: the Sun at the upper right looks wide, and the ground below the camera smears along the bottom edge.

## Controls

- **Panorama HFOV °** sets the horizontal field of view (HFOV), the angle across the image,
  from **1° to 360°**. The default is **180°**.
- **Panorama VFOV °** shows the vertical field of view (VFOV). It is read-only. VFOV = HFOV ×
  height ÷ width of the look-view pane, so one degree covers the same number of pixels in both
  directions. On a 16:9 pane, an HFOV of 180° gives a VFOV of about 101°.
- VFOV stops at **180°**. Beyond that, black bars fill any extra height rather than stretching
  the image. A full **360° × 180°** panorama has a **2:1** image ratio.
- The look-view scroll wheel, pinch and keyboard zoom adjust HFOV.

Panorama HFOV is independent of the normal camera FOV. The camera frustum in the main view still
shows the normal camera FOV. Saved sitches keep the on/off state and HFOV.

Enabling [Fisheye](Fisheye.md) turns panorama off, and enabling panorama turns Fisheye off. While
Panoramic Camera is on, the normal FOV controls and the Fisheye controls are hidden. Their values
are kept.

## How the projection works

The projection spaces horizontal and vertical angles evenly across the image (equirectangular).
The image center is the direction that the camera points. A 360° HFOV wraps behind the camera,
so the left and right edges of the image meet there. A 180° VFOV reaches 90° above and 90° below
the image center.

These angles are measured from the camera's own forward and up axes, not from the ground. The
camera's **Pan (Az)**, **Tilt (El)** and **Roll**, and the Camera Tweaks **xOffset** and
**yOffset**, set the panorama's orientation. With **Tilt (El)** and **Roll** at 0, the horizon is
a straight horizontal line. Any other tilt or roll curves it.

![The same 360-degree panorama of the Grand Canyon with the camera tilted up. The horizon is now a wave: it falls low in the middle of the image, above the canyon, and rises high at the left and right edges. The Panoramic Camera folder and the Heading folder float at the top, with Pan (Az) 0, Tilt (El) 25 and Roll 0](docimages/panoramic-camera-tilted.jpg)

The same view with **Tilt (El)** at 25. The **Camera → Heading** folder is dragged out of its menu, and **Pan (Az)** and **Roll** stay at 0. The camera tilts up, so the horizon falls below the center line in the middle of the image. It rises above the center line at the left and right edges, behind the camera. The curve comes from the tilt, not from the terrain.

## Matching a panorama photograph

You need a photograph, its horizontal span in degrees, and the place it was taken from.

1. Set the camera location and time as usual.
2. Crop a copy of the photograph so that the horizon is at mid-height, because a level camera
   puts level directions on the center line.
3. Drop the photograph on Sitrec and choose **Video Image**. See
   [Images as video](LoadingVideo.md#images-as-video).
4. Drag the look-view pane to the same shape as the photograph.
5. Set **Panorama HFOV °** to the horizontal span of the photograph. VFOV follows. For example,
   a 6000 × 2000 photograph that covers 360° needs a 3:1 pane, and VFOV is then 120°.
6. Keep **Tilt (El)** and **Roll** at 0, and set **Pan (Az)** to the direction at the center of
   the photograph.
7. Raise **Vid Overlay Trans %** in the View menu to fade the photograph over the look view. Keep
   **Video Zoom %** at 100%. When the match is correct, landmarks line up across the whole width
   of the image.

Sitrec uses only the equirectangular mapping. A photograph stored with another vertical mapping
lines up only near its horizon.

## Terrain and buildings

Terrain and 3D buildings load across the whole area that the panorama shows. Sitrec selects tile
detail from the number of pixels that cover each degree, so a wider view loads coarser tiles over
a larger area. Water reflections and sky labels follow the panorama as well.

## What does not apply

- The **Ray-traced** refraction model has no effect on the panorama. The panorama uses the
  **Standard** model and its settings in **Effects → Atmospheric Refraction**. See
  [Atmospheric Refraction](Refraction.md).
- **Look Y-comp** and **Match Video Aspect** do not apply to the panorama.
- In a headset, the look view uses its normal projection and not the panorama.

## See also

- [Fisheye (Allsky) Projection](Fisheye.md), for footage from a fisheye lens
- [The Camera and Target Menus](CameraAndTarget.md)
- [Rendering and Exporting Video](Video.md)
- [Motion Analysis](MotionAnalysis.md)
