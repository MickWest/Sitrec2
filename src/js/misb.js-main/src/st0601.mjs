import * as st0102 from "./st0102.mjs";
import * as st0806 from "./st0806.mjs";
import * as st0903 from "./st0903.mjs";
import * as klv from "./klv.mjs";
import {asHexString, cast, startsWith} from "./klv.mjs";

// module.exports.name = 'st0601'
export const name = "st0601";
export const key = cast("060e2b34020b01010e01030101000000");
export const minSize = 31;

export function parse(buffer, options = {}) {
	const packet = cast(buffer);

	options.debug === true && console.debug("-------Start Parse 0601-------");
//	options.debug === true &&
//		process.stdout.write(`Packet ${packet.toString("hex")} ${packet.length}\n`);

	if (packet.length < minSize) {
		// must have a 16 byte key, 1 byte BER, 10 byte timestamp, 4 byte checksum
		throw new Error(`ST0601: Buffer too small to parse. Expected at least ${minSize} bytes, but received ${packet.length} bytes`);
	}

	if (!startsWith(packet, key)) {
		// compare first 16 bytes before BER
		const receivedKey = asHexString(packet.subarray(0, Math.min(key.length, packet.length)));
		throw new Error(`ST0601: Invalid packet key. Expected key '${asHexString(key)}', but received '${receivedKey}'`);
	}

	let { berHeader, berLength, contentLength } = klv.getBer(packet[key.length]);
	if (contentLength === null) {
		contentLength = klv.getContentLength(
			packet.subarray(key.length + berHeader, key.length + berHeader + berLength)
		); // read content after key and length)
	}

	const parsedLength = key.length + berHeader + berLength + contentLength;
	if (parsedLength > packet.length) {
		// buffer length isn't long enough to read content
		throw new Error(`ST0601: Incomplete packet. Expected ${parsedLength} bytes (key: ${key.length}, BER header: ${berHeader}, BER length: ${berLength}, content: ${contentLength}), but packet is only ${packet.length} bytes`);
	}

	const values = [];

	let i = key.length + berHeader + berLength; //index of first content key
	let checksumFound = false;
	
	while (i < parsedLength && !checksumFound) {
		try {
			const { key, keyLength } = klv.getKey(packet.subarray(i, packet.length));

			// Check for suspicious key values that indicate padding or corruption
			if (keyLength > 1 && key > 200) {
				// Long-form key with suspiciously high value - likely padding
				options.debug === true && console.debug(
					`ST0601: Stopping parse at position ${i}. Encountered suspicious key value ${key} (0x${key.toString(16)}) which appears to be padding or end marker. Remaining bytes: ${parsedLength - i}`
				);
				break;
			}

			let { berHeader, berLength, contentLength } = klv.getBer(packet[i + keyLength]);
			if (contentLength === null) {
				contentLength = klv.getContentLength(
					packet.subarray(
						i + keyLength + berHeader,
						i + keyLength + berHeader + berLength
					)
				); // read content after key and length // i + key.length
			}

			const totalBytesNeeded = keyLength + berHeader + berLength + contentLength;
			const remainingInParsedLength = parsedLength - i;
			const remainingInActualPacket = packet.length - i;

			// Check for buffer overflow
			if (parsedLength < i + keyLength + berHeader + berLength + contentLength) {
				const actualContentAvailable = remainingInParsedLength - keyLength - berHeader - berLength;
				
				if (actualContentAvailable > 0 && options.parsePartial) {
					const remainingBytes = packet.subarray(i, Math.min(i + 20, packet.length));
					const hexDump = asHexString(remainingBytes);
					console.warn(
						`ST0601: Buffer overflow at position ${i}.\n` +
						`  Item key ${key} claims ${contentLength} bytes but only ${actualContentAvailable} available.\n` +
						`  Remaining bytes (hex): ${hexDump}\n` +
						`  Attempting partial parse with ${actualContentAvailable} bytes.`
					);
					contentLength = actualContentAvailable;
				} else {
					console.warn(
						`ST0601: Buffer overflow at position ${i}. Item key ${key} requires ${totalBytesNeeded} bytes, but only ${remainingInParsedLength} bytes remain. Skipping remaining items.`
					);
					break;
				}
			}

			// const valueBuffer = packet.subarray(
			const valueBuffer = new DataView(
				packet.buffer,
				packet.byteOffset + i + keyLength + berHeader + berLength,
				contentLength
			); // read content after key and length

			let parsed =
				options.value !== false ? convert(key, valueBuffer, options) : { key };

			// Per-tag converters return `null` when the encoded value is the
			// ST 0601 "out-of-range / unknown" sentinel (e.g. 0x80000000 for
			// the int32 corner-point tags 82–87). Treat that as "tag present
			// but value unknown" so the parse loop keeps going — otherwise
			// the unguarded `parsed.value` access below crashes the whole
			// packet, taking the checksum tag with it.
			if (parsed === null) {
				parsed = { key, value: null };
			}

			if (typeof parsed.value === "string")
				parsed.value = parsed.value.replace(/[^\x20-\x7E]+/g, "");

			if (options.debug === true) {
				if (key === 2) {
					console.debug(
						key,
						contentLength,
						parsed.name,
						`${new Date(parsed.value / 1000)}${parsed.unit || ""}`,
						valueBuffer
					);
				} else {
					console.debug(
						key,
						contentLength,
						parsed.name,
						`${parsed.value}${parsed.unit || ""}`,
						valueBuffer
					);
				}
			}
			if (options.debug || options.payload || options.value === false) {
				parsed.packet = asHexString(
					new Uint8Array(
						valueBuffer.buffer,
						valueBuffer.byteOffset,
						valueBuffer.byteLength
					)
				);
			}

			values.push(parsed);

			// Checksum (key 1) should be the last field in ST0601
			if (key === 1) {
				checksumFound = true;
				options.debug === true && console.debug(
					`ST0601: Checksum found at position ${i}. Stopping parse. Remaining bytes in packet: ${parsedLength - (i + keyLength + berHeader + berLength + contentLength)}`
				);
			}

			i += keyLength + berHeader + berLength + contentLength; // advance past key, length and value bytes
		} catch (error) {
			console.warn(
				`ST0601: Error parsing item at position ${i}: ${error.message}. Skipping remaining items.`
			);
			break;
		}
	}

	const checksum = values.find((klv) => klv.key === 1);
	if (!checksum) {
		// Parse loop bailed before the checksum tag was reached. Return what
		// we got rather than NPE'ing on the unguarded `checksum.value` access
		// below — same tolerance philosophy as the bad-checksum branch.
		return values;
	}
	const checksumValue =
		checksum.value !== undefined ? checksum.value : checksum.packet.readUInt16BE(0);
	if (!klv.isChecksumValid(packet.subarray(0, parsedLength), checksumValue)) {
		checksum.valid = false;
		console.debug("Invalid checksum");
		// since we have noisy data from chopped-up files, we won't throw an error here

		//throw new Error(`Invalid checksum`)
	}

	return values;
}

