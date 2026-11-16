#!/usr/bin/env python3
"""Lossless OMM CSV <-> typed Parquet cache conversion (PyArrow 20+)."""
import argparse
import csv
from datetime import date, datetime
from decimal import Decimal
import gzip
import json
import re
import sys

import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq

DECIMALS = {'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
            'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'}
INTEGERS = {'NORAD_CAT_ID', 'GP_ID', 'FILE', 'EPHEMERIS_TYPE'}
TIMESTAMPS = {'EPOCH', 'CREATION_DATE'}
DATES = {'LAUNCH_DATE', 'DECAY_DATE'}
REQUIRED = DECIMALS | INTEGERS | TIMESTAMPS | DATES | {
    'OBJECT_NAME', 'OBJECT_ID', 'OBJECT_TYPE', 'RCS_SIZE', 'COUNTRY_CODE', 'SITE', 'MEAN_ELEMENT_THEORY'}
FORMATS_KEY = b'sitrec:gp:formats'


def format_value(value, hint):
    if value is None:
        return ''
    if hint['kind'] == 'timestamp':
        return value.isoformat(timespec='microseconds' if hint['digits'] else 'seconds')
    return str(value)


def typed_column(name, column):
    """Use a binary type only when it reconstructs every original cell exactly."""
    values = column.to_pylist()
    nonempty = [v for v in values if v != '']
    hint = {'kind': 'string'}
    try:
        if not nonempty:
            return column, hint
        if name in DECIMALS:
            parsed = [Decimal(v) if v else None for v in values]
            numbers = [v for v in parsed if v is not None]
            if any(not v.is_finite() or (v.is_zero() and v.is_signed()) for v in numbers):
                return column, hint
            scale = max(0, max(-v.as_tuple().exponent for v in numbers))
            precision = max(1, scale, max(len(v.as_tuple().digits) + v.as_tuple().exponent + scale for v in numbers))
            result = pa.array(parsed, type=pa.decimal128(precision, scale))
            hint = {'kind': 'decimal', 'scale': scale}
        elif name in INTEGERS:
            result = pa.array([int(v) if v else None for v in values], type=pa.uint64())
            hint = {'kind': 'integer'}
        elif name in TIMESTAMPS:
            digits = 6 if all(re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}', v) for v in nonempty) else 0
            result = pa.array([datetime.fromisoformat(v) if v else None for v in values], type=pa.timestamp('us'))
            hint = {'kind': 'timestamp', 'digits': digits}
        elif name in DATES:
            result = pa.array([date.fromisoformat(v) if v else None for v in values], type=pa.date32())
            hint = {'kind': 'date'}
        else:
            return column, hint
        # Noncanonical spelling, mixed decimal scales, or finer timestamps stay
        # strings. An upstream formatting change must never lose information.
        if all(source == format_value(value, hint) for source, value in zip(values, result.to_pylist())):
            return result, hint
    except (ValueError, ArithmeticError, OverflowError, pa.ArrowException):
        pass
    return column, {'kind': 'string'}


def encode(source, target):
    opener = gzip.open if source.endswith('.gz') else open
    with opener(source, 'rb') as stream:
        header = next(csv.reader([stream.readline().decode('utf-8-sig')]))
    if not REQUIRED.issubset(header) or len(set(header)) != len(header):
        raise ValueError('Incomplete OMM metadata header')
    table = pacsv.read_csv(source, convert_options=pacsv.ConvertOptions(
        column_types={n: pa.string() for n in header}, strings_can_be_null=False))
    if not table.num_rows:
        raise ValueError('Empty OMM catalog')
    columns, hints = {}, {}
    for name in header:
        columns[name], hints[name] = typed_column(name, table[name])
    typed = pa.table(columns).replace_schema_metadata({
        b'sitrec:gp:version': b'1', FORMATS_KEY: json.dumps(hints, separators=(',', ':')).encode()})
    dictionaries = [n for n in header if hints[n]['kind'] == 'string']
    pq.write_table(typed, target, compression='zstd', compression_level=9,
                   use_dictionary=dictionaries, store_decimal_as_integer=True, row_group_size=262144)
    if not typed.equals(pq.read_table(target)):
        raise ValueError('Parquet verification failed')


def decode(source, target):
    parquet = pq.ParquetFile(source)
    hints = json.loads(parquet.schema_arrow.metadata[FORMATS_KEY])
    # Compatibility responses are temporary gzip CSVs, never a second durable
    # archive. Stream batches to bound memory even for a wide history window.
    with gzip.open(target, 'wt', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream, lineterminator='\n')
        names = parquet.schema_arrow.names
        writer.writerow(names)
        for batch in parquet.iter_batches(batch_size=8192):
            columns = [batch.column(i).to_pylist() for i in range(len(names))]
            for row in zip(*columns):
                writer.writerow([format_value(v, hints[n]) for n, v in zip(names, row)])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['encode', 'decode'])
    parser.add_argument('source')
    parser.add_argument('target')
    args = parser.parse_args()
    try:
        (encode if args.operation == 'encode' else decode)(args.source, args.target)
    except Exception as error:
        print('GP conversion failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
