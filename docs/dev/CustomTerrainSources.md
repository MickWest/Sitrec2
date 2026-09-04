# Custom Terrain Sources

"Terrain" is the surface of the Earth. In Sitrec we normally just show a portion of the local terrain, specific to the sitch. For example:
![Example-of-terrain.jpg](../docimages/terrain/Example-of-terrain.jpg)

Terrain is a in two parts, a "map" and "elevation." 

"Map" is the image used to render the map. i.e. the overhead image of the street, hills, desert, etc. 

"Elevation" is 3D shape of the ground, stored as an array of heights above sea level (elevations).

The source of this data can vary. Metabunk has a variety of options for these sources built in. If you create your own installation then you can add your own sources. This might be useful if you can't access sites like MapBox from your network, or if you have your own custom overlay that you would like to use. 

Sitrec has limited support for Web Map Service (WMS) and Web Map Tile Service (WMTS) formats, as well as custom tile formats.

Map sources and elevation sources are configured with a map definition. These are stored per-install in config/config.js (see config/config.js.example). The simplest such sources just specify a name, and function that takes z,x,y tiles specifiers and returns the URL of a tile. 

A custom source's `mapURL` function receives the tile `z, x, y` directly, so if a particular server's tiling is offset by a fixed amount from Sitrec's standard slippy-map zoom you can apply the shift inside the function (e.g. build the URL from `z - 1`). For sources defined via environment variables instead of `config.js` — the `SITREC_CUSTOM_MAP_<NAME>_*` / `SITREC_CUSTOM_ELEVATION_<NAME>_*` vars documented in `config/shared.env.example` — the same shift is available declaratively as `_ZOFFSET`: an integer that is ADDED to `z` before it is substituted into the URL's `{z}` placeholder (`0` is a no-op, e.g. `SITREC_CUSTOM_MAP_ESRI_ZOFFSET=-1`). A companion `_MIN_ZOOM` (default 0) sets the lowest zoom Sitrec requests from the source (below it the terrain uses a placeholder tile rather than making a request); a negative `_ZOFFSET` automatically raises that effective minimum, so the value sent in `{z}` can never go negative regardless of `_MIN_ZOOM`.

## Water colour, and the Water Reflection effect

The Water Reflection effect (**Effects → Water Reflection**) finds water by matching the loaded map texture against the colour the source paints water with, declared as `waterColor: [r, g, b]` on the map definition. A source that does not declare one gets no reflections at all — the check is on the *declared* colour, not on the pixels, so that satellite imagery cannot invent lakes out of similarly-coloured ground.

Two backfills mean you rarely have to write it yourself:

- A `config.js` source keyed `osm` or `osmHighlight` is given OSM's fill `[170, 211, 223]` (`#AAD3DF`) if it does not set one. `config/config.js` is per-install and not checked in, so existing installs would otherwise silently lack it.
- An env-defined source whose URL points at the standard OSM tile servers (`tile.openstreetmap.org`, `tile.osm.org`, including when routed through `cachemaps.php`) gets the same colour. This keys off the **URL**, not the `<NAME>` segment, because a source may be named anything and pointed anywhere.

A source that sets `waterColor` itself always wins over both. For env-defined sources that is `SITREC_CUSTOM_MAP_<NAME>_WATER_COLOR`, written as `"170,211,223"` or `"#AAD3DF"` — needed for a self-hosted or restyled OSM whose water is some other colour. An unparseable value is ignored rather than trusted: an OSM tile server still gets its automatic colour, and any other source is left with none, so the effect stays off instead of matching water of some arbitrary wrong colour.

Satellite sources have no flat water colour and should not be given one. Water Reflection covers them by other means: *Vector Water Mask*, which rasterises real water polygons and ignores the imagery entirely (needs a MapTiler key), or *Combine Terrain with OSM*, which stamps OSM's water fill into the loaded imagery. The combine needs some OSM-like source present to stamp *from*; it prefers the `config.js` `osm` key and otherwise uses any other source that declares a water colour and is not `mapping: 4326`, so an install that defines OSM only through `SITREC_CUSTOM_MAP_OSM_*`, or one running with `SITREC_ENABLE_DEFAULT_MAP_SOURCES=false`, still gets the option.

