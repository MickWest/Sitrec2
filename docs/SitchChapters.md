# Sitch Chapters

A sitch can have several **chapters**. Each chapter keeps its own setup: the views, the
cameras, the date and time, the current frame, the measurement points and the timeline markers.
The rest of the sitch is shared by all the chapters: the track data, the objects, the terrain,
the loaded videos and the other settings. A chapter does keep which source sets the camera
**Position**, but not the **Manual** position. See
[Capture and restore scope](#capture-and-restore-scope).

Use chapters to keep several setups of one event in one sitch. For example, one chapter can
show the event from the camera, and another chapter can show it from above. Or one chapter
can show the start of a video, and another chapter can show the end.

The chapter controls are in **File → Sitch Chapters**. A sitch always has at least one
chapter. A new sitch has one chapter, named **Chapter 1**.

## The Sitch Chapters menu

| Item | What it does |
|---|---|
| **Add chapter** | Makes a new chapter from the current setup, and switches to it. A new chapter is named **Chapter N** |
| **Rename chapter** | Gives the current chapter a new name |
| **Delete chapter** | Deletes the current chapter, after you confirm, and switches to the next chapter (or to the previous chapter, if the current chapter is the last one). You cannot delete the only chapter |
| **Revert sitch to last save / load** | Discards all the edits made since the sitch was last saved or loaded, after you confirm, and loads the sitch again. This reverts the whole sitch, not only the chapters |
| **Restore chapter from server version…** | Loads one chapter from a saved server version of this sitch into the current chapter. See [Restoring one chapter](#restoring-one-chapter) |
| **Restore chapter from saved file…** | Loads one chapter from a saved sitch file into the current chapter. See [Restoring one chapter](#restoring-one-chapter) |
| **Chapters** | One button for each chapter. **●** marks the current chapter. Click a chapter to switch to it |
| **Add satellite rise / set markers** | Adds a timeline marker at each satellite rise and set during the sitch. See [Satellite rise and set markers](#satellite-rise-and-set-markers) |
| **Advanced: capture scope** | The kinds of data that a chapter keeps. See [Capture and restore scope](#capture-and-restore-scope) |
| **Advanced: restore scope** | The kinds of data that are applied when you switch to a chapter or restore a chapter |

## Switching chapters

When you switch to another chapter, Sitrec first stores the current setup in the chapter that
you leave. Then it applies the setup of the chapter that you switch to. Edits to the setup of a
chapter stay in that chapter. Edits to a shared part of the sitch, such as a track or (by
default) the target, show in all the chapters.

Switching chapters clears the undo history, so **Ctrl/Cmd+Z** cannot undo an edit that you made
before the switch. Deleting a chapter and restoring a chapter also clear it.

The chapters are saved with the sitch. A saved sitch opens at the chapter that was current when
you saved it. The edits stay in memory until you save the sitch (see
[Saving and Loading Sitches](SavingAndLoading.md)).

## Timeline markers in chapters

Each chapter has its own [timeline markers](TimeAndSync.md#the-playback-bar). When you switch
chapters, the markers on the timeline change to the markers of that chapter. To add, rename or
delete a marker, right-click the timeline. The change applies to the current chapter.

If **Timeline markers** is off in the capture scope, a chapter loses its stored markers when you
leave it. When you switch back to that chapter, the timeline does not change.

A sitch saved by Sitrec 2.176.0 to 2.177.1 can have **timeline events** in its chapters. When you
load it, the events of each chapter become timeline markers of that chapter. An event on the
same frame as a marker is added to the label of that marker, after a semicolon.

## Satellite rise and set markers

**Add satellite rise / set markers** adds a marker at each time that a satellite rises above,
or sets below, the horizon between the first frame and the last frame of the sitch. The marker
is labeled *satellite name* **rises** or *satellite name* **sets**. The command is also in the
timeline's right-click menu.

![The right-click menu of the timeline, titled Timeline: Frame 19. It has the rows Add Marker at Current Frame (0), Add Marker Here (19) and Add satellite rise / set markers, and an open Go to Marker (5) folder. The folder lists STARLINK-1108 sets at frame 1036, STARLINK-1115 sets at frame 1277, STARLINK-1092 rises at frame 1430, STARLINK-1062 sets at frame 2382 and STARLINK-1145 sets at frame 2504. To the right of the menu, five small cyan flags hang from the top of the white timeline bar](docimages/sitch-chapters-satellite-markers.jpg)

*The timeline after **Add satellite rise / set markers**. Each cyan flag is one marker. The flags
do not show their labels. To read a label, put the pointer on a flag, or right-click the timeline
and open **Go to Marker**. This folder lists each marker with its label and its frame. Here it
lists the five flags from left to right.*

- Load satellite data first (see [The Satellites Menu](Satellites.md)). Only the satellites that are
  shown in the sky are included (see
  [Which satellites are shown](Satellites.md#which-satellites-are-shown)).
- The horizon is 0° elevation (the horizontal plane) at the look camera's position at the
  current frame. Terrain and refraction are not included. A camera that moves during the sitch
  is taken to stay at that position.
- Sitrec calculates the satellite elevations at 30-second intervals, and finds the time of each
  crossing by linear interpolation between the two calculations on each side of it. A satellite
  that rises and sets again within 30 seconds (a pass that only touches the horizon) can be
  missed.
- If a frame already has a marker, the new label is added to its label, after a semicolon.
  A marker that already has the label does not change, so you can use the command again.
- **Ctrl/Cmd+Z** removes the markers that the command added.

## Restoring one chapter

**Restore chapter from server version…** and **Restore chapter from saved file…** load the
setup of one chapter from a saved copy of a sitch:

1. Select a server version of the current sitch (sign in first), or a saved `.json` or `.js`
   sitch file.
2. Select a chapter of that save.
3. Confirm. The setup of the chapter that you selected becomes the setup of the current
   chapter. The other chapters do not change.

Before the restore, Sitrec adds a **recovery chapter** named *chapter name*
**(before restore)**. It keeps the setup that the current chapter had before the restore. A
recovery chapter keeps all the kinds of data, whatever the capture scope, so that it has
everything that the restore can change.

## Capture and restore scope

The two **Advanced** folders select which kinds of data a chapter keeps (capture scope) and
which kinds are applied when you switch to a chapter or restore a chapter (restore scope):

| Kind | Default capture | What it includes |
|---|---|---|
| **Views** | On | The views: their positions, sizes and settings, the text in the Notes view, the **Rendering Effects** checkbox, which of the look view's blur, static noise, levels and JPEG artifact effects are on, and which video is selected in **Video → Current Video** |
| **Cameras** | On | The main and look cameras, the **Position**, **Camera Heading** and **Camera FOV** sources, and the pan, tilt, roll and field of view. The **Manual** latitude, longitude and altitude are shared by all the chapters |
| **Date/Time** | On | The start date and time, the time zone and the **Simulation Speed** |
| **Measurement** | On | The start and end points of the measurement that you set with the **V** and **B** keys. The items in **Show → Measurements** are shared by all the chapters |
| **Timeline markers** | On | The timeline markers |
| **Others** | Off | Lighting, the **Enable Video Effects** checkbox, the target and the traverse object |

The other effect settings are shared by all the chapters. All the kinds are on in the restore
scope by default. A chapter always keeps its current frame. The scope settings are not saved
with the sitch.

Sitrec stores a chapter again each time you leave it, with the current capture scope. So a kind
that is off in the capture scope is deleted from that chapter. A kind that is off only in the
restore scope is not applied when you switch to the chapter, and when you leave it, the data on
the screen replaces the stored data of that kind.
