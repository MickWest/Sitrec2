#!/usr/bin/env python3
"""make-xlsx.py - build FlareStats.xlsx, with line charts, from flare-stats.mjs output.

    python3 tools/shf/stats/make-xlsx.py <out-dir>

Reads the CSV files and run.json that flare-stats.mjs wrote to <out-dir>, and writes
<out-dir>/FlareStats.xlsx. flare-stats.mjs runs this itself at the end of a run;
run it by hand only to rebuild the workbook. Needs openpyxl (pip3 install openpyxl).
"""

import csv
import datetime
import json
import os
import sys

from openpyxl import Workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.chart.axis import DateAxis
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

CHART_W, CHART_H = 30, 13      # large charts (cm)
SMALL_W, SMALL_H = 16, 8.5     # per-month charts (cm)


def read_csv(out_dir, name):
    with open(os.path.join(out_dir, name), newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.reader(fh))
    return rows[0], rows[1:]


def number(text):
    try:
        value = float(text)
    except ValueError:
        return text
    return int(value) if value.is_integer() else value


def put_table(ws, header, rows, first_row=1, first_col=1, date_col=None, freeze=True):
    """Write a header row and data rows; convert numbers (and ISO dates in date_col)."""
    for c, text in enumerate(header):
        cell = ws.cell(row=first_row, column=first_col + c, value=text)
        cell.font = Font(bold=True)
    for r, row in enumerate(rows, start=1):
        for c, text in enumerate(row):
            if c == date_col:
                value = datetime.date.fromisoformat(text)
            else:
                value = number(text)
            cell = ws.cell(row=first_row + r, column=first_col + c, value=value)
            if c == date_col:
                cell.number_format = "yyyy-mm-dd"
    if freeze:
        ws.freeze_panes = ws.cell(row=first_row + 1, column=first_col + 1)
    for c in range(len(header)):
        ws.column_dimensions[get_column_letter(first_col + c)].width = 12 if c else 16


def line_chart(title, y_title, x_title, width=CHART_W, height=CHART_H, date_axis=False):
    chart = LineChart()
    chart.title = title
    chart.y_axis.title = y_title
    chart.width, chart.height = width, height
    if date_axis:
        # A DateAxis has axId 500, so the y axis must cross 500 (not the default 10).
        # A y axis that crosses a missing axis makes Excel delete the whole drawing.
        chart.y_axis.crossAx = 500
        chart.x_axis = DateAxis(crossAx=100)
        chart.x_axis.number_format = "mmm"
        chart.x_axis.majorTimeUnit = "months"
    chart.x_axis.title = x_title
    # openpyxl 3.1 marks axes "deleted" unless told otherwise; Excel then hides them.
    chart.x_axis.delete = False
    chart.y_axis.delete = False
    chart.legend.position = "r"
    return chart


def add_series(chart, ws, n_series, first_row, last_row, cat_col=1, first_data_col=2):
    """Series are columns first_data_col.., titled by the header in first_row."""
    data = Reference(ws, min_col=first_data_col, max_col=first_data_col + n_series - 1,
                     min_row=first_row, max_row=last_row)
    chart.add_data(data, titles_from_data=True)
    chart.set_categories(Reference(ws, min_col=cat_col, min_row=first_row + 1, max_row=last_row))
    for series in chart.series:
        series.smooth = False
        series.marker.symbol = "none"
        series.graphicalProperties.line.width = 15000   # EMU, about 1.2 pt


def about_sheet(ws, run):
    lines = [
        ("Starlink flare statistics", None),
        ("", None),
        ("Constellation", run["source"] + (f"  ({run['tle']})" if run.get("tle") else "")),
        ("Model version", run.get("model", "not recorded")),
        ("Nights", f"{run['from']} to {run['to']}, every {run['stepDays']} day(s): {run['nights']} nights"),
        ("Latitudes", ", ".join(run["labels"])),
        ("Longitude", f"{run['lon']} deg"),
        ("Observer altitude", f"{run['altKm']} km"),
        ("Minimum flare elevation", f"{run['minElevationDeg']} deg"),
        ("Generated", run["generated"]),
        ("", None),
        ("Definitions", None),
        ("What is counted", "Flares seen by ONE observer at the latitude, longitude and altitude above, in the "
                            "whole sky above the horizon. Not a worldwide total."),
        ("Night of D", "Local mean solar noon on D to noon on D+1, so each dark period is counted once."),
        ("Local solar hour", "Local mean solar time = UTC + longitude/15 hours (no time zones, no daylight saving)."),
        ("All flares", "Every glint inside the 5 deg flare cone."),
        ("Visible flare", "The glint at least doubles the satellite's base brightness (the shared model the "
                          "SHF predictor and Sitrec's night sky use): a glint angle below about 4.44 deg for a "
                          "fully sunlit satellite."),
        ("Not included", "Sky conditions: twilight, haze near the horizon, the Moon, light pollution. The "
                         "brightness is Sitrec's own scale, not an astronomical magnitude."),
        ("Per-hour values", "Mean number of flares per night that peak inside that hour."),
        ("Synthetic constellation", "About 10,500 satellites in the measured Starlink shells, re-epoched to each "
                                    "night. It gives realistic statistics, not the positions of real satellites."),
    ]
    for r, (key, value) in enumerate(lines, start=1):
        ws.cell(row=r, column=1, value=key).font = Font(bold=(value is None or r == 1), size=14 if r == 1 else 11)
        if value is not None:
            ws.cell(row=r, column=2, value=value)
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 110


