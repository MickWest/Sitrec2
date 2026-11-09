// Estimated constellation population at UTC month boundaries, counted from launch/end
// dates in Jonathan McDowell's Starlink index (snapshot updated 2026-08-08):
// https://www.planet4589.org/space/con/star/starindex.html
// Excludes the two Tintin prototypes and suborbital simulators. Interpolation estimates
// population between samples; it does not reproduce individual launches or historical shells.
// The final anchor is the measured population in SHF's shell table. Future dates hold that
// count rather than inventing future launches. Refresh these samples with the shell table.
import {STARLINK_SHELLS} from "../tools/shf/starlinkShells.js";

const population = [
    ["2019-05-23", 0],
    ["2019-05-24", 60],
    ["2019-06-01", 59],
    ["2019-07-01", 56],
    ["2019-08-01", 56],
    ["2019-09-01", 56],
    ["2019-10-01", 56],
    ["2019-11-01", 56],
    ["2019-12-01", 116],
    ["2020-01-01", 114],
    ["2020-02-01", 234],
    ["2020-03-01", 290],
    ["2020-04-01", 349],
    ["2020-05-01", 407],
    ["2020-06-01", 403],
    ["2020-07-01", 520],
    ["2020-08-01", 514],
    ["2020-09-01", 619],
    ["2020-10-01", 649],
    ["2020-11-01", 816],
    ["2020-12-01", 872],
    ["2021-01-01", 871],
    ["2021-02-01", 940],
    ["2021-03-01", 1059],
    ["2021-04-01", 1289],
    ["2021-05-01", 1402],
    ["2021-06-01", 1631],
    ["2021-07-01", 1630],
    ["2021-08-01", 1621],
    ["2021-09-01", 1607],
    ["2021-10-01", 1647],
    ["2021-11-01", 1639],
    ["2021-12-01", 1680],
    ["2022-01-01", 1761],
    ["2022-02-01", 1839],
    ["2022-03-01", 1936],
    ["2022-04-01", 2075],
    ["2022-05-01", 2164],
    ["2022-06-01", 2371],
    ["2022-07-01", 2419],
    ["2022-08-01", 2663],
    ["2022-09-01", 2900],
    ["2022-10-01", 3085],
    ["2022-11-01", 3232],
    ["2022-12-01", 3225],
    ["2023-01-01", 3328],
    ["2023-02-01", 3475],
    ["2023-03-01", 3652],
    ["2023-04-01", 3860],
    ["2023-05-01", 3917],
    ["2023-06-01", 4144],
    ["2023-07-01", 4312],
    ["2023-08-01", 4490],
    ["2023-09-01", 4626],
    ["2023-10-01", 4786],
    ["2023-11-01", 4954],
    ["2023-12-01", 5081],
    ["2024-01-01", 5201],
    ["2024-02-01", 5346],
    ["2024-03-01", 5449],
    ["2024-04-01", 5621],
    ["2024-05-01", 5811],
    ["2024-06-01", 6003],
    ["2024-07-01", 6088],
    ["2024-08-01", 6134],
    ["2024-09-01", 6270],
    ["2024-10-01", 6337],
    ["2024-11-01", 6465],
    ["2024-12-01", 6685],
    ["2025-01-01", 6692],
    ["2025-02-01", 6790],
    ["2025-03-01", 6927],
    ["2025-04-01", 7005],
    ["2025-05-01", 7186],
    ["2025-06-01", 7536],
    ["2025-07-01", 7793],
    ["2025-08-01", 7963],
    ["2025-09-01", 8172],
    ["2025-10-01", 8435],
    ["2025-11-01", 8724],
    ["2025-12-01", 8990],
    ["2026-01-01", 9261],
    ["2026-02-01", 9457],
    ["2026-03-01", 9731],
    ["2026-04-01", 10029],
    ["2026-05-01", 10263],
    ["2026-06-01", 10431],
    ["2026-07-01", 10656],
    ["2026-08-01", 10883],
    [STARLINK_SHELLS.refEpoch.slice(0, 10), STARLINK_SHELLS.total],
].map(([date, count]) => [Date.parse(date), count]);

export function starlinkPopulation(date) {
    // Population changes once per UTC date; motion continues within each day.
    const ms = Math.floor(date.getTime() / 86400000) * 86400000;
    if (!Number.isFinite(ms) || ms < population[1][0]) return 0;
    for (let i = 1; i < population.length; i++) {
        const [end, count] = population[i];
        if (ms <= end) {
            const [start, previous] = population[i - 1];
            return Math.round(previous + (count - previous) * (ms - start) / (end - start));
        }
    }
    return population[population.length - 1][1];
}
