# Time zone borders

`timezone-borders.bin.gz` holds the lines that Sitrec draws for **Time → Show Time Zones**.
They come from the "now" set with oceans of
[timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder)
(release 2026f), which covers the whole globe: at sea the zones are the 15-degree nautical
bands. The lines are those of an ordinary time zone map: a border is kept only where the
standard UTC offset (the offset without daylight saving time) changes, so Arizona and New
Mexico, both UTC-7 standard, have no line between them.

The lines are simplified to about 1.1 km and stored at 1e-4 degree (about 11 m), about
120 KB. `scripts/buildTimeZoneBorders.js` makes the file and describes its format.

## Licence

Time zone border data © OpenStreetMap contributors, from timezone-boundary-builder by Evan
Siroky.

This file is a database derived from that data. It is made available under the
[Open Data Commons Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/),
the licence of the source data.

OpenStreetMap copyright and licence: https://www.openstreetmap.org/copyright

The ODbL applies to this data file only. It does not apply to the Sitrec source code.
