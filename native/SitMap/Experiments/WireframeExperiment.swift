import AppKit
import MapKit
import ObjectiveC
import RendererRuntime
import SitMapCore

// Runtime research, included only in the scratch experimental build.
final class WireframeExperiment: NSObject {
    static let shared = WireframeExperiment()
    struct Control {
        let key: String, encoding: String, group: String
        let writable: Bool
        var error: String?
        var label: String {
            key.replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
                .replacingOccurrences(of: "([A-Z])([A-Z][a-z])", with: "$1 $2", options: .regularExpression)
        }
        var kind: String {
            if encoding == "B" { return "Boolean" }
            if encoding == "f" || encoding == "d" { return "Decimal" }
            if encoding.hasPrefix("@") { return "Text" }
            if encoding.hasPrefix("{") { return "JSON array" }
            return "Integer / enum"
        }
    }
    private(set) var controls: [Control] = []
    private var settings: NSObject?
    private weak var map: MKMapView?
    private var originals: [String: Any] = [:]
    private var edited = Set<String>()
    private var failure: String?
    private var internalSettingsActivated = false
    var changed: (() -> Void)?

    func initialize() {
        _ = Bundle(path: "/System/Library/PrivateFrameworks/VectorKit.framework")?.load()
        let selector = NSSelectorFromString("sharedSettingsExt")
        guard let cls = NSClassFromString("VKDebugSettings"),
              let method = class_getClassMethod(cls, selector),
              String(cString: method_getTypeEncoding(method)!) == "@16@0:8" else {
            failure = "This system does not expose the expected settings singleton."; return
        }
        typealias Getter = @convention(c) (AnyClass, Selector) -> Unmanaged<AnyObject>
        let getter = unsafeBitCast(method_getImplementation(method), to: Getter.self)
        settings = getter(cls, selector).takeUnretainedValue() as? NSObject
        guard let settings else { failure = "The settings singleton is unavailable."; return }
        var count: UInt32 = 0
        guard let properties = class_copyPropertyList(object_getClass(settings), &count) else { return }
        defer { free(properties) }
        for index in 0..<Int(count) {
            let property = properties[index], key = String(cString: property_getName(property))
            guard let rawType = property_copyAttributeValue(property, "T") else { continue }
            let encoding = String(cString: rawType); free(rawType)
            let rawReadOnly = property_copyAttributeValue(property, "R")
            let readOnly = rawReadOnly != nil
            if let rawReadOnly { free(rawReadOnly) }
            let setter = NSSelectorFromString("set" + key.prefix(1).uppercased() + key.dropFirst() + ":")
            let supported = ["B", "f", "d", "i", "I", "q", "Q", "C", "S", "@\"NSString\""].contains(encoding)
                || structLayout(encoding) != nil
            var control = Control(key: key, encoding: encoding, group: group(key),
                writable: !readOnly && supported && settings.responds(to: setter))
            do { originals[key] = try read(key) ?? NSNull() }
            catch { control.error = error.localizedDescription }
            controls.append(control)
        }
        controls.sort { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }
    private func group(_ key: String) -> String {
        let k = key.lowercased()
        if k.hasPrefix("ar") || k.hasPrefix("munin") { return "Look Around & AR" }
        if ["fov", "camera", "collision", "cliplane", "tilt"].contains(where: k.contains) { return "Camera & Collision" }
        if ["lighting", "shadow", "ssao", "coloradjustment", "hillshade", "normals"].contains(where: k.contains) { return "Lighting & Materials" }
        if k.hasPrefix("altitude") || k.hasPrefix("flyover") || k.hasPrefix("realistic") { return "Flyover & Imagery" }
        if k.hasPrefix("davinci") || k.contains("building") || k.contains("terrain") { return "Terrain & Buildings" }
        if k.contains("label") || k.hasPrefix("eta") || k.contains("poi") || k.contains("roadsign") { return "Labels & Places" }
        if ["nav", "route", "transit", "tracking", "tours"].contains(where: k.contains) { return "Navigation" }
        return "Rendering & Diagnostics"
    }
    private func read(_ key: String) throws -> Any? {
        guard let settings else { throw SitMapError("No renderer settings.") }
        var error: NSError?
        let value = SMReadProperty(settings, key, &error)
        if let error { throw error }
        return value
    }
    private func write(_ key: String, _ value: Any?) throws {
        guard let settings else { throw SitMapError("No renderer settings.") }
        var error: NSError?
        _ = SMWriteProperty(settings, key, value, &error)
        if let error { throw error }
    }
    func attach(_ map: MKMapView) {
        self.map = map
        try? configure(["realisticWireframeEnabled": true, "daVinciWireframeEnabled": true])
    }
    private var vectorMap: NSObject? {
        guard let map, let ivar = class_getInstanceVariable(MKMapView.self, "_mapView"),
              let encoding = ivar_getTypeEncoding(ivar), String(cString: encoding).hasPrefix("@") else { return nil }
        return object_getIvar(map, ivar) as? NSObject
    }
    private func callVoid(_ name: String) -> Bool {
        guard let object = vectorMap, let cls = object_getClass(object),
              let method = class_getInstanceMethod(cls, NSSelectorFromString(name)),
              String(cString: method_getTypeEncoding(method)!) == "v16@0:8" else { return false }
        typealias Call = @convention(c) (AnyObject, Selector) -> Void
        unsafeBitCast(method_getImplementation(method), to: Call.self)(object, NSSelectorFromString(name))
        return true
    }
    // The three aggregate properties exposed on this OS. Field names are not
    // in the runtime metadata, so show typed arrays without inventing meanings.
    private func structLayout(_ type: String) -> [(Int, String)]? {
        switch type {
        case "{GEOTileSetRegion=IIIIII}": return (0..<6).map { ($0 * 4, "I") }
        case "{VKDebugSettings2DLandmarkStrokeSettings=BBBff}": return [(0,"B"),(1,"B"),(2,"B"),(4,"f"),(8,"f")]
        case "{?=ffddff}": return [(0,"f"),(4,"f"),(8,"d"),(16,"d"),(24,"f"),(28,"f")]
        default: return nil
        }
    }
    private func jsonValue(_ value: Any?, control: Control) -> Any {
        guard let value else { return NSNull() }
        guard let layout = structLayout(control.encoding), let packed = value as? NSValue else { return value }
        var size = 0
        NSGetSizeAndAlignment(control.encoding, &size, nil)
        let bytes = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 8)
        defer { bytes.deallocate() }
        packed.getValue(bytes, size: size)
        return layout.map { offset, type -> Any in
            switch type {
            case "B": return bytes.load(fromByteOffset: offset, as: UInt8.self) != 0
            case "I": return bytes.load(fromByteOffset: offset, as: UInt32.self)
            case "f": return bytes.load(fromByteOffset: offset, as: Float.self)
            default: return bytes.load(fromByteOffset: offset, as: Double.self)
            }
        }
    }
    func value(_ control: Control) -> Any { jsonValue(try? read(control.key), control: control) }
    func isEdited(_ control: Control) -> Bool { edited.contains(control.key) }
    func text(_ control: Control) -> String {
        let value = value(control)
        if value is NSNull { return "" }
        if let values = value as? [Any], let data = try? JSONSerialization.data(withJSONObject: values),
           let text = String(data: data, encoding: .utf8) { return text }
        return String(describing: value)
    }
    private func converted(_ value: Any, type: String) throws -> Any? {
        if type == "@\"NSString\"" {
            if value is NSNull { return nil }
            guard let text = value as? String else { throw SitMapError("Expected text.") }; return text
        }
        if let layout = structLayout(type) {
            guard let array = value as? [Any], array.count == layout.count else { throw SitMapError("Expected a JSON array with \(layout.count) fields.") }
            var size = 0; NSGetSizeAndAlignment(type, &size, nil)
            let bytes = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 8)
            defer { bytes.deallocate() }; bytes.initializeMemory(as: UInt8.self, repeating: 0, count: size)
            for (index, field) in layout.enumerated() {
                guard let number = try converted(array[index], type: field.1) as? NSNumber else { throw SitMapError("Invalid structure field.") }
                switch field.1 {
                case "B": bytes.storeBytes(of: UInt8(number.boolValue ? 1 : 0), toByteOffset: field.0, as: UInt8.self)
                case "I": bytes.storeBytes(of: number.uint32Value, toByteOffset: field.0, as: UInt32.self)
                case "f": bytes.storeBytes(of: number.floatValue, toByteOffset: field.0, as: Float.self)
                default: bytes.storeBytes(of: number.doubleValue, toByteOffset: field.0, as: Double.self)
                }
            }
            return NSValue(bytes: bytes, objCType: type)
        }
        guard let number = value as? NSNumber else { throw SitMapError("Expected a numeric value.") }
        if type == "B" {
            guard CFGetTypeID(number) == CFBooleanGetTypeID() else { throw SitMapError("Expected true or false.") }; return number
        }
        guard CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { throw SitMapError("Expected a finite number.") }
        if type == "f" {
            guard number.floatValue.isFinite else { throw SitMapError("Value exceeds the float range.") }; return NSNumber(value: number.floatValue)
        }
        if type == "d" { return number }
        let decimal = number.decimalValue
        let range: (Decimal, Decimal)
        switch type {
        case "i": range = (Decimal(Int32.min), Decimal(Int32.max))
        case "I": range = (0, Decimal(UInt32.max))
        case "q": range = (Decimal(Int64.min), Decimal(Int64.max))
        case "Q": range = (0, Decimal(UInt64.max))
        case "C": range = (0, 255)
        case "S": range = (0, 65535)
        default: throw SitMapError("Unsupported property type: \(type)")
        }
        guard decimal >= range.0, decimal <= range.1, number.doubleValue.rounded(.towardZero) == number.doubleValue else {
            throw SitMapError("Expected an integer in \(range.0)…\(range.1).")
        }
        return number
    }
    func applyText(_ text: String, control: Control) throws {
        let value: Any
        if control.encoding.hasPrefix("@") { value = text }
        else {
            guard let data = text.data(using: .utf8) else { throw SitMapError("Invalid input.") }
            value = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        }
        try configure([control.key: value])
    }
    func reset(_ key: String? = nil) throws {
        let keys = key.map { [$0] } ?? Array(edited)
        for key in keys {
            guard let original = originals[key] else { continue }
            try write(key, original is NSNull ? nil : original); edited.remove(key)
        }
        refresh()
    }
    func configure(_ values: [String: Any]) throws {
        guard settings != nil else { throw SitMapError(failure ?? "No settings object.") }
        var assignments: [(String, Any?)] = []
        for (key, value) in values {
            if key == "reset" || key == "activateInternalSettings" {
                guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw SitMapError("\(key) must be boolean.") }; continue
            }
            guard let control = controls.first(where: { $0.key == key }), control.writable,
                  control.error == nil, originals[key] != nil else { throw SitMapError("Unsupported or read-only setting: \(key)") }
            assignments.append((key, try converted(value, type: control.encoding)))
        }
        if values["reset"] as? Bool == true { try reset() }
        if values["activateInternalSettings"] as? Bool == true {
            guard callVoid("activateInternalSettings") else { throw SitMapError("Internal settings activation is unavailable.") }
            internalSettingsActivated = true
        }
        for (key, value) in assignments { try write(key, value); edited.insert(key) }
        refresh()
    }
    private func refresh() {
        _ = callVoid("setNeedsRender"); map?.needsDisplay = true; changed?()
    }
    func state() -> [String: Any] {
        var values: [String: Any] = [:]
        for control in controls { values[control.key] = value(control) }
        return ["build": "wireframe-experiment-2", "available": settings != nil, "settings": values,
                "controlCount": controls.count, "editableCount": controls.filter(\.writable).count,
                "changed": Array(edited).sorted(), "internalSettingsActivated": internalSettingsActivated,
                "renderer": "VectorKit private debug settings", "geometryExported": false,
                "error": failure as Any? ?? NSNull()]
    }
    func selfTest() throws -> [String: Any] {
        guard settings != nil else { throw SitMapError("Settings unavailable.") }
        var tested = 0
        for key in ["realisticWireframeEnabled", "minFov", "selectedMapTilesToPaint", "landmark2DStrokeSettings", "muninTapState", "arDebugSceneFeatureText"] {
            guard let control = controls.first(where: { $0.key == key }) else { continue }
            let before = value(control)
            try configure([key: before]); try reset(key); tested += 1
        }
        try configure(["realisticWireframeEnabled": true])
        guard let control = controls.first(where: { $0.key == "realisticWireframeEnabled" }), (value(control) as? NSNumber)?.boolValue == true else {
            throw SitMapError("Wireframe readback failed.")
        }
        try reset()
        for (key, invalid) in [("minFov", "bad" as Any), ("realisticWireframeEnabled", 2), ("lodOverride", 300), ("relaxTiltLimits", "yes")] {
            do { try configure([key: invalid]); throw SitMapError("Validation failed for \(key)") }
            catch let error as SitMapError { if error.localizedDescription.hasPrefix("Validation failed") { throw error } }
            catch { }
        }
        return ["controls": controls.count, "editable": controls.filter(\.writable).count,
                "roundTrips": tested, "unreadable": controls.filter { $0.error != nil }.map(\.key), "passed": true]
    }
}
