# Sitch Chapters

A custom sitch can have several **chapters**. Each chapter keeps its own setup: the views,
the cameras, the date and time, the current frame and the timeline markers. The rest of the
sitch is shared by all the chapters: the tracks, the objects, the terrain, the video and the
other settings.

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
| **Advanced: restore scope** | The kinds of data that are applied when you switch to a chapter |

## Switching chapters

When you switch to another chapter, Sitrec first stores the current setup in the chapter that
you leave. Then it applies the setup of the chapter that you switch to. Your edits to a
chapter stay in that chapter.

Switching chapters clears the undo history, so **Ctrl/Cmd+Z** cannot undo an edit that you made
before the switch. Deleting a chapter and restoring a chapter also clear it.

The chapters are saved with the sitch. The edits stay in memory until you save the sitch
(see [Saving and Loading Sitches](SavingAndLoading.md)).

## Timeline markers in chapters

Each chapter has its own [timeline markers](TimeAndSync.md#the-playback-bar). When you switch
chapters, the markers on the timeline change to the markers of that chapter. To add, rename or
delete a marker, right-click the timeline. The change applies to the current chapter.

If **Timeline markers** is off in the capture scope, a chapter does not keep markers, and the
markers stay the same when you switch to that chapter.

A sitch saved by Sitrec 2.176.0 to 2.177.1 can have **timeline events** in its chapters. When you
load it, the events of each chapter become timeline markers of that chapter. An event on the
same frame as a marker is added to the label of that marker, after a semicolon.

## Satellite rise and set markers

**Add satellite rise / set markers** adds a marker at each time that a satellite rises above,
or sets below, the horizon between the first frame and the last frame of the sitch. The marker
is labeled **<satellite> rises** or **<satellite> sets**. The command is also in the timeline's
right-click menu.

- Load satellite data first (see [Satellites](Satellites.md)). Only the satellites that are
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

1. Select a server version of the current sitch, or a saved `.json` or `.js` sitch file.
2. Select a chapter of that save.
3. Confirm. The setup of the chapter that you selected becomes the setup of the current
   chapter. The other chapters do not change.

Before the restore, Sitrec adds a **recovery chapter** named **<name> (before restore)**. It
keeps the setup that the current chapter had before the restore. A recovery chapter keeps all
the kinds of data, whatever the capture scope, so that it has everything that the restore can
change.

## Capture and restore scope

The two **Advanced** folders select which kinds of data a chapter keeps (capture scope) and
which kinds are applied when you switch to a chapter (restore scope):

| Kind | Default capture | What it includes |
|---|---|---|
| **Views** | On | The views: their positions, sizes and settings |
| **Cameras** | On | The main and look cameras, the camera position, heading and field of view |
| **Date/Time** | On | The start date and time |
| **Measurement** | On | The two measurement points A and B |
| **Timeline markers** | On | The timeline markers |
| **Others** | Off | Lighting, effects, the target and the traverse object |

All the kinds are on in the restore scope by default. A chapter always keeps its current
frame. The scope settings are not saved with the sitch.
