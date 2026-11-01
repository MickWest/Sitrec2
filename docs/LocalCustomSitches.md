# Local Custom Sitches in Sitrec

> **⚠️ Deprecated.** Hand-authoring `Sit*.js` files is no longer the recommended way to build a sitch. Use the drag-and-drop custom sitch tool instead — see [Getting Started with Sitrec](CustomSitchTool.md). This page is kept for existing hand-written `Sit*.js` files, which include the bundled sitches that still ship in this form; new sitches should not be created this way.

A **sitch** (short for *situation*) is one Sitrec scene: a place, a span of time, and the camera, tracks, objects and video that recreate an event. You can save and share a sitch, but it is a sitch before you save it.

Hand-written sitches are defined using a Javascript style structure stored in a file that starts with "Sit" and ends with .js. Each Sitch is inside a folder that can (optionally) contain asset files (like KML or MISB tracks, CSV data files, or 3D models).

Sitrec is primarily aimed  with recreating an event that happens over the course of a few seconds or minutes. The main way it does this is with *time series data*. 

### Time Series Data (TSD)

Time series data is data that is recorded at specified intervals of time. The most obvious example is a video, where individual frames of the video are data, and they are recorded at regular interval, like 30 frames per second. 

TSD is often recorded at regular intervals, but can be at irregular intervals. The intervals can be small or large. 

When we play a sitch, we are essentially creating an interactive video. Sitrec will try to match the original video frame rate. So if there is TSD that has a different interval from the video, then we will need to interpolate intermediate data for the missing time intervals. 

Since matching source video is so fundamental to Sitrec, and since we often want to advance the simulation by individual frames matching the video, it's convenient that the unit of time used is **one frame**.  

This means that the unit of time can vary. One frame is often 1/30th of a second, but could be other fractions of a second, like 1/60, 1/29.97, 1/24, 1/25 and others. The length of a frame is defined by the **frames per second** set in the sitch file. If none is specified, then **fps** will default to 30. 

The time part of the sitch is defined by two other variable, the **frames** and **startTime**.

**frames** is the number of frames in the sitch, which will typically be the number of frames in a video, but also might represent a simple time interval. 

The duration of the sitch in seconds is given by **duration = frames/fps**, hence **frames = duration * fps**

**startTime** is the date and time at the start of the sitch, in UTC time. It's the time at the start of the first frame. Frames in the sitch are zero based. Meaning the at frame 0, the time will be equal to startTime, and at frame **f** the time will be **startTime + (f / fps)**

Example

