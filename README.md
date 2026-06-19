# Sitrec2

![sitrec](https://github.com/MickWest/Sitrec2/actions/workflows/ci.yml/badge.svg?event=push)

Sitrec (Situation recreation) is a web application that allows for the real-time interactive 3D recreation of various situations. It was created initially to analyze the US Navy UAP/UFO video (Gimbal, GoFast, and FLIR1/Nimitz), but has expanded to include several other situations (referred to as "sitches"). It's written mostly by [Mick West](https://github.com/MickWest), with a lot of input from the members of [Metabunk](https://www.metabunk.org).

Here's a link to [Sitrec on Metabunk](https://www.metabunk.org/sitrec).

My goal here is to create a tool to effectively analyze UAP/UFO cases, and to share that analysis in a way that people can understand it. Hence, I focused on making Sitrec run in real-time (30 fps or faster), and be interactive both in viewing, and in exploring the various parameters of a sitch.  

### User Documentation

- [The Sitrec User Interface - How the menus work](docs/UserInterface.md)
- [The Custom Sitch Tool - Drag and Drop Sitches](docs/CustomSitchTool.md)
- [Local Custom Sitches - JSON-based sitch definitions for advanced setups](docs/LocalCustomSitches.md)
- [Loading and Filtering Tracks - Formats, importing, filtering, and display](docs/Tracks.md)
- [Wind in Sitrec - Wind menu, atmospheric data sources, streamlines](docs/Wind.md)
- [Saving and Loading Sitches - Server saves and local folder workflow](docs/SavingAndLoading.md)
- [Custom Models and 3D Objects - Add your own planes](docs/CustomModels.md)
- [Camera Modes - Normal (Az/El) and Satellite (quaternion) view modes](docs/satcam.md)
- [Recreating Gimbal - Walkthrough: build a Gimbal sitch from scratch via drag-and-drop](docs/gimbal-recreate.md)
- [Recreating Starlink Situations - Horizon Flares](docs/Starlink.md)
- [GIS, Geodesy, and Altitude - Understanding altitude datums and coordinate systems](docs/GIS.md)
- [What's New](docs/WhatsNew.md)


### Technical Documentation (for coders and webmasters)

- [Installing and Configuring a Sitrec Server](docs/dev/Installing-and-configuring.md)
- [File Rehosting and Related Server Configuration](docs/dev/FileRehosting.md)
- [Custom Terrain and Elevation Sources, WMS, etc.](docs/dev/CustomTerrainSources.md)
- [Adding New Settings - Developer checklist for new user settings](docs/dev/ADDING_NEW_SETTINGS.md)
- [Settings Manager Architecture - Server/cookie fallback and sanitization](docs/dev/SettingsManager.md)
- [Dynamic GUI Mirroring - API for mirrored GUI controls](docs/dev/dynamic-gui-mirroring.md)
- [MISB Timing & Sync - Per-frame KLV/video alignment in TS-sourced files](docs/dev/misb-timing.md)
- [Traverse Methods - How LOS + physical assumptions resolve target positions per frame](docs/TraverseMethods.md)
- [Wind Internals - Data flow, file formats, and atmospheric data sources](docs/Wind-Internals.md)


### Legacy documentation
- [Adding a Sitch in Code (older method)](docs/dev/AddSitchInCode.md)

The most common use case is to display three views:
- A video of a UAP situation 
- A 3D recreation of that video 
- A view of the 3D world from another perspective (with movable camera) 
- Plus various graphs and stats. 

Here's the [famous Aguadilla video](https://www.metabunk.org/sitrec/?sitch=agua)

![screenshot of Sitrec showing the Aguadilla sitch](docs/readmeImages/agua-example.jpg)

Sitrec uses or ingests a variety of data sources

- ADS-B files in KML format from ADSB Exchange, FlightAware, Planefinder, and others
- TLE files in Two or Three Line Element format (for satellites, mostly Starlink)
- Star catalogs (BSC, etc.)
- Video (mp4, mov, H.264, H.265 )
- DJI Drone tracks from Airdata as .csv
- GLB (Binary GLTF 3D models)
- Generic custom data in .csv
- PBA (Pico Balloon Archive) .txt files
- MISB style 3d Track data in KLV or CSV format
- Image files (jpg, png, etc) as single frame videos or ground overlays
- Image Overlays in KMZ format

 
Some types of situations covered:

- UAP Videos
  - Taken from a plane where a target object's azimuth and elevation are known ("angles only")
  - Taken from a plane of another plane
  - Taken from a plane looking in a particular direction
  - From a fixed position
- Viewing the sky (with accurate planets and satellites)



City Location and population data from: https://simplemaps.com/data/us-cities