export function encode(items) {
	const chunks = items.map((klv) => {
		if (klv.key == 2) {
			const uint = bnToBuf(klv.value, st0601data(klv.key).length);
			return {
				key: klv.key,
				packet: uint,
			};
		}
		return klv;
	});

	return assemble(chunks);
}

export function assemble(chunks) {
	const header = key.toString("hex");
	let payload = "";
	for (const chunk of chunks) {
		if (chunk.key === 1) {
			continue;
		}
		const packet =
			typeof chunk.packet === "string"
				? chunk.packet
				: chunk.packet.toString("hex");
		payload +=
			chunk.key.toString(16).padStart(2, "0") +
			(packet.length / 2).toString(16).padStart(2, "0") +
			packet;
	}
	const payloadWithCheckSum = payload + `01020000`;
	const completePacketForChecksum =
		header + getPayloadLengthBer(payloadWithCheckSum) + payloadWithCheckSum;
	const checksum = klv.calculateChecksum(completePacketForChecksum); // pad the ending with a fake checksum
	return (
		completePacketForChecksum.slice(0, -4) + checksum.toString(16).padStart(4, "0")
	); // remove 4 blank characters, 2 bytes
}

const getPayloadLengthBer = (payload) => {
	const byteLength = payload.length / 2;
	if (byteLength > 127) {
		// BER long form
		const berLength = Math.ceil(byteLength / 255);
		return `8${berLength}${byteLength.toString(16).padStart(berLength * 2, "0")}`;
	} else {
		// BER short form
		return byteLength.toString(16).padStart(2, "0");
	}
};