```javascript
    fps: 29.97,
    frames: 19480, // (10*60+50)*29.97,
    startTime: "2023-08-05T07:39:13.000Z",
```
Here the sitch has a video running at 29.97 fps. For a video with a variable frame rate, see [VFR Fix](LoadingVideo.md#variable-frame-rate-vfr-fix).  
The **frames** value is set to 19480. The part of the line after // is a "comment", meaning it is helpful info for you the reader, but it is ignored by the code. Here I'm noting that the value 19480 comes from multiplying a duration in seconds by the fps. The (10*60+50) is the number of seconds in 10 minutes and 50 seconds. 

The startTime value is a UTC date and time in the format YYYY-MM-DDTHH:MM:SS.mmmZ (where mmm is milliseconds). The milliseconds are optional.

### Sitch File Format

The above example is part of a sitch file. Notice each line has two fundamental parts, a key followed by a colon(:), and a value followed by a comma (,). This is a necessary part of each line, and omitting the colon or comma will result in errors.

The simplest sitch file would look like:

```javascript
export const SitEmpty = {
    name: "empty",
}
```

The line **export const SitEmpty = {** is not used, but makes it backwards compatible with the legacy built-in sitches (which required recompiling the entire project)

A more functional sitch, with comments explaining what each line does. This is a shortened form of [SitSWR.js](https://github.com/MickWest/Sitrec2/blob/main/data/swr/SitSWR.js).
```javascript
export const SitSWR = {
    name: "swr",                    // the name of the sitch, which we can use with "include_"
    menuName: "Skinwalker Ranch",   // Name displayed in the menu

    // Terrain Lat/Lon is the center of the map
    // zoom is the zoom level of the map (2 to 15 in the Terrain menu)
    // nTiles is the size of the square region to load (in tiles, so here 4x4)
    terrain: {lat: 40.2572028, lon: -109.893759, zoom: 14, nTiles: 4},

    // a single camera, with the position and heading define by two LLA points
    mainCamera: {
        startCameraPositionLLA:[40.254018,-109.880925,1685.104643],
        startCameraTargetLLA:[40.257957,-109.891099,1439.697690],
    },
    
    // a full screen view. The size and position are fractions of the window size
    // background is the color of the sky.
    mainView: {left:0.0, top:0, width:1,height:1, background: [0.53, 0.81, 0.92],},
}
```
LLA means latitude, longitude and altitude. In a sitch file, altitude is in meters above [mean sea level (MSL)](GIS.md#three-kinds-of-height).

Here we see more complex values, which are themselves key:value *objects* - i.e. a list of named parameters with values.

Notice that the value for the **mainCamera:** key is over four lines. This is normal Javascript, but it's important to recognize that **startCameraPositionLLA:** is a parameter of **mainCamera** and not of the sitch.  

### Creating a Local Custom Sitch

The create your own sitch, the simplest way it to start with an existing sitch. You can do this in two ways:
1) Copy an existing sitch, e.g. [SitSWR.js](https://github.com/MickWest/Sitrec2/blob/main/data/swr/SitSWR.js), and rename it.
2) Use the include_ directive to include an existing sitch and just override the parts you need. 

Either way, you will need to create a local folder (i.e. a folder on your computer) and put the sitch file in it. This folder will also contain any other local assets you might want to use, like a .KML or .CSV file


### Copying an existing sitch

For example, say we want a bare-bones version of the SWR sitch, but we want to change the location. We see we have location data in the terrain: and mainCamera: definitions. Initially the best approach is to remove any camera locations and just edit the terrain location. So the steps are:

1) Create a folder called CustomTest
2) Copy the SWR sitch, [SitSWR.js](https://github.com/MickWest/Sitrec2/blob/main/data/swr/SitSWR.js), to the CustomTest folder, and rename it SitCustomTest.js
3) Edit it to A) remove the camera position. B) change the terrain position. C) remove `canvasResolution`. D) replace `mainView` with the short form below, which has no blur effect.
```javascript
export const SitCustomTest = {
name: "customtest",                    // the name of the sitch, which we can use with "include_"
menuName: "Custom Test",   // Name displayed in the menu

    terrain: {lat: 37.2339, lon: -115.80446, zoom: 14, nTiles: 4},
    mainCamera: {},
    mainView: {left:0.0, top:0, width:1,height:1, background: [0.53, 0.81, 0.92],},
}
```
Local folder access needs Chrome or Microsoft Edge. In Sitrec, click **File → Local → Select Local Sitch Folder**, then navigate to the folder and click "Open" (you are opening the folder, so you don't need to select the .js file)

Since Sitrec runs in a browser, it needs your permission to read and write the folder, so accept the browser's prompts. This sets the working folder. It does not load a sitch.

Then click **File → Local → Open Local Sitch**, which appears now that a folder is set, and select SitCustomTest.js. The **Local** submenu title now also shows the folder name. You should see a view of the new location.

**Open Local Sitch** also accepts a saved `.json` sitch. A `.json` saved from a hand-written sitch is the exception: it holds only your changes against the sitch named in `name`, so it does not open the sitch you wrote.

By default if there's no camera position specified, the camera will be high up, looking down. To fix this click on the terrain and zoom in with the mouse wheel, and adjust the view to a good position. To read the camera position, click **File → Local → Save Local As...**. Open the saved .json file in a text editor and find `mainCamera` under `mods`. Copy `startPosLLA` into `startCameraPositionLLA` and `lookAtLLA` into `startCameraTargetLLA`, in the mainCamera definition of the .js file, like:
```javascript
    mainCamera: {
    	startCameraPositionLLA:[37.255071,-115.803489,1543.399930],
		startCameraTargetLLA:[37.248309,-115.810684,1380.600230],
	},
```
Then save the file. **Sitrec does not watch the file**, so to see your change click **Open Local Sitch** and select SitCustomTest.js again. You should see something like this view of the new location:
![Terrain at Area 51 from the sample camera position, with a light blue sky, a mountain behind the base and a dry lake bed at the right](docimages%2F2024-03-28_11-11-56.jpg)

### Including an existing sitch

Instead of copying the entire file, you might want to just make a few changes to a complex sitch. The simplest way of doing that is to use "include_" followed by the name of the sitch. The name here is the value defined in the sitch, e.g. "swr", and not the filename (so NOT "SitSWR.js").

The include_ directive will override anything that comes before it, and then any lines after will override that. So here we use the SWR sitch, but change the mainView to be half the width of the screen, and change the background (sky) color to grey. 

```javascript
export const SitCustomTest = {
    include_swr: true,
    mainView: {left:0.0, top:0, width:0.5,height:1, background: [0.2, 0.2, 0.2]},
}
```

Giving:
![Sitrec window with the terrain and a grey sky in the left half, and black in the right half](docimages%2F2024-03-28_11-23-36.jpg)
(Notice the grey sky. The right half of the window is black because no view covers it.)

The include_ method is a nice easy way of taking a sitch that resembles what you want, and only modify the relevant parts. It makes it clear what you've changed.

### Adding custom local data

A common UAP scenario is video of an object filmed out of a plane window, where the object is suspected to be another plane. To accurately recreate this situation you need:
1) The video
2) The time of the start of the video
3) The approximate location
4) The ADS-B tracks of the planes

For this example we will take an existing sitch, N14AQ, and convert it into a stich based on a video from Kansas

### Including the parent sitch, and adding the video

As before, we make a folder, and add a new file, Sitkansas2.js. We also add the new video file to the folder. We also need to check how long it is (in frames) and check the fps (30). We now have a sitch file that will show the video
```javascript
export const SitKansas = {
	include_n14aq: true,
    videoFile: "124984_Kansas.mp4",
    frames: 569,
}
```