def per_night_sheet(wb, out_dir, kind):
    header, rows = read_csv(out_dir, f"flares_per_night_{kind}.csv")
    ws = wb.create_sheet(f"Per night ({kind})")
    n = len(header) - 1
    chart_col = n + 3
    put_table(ws, header, rows, date_col=0)
    chart = line_chart(f"{kind.capitalize()} Starlink flares per night, by latitude",
                       "Flares per night", "Night of", date_axis=True)
    add_series(chart, ws, n, 1, len(rows) + 1)
    ws.add_chart(chart, f"{get_column_letter(chart_col)}2")


def per_hour_sheet(wb, out_dir, kind):
    header, rows = read_csv(out_dir, f"flares_per_hour_year_{kind}.csv")
    ws = wb.create_sheet(f"Per hour ({kind})")
    n = len(header) - 1
    put_table(ws, header, rows)
    chart = line_chart(f"{kind.capitalize()} flares per hour, mean over all nights",
                       "Mean flares per night in the hour", "Local solar hour")
    add_series(chart, ws, n, 1, len(rows) + 1)
    ws.add_chart(chart, f"{get_column_letter(n + 3)}2")


def by_month_sheet(wb, out_dir, kind):
    """One small chart per month. The data sits in 24-row blocks, one block per month."""
    header, rows = read_csv(out_dir, f"flares_per_hour_by_month_{kind}.csv")
    ws = wb.create_sheet(f"Hour by month ({kind})")
    n = len(header) - 2
    # Re-lay the long table as one block per month: a title row, a header, 24 hours.
    months = []
    for row in rows:
        if not months or months[-1][0] != row[0]:
            months.append((row[0], []))
        months[-1][1].append(row[1:])
    block = 24 + 3
    all_values = [number(v) for row in rows for v in row[2:]]
    y_max = max([v for v in all_values if isinstance(v, (int, float))] + [1])
    for i, (month, month_rows) in enumerate(months):
        top = 1 + i * block
        ws.cell(row=top, column=1, value=month).font = Font(bold=True, size=12)
        # No frozen panes here: freezing and then clearing them leaves <selection>
        # entries that name a missing pane, and Excel reports the sheet view as damaged.
        put_table(ws, header[1:], month_rows, first_row=top + 1, freeze=False)
        chart = line_chart(f"{month}: {kind} flares per hour", "Mean per night", "Local solar hour",
                           SMALL_W, SMALL_H)
        chart.y_axis.scaling.min = 0
        chart.y_axis.scaling.max = y_max     # same scale on every month, so they compare
        add_series(chart, ws, n, top + 1, top + 1 + len(month_rows))
        # Charts two across, beside the data column block.
        col = n + 3 + (i % 2) * 10
        row = 1 + (i // 2) * 17
        ws.add_chart(chart, f"{get_column_letter(col)}{row}")


def summary_sheet(wb, out_dir):
    header, rows = read_csv(out_dir, "summary.csv")
    ws = wb.create_sheet("Summary")
    put_table(ws, header, rows)
    for c in range(len(header)):
        ws.column_dimensions[get_column_letter(c + 1)].width = 16


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out_dir = sys.argv[1]
    with open(os.path.join(out_dir, "run.json"), encoding="utf-8") as fh:
        run = json.load(fh)

    wb = Workbook()
    about_sheet(wb.active, run)
    wb.active.title = "About"
    summary_sheet(wb, out_dir)
    for kind in ("visible", "all"):
        per_night_sheet(wb, out_dir, kind)
        per_hour_sheet(wb, out_dir, kind)
        by_month_sheet(wb, out_dir, kind)

    path = os.path.join(out_dir, "FlareStats.xlsx")
    wb.save(path)
    print(f"Wrote {os.path.abspath(path)}")


if __name__ == "__main__":
    main()
