import {parquetMetadata, parquetRead} from 'hyparquet';
import {ZSTDDecoder} from 'zstddec';

let decoderPromise;
function zstdDecoder() {
    return decoderPromise ??= (async () => {
        const decoder = new ZSTDDecoder();
        await decoder.init();
        return decoder;
    })().catch(error => { decoderPromise = undefined; throw error; });
}

function decimalText(value, scale) {
    if (value instanceof Uint8Array) {
        let integer = 0n;
        for (const byte of value) integer = (integer << 8n) | BigInt(byte);
        if (value[0] & 128) integer -= 1n << BigInt(value.length * 8);
        value = integer;
    }
    // Physical INT64s stay BigInt until they are back in their decimal spelling.
    const negative = value < 0;
    const digits = String(negative ? -value : value).padStart(scale + 1, '0');
    return (negative ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}

function timestampText(value, digits) {
    // Date is used only for whole seconds; never round the microsecond remainder.
    const micros = BigInt(value);
    const remainder = ((micros % 1000000n) + 1000000n) % 1000000n;
    const seconds = (micros - remainder) / 1000000n;
    const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
    return digits ? base + '.' + String(remainder).padStart(6, '0') : base;
}

const csvCell = value => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;

// Decode to the existing OMM representation so imports, merges, exports and
// propagation all use the same parser. The original binary stays in FileManager
// for rehosting/saving; no precision is lost in an intermediate JS Number.
export async function satelliteParquetToCSV(file) {
    const metadata = parquetMetadata(file);
    const properties = Object.fromEntries((metadata.key_value_metadata ?? []).map(x => [x.key, x.value]));
    if (properties['sitrec:gp:version'] !== '1') throw new Error('Unsupported satellite Parquet format');
    const hints = JSON.parse(properties['sitrec:gp:formats']);
    const fields = metadata.schema.slice(1);
    if (!fields.some(f => f.name === 'NORAD_CAT_ID') || !fields.some(f => f.name === 'EPOCH')) {
        throw new Error('Parquet file is not an OMM satellite catalog');
    }
    const rows = Number(metadata.num_rows);
    if (!Number.isSafeInteger(rows) || rows < 1) throw new Error('Invalid satellite catalog row count');
    for (const field of fields) {
        if (field.converted_type === 'DECIMAL') {
            // hyparquet normally converts DECIMAL through Number, which can
            // round the last digit. Read the physical scaled integer instead.
            delete field.converted_type;
            delete field.logical_type;
        }
        if (!hints[field.name]) throw new Error('Missing satellite column format: ' + field.name);
    }
    const decoder = await zstdDecoder();
    const columns = Object.fromEntries(fields.map(f => [f.name, new Array(rows)]));
    await parquetRead({file, metadata,
        compressors: {ZSTD: (data, size) => decoder.decode(data, size)},
        parsers: {timestampFromMicroseconds: value => value,
            dateFromDays: days => new Date(days * 86400000).toISOString().slice(0, 10)},
        onChunk({columnName, columnData, rowStart}) {
            const hint = hints[columnName];
            const column = columns[columnName];
            for (let i = 0; i < columnData.length; i++) {
                const value = columnData[i];
                const text = value == null ? '' : hint.kind === 'decimal' ? decimalText(value, hint.scale)
                    : hint.kind === 'timestamp' ? timestampText(value, hint.digits) : String(value);
                column[rowStart + i] = csvCell(text);
            }
        }});
    const ordered = fields.map(f => columns[f.name]);
    const lines = new Array(rows + 1);
    lines[0] = fields.map(f => csvCell(f.name)).join(',');
    for (let row = 0; row < rows; row++) lines[row + 1] = ordered.map(column => column[row]).join(',');
    return lines.join('\n') + '\n';
}