### With Google Photorealistic 3D Tiles

Google Photorealistic 3D Tiles do not sit on the terrain, they replace it: the terrain quadtree is hidden outright while they are on. Everything above therefore stops applying — there is no map texture in the frame to match a colour against, and no terrain tile to carry a mask. *Water on 3D Tiles* (on by default) shades the tiles' own surface instead, and needs no `waterColor` from any source, because it never looks at imagery.

It finds water three ways at once, all of which have to agree: a water mask rasterised from the same vector polygons *Vector Water Mask* uses, covering a square of ground around whatever water is being looked at; a height band around the sea surface, which is what keeps the pier decks, the boats and the seafront out of a mask that is only a plan view; and a test that the surface faces the sky, which removes the pilings. *3D Tile Water Band* and *3D Tile Mask Span* control the second and the first.

This needs a vector water source. There is no colour fallback and cannot be one: a photogrammetric tile carries a photograph of the sea, not a flat fill, so there is nothing for a colour test to match.

### The vector water source

Both *Vector Water Mask* and *Water on 3D Tiles* read water polygons from a server speaking the **OpenMapTiles schema** — a `water` layer of polygons in Mapbox Vector Tile (`.pbf`) format. Sitrec takes that layer's polygons only, keeping every feature class except `swimming_pool`, and rasterises them with the canvas's antialiasing so the shoreline is fractional coverage rather than a threshold.

The default is MapTiler (`MAPTILER_KEY`), chosen because that key was already one Sitrec asks for. It is not a requirement. `SITREC_VECTOR_WATER_URL` is a `{z}/{x}/{y}` template pointing anywhere else — a self-hosted OpenMapTiles, or any other server with the same schema — and when it is set `MAPTILER_KEY` is not consulted at all, so a deployment with no route to the internet needs no account with anyone. This is the water counterpart of `SITREC_ENABLE_DEFAULT_MAP_SOURCES=false`, which does the same job for the basemaps; before it existed, that flag left the basemaps correctly restricted while the water mask carried on calling out.

`SITREC_VECTOR_WATER_MAX_ZOOM` (default 14, what OpenMapTiles publishes) is the deepest zoom your server actually serves. Getting it too high fails quietly rather than loudly: the missing tiles 404, a 404 correctly means "no water polygons here", and the water disappears with nothing logged. Past this zoom the polygons are magnified rather than resampled — that is the whole reason for using vector data — so setting it low costs very little.

Like a custom map source's URL, this one is fetched by the browser and is visible to anyone using the site. A credential embedded in it is as public as `MAPTILER_KEY` is, and should be scoped the same way.

**Attribution.** The water source carries its own credit in the on-screen attribution overlay, shown whenever its data is in use and hidden when it is not. It needs a slot of its own because the overlay is otherwise driven per map source, and the water polygons are not a map source — which matters most under Google Photorealistic 3D Tiles, where the basemap credit is suppressed entirely and the water becomes the only thing on screen that has to be credited.

MapTiler credits MapTiler and OpenStreetMap. A source set through `SITREC_VECTOR_WATER_URL` is credited to OpenStreetMap by default, because the OpenMapTiles schema is normally built from ODbL OpenStreetMap data and defaulting to a credit is the safe way round. Override it with `SITREC_VECTOR_WATER_ATTRIBUTION` and `SITREC_VECTOR_WATER_TERMS_URL`. Setting the attribution to an **empty** value is honoured as "credit nothing" rather than treated as unset, so an operator whose water data genuinely carries no attribution requirement can switch the line off.

Example: Open Streetmap:

```javascript
        osm: {
            name: "Open Streetmap",
            mapURL: (z,x,y) => {
                return `https://c.tile.openstreetmap.org/${z}/${x}/${y}.png`
            },
        },