const bnToBuf = (bn, size) => {
	let hex = BigInt(bn).toString(16);
	hex = hex.padStart(size * 2, "0");
	return hex;
};

const two16SignedMax = 2 ** 15 - 1;
const two16SignedMin = -1 * two16SignedMax;
const two16Unsigned = 2 ** 16 - 1;
const two32max = 2 ** 32 - 1;
const two32SignedMax = 2 ** 31 - 1;
const two32SignedMin = -1 * two32SignedMax;

// TODO: Keep and use a TextDecoder instance for converting UTF-8 byte sequences into JS Strings.

const textDecoder = new TextDecoder();

function convert(key, dataview, options) {
	try {
		switch (key) {
			case 1:
				// Checksum - should be 2 bytes per standard, but handle 1 byte for non-compliant files
				let checksumValue;
				if (dataview.byteLength === 1) {
					checksumValue = dataview.getUint8(0);
					console.warn(`ST0601: Non-standard 1-byte checksum detected (expected 2 bytes). Value: 0x${checksumValue.toString(16).padStart(2, '0')}`);
				} else if (dataview.byteLength === 2) {
					checksumValue = dataview.getUint16(0, false);
					// There are lots of checksum packets in large files, so we won't log each one
					// console.log(`ST0601: Standard 2-byte checksum detected. Value: 0x${checksumValue.toString(16).padStart(4, '0')}`);
				} else {
				//	throw new Error(`ST0601: Invalid checksum length. Expected 1 or 2 bytes, got ${dataview.byteLength} bytes`);
					// patch for invalid checksum length
					// throwing an error here breaks parsing of some files in the wild
					// so we log a warning and set checksum to 0

					// // hex dump the invalid checksum data
					// let hexString = '';
					// for (let i = 0; i < dataview.byteLength; i++) {
					// 	const byte = dataview.getUint8(i);
					// 	hexString += byte.toString(16).padStart(2, '0') + ' ';
					// }
					// console.warn(`ST0601: Invalid checksum data (length ${dataview.byteLength} bytes): ${hexString.trim()}`);
					//
					// // and decimal dump
					// let decimalString = '';
					// for (let i = 0; i < dataview.byteLength; i++) {
					// 	const byte = dataview.getUint8(i);
					// 	decimalString += byte.toString(10).padStart(3, '0') + ' ';
					// }
					// console.warn(`ST0601: Invalid checksum data (length ${dataview.byteLength} bytes): ${decimalString.trim()}`);


					//checksumValue = dataview.getUint16(0, false);
					checksumValue = 32767;
					console.warn(`ST0601: Invalid checksum length. Expected 1 or 2 bytes, got ${dataview.byteLength} bytes. Setting checksum to ${checksumValue}`);

				}
				return {
					key,
					name: st0601data(key).name,
					value: checksumValue,
					valid: true,
				};
			case 2:
				// klv.checkRequiredSize(key, buffer, st0601data(key).length)
				return {
					key,
					name: st0601data(key).name,
					value: parseFloat(dataview.getBigUint64(0, false)),
					unit: "µs",
				};
			case 3:
			case 4:
			case 10:
			case 11:
			case 12:
				return {
					key,
					name: st0601data(key).name,
					value: textDecoder.decode(dataview),
				};
			case 5:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[0, 360]
					),
					unit: "°",
				};
			case 6:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two16SignedMin, two16SignedMax],
						[-20, 20]
					),
					unit: "°",
				};
			case 7:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two16SignedMin, two16SignedMax],
						[-50, 50]
					),
					unit: "°",
				};
			case 8:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
					value: dataview.getUint8(0, false),
					unit: "m/s",
				};
			case 9:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
					value: dataview.getUint8(0, false),
					unit: "m/s",
				};
			case 13:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 14:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-180, 180]
					),
					unit: "°",
				};
			case 15:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[-900, 19000]
					),
					unit: "m",
				};
			case 16:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[0, 180]
					),
					unit: "°",
				};
			case 17:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[0, 180]
					),
					unit: "°",
				};
			case 18:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint32(0, false),
						[0, two32max],
						[0, 360]
					),
					unit: "°",
				};
			case 19:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-180, 180]
					),
					unit: "°",
				};
			case 20:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint32(0, false),
						[0, two32max],
						[0, 360]
					),
					unit: "°",
				};
			case 21:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint32(0, false),
						[0, two32max],
						[0, 5000000]
					),
					unit: "m",
				};
			case 22:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[0, 10000]
					),
					unit: "m",
				};
			case 23:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 24:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-180, 180]
					),
					unit: "°",
				};
			case 25:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[-900, 19000]
					),
					unit: "m",
				};
			case 26:
			case 27:
			case 28:
			case 29:
			case 30:
			case 31:
			case 32:
			case 33:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value:
					//	buffer.compare(Buffer.from("8000", "hex")) === 0
					dataview.getUint16(0, false) === 0x8000
							? null
							: klv.scale(
									dataview.getInt16(0, false),
									[two16SignedMin, two16SignedMax],
									[-0.075, 0.075]
							  ),
					unit: "°",
				};
			case 34:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
					value: dataview.getUint8(0, false),
					//unit: 'code'
				};
			case 35:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[0, 360]
					),
					unit: "°",
				};
			case 36:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(dataview.getUint8(0, false), [0, 255], [0, 100]),
					unit: "m/s",
				};
			case 37:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[0, 5000]
					),
					unit: "mbar",
				};
			case 38:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[-900, 19000]
					),
					unit: "m",
				};
			case 39:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
				//	value: buffer.readInt8(0),
					data: dataview.getInt8(0),
					unit: "°C",
				};
			case 40:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 41:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-180, 180]
					),
					unit: "°",
				};
			case 42:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[-900, 19000]
					),
					unit: "m",
				};
			case 43:
			case 44:
				return {
					key,
					name: st0601data(key).name,
					value: 2 * dataview.getUint8(0, false),
					unit: "pixels",
				};
			case 45:
			case 46:
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[0, two16Unsigned],
						[0, 4095]
					),
					unit: "m",
				};
			case 47:
				return {
					key,
					name: st0601data(key).name,
					value: dataview.getUint8(0, false),
				};
			case 48:
				return {
					key,
					name: st0601data(key).name,
					value: st0102.parse(dataview, options),
				};
			case 50:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two16SignedMin, two16SignedMax],
						[-20, 20]
					),
					unit: "°",
				};
			case 51:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two16SignedMin, two16SignedMax],
						[-180, 180]
					),
					unit: "m/s",
				};
			case 52:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two16SignedMin, two16SignedMax],
						[-20, 20]
					),
					unit: "°",
				};
			case 55:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(dataview.getUint8(0, false), [0, 255], [0, 100]),
					unit: "%",
				};
			case 56:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
					value: dataview.getUint8(0, false),
					unit: "m/s",
				};
			case 57:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint32(0, false),
						[0, two32max],
						[0, 5000000]
					),
					unit: "m",
				};
			case 58:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[0, two16Unsigned],
						[0, 10000]
					),
					unit: "kg",
				};
			case 59:
				return {
					key,
					name: st0601data(key).name,
					//value: buffer.toString(),
					value: textDecoder.decode(dataview),
				};
			case 62:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: dataview.getUint16(0, false),
				};
			case 63:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
					value: dataview.getUint8(0, false),
				};
			case 64:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[0, 360]
					),
					unit: "°",
				};
			case 65:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
					value: dataview.getUint8(0, false),
				};
			case 67:
				klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(buffer.readInt32BE(0), [two32SignedMin, two32SignedMax], [-90, 90]),
					unit: '°'
				}
			case 68:
				klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(buffer.readInt32BE(0), [two32SignedMin, two32SignedMax], [-180, 180]),
					unit: '°'
				}
			case 70:
				return {
					key,
					name: st0601data(key).name,
					// value: buffer.toString(),
					value: textDecoder.decode(dataview),

				};
			case 71:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[0, 360]
					),
					unit: "°",
				};
			case 72:
				// klv.checkRequiredSize(key, buffer, 8)
				return {
					key,
					name: st0601data(key).name,
					value: parseFloat(dataview.getBigUint64(0, false)),
					unit: "µs",
				};
			case 73:
				return {
					key,
					name: st0601data(key).name,
					value: st0806.parseLS(buffer, options),
				};
			case 74:
				return {
					key,
					name: st0601data(key).name,
					value: st0903.parseLS(buffer, options),
				};
			case 75:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[-900, 19000]
					),
					unit: "m",
				};
			case 76:
				klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(buffer.readUInt16BE(0), [0, two16Unsigned], [-900, 19000]),
					unit: 'm'
				}
			case 77:
				// klv.checkRequiredSize(key, buffer, 1)
				return {
					key,
					name: st0601data(key).name,
					value: dataview.getUint8(0, false),
				};
			case 78:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getUint16(0, false),
						[0, two16Unsigned],
						[-900, 19000]
					),
					unit: "m",
				};
			case 79:
			case 80:
				// klv.checkRequiredSize(key, buffer, 2)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two16SignedMin, two16SignedMax],
						[-327, 327]
					),
					unit: "°",
				};
			case 82:
				// klv.checkRequiredSize(key, buffer, 4)
				// if (buffer.compare(Buffer.from("8000", "hex")) === 0) {
				if (dataview.getUint16(0, false) === 0x8000) {
					return null;
				}
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 83:
				// klv.checkRequiredSize(key, buffer, 4)
				// if (buffer.compare(Buffer.from("8000", "hex")) === 0) {
				if (dataview.getUint16(0, false) === 0x8000) {
					return null;
				}
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-180, 180]
					),
					unit: "°",
				};
			case 84:
				// klv.checkRequiredSize(key, buffer, 4)
				// if (buffer.compare(Buffer.from("8000", "hex")) === 0) {
				if (dataview.getUint16(0, false) === 0x8000) {
					return null;
				}
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 85:
				// klv.checkRequiredSize(key, buffer, 4)
				// if (buffer.compare(Buffer.from("8000", "hex")) === 0) {
				if (dataview.getUint16(0, false) === 0x8000) {
					return null;
				}
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-180, 180]
					),
					unit: "°",
				};
			case 86:
				// klv.checkRequiredSize(key, buffer, 4)
				// if (buffer.compare(Buffer.from("8000", "hex")) === 0) {
				if (dataview.getUint16(0, false) === 0x8000) {
					return null;
				}
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 87:
				// klv.checkRequiredSize(key, buffer, 4)
				// if (buffer.compare(Buffer.from("8000", "hex")) === 0) {
				if (dataview.getUint16(0, false) === 0x8000) {
					return null;
				}
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-180, 180]
					),
					unit: "°",
				};
			case 88:
				// klv.checkRequiredSize(key, buffer, 4)
				// if (buffer.compare(Buffer.from("8000", "hex")) === 0) {
				if (dataview.getUint16(0, false) === 0x8000) {
					return null;
				}
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 89:
				// klv.checkRequiredSize(key, buffer, 4)
				// if (buffer.compare(Buffer.from("8000", "hex")) === 0) {
				if (dataview.getUint16(0, false) === 0x8000) {
					return null;
				}
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt32(0, false),
						[two32SignedMin, two32SignedMax],
						[-180, 180]
					),
					unit: "°",
				};
			case 90:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 91:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 92:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 93:
				// klv.checkRequiredSize(key, buffer, 4)
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						dataview.getInt16(0, false),
						[two32SignedMin, two32SignedMax],
						[-90, 90]
					),
					unit: "°",
				};
			case 94:
				return {
					key,
					name: st0601data(key).name,
					value: asHexString(
						new Uint8Array(
							dataview.buffer,
							dataview.byteOffset,
							dataview.byteLength
						)
					), // todo verify this is supposed to have unicode in it
				};
			case 96:
				klv.checkMaxSize(key, buffer, 8);
				return {
					key,
					name: st0601data(key).name,
					value: klv.scale(
						klv.readVariableUInt(buffer),
						[0, 2 ** (buffer.length * 8)],
						[0, 1500000]
					), //todo this is not correct
					unit: "m",
				};
			case 116:
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
				};
			case 117:
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
					unit: "dps",
				};
			case 118:
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
					unit: "dps",
				};
			case 119:
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
					unit: "dps",
				};
			case 120:
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
					unit: "%",
				};
			case 123:
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
				};
			case 124:
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
				};
			case 125:
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
				};
			case 129:
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
				};
			default:
				if (options.strict === true) {
					throw Error(`ST0601: Unknown or unsupported key ${key} (0x${key.toString(16).padStart(2, '0')}). Buffer size: ${dataview.byteLength} bytes`);
				}
				return {
					key,
					name: st0601data(key).name,
					value: "Not Implemented",
				};
		}
	} catch (e) {
		// Add context to the error if it doesn't already have ST0601 prefix
		if (e.message && !e.message.startsWith('ST0601:')) {
			const keyName = st0601data(key)?.name || 'Unknown';
			throw new Error(`ST0601: Error parsing key ${key} (0x${key.toString(16).padStart(2, '0')}) '${keyName}'. Buffer size: ${dataview.byteLength} bytes. Original error: ${e.message}`, { cause: e });
		}
		throw e;
	}
}