However, it's still showing the location and tracks from the old sitch. So we need to get the two ADS-B tracks we are interested in and add them to the folder:
![Folder holding the video, two KML tracks and the sitch file](docimages%2FContents-of-custom-kansas.jpg)

Then we modify the local sitch:
```javascript
export const SitKansas = {
	include_n14aq: true,
    videoFile: "124984_Kansas.mp4",
    frames: 569,
    files: {
        cameraFile:'N615UX-track-EGM96.kml',
        TargetTrack: 'N121DZ-track-EGM96.kml'
    },
    startTime: "2022-09-01T20:07:32.3Z",
}
```
**Known problem:** a KML file named in `files:` and read from the local folder stops the sitch from loading. The console shows `newSitch: transition failed`, and no terrain or track appears. Until this is fixed, host the two KML files and put their URLs in `files:` (see [Sharing and Rehosting](#sharing-and-rehosting)). The video can stay in the local folder.

When we save and open that, the target model does not load. You'll see an error in the console: "Failed to load model: TargetObjectFile", and you'll note that the original sitch had a line in files of **TargetObjectFile: './models/B737Max8.glb**', along with a later line that uses this "**targetObject: {file: "TargetObjectFile"},**". This might happen when you inherit a sitch. You need to manually add the missing file reference, or remove where it's used. The latter is simplest, and we can just add a line: **    targetObject: null,**

The final steps to get this working is to add the terrain, and to reset the mainCamera to defaults {}, so we have:
```javascript
export const SitKansas = {
	include_n14aq: true,
    videoFile: "124984_Kansas.mp4",
    frames: 569,
    files: {
        cameraFile:'N615UX-track-EGM96.kml',
        TargetTrack: 'N121DZ-track-EGM96.kml'
    },
    startTime: "2022-09-01T20:07:32.3Z",
    targetObject: null,
    terrain: {lat: 38.890803, lon: -101.874630, zoom: 9, nTiles: 8},
    mainCamera: {},
}
```

With your KML URLs in place of the local file names in `files:`, we now have a working custom sitch. There are some remaining cosmetic steps. First, as above, we adjust the camera and add the camera position to mainCamera.

Secondly, notice the black bands at each side of the video:
![The video view, with black bands at each side of the video](docimages%2FKansas-video-has-black-bars.jpg)
This is because the aspect ratio of the video is different to N14AQ. We can fix this with:
```javascript
    videoView: { left: 0.5, top: 0.1, width: 0.25, height: -1.77777777,},
    lookView: { left: 0.75, top: 0.1, width: 0.25, height: -1.77777777,},
```

### View position and size. 

A view's position is define by left and top, and the size by width and height. Left and top are the offsets from the left and top of the window, as a fraction of the window size. So in the example above we have two views occupying the right half of the screen, one at 0.5 and the other at 0.75. Both are 0.1 from the top of the window.
The width and high are also fractions of the window width and height, *unless* they are negative, in which case they are fractions of the other value. So a height of -1.7777 will be 1.7777 times the width. This allows use to have a fixed aspect ratio that matches the video. If done correctly the vide will play with no back bars. 
The 1.777777 number here is simply the height of the video divided by the width. 

So our final sitch file is as follows. Again, replace the local file names in `files:` with your KML URLs.
```javascript
export const SitKansas = {
	include_n14aq: true,
    videoFile: "124984_Kansas.mp4",
    frames: 569,
    files: {
        cameraFile:'N615UX-track-EGM96.kml',
        TargetTrack: 'N121DZ-track-EGM96.kml'
    },
    startTime: "2022-09-01T20:07:32.3Z",
    targetObject: null,
    terrain: {lat: 38.890803, lon: -101.874630, zoom: 9, nTiles: 8},
    mainCamera: {
        startCameraPositionLLA:[38.185549,-101.651511,44720.548136],
        startCameraTargetLLA:[38.193124,-101.655798,44351.373688],
    },
    videoView: { left: 0.5, top: 0.1, width: 0.25, height: -1.77777777,},
    lookView: { left: 0.75, top: 0.1, width: 0.25, height: -1.77777777,},
}
```

### Sharing and Rehosting

As it's a local sitch on your computer, it's visible only to you. To share it, upload the .js file and its assets to a host that allows cross-origin requests: that is, it lets a page on one site read a file from another site. A host can show a file in a browser tab and still not allow this. Replace the local file names in the .js file with URLs. Then share a link that has the URL of the .js file:

`https://www.metabunk.org/sitrec/?custom=<URL of the .js file>`

A save to the server does not keep a hand-written sitch. It saves only your changes against the sitch named in `name`, so its link does not open the sitch you wrote. To save a sitch to the server, build it with the custom sitch tool. See [Saving and Loading Sitches](SavingAndLoading.md).

### Work in progress

This is all still very much a work in progress, and is subject to improvement. I welcome bug reports (and fixes!) and feature suggestions

<mick@mickwest.com>


