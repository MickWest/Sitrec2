// resetOutDir.js — empty a generated-results tree before regenerating it.
//
// WHY THIS IS NOT JUST fs.rmSync. The results trees live inside a
// Dropbox-synced working copy, and Finder/Dropbox recreate .DS_Store inside a
// directory WHILE the recursive delete is walking it. rmSync then reaches the
// rmdir for a directory that has become non-empty again and throws ENOTEMPTY —
// after it has already deleted most of the tree. The failure is therefore
// destructive: the bench aborts with the set half gone, and the half that
// remains looks like a complete run to anything that reads it. Measured on the
// M1 tree, which came back with two of its four duration folders.
//
// Retrying is the whole fix: the recreated file is deleted on the next pass and
// the directory goes. A handful of attempts is plenty — this is a race with a
// file watcher, not a permissions problem, and if it were a permissions problem
// no number of retries would help, so the last failure is rethrown.

import fs from "fs";

export function resetOutDir(dir, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try {
            fs.rmSync(dir, {recursive: true, force: true});
            if (!fs.existsSync(dir)) return;
        } catch (e) {
            // ENOTEMPTY is the race above; anything else is a real problem and
            // retrying it just delays the report.
            if (e?.code !== "ENOTEMPTY" && e?.code !== "EBUSY") throw e;
            if (i === attempts - 1) throw e;
        }
    }
    if (fs.existsSync(dir)) {
        throw new Error(`resetOutDir: ${dir} still exists after ${attempts} attempts`);
    }
}