```

Here the function mapURL returns a direct OSM tile request. OpenStreetMap needs no account token, so the request can go straight to the tile server. For sources that do need a token, or that you want to cache, you can instead route the request through the Metabunk server cache, e.g. `SITREC_SERVER+"cachemaps.php?url=" + encodeURIComponent(...)`. The token is then added server-side, which requires additional configuration. Caching is done to protect the account token and to cache map and terrain tiles to avoid multiple requests in development. 

To access a map source directly you can include a request token that is specific to your server. For example, the metabunk Maptiler config is direct:

```javascript
        maptiler: {
            name: "MapTiler",
            mapURL: (z,x,y, layerName, layerType) => {
                return(`https://api.maptiler.com/tiles/${layerName}/${z}/${x}/${y}.${layerType}?key=YOUR_MAPTILER_KEY`); // replace with your own key
            },
        },
```

WMS and WMTS sources are specified in a similar way. Here's two working examples:

```javascript
        NRL_WMS: {
            name: "Naval Research Laboratory WMS",
            mapURL: function (z,x,y, layerName, layerType) {
                return this.mapProjectionTextures.wmsGetMapURLFromTile("https://geoint.nrlssc.org/nrltileserver/wms/category/Imagery?",layerName,z,x,y);
            },
            capabilities: "https://geoint.nrlssc.org/nrltileserver/wms/category/Imagery?REQUEST=GetCapabilities&SERVICE=WMS",
            layer: "ImageryMosaic",

        },

        NRL_WMTS: {
            name: "Naval Research Laboratory WMS Tile",

            mapURL: function (z,x,y,  layerName, layerType) {
                return this.mapProjectionTextures.wmtsGetMapURLFromTile("https://geoint.nrlssc.org/nrltileserver/wmts",layerName,z,x,y);
            },
            capabilities: "https://geoint.nrlssc.org/nrltileserver/wmts?REQUEST=GetCapabilities&VERSION=1.0.0&SERVICE=WMTS",
            layer: "BlueMarble_AUTO",
            mapping: 4326,

        },
```



A WMS map source usually returns a rectangle that covers a specific range of latitude and longitude. Since Sitrec expects regular sized tile, there's a simple mapping from tile coordinates to lat/lon extents of a tile. Doing it this way is not the most efficient, but essentially converts a WMTS tile request into the matching WMS request. The example above uses this utility function:

```javascript
    wmsGetMapURLFromTile(urlBase, name, z, x, y) {
        const {lat0, lon0, lat1, lon1} = this.getCorners(y, z, x);

        // if the urlBase does not end in a ?, then add one
        if (urlBase[urlBase.length-1] !== '?') {
            urlBase += '?';
        }

        const url =
            urlBase+
            "SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1" +
            "&LAYERS=" + name +
            "&FORMAT=image/jpeg" +
            "&CRS=EPSG:4326" +
            `&BBOX=${lon0},${lat1},${lon1},${lat0}` +
            "&WIDTH=256&HEIGHT=256" +
            "&STYLES=";

//        console.log("URL = " + url);
        return url;

    }
```

That's in WMSUtils.js. You can use this, or you are free to add code to your config.js (I recommend just adding it there to simplify merging with later releases of Sitrec)

WMTS and WMS source have a "capabilities" parameter. This specifies a query that returns an XML file that describes the various layers that a server has to offer. The NRL sources in the example have multiple layers. 

You must specify a default layer to use, like:
```javascript
            layer: "BlueMarble_AUTO",
```
When a source uses `capabilities`, this default `layer` is required — if you omit it, Sitrec pops up an alert and the map won't load. The "just use the first one" auto-selection only applies to the layer dropdown after the capabilities have loaded, not to omitting the default `layer`. 

Tile sources can specify one of two mappings, which specify the projection of the map (Mercator, Equirectangular, etc). These use the EPSG number, and the default is EPSG:3857. Note the NRL WMTS example uses 4326.
```javascript
            mapping: 4326,
