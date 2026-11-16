# Satellite catalog storage

Space-Track still supplies OMM CSV. The server stores complete catalogs as typed
Parquet with Zstd compression (`*.v1.parquet`). Integer IDs, exact fixed-point
decimals and microsecond timestamps retain the source values. A column remains
text if its original spelling cannot be reconstructed exactly. Empty values,
extra columns and row order are preserved.

The standard Docker images install PyArrow 20.0.0. On other PHP hosts, install it
in the Python environment used by the web server:

```sh
python3 -m pip install pyarrow==20.0.0
```

Set the server environment variable `GP_PYTHON` to an absolute Python executable
if it is not on the web server's search path. `proc_open` must be available.
Deployments that omit Python, including release images built with
`WITH_GFS_WIND=0`, retain the gzip CSV fallback. Conversion failures are logged
and leave the working source cache intact.

Updated clients request `format=parquet&schema=3`. Existing full-metadata CSV
caches convert locally on demand, under the same per-catalog lock as downloads.
Conversion verifies the complete typed table before atomically publishing it,
then removes the superseded CSV. Migration preserves the source modification
time, so current-catalog expiry and historical settle checks remain valid.
Incomplete older metadata caches still refresh from the source as before.

Requests without `format=parquet` receive a temporary CSV compatibility response;
only Parquet is retained on disk. HTTP conditional requests avoid decoding an
unchanged catalog. A failed upstream refresh can still serve the old catalog.

The browser recognizes Parquet by its `PAR1` signature, including saved files
with older extensions. It lazily loads the Parquet/Zstd decoder and reconstructs
OMM text for the shared satellite parser. Original binary bytes are retained for
saving and rehosting. CSV, TLE and existing saved sitches continue to load.

For the October 10, 2025 catalog (October 9–11 query window), 182,686 element sets
for 25,872 objects measured 8.70 MB as gzip CSV and 5.19 MB as typed Parquet.
These are decimal MB; actual size varies with catalog and metadata.
