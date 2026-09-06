#!/usr/bin/env python3
"""Build Sitrec's original angular and pixel OSD fonts.

Run: python3 scripts/generateHUDFonts.py (requires fonttools).
Glyphs are authored here as geometric strokes, not extracted from another font.
Coordinates use a 5 by 7 design grid, with flat terminals and clipped corners.
The pixel companion samples the same design onto an eight-row cell grid.
"""
from pathlib import Path
from math import hypot

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "data" / "fonts"

# Each glyph is a list of pen strokes in top-down design coordinates.
STROKES = {
    "A": [[(0, 7), (0, 1.5), (1.5, 0), (3.5, 0), (5, 1.5), (5, 7)], [(0, 4), (5, 4)]],
    "B": [[(0, 0), (0, 7)], [(0, 0), (3.8, 0), (5, 1), (5, 2.5), (3.8, 3.5), (0, 3.5)],
          [(3.8, 3.5), (5, 4.5), (5, 6), (3.8, 7), (0, 7)]],
    "C": [[(5, 1), (4, 0), (1, 0), (0, 1), (0, 6), (1, 7), (4, 7), (5, 6)]],
    "D": [[(0, 0), (0, 7), (3.5, 7), (5, 5.5), (5, 1.5), (3.5, 0), (0, 0)]],
    "E": [[(5, 0), (0, 0), (0, 7), (5, 7)], [(0, 3.5), (4, 3.5)]],
    "F": [[(5, 0), (0, 0), (0, 7)], [(0, 3.5), (4, 3.5)]],
    "G": [[(5, 1), (4, 0), (1, 0), (0, 1), (0, 6), (1, 7), (4, 7), (5, 6), (5, 3.5), (2.5, 3.5)]],
    "H": [[(0, 0), (0, 7)], [(5, 0), (5, 7)], [(0, 3.5), (5, 3.5)]],
    "I": [[(2.5, 0), (2.5, 7)]],
    "J": [[(5, 0), (5, 6), (4, 7), (1, 7), (0, 6), (0, 5)]],
    "K": [[(0, 0), (0, 7)], [(5, 0), (0, 4)], [(1.5, 2.8), (5, 7)]],
    "L": [[(0, 0), (0, 7), (5, 7)]],
    "M": [[(0, 7), (0, 0), (2.5, 3), (5, 0), (5, 7)]],
    "N": [[(0, 7), (0, 0), (5, 7), (5, 0)]],
    "O": [[(1, 0), (4, 0), (5, 1), (5, 6), (4, 7), (1, 7), (0, 6), (0, 1), (1, 0)]],
    "P": [[(0, 7), (0, 0), (4, 0), (5, 1), (5, 2.5), (4, 3.5), (0, 3.5)]],
    "Q": [[(1, 0), (4, 0), (5, 1), (5, 5.5), (3.5, 7), (1, 7), (0, 6), (0, 1), (1, 0)], [(3, 5), (5, 7)]],
    "R": [[(0, 7), (0, 0), (4, 0), (5, 1), (5, 2.5), (4, 3.5), (0, 3.5)], [(2.5, 3.5), (5, 7)]],
    "S": [[(5, 1), (4, 0), (1, 0), (0, 1), (0, 2.5), (1, 3.5), (4, 3.5), (5, 4.5), (5, 6), (4, 7), (1, 7), (0, 6)]],
    "T": [[(0, 0), (5, 0)], [(2.5, 0), (2.5, 7)]],
    "U": [[(0, 0), (0, 6), (1, 7), (4, 7), (5, 6), (5, 0)]],
    "V": [[(0, 0), (0, 2), (2.5, 7), (5, 2), (5, 0)]],
    "W": [[(0, 0), (0, 7), (2.5, 4), (5, 7), (5, 0)]],
    "X": [[(0, 0), (5, 7)], [(5, 0), (0, 7)]],
    "Y": [[(0, 0), (2.5, 3.5), (5, 0)], [(2.5, 3.5), (2.5, 7)]],
    "Z": [[(0, 0), (5, 0), (0, 7), (5, 7)]],
    "0": [[(1.5, 0), (3.5, 0), (5, 1.5), (5, 5.5), (3.5, 7), (1.5, 7), (0, 5.5), (0, 1.5), (1.5, 0)]],
    "1": [[(1, 1.5), (2.5, 0), (2.5, 7)]],
    "2": [[(0, 1), (1, 0), (4, 0), (5, 1), (5, 2.5), (0, 6), (0, 7), (5, 7)]],
    "3": [[(0, 0), (4, 0), (5, 1), (5, 2.5), (4, 3.5), (2, 3.5)],
          [(4, 3.5), (5, 4.5), (5, 6), (4, 7), (0, 7)]],
    "4": [[(3.5, 0), (0, 4.5), (5, 4.5)], [(3.5, 0), (3.5, 7)]],
    "5": [[(5, 0), (0, 0), (0, 3.5), (4, 3.5), (5, 4.5), (5, 6), (4, 7), (0, 7)]],
    "6": [[(5, 0), (1.5, 0), (0, 1.5), (0, 6), (1, 7), (4, 7), (5, 6), (5, 4.5), (4, 3.5), (0, 3.5)]],
    "7": [[(0, 0), (5, 0), (1, 7)]],
    "8": [[(1, 0), (4, 0), (5, 1), (5, 2.5), (4, 3.5), (1, 3.5), (0, 2.5), (0, 1), (1, 0)],
          [(1, 3.5), (0, 4.5), (0, 6), (1, 7), (4, 7), (5, 6), (5, 4.5), (4, 3.5)]],
    "9": [[(5, 3.5), (1, 3.5), (0, 2.5), (0, 1), (1, 0), (4, 0), (5, 1), (5, 5.5), (3.5, 7), (0, 7)]],
    "-": [[(0.5, 3.5), (4.5, 3.5)]],
    "+": [[(0.5, 3.5), (4.5, 3.5)], [(2.5, 1.5), (2.5, 5.5)]],
    "=": [[(0.5, 2.5), (4.5, 2.5)], [(0.5, 4.5), (4.5, 4.5)]],
    "/": [[(0, 7), (5, 0)]], "\\": [[(0, 0), (5, 7)]],
    "_": [[(0, 7), (5, 7)]],
    "<": [[(4, 1), (1, 3.5), (4, 6)]], ">": [[(1, 1), (4, 3.5), (1, 6)]],
    "(": [[(3.5, 0), (1.5, 2), (1.5, 5), (3.5, 7)]],
    ")": [[(1.5, 0), (3.5, 2), (3.5, 5), (1.5, 7)]],
    "[": [[(4, 0), (1.5, 0), (1.5, 7), (4, 7)]],
    "]": [[(1, 0), (3.5, 0), (3.5, 7), (1, 7)]],
    "{": [[(4, 0), (2.5, 0), (2.5, 2.5), (1, 3.5), (2.5, 4.5), (2.5, 7), (4, 7)]],
    "}": [[(1, 0), (2.5, 0), (2.5, 2.5), (4, 3.5), (2.5, 4.5), (2.5, 7), (1, 7)]],
    "|": [[(2.5, 0), (2.5, 7)]], "!": [[(2.5, 0), (2.5, 4.5)], [(2.5, 6), (2.5, 7)]],
    "?": [[(0, 1), (1, 0), (4, 0), (5, 1), (5, 2), (2.5, 4), (2.5, 4.5)], [(2.5, 6), (2.5, 7)]],
    ".": [[(2.5, 6), (2.5, 7)]], ",": [[(3, 6), (2, 8)]],
    ":": [[(2.5, 1.5), (2.5, 2.5)], [(2.5, 5), (2.5, 6)]],
    ";": [[(2.5, 1.5), (2.5, 2.5)], [(3, 5), (2, 7)]],
    "'": [[(2.5, 0), (2.5, 1.5)]], '"': [[(1.5, 0), (1.5, 1.5)], [(3.5, 0), (3.5, 1.5)]],
    "`": [[(2, 0), (3, 1.5)]], "^": [[(0.5, 2.5), (2.5, 0.5), (4.5, 2.5)]],
    "~": [[(0, 4), (1.5, 2.5), (3.5, 4.5), (5, 3)]],
    "#": [[(2, 0), (1, 7)], [(4, 0), (3, 7)], [(0, 2), (5, 2)], [(0, 5), (5, 5)]],
    "*": [[(0.5, 1.5), (4.5, 5.5)], [(4.5, 1.5), (0.5, 5.5)], [(2.5, 0.5), (2.5, 6.5)]],
    "°": [[(1.5, 0), (3, 0), (3.5, 0.5), (3.5, 2), (3, 2.5), (1.5, 2.5), (1, 2), (1, 0.5), (1.5, 0)]],
    "∞": [[(0, 3), (1, 2), (4, 5), (5, 4), (5, 3), (4, 2), (1, 5), (0, 4), (0, 3)]],
    "&": [[(5, 7), (0.5, 2), (0.5, 1), (1.5, 0), (3, 0), (4, 1), (4, 2), (0, 5), (0, 6), (1, 7), (3, 7), (5, 4)]],
    "@": [[(5, 6), (4, 7), (1, 7), (0, 6), (0, 1), (1, 0), (4, 0), (5, 1), (5, 5), (3.5, 5), (3.5, 2), (2, 2), (1.5, 2.5), (1.5, 4.5), (2, 5), (3.5, 5)]],
}
STROKES["$"] = STROKES["S"] + [[(2.5, -0.5), (2.5, 7.5)]]
STROKES["%"] = [[(0, 7), (5, 0)], [(0, 0), (1.5, 0), (1.5, 1.5), (0, 1.5), (0, 0)],
                [(3.5, 5.5), (5, 5.5), (5, 7), (3.5, 7), (3.5, 5.5)]]