```

The above example are all for map sources (i.e. the textures or bitmaps used to cover the terrain). Elevation is simpliar

# Custom Elevation Sources

The default terrain source used by Metabunk Sitrec is a public domain EPSG:3857 tile source from MapZen that encodes elevation data into the RGB values of a PNG tile. This govers the entire globe. See:
<https://registry.opendata.aws/terrain-tiles/>

The second source seen in the example below is the National Map 3DEP GeoTIFF. This is a US only source that provides elevation data in GeoTIFF format. This is a WMS source that returns a GeoTIFF file with the elevation data in 32 bit floats. Decoding this is a bit more complex than the PNG source, but it is more accurate and has a higher resolution. However it is limited to the US. 

Note that the NationalMap source uses the default web-mercator (3857) projection. The exportImage endpoint accepts any bbox in EPSG:4326, so the source avoids the 4326/CRS84Quad mapping (which can trigger dynamic subdivision issues) and instead requests tiles on the same web-mercator grid as the texture tiles.

```javascript
    customElevationSources: {
        AWS_Terrarium: {
            name: "AWS Terrarium",

            mapURL: (z,x,y) => {
                return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`
            },

            maxZoom: 15,
            minZoom: 0,
            tileSize: 256,
            attribution: "AWS Terrarium Elevation Data",
        },

        NationalMap: {
            name: "National Map 3DEP GeoTIFF",
            // here's a working example URL
            // https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?f=image&format=tiff&bbox=-118.5,33.3,-118.3,33.5&bboxSR=4326&imageSR=4326&size=500,500
            mapURL: function (z,x,y, layerName, layerType) {
                return this.mapProjectionElevation.getWMSGeoTIFFURLFromTile("https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage",z,x,y);
            },
            maxZoom: 14,
            minZoom: 0,
            tileSize: 256,
            attribution: "National Map 3DEP GeoTIFF",


        }

    }
```

The function getWMSGeoTIFFURLFromTile is in WMSUtils.js.  

```javascript
    getWMSGeoTIFFURLFromTile(urlBase, z, x, y) {
        const {lat0, lon0, lat1, lon1} = this.getCorners(y, z, x);

        // if the urlBase does not end in a ?, then add one
        if (urlBase[urlBase.length-1] !== '?') {
            urlBase += '?';
        }

        // Expand bbox by half a pixel on each side to fix tile edge discontinuities.
        // ArcGIS exportImage uses "pixel-is-area" registration where the bbox defines
        // cell edges, not pixel centers. Without this expansion, adjacent tiles' edge
        // pixels sample locations one pixel apart, causing elevation mismatches.
        const pixelSize = 256;
        const halfPixelLon = (lon1 - lon0) / pixelSize / 2;
        const halfPixelLat = (lat0 - lat1) / pixelSize / 2; // lat0 > lat1 (north > south)

        const url =
            urlBase +
            "&f=image&format=tiff" +
            `&bbox=${lon0 - halfPixelLon},${lat1 - halfPixelLat},${lon1 + halfPixelLon},${lat0 + halfPixelLat}` +
            "&bboxSR=4326&imageSR=4326&size=256,256";

        return url;
    }
```

Note it currently has the size and other parameters hard coded. You may need to adjust this to match the capabilities of the server you are using. I'd be happy to add support for other formats if you can provide a working example.

The decoding of the GeoTIFF is done in src/QuadTreeTile.js (the handleGeoTIFFElevation / computeElevationFromGeoTIFF methods), with low-level TIFF parsing in src/TIFFUtils.js. This is a bit more complex than the PNG decoding as the data is in 32 bit floats and is arranged in 128x128 tiles within the TIFF file. Other formats like 16 bit integer elevations, different internal tilings, no tiling, different projections (3857 vs 4326) etc could easily be supported, but this is the only one I have implemented as it's the only good public dataset I've found.

When testing elevation sources, adjust the elevationScale in the Terrain menu to 10 to make the terrain more visible.

![elevationScale-demo.jpg](../docimages/terrain/elevationScale-demo.jpg)


