import fs from 'fs';

function crc16Xmodem(bytes, init = 0x0000) {
    let crc = init & 0xFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= (bytes[i] & 0xFF) << 8;
        for (let b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc;
}

class ULogParser {
    constructor() {
        this.formats = new Map();
        this.messages = new Map();
        this.data = [];
        this.parameters = new Map();
        this.info = new Map();
        this.multiData = new Map();
        this.hasChecksums = false;
    }

    detectChecksums(view, startOffset) {
        const validTypes = [70, 73, 77, 80, 65, 68, 66, 76, 82, 83, 79, 67, 81];
        let offset = startOffset;
        let validCount = 0;
        
        for (let i = 0; i < 3; i++) {
            if (offset + 3 > view.byteLength) break;
            
            const msgSize = view.getUint16(offset, true);
            const msgType = view.getUint8(offset + 2);
            
            if (!validTypes.includes(msgType) || msgSize === 0 || msgSize > 10000) {
                break;
            }
            
            if (offset + 3 + msgSize + 2 > view.byteLength) break;
            
            const msgBytes = new Uint8Array(3 + msgSize);
            msgBytes[0] = msgSize & 0xFF;
            msgBytes[1] = (msgSize >>> 8) & 0xFF;
            msgBytes[2] = msgType;
            for (let j = 0; j < msgSize; j++) {
                msgBytes[3 + j] = view.getUint8(offset + 3 + j);
            }
            
            const calculatedCrc = crc16Xmodem(msgBytes);
            const fileCrcLow = view.getUint8(offset + 3 + msgSize);
            const fileCrcHigh = view.getUint8(offset + 3 + msgSize + 1);
            const fileCrc = fileCrcLow | (fileCrcHigh << 8);
            
            if (calculatedCrc !== fileCrc) {
                break;
            }
            
            const nextOffset = offset + 3 + msgSize + 2;
            if (nextOffset + 3 <= view.byteLength) {
                const nextSize = view.getUint16(nextOffset, true);
                const nextType = view.getUint8(nextOffset + 2);
                
                if (!validTypes.includes(nextType) || nextSize === 0 || nextSize > 10000) {
                    break;
                }
            }
            
            validCount++;
            offset = nextOffset;
        }
        
        return validCount === 3;
    }

    async parse(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        let offset = 0;

        const headerBytes = this.readBytes(view, offset, 7);
        offset += 7;
        const expected = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35];
        
        if (!headerBytes.every((b, i) => b === expected[i])) {
            throw new Error(`Invalid ULog file: header magic bytes not found`);
        }

        const version = view.getUint8(offset);
        offset += 1;

        const timestamp = view.getBigUint64(offset, true);
        offset += 8;

        this.version = version;
        this.info.set('version', version);
        this.info.set('timestamp', timestamp);

        this.hasChecksums = this.detectChecksums(view, offset);

        let messageCount = 0;
        let firstUnknownOffset = null;

        while (offset < view.byteLength) {
            if (offset + 3 > view.byteLength) break;
            
            const msgStartOffset = offset;
            
            const msgSize = view.getUint16(offset, true);
            offset += 2;

            const msgType = view.getUint8(offset);
            offset += 1;

            if (offset + msgSize > view.byteLength) {
                break;
            }
            
            const msgData = new DataView(arrayBuffer, offset, msgSize);
            
            const validTypes = [70, 73, 77, 80, 65, 68, 66, 76, 82, 83, 79, 67, 81];
            if (!validTypes.includes(msgType) && firstUnknownOffset === null) {
                firstUnknownOffset = offset - 3;
                
                let found = false;
                let bestMatch = null;
                for (let searchOffset = offset; searchOffset < Math.min(offset + 100, view.byteLength - 3); searchOffset++) {
                    const testSize = view.getUint16(searchOffset, true);
                    const testType = view.getUint8(searchOffset + 2);
                    if (validTypes.includes(testType) && testSize > 0 && testSize < 10000) {
                        if (!bestMatch) {
                            bestMatch = searchOffset;
                            
                            if (searchOffset === offset + 2) {
                                offset = searchOffset;
                                continue;
                            }
                        }
                        if (searchOffset - offset < 5) break;
                    }
                }
                
                if (messageCount < 5 && !bestMatch) {
                    throw new Error(`Invalid ULog format: unknown message type 0x${msgType.toString(16)} at offset 0x${firstUnknownOffset.toString(16)} (message #${messageCount})`);
                } else if (bestMatch && bestMatch !== offset) {
                    offset = bestMatch;
                    messageCount--;
                    continue;
                }
            }
            
            try {
                switch (msgType) {
                    case 70: // 'F' - Format
                        this.parseFormat(msgData);
                        break;
                    case 73: // 'I' - Info
                        this.parseInfo(msgData);
                        break;
                    case 77: // 'M' - Info Multiple
                        this.parseInfoMultiple(msgData);
                        break;
                    case 80: // 'P' - Parameter
                        this.parseParameter(msgData);
                        break;
                    case 65: // 'A' - Add Logged Message
                        this.parseAddLogged(msgData);
                        break;
                    case 68: // 'D' - Data
                        this.parseData(msgData);
                        break;
                    case 66: // 'B' - Flag Bits
                        this.parseFlagBits(msgData);
                        break;
                    case 76: // 'L' - Logged String
                        break;
                    case 82: // 'R' - Remove Logged Message
                        break;
                    case 83: // 'S' - Sync
                        break;
                    case 79: // 'O' - Dropout
                        break;
                    case 67: // 'C' - Logging Tagged
                        break;
                    case 81: // 'Q' - Parameter Default
                        break;
                }
            } catch (e) {
                console.error(`Error parsing message type '${String.fromCharCode(msgType)}' at offset 0x${(offset-3).toString(16)}:`, e);
            }

            offset += msgSize;
            
            if (this.hasChecksums) {
                offset += 2;
            }
            
            messageCount++;
        }

        return this.extractTrackData();
    }

    readBytes(view, offset, length) {
        const bytes = [];
        for (let i = 0; i < length; i++) {
            bytes.push(view.getUint8(offset + i));
        }
        return bytes;
    }

    readString(view, offset, maxLength) {
        const bytes = [];
        for (let i = 0; i < maxLength; i++) {
            const byte = view.getUint8(offset + i);
            if (byte === 0) break;
            bytes.push(byte);
        }
        return String.fromCharCode(...bytes);
    }

    parseFlagBits(view) {
        if (view.byteLength < 16) {
            return;
        }

        const compatFlags = view.getBigUint64(0, true);
        const incompatFlags = view.getBigUint64(8, true);
        
        const INCOMPAT_FLAG0_DATA_APPENDED_MASK = 1n;
        if (incompatFlags & INCOMPAT_FLAG0_DATA_APPENDED_MASK) {
            const numAppendedOffsets = (view.byteLength - 16) / 8;
            this.info.set('has_appended_data', true);
            
            const appendedOffsets = [];
            for (let i = 0; i < numAppendedOffsets; i++) {
                appendedOffsets.push(view.getBigUint64(16 + i * 8, true));
            }
            this.info.set('appended_offsets', appendedOffsets);
        }
    }

    parseFormat(view) {
        const formatStr = this.readString(view, 0, view.byteLength);
        const colonIdx = formatStr.indexOf(':');
        if (colonIdx === -1) return;

        const name = formatStr.substring(0, colonIdx);
        const fieldsStr = formatStr.substring(colonIdx + 1);
        
        const fields = [];
        const fieldParts = fieldsStr.split(';');
        
        for (const part of fieldParts) {
            if (!part.trim()) continue;
            const spaceIdx = part.lastIndexOf(' ');
            if (spaceIdx === -1) continue;
            
            const type = part.substring(0, spaceIdx).trim();
            const fieldName = part.substring(spaceIdx + 1).trim();
            
            fields.push({ name: fieldName, type: this.parseFieldType(type) });
        }

        this.formats.set(name, fields);
    }

    parseFieldType(typeStr) {
        const arrayMatch = typeStr.match(/^(.+)\[(\d+)\]$/);
        if (arrayMatch) {
            return {
                baseType: arrayMatch[1],
                isArray: true,
                arraySize: parseInt(arrayMatch[2])
            };
        }
        return {
            baseType: typeStr,
            isArray: false,
            arraySize: 1
        };
    }

    parseInfo(view) {
        const keyLen = view.getUint8(0);
        const typeAndKey = this.readString(view, 1, keyLen);
        
        const spaceIdx = typeAndKey.indexOf(' ');
        if (spaceIdx === -1) return;
        
        const type = typeAndKey.substring(0, spaceIdx);
        const key = typeAndKey.substring(spaceIdx + 1);
        
        const valueOffset = 1 + keyLen;
        const valueLength = view.byteLength - valueOffset;
        
        let value;
        if (type.startsWith('char[')) {
            const bytes = [];
            for (let i = 0; i < valueLength; i++) {
                const byte = view.getUint8(valueOffset + i);
                if (byte === 0) break;
                bytes.push(byte);
            }
            value = String.fromCharCode(...bytes);
        } else if (type === 'int32_t') {
            value = view.getInt32(valueOffset, true);
        } else if (type === 'uint32_t') {
            value = view.getUint32(valueOffset, true);
        } else if (type === 'int64_t') {
            value = view.getBigInt64(valueOffset, true);
        } else if (type === 'uint64_t') {
            value = view.getBigUint64(valueOffset, true);
        } else if (type === 'float') {
            value = view.getFloat32(valueOffset, true);
        } else if (type === 'double') {
            value = view.getFloat64(valueOffset, true);
        } else {
            value = this.readString(view, valueOffset, valueLength);
        }
        
        this.info.set(key, value);
    }

    parseInfoMultiple(view) {
        const isContinued = view.getUint8(0);
        const keyLen = view.getUint8(1);
        const typeAndKey = this.readString(view, 2, keyLen);
        
        const spaceIdx = typeAndKey.indexOf(' ');
        if (spaceIdx === -1) return;
        
        const type = typeAndKey.substring(0, spaceIdx);
        const key = typeAndKey.substring(spaceIdx + 1);
        
        const valueOffset = 2 + keyLen;
        const valueLength = view.byteLength - valueOffset;
        
        let value;
        if (type.startsWith('char[')) {
            const bytes = [];
            for (let i = 0; i < valueLength; i++) {
                const byte = view.getUint8(valueOffset + i);
                if (byte === 0) break;
                bytes.push(byte);
            }
            value = String.fromCharCode(...bytes);
        } else {
            value = this.readString(view, valueOffset, valueLength);
        }
        
        if (!this.multiData.has(key)) {
            this.multiData.set(key, []);
        }
        this.multiData.get(key).push(value);
    }

    parseParameter(view) {
        const keyLen = view.getUint8(0);
        const typeAndKey = this.readString(view, 1, keyLen);
        
        const spaceIdx = typeAndKey.indexOf(' ');
        if (spaceIdx === -1) return;
        
        const type = typeAndKey.substring(0, spaceIdx);
        const key = typeAndKey.substring(spaceIdx + 1);
        
        const valueOffset = 1 + keyLen;
        
        let value;
        if (type === 'int32_t') {
            value = view.getInt32(valueOffset, true);
        } else if (type === 'float') {
            value = view.getFloat32(valueOffset, true);
        } else {
            value = this.readString(view, valueOffset, view.byteLength - valueOffset);
        }
        
        this.parameters.set(key, value);
    }

    parseAddLogged(view) {
        const multiId = view.getUint8(0);
        const msgId = view.getUint16(1, true);
        const msgName = this.readString(view, 3, view.byteLength - 3);
        
        this.messages.set(msgId, { name: msgName, multiId });
    }

    parseData(view) {
        const msgId = view.getUint16(0, true);
        const msgInfo = this.messages.get(msgId);
        
        if (!msgInfo) return;
        
        const format = this.formats.get(msgInfo.name);
        if (!format) return;

        const record = { _msgName: msgInfo.name, _msgId: msgId };
        let offset = 2;

        for (const field of format) {
            try {
                const value = this.readFieldValue(view, offset, field.type);
                record[field.name] = value.value;
                offset += value.size;
            } catch (e) {
                break;
            }
        }

        this.data.push(record);
    }

    readFieldValue(view, offset, type) {
        const { baseType, isArray, arraySize } = type;

        if (isArray) {
            const values = [];
            let totalSize = 0;
            for (let i = 0; i < arraySize; i++) {
                const result = this.readSingleValue(view, offset + totalSize, baseType);
                values.push(result.value);
                totalSize += result.size;
            }
            return { value: values, size: totalSize };
        } else {
            return this.readSingleValue(view, offset, baseType);
        }
    }

    readSingleValue(view, offset, type) {
        switch (type) {
            case 'int8_t':
                return { value: view.getInt8(offset), size: 1 };
            case 'uint8_t':
                return { value: view.getUint8(offset), size: 1 };
            case 'int16_t':
                return { value: view.getInt16(offset, true), size: 2 };
            case 'uint16_t':
                return { value: view.getUint16(offset, true), size: 2 };
            case 'int32_t':
                return { value: view.getInt32(offset, true), size: 4 };
            case 'uint32_t':
                return { value: view.getUint32(offset, true), size: 4 };
            case 'int64_t':
                return { value: view.getBigInt64(offset, true), size: 8 };
            case 'uint64_t':
                return { value: view.getBigUint64(offset, true), size: 8 };
            case 'float':
                return { value: view.getFloat32(offset, true), size: 4 };
            case 'double':
                return { value: view.getFloat64(offset, true), size: 8 };
            case 'bool':
                return { value: view.getUint8(offset) !== 0, size: 1 };
            case 'char':
                return { value: String.fromCharCode(view.getUint8(offset)), size: 1 };
            default:
                if (!this.formats.has(type)) {
                    console.warn(`Unknown type: ${type}`);
                }
                return { value: null, size: 1 };
        }
    }

    extractTrackData() {
        const trackPoints = [];
        
        const positionMessages = this.data.filter(d => 
            d._msgName === 'vehicle_global_position' ||
            d._msgName === 'vehicle_local_position' ||
            d._msgName === 'vehicle_gps_position' ||
            d._msgName === 'sensor_gps'
        );

        for (const msg of positionMessages) {
            const point = {
                timestamp: msg.timestamp ? Number(msg.timestamp) / 1000000.0 : 0,
            };

            let lat = null;
            let lon = null;
            let alt = null;

            if (msg.latitude_deg !== undefined && msg.longitude_deg !== undefined) {
                lat = msg.latitude_deg;
                lon = msg.longitude_deg;
                alt = msg.altitude_msl_m !== undefined ? msg.altitude_msl_m : 
                     (msg.altitude_ellipsoid_m !== undefined ? msg.altitude_ellipsoid_m : null);
            } else if (msg.lat !== undefined && msg.lon !== undefined) {
                lat = msg.lat;
                lon = msg.lon;
                alt = msg.alt;
            }

            if (lat !== null && lon !== null) {
                const latType = this.getFieldType(msg._msgName, 'lat') || this.getFieldType(msg._msgName, 'latitude_deg');
                const lonType = this.getFieldType(msg._msgName, 'lon') || this.getFieldType(msg._msgName, 'longitude_deg');
                const altType = this.getFieldType(msg._msgName, 'alt') || this.getFieldType(msg._msgName, 'altitude_msl_m');
                
                const latIsInteger = latType && (latType.baseType === 'int32_t' || latType.baseType === 'int64_t');
                const lonIsInteger = lonType && (lonType.baseType === 'int32_t' || lonType.baseType === 'int64_t');
                const altIsInteger = altType && (altType.baseType === 'int32_t' || latType.baseType === 'int64_t');

                if (latIsInteger || Math.abs(lat) > 360) {
                    point.lat = lat / 1e7;
                } else {
                    point.lat = lat;
                }
                
                if (lonIsInteger || Math.abs(lon) > 360) {
                    point.lon = lon / 1e7;
                } else {
                    point.lon = lon;
                }
                
                if (alt !== null && alt !== undefined) {
                    if (altIsInteger || Math.abs(alt) > 10000) {
                        point.alt = alt / 1000.0;
                    } else {
                        point.alt = alt;
                    }
                } else {
                    point.alt = 0;
                }
            } else if (msg.x !== undefined && msg.y !== undefined) {
                point.x = msg.x;
                point.y = msg.y;
                point.z = msg.z !== undefined ? msg.z : 0;
            }

            if (msg.vx !== undefined) point.vx = msg.vx;
            if (msg.vy !== undefined) point.vy = msg.vy;
            if (msg.vz !== undefined) point.vz = msg.vz;

            if (Object.keys(point).length > 1) {
                trackPoints.push(point);
            }
        }

        return {
            points: trackPoints,
            formats: this.formats,
            messages: this.messages,
            parameters: this.parameters,
            info: this.info,
            allData: this.data
        };
    }

    getFieldType(messageName, fieldName) {
        const format = this.formats.get(messageName);
        if (!format) return null;
        const field = format.find(f => f.name === fieldName);
        return field ? field.type : null;
    }
}

