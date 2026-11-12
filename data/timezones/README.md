# Time zone borders

`timezone-borders.bin.gz` holds the time zone map that Sitrec draws for
**Time → Show Time Zones**: the borders between the zones, and the zones between them. Sitrec
also uses it to find the time zone at a position (**Set Time Zone from Camera Location**, and a
photo with a GPS position). It comes from the "1970" set with oceans of
[timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder)
(release 2026f), which covers the whole globe: at sea the zones are the 15-degree nautical
bands. Each of its 304 zones is an area where the clocks have been the same since 1970, named
after an IANA zone (for example `America/Vancouver`), so Sitrec gets each zone's UTC offset
at the sitch time from the browser, with daylight saving time, for any date since 1970.
Sitrec draws a line only where the offsets on the two sides differ then, and colors each zone
by its offset. Where two zones cover the same land (Xinjiang has UTC+8 and UTC+6), the area
keeps both.

The lines are simplified to about 1.1 km and stored at 1e-4 degree (about 11 m), about
250 KB. `scripts/buildTimeZoneBorders.js` makes the file and describes its format.

## Licence

Time zone border data © OpenStreetMap contributors, from timezone-boundary-builder by Evan
Siroky.

This file is a database derived from that data. It is made available under the
[Open Data Commons Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/),
the licence of the source data.

OpenStreetMap copyright and licence: https://www.openstreetmap.org/copyright

The ODbL applies to this data file only. It does not apply to the Sitrec source code.
