import Foundation

// Package the PNG representations without changing their pixels or alpha.
// ICNS stores each PNG in a named chunk with a big-endian byte count.
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let representations = [
    ("icp4", "icon_16x16.png"), ("ic11", "icon_16x16@2x.png"),
    ("icp5", "icon_32x32.png"), ("ic12", "icon_32x32@2x.png"),
    ("ic07", "icon_128x128.png"), ("ic13", "icon_128x128@2x.png"),
    ("ic08", "icon_256x256.png"), ("ic14", "icon_256x256@2x.png"),
    ("ic09", "icon_512x512.png"), ("ic10", "icon_512x512@2x.png")
]
func appendLength(_ count: Int, to data: inout Data) {
    var length = UInt32(count).bigEndian
    withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
}
var chunks = Data()
for (type, name) in representations {
    let png = try Data(contentsOf: source.appendingPathComponent(name))
    precondition(png.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]), "Expected PNG: \(name)")
    chunks.append(Data(type.utf8))
    appendLength(png.count + 8, to: &chunks)
    chunks.append(png)
}
var icon = Data("icns".utf8)
appendLength(chunks.count + 8, to: &icon)
icon.append(chunks)
try icon.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
