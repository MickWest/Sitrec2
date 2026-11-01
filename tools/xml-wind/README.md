# XML Wind Profile Analyzer

Use this tool when you have an XML weather file with a vertical wind profile (the wind
at each altitude) that Sitrec cannot read yet. It finds the
`SITREC_CUSTOM_SOUNDING_<NAME>_*` settings that describe the layout of the file (see
`config/shared.env.example`, "Custom Sounding Files"). It does not look up winds for a
place or date: see [Wind in Sitrec](https://github.com/MickWest/Sitrec2/blob/main/docs/Wind.md).

Open it from **Sitrec → Extra Tools → XML Wind Profile Analyzer**, or open `index.html`
from a web server. It does not work from disk: Chrome blocks the module imports of a
`file://` page. Drop an `.xml` file on the page, click **Choose a file**, or click
**Load the sample file** for a made-up example. The line below the buttons says if a profile was found. The tool then shows:

- **The file**: root element, namespaces, and whether a field keeps its number in the
  element itself or in a `<Value>` element inside it.
- **Position**: each latitude that has a longitude beside it, with the elevation, and
  which one Sitrec takes (the one nearest the levels in the XML tree).
- **Vertical wind profile**: the element that repeats once for each altitude, and
  which of its fields is the altitude, pressure, temperature, wind direction and wind
  speed, each with the evidence for it.
- **Notes**: what the tool cannot tell from the file, such as the wind direction
  convention (`_WIND_DIR_CONVENTION`), measured or model data (`_DATA_KIND`), the time
  tag (`_TIME_TAG`) and heights
  [above ground level (AGL)](https://github.com/MickWest/Sitrec2/blob/main/docs/GIS.md#three-kinds-of-height)
  (`_ALT_REFERENCE`). These settings are not proposed and no CHECK marks them: add them
  by hand if they apply.
- **Proposed settings**: the `shared.env` lines. A line marked `CHECK` is a guess or a
  default. You can edit the settings and check them again, but the report keeps the
  first proposal, not your edits.
- **What Sitrec reads with these settings**: the position and the levels, read with
  the same code that Sitrec uses.
- **Other repeating elements in the file**: if the tool finds no profile, this section
  opens, and the page has no notes, settings or check. The report is still made.
- **Report**: a text account to send to the person who sets up Sitrec. With **Include
  the values from the file** off (the default), it has the structure of the file: tag
  names, namespace addresses, known unit names, counts and kinds of data. It has no
  measurement, position, time or file name, and no other text inside an element, such
  as a station name. A tag name or a namespace address can itself say where a file
  comes from, so read the report before you send it. With the box on, it also has the
  file name, positions, field ranges and times.

The file is read in the browser. Nothing is uploaded.

The person who runs the installation adds the settings to `shared.env`. To try them
for yourself only, paste them into **Sitrec → Settings → SITREC_ ENV Override…**, if the
installation allows it. Then drop the `.xml` file onto Sitrec: see
[XML wind profiles](https://github.com/MickWest/Sitrec2/blob/main/docs/Wind.md#xml-wind-profiles).

## How it decides

All of it is a heuristic over tag names and values.

- A **value element** is a leaf that occurs under three or more differently named
  parents, mostly with a number in it.
- A **profile** is an element that occurs two or more times under one parent and has
  a wind direction, a wind speed, and an altitude or a pressure in it.
- A **field's kind** comes from its tag name (for example `dir`, `speed`, `alt`,
  `pres`, `temp`) and a test on its values: at least four direction values in five are
  0 to 360, at least four speed values in five are not negative, and every pressure is
  above zero. An altitude or a pressure that runs one way up the column is preferred,
  but a tag match is enough: the evidence then says "tag name only".
- If no tag looks like an altitude or a pressure, the column that rises steadily over
  the widest range is taken, and marked as a guess. If a pressure tag is found, no
  altitude is guessed: Sitrec estimates each height from the pressure. For a height
  column with an unusual tag, add `_ALT_TAG` and `_ALT_UNITS` by hand.
- A **position** is a tag with `lat` in its name and a coordinate in range, with a
  tag with `lon` or `lng` in its name in the same parent.
- A **unit** is taken from the file if the file states it (a `uom` or `unit`
  attribute, or a `<Units>` element). It then goes into a setting: Sitrec does not read
  units from a file. If the file does not state a unit, the pressure unit is inferred
  from the size of the numbers, a temperature over 150 is taken as kelvin, and the
  altitude unit comes from altitude against pressure in the standard atmosphere, if
  every level has both. These are marked as guesses. A wind speed unit that the file
  does not state cannot be inferred.
- An altitude tag named `FlightLevel`, `Flight_Level` or `FL` holds flight levels:
  the tool proposes `_ALT_UNITS=fl` (marked CHECK). Sitrec reads a flight level as the
  standard-atmosphere height for its pressure, FL x 30.48 m.

## Files

| File | Contents |
|---|---|
| `soundingLayout.js` | The reader for the settings. Sitrec imports it through `src/ParseSoundingXML.js`, so the check in this tool and the import in Sitrec are the same code. |
| `analyze.js` | The detection, the proposed settings, the check and the report. No DOM. |
| `xmlObject.js` | XML document to the nested object that the reader takes. Sitrec's `src/parseXml.js` imports it, so the tool and Sitrec read a file the same way. |
| `app.js`, `index.html` | The page. |
| `sample.xml` | A made-up file for trying the tool. |

Tests: `tests/XmlWindAnalyzer.test.js`, `tests/ParseSoundingXML.test.js`.

## Limits

- The tool reads decimal degrees, with a sign or a hemisphere. Sitrec also reads
  degrees, minutes and seconds. For such a file the check reads nothing, the notes show
  a WARNING and the proposed settings have no position tags. Unless the tags are named
  `Latitude`, `Longitude` and `Elevation`, add `_LAT_TAG`, `_LON_TAG` and `_ELEV_TAG` by
  hand, then import the file in Sitrec to confirm them.
- One position and one profile are taken from a file. If several profiles have the
  same level tag, Sitrec takes the first.
- A number must be the text of an element, or of a value element inside it. Neither
  the tool nor Sitrec reads a number held in an attribute, such as `<Level alt="100"/>`.
- Sitrec reads a missing-value marker (such as -9999) as a real value. The notes flag
  only a negative wind speed or a wind direction outside 0 to 360. If more than one wind
  value in five is out of range, the tool does not take that field, and can find no
  profile.
