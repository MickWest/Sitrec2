# XML Wind Profile Analyzer

Sitrec can read a vertical wind profile from an XML weather file whose layout an
installation describes with `SITREC_CUSTOM_SOUNDING_<NAME>_*` settings (see
`config/shared.env.example`, "Custom Sounding Files"). This tool finds those settings
for a file that nobody has described yet.

Load a file and the tool shows:

- **The file**: root element, namespaces, and whether a field keeps its number in the
  element itself or in a `<Value>` element inside it.
- **Position**: each latitude that has a longitude beside it, with the elevation, and
  which one Sitrec takes (the one nearest the levels in the XML tree).
- **Vertical wind profile**: the element that repeats once for each altitude, and
  which of its fields is the altitude, pressure, temperature, wind direction and wind
  speed, each with the evidence for it.
- **Proposed settings**: the `shared.env` lines. A line marked `CHECK` is a guess or a
  default. The settings can be edited and checked again.
- **What Sitrec reads with these settings**: the position and the levels, read with
  the same code that Sitrec uses.
- **Report**: a text account to send to the person who sets up Sitrec. Without the
  values it has the structure of the file: tag names, namespace addresses, known unit
  names, counts and kinds of data. It has no measurement, position, time, file name or
  other text from the file. A tag name or a namespace address can itself say where a
  file comes from, so read the report before you send it.

The file is read in the browser. Nothing is uploaded.

## How it decides

All of it is a heuristic over tag names and values.

- A **value element** is a leaf that occurs under three or more differently named
  parents, mostly with a number in it.
- A **profile** is an element that occurs two or more times under one parent and has
  a wind direction, a wind speed, and an altitude or a pressure in it.
- A **field's kind** comes from its tag name (for example `dir`, `speed`, `alt`,
  `pres`, `temp`) and a test on its values: a direction is 0 to 360, a speed is not
  negative, an altitude or a pressure runs one way up the column. If no tag looks like
  an altitude, the column that rises steadily is taken, and marked as a guess.
- A **position** is a tag with `lat` in its name and a coordinate in range, with a
  tag with `lon` or `lng` in its name in the same parent.
- A **unit** is taken from the file if the file states it (a `uom` or `unit`
  attribute, or a `<Units>` element). If not, the pressure unit is inferred from the
  size of the numbers, and the altitude unit from altitude against pressure in the
  standard atmosphere. These are marked as guesses. A wind speed unit that the file
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
  degrees, minutes and seconds; for such a file the check here shows no position, but
  the settings can still be correct.
- One position and one profile are taken from a file.
- A number that marks a missing value (such as -9999) is flagged when it is out of
  range for a wind, but Sitrec reads it as a real value.
