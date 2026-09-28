// Execute-test for the flare-stats time helpers (stats/statsCore.mjs): the
// noon-to-noon night window, local-solar-hour binning and the date range.
import { nightStartMs, solarHour, dateRange } from "../stats/statsCore.mjs";

let fails = 0;
function ok(name, cond, extra = "") {
    console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : ""));
    if (!cond) fails++;
}

console.log("== stats: night window and solar hours ==");

ok("night at lon 0 starts 12:00 UTC",
    nightStartMs("2026-06-21", 0) === Date.UTC(2026, 5, 21, 12));
ok("night at lon 90E starts 06:00 UTC",
    nightStartMs("2026-06-21", 90) === Date.UTC(2026, 5, 21, 6));
ok("night at lon 120W starts 20:00 UTC",
    nightStartMs("2026-06-21", -120) === Date.UTC(2026, 5, 21, 20));

ok("solar hour at lon 0 = UTC hour", solarHour(Date.UTC(2026, 0, 1, 3, 59), 0) === 3);
ok("solar hour at lon 90E = UTC + 6", solarHour(Date.UTC(2026, 0, 1, 20, 30), 90) === 2);
ok("solar hour at lon 120W = UTC - 8", solarHour(Date.UTC(2026, 0, 1, 5, 0), -120) === 21);
ok("night start is solar noon",
    [-150, -37.5, 0, 12, 179].every((lon) => solarHour(nightStartMs("2026-03-01", lon), lon) === 12));

const year = dateRange("2026-01-01", "2026-12-31");
ok("a full year has 365 nights", year.length === 365, String(year.length));
ok("leap year has 366 nights", dateRange("2028-01-01", "2028-12-31").length === 366);
ok("range ends on the last date", year[364] === "2026-12-31");
const weekly = dateRange("2026-01-01", "2026-12-31", 7);
ok("weekly step", weekly.length === 53 && weekly[1] === "2026-01-08", `${weekly.length} ${weekly[1]}`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