STROKES["±"] = STROKES["+"] + [[(0.5, 7), (4.5, 7)]]


def outline(points):
    """Mitered, flat-ended stroke polygon; closed strokes form two rings."""
    closed = points[0] == points[-1]
    if closed:
        points = points[:-1]
    vectors, normals = [], []
    for a, b in zip(points, points[1:] + points[:1] if closed else points[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = hypot(dx, dy)
        vectors.append((dx / length, dy / length))
        normals.append((-dy / length, dx / length))

    def side(sign):
        result = []
        for i, (x, y) in enumerate(points):
            if not closed and i in (0, len(points) - 1):
                segment = 0 if i == 0 else -1
                nx, ny = normals[segment]
                dx, dy = vectors[segment]
                cap = -0.5 if i == 0 else 0.5
                result.append((x + sign * nx / 2 + cap * dx, y + sign * ny / 2 + cap * dy))
            else:
                ax, ay = normals[i - 1]
                bx, by = normals[i % len(normals)]
                divisor = 1 + ax * bx + ay * by
                mx, my = sign * (ax + bx) / (2 * divisor), sign * (ay + by) / (2 * divisor)
                if hypot(mx, my) > 1:
                    # Clip acute corners in M/N/V/W instead of growing spikes.
                    result.extend([(x + sign * ax / 2, y + sign * ay / 2),
                                   (x + sign * bx / 2, y + sign * by / 2)])
                else:
                    result.append((x + mx, y + my))
        return result

    left, right = side(1), side(-1)
    rings = [left, right[::-1]] if closed else [left + right[::-1]]
    # Reverse both rings together if needed, keeping holes opposite to exteriors.
    areas = [sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(r, r[1:] + r[:1])) for r in rings]
    if areas[max(range(len(areas)), key=lambda i: abs(areas[i]))] > 0:
        rings = [r[::-1] for r in rings]
    # Flipping the vertical coordinate reverses winding again.
    return [[(round((x + 1) * 100), round((7.5 - y) * 100)) for x, y in r[::-1]] for r in rings]


def inside(point, ring):
    x, y = point
    hit = False
    for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            hit = not hit
    return hit


def make_glyph(strokes, pixel):
    shapes = [outline(stroke) for stroke in strokes]
    contours = [ring for shape in shapes for ring in shape]
    if pixel:
        contours = []
        for row in range(-2, 10):
            for col in range(7):
                x, y = col * 100, row * 100 + 50
                if any(sum(inside((x, y), ring) for ring in shape) % 2 for shape in shapes):
                    contours.append([(x - 50, y - 50), (x - 50, y + 50),
                                     (x + 50, y + 50), (x + 50, y - 50)])
    pen = TTGlyphPen(None)
    for ring in contours:
        pen.moveTo(ring[0])
        for point in ring[1:]:
            pen.lineTo(point)
        pen.closePath()
    glyph = pen.glyph()
    if glyph.numberOfContours > 0:
        glyph.flags[0] |= 0x40  # OVERLAP_SIMPLE: crossing stems are intentional.
    return glyph


def build(pixel=False):
    family = "Sitrec OSD Pixel" if pixel else "Sitrec OSD"
    basename = family.replace(" ", "")
    names = {char: f"uni{ord(char):04X}" for char in STROKES}
    order = [".notdef", "space", *names.values()]
    glyphs = {".notdef": make_glyph(STROKES["?"], pixel), "space": make_glyph([], pixel)}
    glyphs.update({names[c]: make_glyph(strokes, pixel) for c, strokes in STROKES.items()})
    cmap = {ord(c): name for c, name in names.items()}
    cmap.update({ord(c.lower()): names[c] for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"})
    cmap.update({32: "space", 160: "space", 0x2212: names["-"], 0x2013: names["-"],
                 0x2014: names["-"], 0x2032: names["'"], 0x2033: names['"']})
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap(cmap)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (700, glyph.xMin if glyph.numberOfContours else 0)
                                    for name, glyph in glyphs.items()})
    builder.setupHorizontalHeader(ascent=900, descent=-200)
    builder.setupOS2(sTypoAscender=900, sTypoDescender=-200, usWinAscent=1000, usWinDescent=200,
                     sCapHeight=800, sxHeight=800, fsType=0)
    builder.setupNameTable({"familyName": family, "styleName": "Regular", "fullName": family,
                           "psName": basename, "uniqueFontIdentifier": f"Sitrec: {basename}: 1.0",
                           "version": "Version 1.000", "copyright": "Copyright (c) 2026 Mick West",
                           "description": "Original geometric OSD lettering for Sitrec.",
                           "licenseDescription": "Distributed under the Sitrec License; see LICENSE.txt.",
                           "licenseInfoURL": "https://github.com/MickWest/Sitrec2/blob/main/LICENSE"})
    builder.setupPost(isFixedPitch=1)
    builder.setupMaxp()
    # Stable generated binaries, including the TrueType epoch timestamp.
    builder.font.recalcTimestamp = False
    builder.font["head"].created = builder.font["head"].modified = 3871497600
    DEST.mkdir(parents=True, exist_ok=True)
    builder.save(DEST / f"{basename}.ttf")
    return family, len(cmap)


if __name__ == "__main__":
    for pixel in (False, True):
        print(*build(pixel))
    license_text = "\n".join(line.rstrip() for line in (ROOT / "LICENSE").read_text().splitlines()) + "\n"
    (DEST / "LICENSE.txt").write_text(license_text)
