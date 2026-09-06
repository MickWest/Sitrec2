# Sitrec OSD

Original geometric lettering for the MQ9 overlay, designed from visual references
to angular on-screen displays. It is a visual approximation, not the original
equipment font. No third-party font outlines or font programs are included.

- `SitrecOSD.ttf`: angular sans-serif capitals and numerals with flat terminals.
- `SitrecOSDPixel.ttf`: the same design on an eight-row pixel grid.

Both faces are monospaced and include ASCII, degree, plus/minus, infinity, Unicode
minus, and coordinate prime marks. Lowercase input displays as capitals.

Editable glyph strokes and a deterministic font builder are in
`scripts/generateHUDFonts.py`. Rebuild with `python3 scripts/generateHUDFonts.py`
using Python's `fonttools` package. See `LICENSE.txt` for the Sitrec License.
