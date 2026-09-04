#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

class ULogParser {
    constructor() {
        this.formats = new Map();
        this.messages = new Map();
        this.data = [];
        this.parameters = new Map();
        this.info = new Map();
        this.multiData = new Map();
    }

    async parse(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        let offset = 0;

        const header = this.readBytes(view, 0, 16);
        console.log('Header (16 bytes):', header.map(b => b.toString(16).padStart(2, '0')).join(' '));
        
        const magic = this.readBytes(view, 0, 7);
        const magicExpected = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35];
        
        for (let i = 0; i < 7; i++) {
            if (magic[i] !== magicExpected[i]) {
                throw new Error(`Invalid ULog header at byte ${i}: expected ${magicExpected[i].toString(16)}, got ${magic[i].toString(16)}`);
            }
        }
        
        console.log('Magic: Valid ULog header');
        offset = 8;

        const timestamp = view.getBigUint64(offset, true);
        offset += 8;
        console.log('Timestamp:', timestamp);

        this.info.set('version', 1);
        this.info.set('timestamp', timestamp);

        let msgCount = 0;
        let errorCount = 0;
        const msgTypeCounts = new Map();

        while (offset < view.byteLength) {
            if (offset + 3 > view.byteLength) {
                console.log('Reached end of file');
                break;
            }

            const msgSize = view.getUint16(offset, true);
            offset += 2;

            const msgType = view.getUint8(offset);
            offset += 1;

            const msgTypeChar = String.fromCharCode(msgType);
            msgTypeCounts.set(msgTypeChar, (msgTypeCounts.get(msgTypeChar) || 0) + 1);

            if (msgCount < 5) {
                const msgBytes = Array.from(new Uint8Array(arrayBuffer, offset - 3, Math.min(16, view.byteLength - offset + 3))).map(b => b.toString(16).padStart(2, '0')).join(' ');
                console.log(`Message ${msgCount}: type=${msgTypeChar} (${msgType}), size=${msgSize}, offset=${offset - 3}`);
                console.log(`  Bytes: ${msgBytes}`);
            }

            if (msgSize === 0 || offset + msgSize > view.byteLength) {
                console.error(`Invalid message size ${msgSize} at offset ${offset - 3}`);
                break;
            }

            const msgData = new DataView(arrayBuffer, offset, msgSize);
            
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
                    case 76: // 'L' - Logged String
                        break;
                    case 82: // 'R' - Remove Logged Message
                        break;
                    case 83: // 'S' - Sync
                        break;
                    case 79: // 'O' - Dropout
                        break;
                    default:
                        console.warn(`Unknown message type: ${msgType} (${msgTypeChar}) at offset ${offset - 3}`);
                }
                msgCount++;
            } catch (e) {
                console.error(`Error parsing message type ${msgTypeChar} at offset ${offset - 3}:`, e.message);
                errorCount++;
            }

            offset += msgSize;
            
            if (msgCount < 5) {
                console.log(`  -> Next offset: ${offset}, bytes: ${Array.from(new Uint8Array(arrayBuffer, offset, Math.min(8, view.byteLength - offset))).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
            }
        }

        console.log('\n=== Parsing Summary ===');
        console.log('Total messages processed:', msgCount);
        console.log('Errors encountered:', errorCount);
        console.log('\nMessage type counts:');
        for (const [type, count] of msgTypeCounts) {
            console.log(`  ${type}: ${count}`);
        }
        console.log('\nFormats defined:', this.formats.size);
        console.log('Messages registered:', this.messages.size);
        console.log('Data records:', this.data.length);
        console.log('Parameters:', this.parameters.size);
        console.log('Info entries:', this.info.size);

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
        console.log(`Format: ${name} (${fields.length} fields)`);
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
        const key = this.readString(view, 1, keyLen);
        const value = this.readString(view, 1 + keyLen, view.byteLength - 1 - keyLen);
        this.info.set(key, value);
        console.log(`Info: ${key} = ${value}`);
    }

    parseInfoMultiple(view) {
        const keyLen = view.getUint8(1);
        const key = this.readString(view, 2, keyLen);
        const value = this.readString(view, 2 + keyLen, view.byteLength - 2 - keyLen);
        
        if (!this.multiData.has(key)) {
            this.multiData.set(key, []);
        }
        this.multiData.get(key).push(value);
    }

    parseParameter(view) {
        const keyLen = view.getUint8(0);
        const key = this.readString(view, 1, keyLen);
        
        const valueOffset = 1 + keyLen;
        const valueType = this.readString(view, valueOffset, view.byteLength - valueOffset);
        
        this.parameters.set(key, valueType);
    }

    parseAddLogged(view) {
        const multiId = view.getUint8(0);
        const msgId = view.getUint16(1, true);
        const msgName = this.readString(view, 3, view.byteLength - 3);
        
        this.messages.set(msgId, { name: msgName, multiId });
        console.log(`Add logged: ${msgName} (id=${msgId}, multiId=${multiId})`);
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
                console.warn(`Unknown type: ${type}`);
                return { value: null, size: 1 };
        }
    }

    extractTrackData() {
        const trackPoints = [];
        
        const positionMessages = this.data.filter(d => 
            d._msgName === 'vehicle_global_position' || 
            d._msgName === 'vehicle_local_position' ||
            d._msgName === 'vehicle_gps_position'
        );

        console.log(`\n=== Track Data Extraction ===`);
        console.log('Position messages found:', positionMessages.length);
        console.log('Message types:', [...new Set(positionMessages.map(m => m._msgName))]);

        for (const msg of positionMessages) {
            const point = {
                timestamp: msg.timestamp ? Number(msg.timestamp) / 1000000.0 : 0,
            };

            if (msg.lat !== undefined && msg.lon !== undefined) {
                point.lat = msg.lat / 1e7;
                point.lon = msg.lon / 1e7;
                point.alt = msg.alt !== undefined ? msg.alt / 1000.0 : 0;
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

        console.log('Track points extracted:', trackPoints.length);
        if (trackPoints.length > 0) {
            console.log('First point:', JSON.stringify(trackPoints[0], null, 2));
            console.log('Last point:', JSON.stringify(trackPoints[trackPoints.length - 1], null, 2));
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
}

async function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('Usage: node tools/test-px4-parser.js <flight-log.ulg>');
        process.exitCode = 1;
        return;
    }
    
    console.log('='.repeat(60));
    console.log('PX4 ULog Parser Test');
    console.log('='.repeat(60));
    console.log('File:', filePath);
    console.log('='.repeat(60));
    console.log();

    try {
        const buffer = fs.readFileSync(filePath);
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        
        console.log('File size:', buffer.length, 'bytes');
        console.log('First 16 bytes:', Array.from(buffer.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
        console.log();

        const parser = new ULogParser();
        const result = await parser.parse(arrayBuffer);
        
        console.log('\n=== Final Results ===');
        console.log('Track points:', result.points.length);
        console.log('Total data records:', result.allData.length);
        console.log('Message types in data:', [...new Set(result.allData.map(d => d._msgName))].length);
        
        console.log('\n✓ Parsing completed successfully!');
        
    } catch (error) {
        console.error('\n✗ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