export function keys(key) {
	return st0601data(key);
}

function st0601data(key) {
	if (typeof key === "string") {
		key = parseInt(key);
	}
	switch (key) {
		case 1:
			return { name: "Checksum", length: 2 };
		case 2:
			return { name: "Precision Time Stamp", length: 8 };
		case 3:
			return { name: "Mission ID" };
		case 4:
			return { name: "Platform Tail Number" };
		case 5:
			return { name: "Platform Heading Angle" };
		case 6:
			return { name: "Platform Pitch Angle" };
		case 7:
			return { name: "Platform Roll Angle" };
		case 8:
			return { name: "Platform True Airspeed" };
		case 9:
			return { name: "Platform Indicated Airspeed" };
		case 10:
			return { name: "Platform Designation" };
		case 11:
			return { name: "Image Source Sensor" };
		case 12:
			return { name: "Image Coordinate System" };
		case 13:
			return { name: "Sensor Latitude" };
		case 14:
			return { name: "Sensor Longitude" };
		case 15:
			return { name: "Sensor True Altitude" };
		case 16:
			return { name: "Sensor Horizontal Field of View" };
		case 17:
			return { name: "Sensor Vertical Field of View" };
		case 18:
			return { name: "Sensor Relative Azimuth Angle" };
		case 19:
			return { name: "Sensor Relative Elevation Angle" };
		case 20:
			return { name: "Sensor Relative Roll Angle" };
		case 21:
			return { name: "Slant Range" };
		case 22:
			return { name: "Target Width" };
		case 23:
			return { name: "Frame Center Latitude" };
		case 24:
			return { name: "Frame Center Longitude" };
		case 25:
			return { name: "Frame Center Elevation" };
		case 26:
			return { name: "Offset Corner Latitude Point 1" };
		case 27:
			return { name: "Offset Corner Longitude Point 1" };
		case 28:
			return { name: "Offset Corner Latitude Point 2" };
		case 29:
			return { name: "Offset Corner Longitude Point 2" };
		case 30:
			return { name: "Offset Corner Latitude Point 3" };
		case 31:
			return { name: "Offset Corner Longitude Point 3" };
		case 32:
			return { name: "Offset Corner Latitude Point 4" };
		case 33:
			return { name: "Offset Corner Longitude Point 4" };
		case 34:
			return { name: "Icing Detected" };
		case 35:
			return { name: "Wind Direction" };
		case 36:
			return { name: "Wind Speed" };
		case 37:
			return { name: "Static Pressure" };
		case 38:
			return { name: "Density Altitude" };
		case 39:
			return { name: "Outside Air Temperature" };
		case 40:
			return { name: "Target Location Latitude" };
		case 41:
			return { name: "Target Location Longitude" };
		case 42:
			return { name: "Target Location Elevation" };
		case 43:
			return { name: "Target Track Gate Width" };
		case 44:
			return { name: "Target Track Gate Height" };
		case 45:
			return { name: "Target Error Estimate - CE90" };
		case 46:
			return { name: "Target Error Estimate - LE90" };
		case 47:
			return { name: "Generic Flag Data" };
		case 48:
			return { name: "Security Local Set" };
		case 50:
			return { name: "Platform Angle of Attack" };
		case 51:
			return { name: "Platform Vertical Speed" };
		case 52:
			return { name: "Platform Sideslip Angle" };
		case 55:
			return { name: "Relative Humidity" };
		case 56:
			return { name: "Platform Ground Speed" };
		case 57:
			return { name: "Ground Range" };
		case 58:
			return { name: "Platform Fuel Remaining" };
		case 59:
			return { name: "Platform Call Sign" };
		case 62:
			return { name: "Laser PRF Code" };
		case 63:
			return { name: "Sensor Field of View Name" };
		case 64:
			return { name: "Platform Magnetic Heading" };
		case 65:
			return { name: "UAS Datalink LS Version Number" };
		case 67:
			return {name: 'Alternate Platform Latitude'}
		case 68:
			return {name: 'Alternate Platform Longitude'}
		case 70:
			return { name: "Alternate Platform Name" };
		case 71:
			return { name: "Alternate Platform Heading" };
		case 72:
			return { name: "Event Start Time" };
		case 73:
			return { name: "RVT Local Set" };
		case 74:
			return { name: "VMTI Local Set" };
		case 75:
			return { name: "Sensor Ellipsoid Height" };
		case 76:
			return {name: 'Alternate Platform Ellipsoid Height'}
		case 77:
			return { name: "Operational Mode" };
		case 78:
			return { name: "Frame Center Height Above Ellipsoid" };
		case 79:
			return { name: "Sensor North Velocity" };
		case 80:
			return { name: "Sensor East Velocity" };
		case 81:
			return { name: "Image Horizon Pixel Pack" };
		case 82:
			return { name: "Corner Latitude Point 1" };
		case 83:
			return { name: "Corner Longitude Point 1" };
		case 85:
			return { name: "Corner Longitude Point 2" };
		case 84:
			return { name: "Corner Latitude Point 2" };
		case 86:
			return { name: "Corner Latitude Point 3" };
		case 87:
			return { name: "Corner Longitude Point 3" };
		case 88:
			return { name: "Corner Latitude Point 4 " };
		case 89:
			return { name: "Corner Longitude Point 4" };
		case 90:
			return { name: "Platform Pitch Angle (Full)" };
		case 91:
			return { name: "Platform Roll Angle (Full)" };
		case 92:
			return { name: "Platform Angle of Attack (Full)" };
		case 93:
			return { name: "Platform Sideslip Angle (Full)" };
		case 94:
			return { name: "MIIS Core Identifier" };
		case 96:
			return { name: "Target Width Extended" };
		case 98:
			return { name: "Geo-Registration Local Set" };
		case 104:
			return { name: "Sensor Ellipsoid Height Extended" };
		case 113:
			return { name: "Altitude AGL" };
		case 116:
			return { name: "Control Command Verification List" };
		case 117:
			return { name: "Sensor Azimuth Rate" };
		case 118:
			return { name: "Sensor Elevation Rate" };
		case 119:
			return { name: "Sensor Roll Rate" };
		case 120:
			return { name: "On-board MI Storage Percent Full" };
		default:
			return { name: "Unknown" };
	}
}