async function analyzeFile(filePath) {
    console.log('=== PX4 ULog Debug Tool ===\n');
    console.log(`Reading file: ${filePath}`);
    
    const buffer = fs.readFileSync(filePath);
    console.log(`File size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n`);
    
    console.log('Parsing ULog file...');
    const parser = new ULogParser();
    const result = await parser.parse(buffer.buffer);
    
    console.log('✓ Parse completed!\n');
    
    console.log('=== BASIC STATS ===');
    console.log(`Track points found: ${result.points?.length || 0}`);
    console.log(`Total data messages: ${result.allData?.length || 0}`);
    console.log(`Message formats: ${result.formats?.size || 0}`);
    console.log(`Parameters: ${result.parameters?.size || 0}`);
    console.log(`Info fields: ${result.info?.size || 0}`);
    
    if (result.allData && result.allData.length > 0) {
        console.log('\n=== MESSAGE TYPE DISTRIBUTION ===');
        const messageTypes = {};
        result.allData.forEach(msg => {
            const type = msg._msgName || 'unknown';
            messageTypes[type] = (messageTypes[type] || 0) + 1;
        });
        
        const sorted = Object.entries(messageTypes).sort((a, b) => b[1] - a[1]);
        const total = result.allData.length;
        
        console.log(`Total types: ${sorted.length}\n`);
        sorted.slice(0, 20).forEach(([type, count]) => {
            const pct = ((count / total) * 100).toFixed(2);
            console.log(`  ${type.padEnd(35)} ${count.toString().padStart(8)} (${pct}%)`);
        });
        if (sorted.length > 20) {
            console.log(`  ... and ${sorted.length - 20} more types`);
        }
    }
    
    console.log('\n=== POSITION-RELATED MESSAGE TYPES ===');
    const keywords = ['position', 'gps', 'local', 'global', 'location'];
    const messageTypes = new Set(result.allData.map(d => d._msgName));
    const positionTypes = [...messageTypes].filter(type => 
        keywords.some(kw => type.toLowerCase().includes(kw))
    ).sort();
    
    if (positionTypes.length > 0) {
        positionTypes.forEach(type => {
            const count = result.allData.filter(d => d._msgName === type).length;
            console.log(`  ${type}: ${count} messages`);
        });
        
        console.log('\n=== SAMPLE DATA FROM POSITION TYPES ===');
        positionTypes.forEach(type => {
            const sample = result.allData.find(d => d._msgName === type);
            if (sample) {
                console.log(`\n${type}:`);
                const keys = Object.keys(sample).filter(k => !k.startsWith('_')).slice(0, 15);
                keys.forEach(key => {
                    let value = sample[key];
                    if (Array.isArray(value)) {
                        value = `[${value.slice(0, 3).join(', ')}...]`;
                    } else if (typeof value === 'bigint') {
                        value = value.toString();
                    }
                    console.log(`  ${key}: ${value}`);
                });
                if (Object.keys(sample).filter(k => !k.startsWith('_')).length > 15) {
                    console.log(`  ... and ${Object.keys(sample).filter(k => !k.startsWith('_')).length - 15} more fields`);
                }
            }
        });
    } else {
        console.log('  No position-related message types found!');
    }
    
    console.log('\n=== ALL MESSAGE FORMATS WITH POSITION FIELDS ===');
    const formats = [...result.formats.keys()].sort();
    formats.forEach(formatName => {
        const fields = result.formats.get(formatName);
        const posFields = fields.filter(f => 
            keywords.some(kw => f.name.toLowerCase().includes(kw)) ||
            ['lat', 'lon', 'alt', 'altitude', 'x', 'y', 'z'].includes(f.name.toLowerCase())
        );
        if (posFields.length > 0) {
            console.log(`\n${formatName}:`);
            posFields.forEach(field => {
                const typeStr = field.type.isArray 
                    ? `${field.type.baseType}[${field.type.arraySize}]`
                    : field.type.baseType;
                console.log(`  - ${field.name}: ${typeStr}`);
            });
        }
    });
    
    console.log('\n=== INFO FIELDS ===');
    if (result.info && result.info.size > 0) {
        for (const [key, value] of result.info) {
            console.log(`  ${key}: ${value}`);
        }
    }
}

const filePath = process.argv[2];
if (!filePath) {
    console.error('Usage: node tools/px4-debug.js <flight-log.ulg>');
    process.exitCode = 1;
} else {
    analyzeFile(filePath).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
