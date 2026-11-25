import AppKit
import MapKit
import SitMapCore
import UniformTypeIdentifiers

// A short document must stay at the top of its viewport, including after resize.
private final class TopAlignedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

@main
struct SitMapMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSToolbarDelegate {
    private var window: NSWindow!
    private let canvas = MapCanvas(frame: .zero)
    private let server = APIServer()
    private let snapshots = SnapshotService()
    private let status = NSTextField(wrappingLabelWithString: "Starting local API…")
    private let details = NSTextView()
    private var fields: [String: NSTextField] = [:]
    private var sliders: [String: NSSlider] = [:]
    private let style = NSPopUpButton()
    private let sidebarScroll = NSScrollView()
    private var sidebarHidden = UserDefaults.standard.bool(forKey: "SitMapSidebarHidden")
    private var canvasWithSidebar: NSLayoutConstraint!
    private var canvasWithoutSidebar: NSLayoutConstraint!
    private var sidebarToolbarItem: NSToolbarItem?
    private var sidebarMenuItem: NSMenuItem?
    private let sidebarItemIdentifier = NSToolbarItem.Identifier("SitMap.ToggleSidebar")
    private var lastDetailUpdate = Date.distantPast

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 900),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "SitMap"; window.minSize = NSSize(width: 900, height: 650)
        window.setFrameAutosaveName("SitMap")
        let toolbar = NSToolbar(identifier: "SitMap.Toolbar")
        toolbar.delegate = self; toolbar.displayMode = .iconOnly; toolbar.allowsUserCustomization = false
        window.toolbarStyle = .unifiedCompact; window.toolbar = toolbar
        let root = NSView(); root.wantsLayer = true; window.contentView = root
        let sidebar = NSStackView(); sidebar.orientation = .vertical; sidebar.alignment = .leading; sidebar.spacing = 12
        sidebar.distribution = .fill; sidebar.setHuggingPriority(.required, for: .vertical)
        // Padding belongs inside the document. An offset document origin is
        // consumed by NSClipView's scrolling and makes the leading inset vanish.
        sidebar.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        let scroll = sidebarScroll; scroll.contentView = TopAlignedClipView()
        scroll.documentView = sidebar; scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        for view in [canvas, scroll] { view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view) }
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        canvasWithSidebar = canvas.trailingAnchor.constraint(equalTo: scroll.leadingAnchor)
        canvasWithoutSidebar = canvas.trailingAnchor.constraint(equalTo: root.trailingAnchor)
        NSLayoutConstraint.activate([
            canvas.leadingAnchor.constraint(equalTo: root.leadingAnchor), canvas.topAnchor.constraint(equalTo: root.topAnchor),
            canvas.bottomAnchor.constraint(equalTo: root.bottomAnchor), sidebarHidden ? canvasWithoutSidebar : canvasWithSidebar,
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor), scroll.topAnchor.constraint(equalTo: root.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor), scroll.widthAnchor.constraint(equalToConstant: 330),
            sidebar.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            sidebar.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            sidebar.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)
        ])
        scroll.isHidden = sidebarHidden
        let title = NSTextField(labelWithString: "SitMap"); title.font = .systemFont(ofSize: 26, weight: .semibold)
        sidebar.addArrangedSubview(title)
        sidebar.addArrangedSubview(NSTextField(labelWithString: "Apple Maps · 3D terrain & buildings"))
        style.addItems(withTitles: ["Imagery", "Hybrid", "Standard"]); style.target = self; style.action = #selector(changeStyle)
        sidebar.addArrangedSubview(style)
        let places = NSPopUpButton(); places.addItems(withTitles: ["Jump to place…", "San Francisco", "Yosemite Valley", "Manhattan"])
        places.target = self; places.action = #selector(preset(_:)); sidebar.addArrangedSubview(places)
        let header = NSTextField(labelWithString: "CAMERA REQUEST"); header.font = .systemFont(ofSize: 11, weight: .semibold)
        header.textColor = .secondaryLabelColor; sidebar.addArrangedSubview(header)
        for (key, label, value) in [("latitude", "Latitude", "37.795"), ("longitude", "Longitude", "-122.405"),
            ("altitudeMSL", "Altitude MSL (m)", "900"), ("groundAltitudeMSL", "Ground MSL (m)", "0"),
            ("heading", "Heading (°)", "210"), ("elevation", "Elevation (°)", "-35"),
            ("verticalFov", "Vertical FOV (°)", "30"), ("roll", "Roll (°)", "0")] {
            let row = NSStackView(); row.orientation = .horizontal; row.distribution = .fillEqually
            let name = NSTextField(labelWithString: label), field = NSTextField(string: value)
            field.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
            field.target = self; field.action = #selector(applyFields)
            field.setAccessibilityLabel(label); fields[key] = field
            row.addArrangedSubview(name); row.addArrangedSubview(field)
            let group = NSStackView(); group.orientation = .vertical; group.alignment = .leading; group.spacing = 4
            group.addArrangedSubview(row); sidebar.addArrangedSubview(group)
            group.widthAnchor.constraint(equalTo: sidebar.widthAnchor, constant: -40).isActive = true
            row.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
            if ["altitudeMSL", "heading", "elevation", "verticalFov"].contains(key) {
                let slider = NSSlider(value: 0, minValue: key == "elevation" ? -90 : 0,
                    maxValue: key == "heading" ? 360 : (key == "elevation" ? 0 : 1),
                    target: self, action: #selector(sliderChanged(_:)))
                slider.identifier = NSUserInterfaceItemIdentifier(key)
                slider.isContinuous = true; slider.setAccessibilityLabel(label)
                slider.toolTip = key == "altitudeMSL" ? "Adjust altitude above the supplied ground; type an exact MSL altitude in the field."
                    : key == "elevation" ? "−90° looks straight down; 0° looks at the horizon." : label
                sliders[key] = slider; group.addArrangedSubview(slider)
                slider.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
            }
        }
        updateSliders()
        sidebar.addArrangedSubview(NSButton(title: "Apply Camera", target: self, action: #selector(applyFields)))
        sidebar.addArrangedSubview(NSButton(title: "Save 4K Snapshot…", target: self, action: #selector(saveSnapshot)))
        let help = NSTextField(wrappingLabelWithString:
            "Sliders apply immediately. Turn off live sync in Sitrec for manual control.\n\nLeft drag: move ground\nMiddle / Shift drag: orbit\nRight / ⌘ drag: look around\nWheel: dolly · Shift-wheel: FOV\n\nSitMap adjusts render size to preserve the requested angle. MapKit terrain and camera limits still apply.")
        help.font = .systemFont(ofSize: 11); help.textColor = .secondaryLabelColor
        sidebar.addArrangedSubview(help)
        status.font = .monospacedSystemFont(ofSize: 10, weight: .regular); sidebar.addArrangedSubview(status)
        status.heightAnchor.constraint(equalToConstant: 44).isActive = true
        status.maximumNumberOfLines = 3
        details.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        details.string = "Loading Apple Maps…"; details.isEditable = false; details.drawsBackground = false
        details.textContainerInset = NSSize(width: 0, height: 0)
        details.isHorizontallyResizable = false; details.isVerticallyResizable = true
        details.textContainer?.widthTracksTextView = true
        details.autoresizingMask = [.width]
        let detailScroll = NSScrollView(); detailScroll.documentView = details
        detailScroll.hasVerticalScroller = true; detailScroll.drawsBackground = false
        sidebar.addArrangedSubview(detailScroll)
        NSLayoutConstraint.activate([
            detailScroll.widthAnchor.constraint(equalTo: sidebar.widthAnchor, constant: -40),
            detailScroll.heightAnchor.constraint(equalToConstant: 240)
        ])
        for label in [help, status] { label.widthAnchor.constraint(equalTo: sidebar.widthAnchor, constant: -40).isActive = true }
        let legal = NSButton(title: "Apple Maps · Legal", target: self, action: #selector(openLegal))
        legal.bezelStyle = .inline; legal.contentTintColor = .white
        legal.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(legal)
        NSLayoutConstraint.activate([legal.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: 12),
                                     legal.bottomAnchor.constraint(equalTo: canvas.bottomAnchor, constant: -10)])
        canvas.changed = { [weak self] in self?.updateDetails() }
        server.statusChanged = { [weak self] text in self?.status.stringValue = text }
        server.applyLive = { [weak self] request in
            guard let self else { throw SitMapError("Map window is unavailable.") }
            try self.canvas.apply(request)
            return Double(self.canvas.map.camera.pitch)
        }
        server.route = { [weak self] request, reply in self?.route(request, reply: reply) }
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        root.layoutSubtreeIfNeeded(); applyFields()
        do { try server.start() } catch { status.stringValue = "API failed: \(error.localizedDescription)" }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { server.stop() }
    private func buildMenu() {
        let bar = NSMenu(); NSApp.mainMenu = bar
        let item = NSMenuItem(); bar.addItem(item)
        let app = NSMenu(); item.submenu = app
        app.addItem(withTitle: "About SitMap", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator()); app.addItem(withTitle: "Quit SitMap", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); bar.addItem(editItem); let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let viewItem = NSMenuItem(); bar.addItem(viewItem)
        let viewMenu = NSMenu(title: "View"); viewItem.submenu = viewMenu
        let toggle = NSMenuItem(title: sidebarHidden ? "Show Sidebar" : "Hide Sidebar", action: #selector(toggleSidebar), keyEquivalent: "s")
        toggle.keyEquivalentModifierMask = [.command, .control]; toggle.target = self
        viewMenu.addItem(toggle); sidebarMenuItem = toggle
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, sidebarItemIdentifier]
    }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, sidebarItemIdentifier]
    }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard identifier == sidebarItemIdentifier else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.target = self; item.action = #selector(toggleSidebar); sidebarToolbarItem = item
        updateSidebarToggle()
        return item
    }
    private func updateSidebarToggle() {
        let title = sidebarHidden ? "Show Sidebar" : "Hide Sidebar"
        sidebarToolbarItem?.label = title; sidebarToolbarItem?.toolTip = title
        sidebarToolbarItem?.image = NSImage(systemSymbolName: "sidebar.right", accessibilityDescription: title)
        sidebarMenuItem?.title = title
    }
    @objc private func toggleSidebar() {
        setSidebarHidden(!sidebarHidden)
    }
    private func setSidebarHidden(_ hidden: Bool) {
        guard hidden != sidebarHidden else { return }
        sidebarHidden = hidden
        UserDefaults.standard.set(sidebarHidden, forKey: "SitMapSidebarHidden")
        sidebarScroll.isHidden = sidebarHidden
        NSLayoutConstraint.deactivate([canvasWithSidebar, canvasWithoutSidebar])
        NSLayoutConstraint.activate([sidebarHidden ? canvasWithoutSidebar : canvasWithSidebar])
        updateSidebarToggle()
        window.contentView?.layoutSubtreeIfNeeded()
    }
    @objc private func openLegal() { NSWorkspace.shared.open(URL(string: "https://www.apple.com/legal/internet-services/maps/")!) }
    @objc private func changeStyle() { canvas.setStyle(["imagery", "hybrid", "standard"][style.indexOfSelectedItem]) }
    private func updateSliders() {
        let ground = Double(fields["groundAltitudeMSL"]?.stringValue ?? "") ?? 0
        for (key, slider) in sliders {
            guard let value = Double(fields[key]?.stringValue ?? ""), value.isFinite else { continue }
            switch key {
            case "altitudeMSL": slider.doubleValue = log(max(1, value - ground)) / log(2_000_000)
            case "verticalFov": slider.doubleValue = log(max(0.1, value) / 0.1) / log(1200)
            case "heading": slider.doubleValue = wrapDegrees(value)
            default: slider.doubleValue = value
            }
        }
    }
    @objc private func sliderChanged(_ sender: NSSlider) {
        guard let key = sender.identifier?.rawValue, let field = fields[key] else { return }
        var value = sender.doubleValue
        if key == "altitudeMSL" {
            let ground = Double(fields["groundAltitudeMSL"]?.stringValue ?? "") ?? 0
            value = ground + min(1_999_999, max(1.01, exp(value * log(2_000_000))))
        } else if key == "verticalFov" {
            value = min(120, max(0.1, 0.1 * exp(value * log(1200))))
        }
        field.stringValue = String(format: "%.3f", value)
        applyFields()
    }
    @objc private func applyFields() {
        do {
            var data: [String: Any] = ["style": ["imagery", "hybrid", "standard"][style.indexOfSelectedItem]]
            for (key, field) in fields {
                guard let value = Double(field.stringValue) else { throw SitMapError("\(key) must be a number.") }
                data[key] = value
            }
            if let aspect = canvas.request?.aspect { data["aspect"] = aspect }
            updateSliders()
            let request = try JSONDecoder().decode(ViewRequest.self, from: JSONSerialization.data(withJSONObject: data))
            try canvas.apply(request)
        } catch { details.string = error.localizedDescription }
    }
    @objc private func preset(_ sender: NSPopUpButton) {
        guard sender.indexOfSelectedItem > 0 else { return }
        let values: [[Double]] = [[37.795,-122.405,900,0,210,-35], [37.728,-119.637,2800,1200,65,-25], [40.706,-74.013,1000,0,30,-35]]
        for (key, value) in zip(["latitude","longitude","altitudeMSL","groundAltitudeMSL","heading","elevation"], values[sender.indexOfSelectedItem - 1]) {
            fields[key]?.stringValue = String(value)
        }
        applyFields()
        sender.selectItem(at: 0)
    }
    private func updateDetails() {
        guard Date().timeIntervalSince(lastDetailUpdate) > 0.15 else { return }
        lastDetailUpdate = Date()
        // Keep the inspector truthful while following Sitrec, without replacing
        // text under the user's cursor while they edit a manual request.
        if let request = canvas.request, !(window.firstResponder is NSTextView && (window.firstResponder as? NSTextView)?.isFieldEditor == true) {
            let values = ["latitude": request.latitude, "longitude": request.longitude,
                "altitudeMSL": request.altitudeMSL, "groundAltitudeMSL": request.groundAltitudeMSL ?? 0,
                "heading": request.heading, "elevation": request.elevation,
                "verticalFov": request.verticalFov ?? canvas.nativeFov ?? 30, "roll": request.roll ?? 0]
            for (key, value) in values {
                fields[key]?.stringValue = String(format: key == "latitude" || key == "longitude" ? "%.8f" : "%.3f", value)
            }
            if let index = ["imagery", "hybrid", "standard"].firstIndex(of: canvas.style) { style.selectItem(at: index) }
            updateSliders()
        }
        let c = canvas.map.camera
        let fov = canvas.nativeFov.map { String(format: "%.2f°", $0) } ?? "calibrating"
        let live = server.syncState
        let scrollOrigin = details.enclosingScrollView?.contentView.bounds.origin ?? .zero
        details.string = String(format: "APPLIED MAP CAMERA\nHeading %.2f° · pitch %.2f°\nDistance %.1f m\nNative FOV %@\n%@\nSync applied: %d", c.heading, Double(c.pitch), c.centerCoordinateDistance,
                                     fov, canvas.renderComplete ? "Tiles rendered" : "Loading tiles…", live["applied"] as? Int ?? 0)
        if let pitch = canvas.desiredPitch, abs(pitch - Double(c.pitch)) > 0.05 {
            details.string += String(format: "\nReprojected pitch %.2f°", pitch)
        }
        details.string += String(format: "\nRender surface %.2f×", canvas.sourceScale)
        if let fidelity = canvas.state()["fidelity"] as? [String: Any], let warnings = fidelity["warnings"] as? [String], !warnings.isEmpty {
            details.string += "\n\n" + warnings.joined(separator: "\n\n")
        }
        details.enclosingScrollView?.contentView.scroll(to: scrollOrigin)
    }
    private func route(_ request: HTTPRequest, reply: @escaping APIServer.Reply) {
        do {
            switch (request.method, request.path) {
            case ("GET", "/v1/status"), ("GET", "/v1/view"):
                var value = canvas.state(); value["sync"] = server.syncState
                value["capabilities"] = ["liveSync": true, "websocketPort": 9877, "fov": "calibrated projection", "roll": "image rotation", "pitchReprojection": true, "adaptiveRenderScale": true, "anchoredNavigation": true, "synchronousRenderSize": true, "unrestrictedPitch": false]
                value["layout"] = ["sidebarHidden": sidebarHidden]
                reply(200, value)
            case ("POST", "/v1/projection"):
                struct Point: Decodable { let x: Double; let y: Double }
                struct Samples: Decodable { let points: [Point] }
                let samples = try JSONDecoder().decode(Samples.self, from: request.body)
                let values = try canvas.projectionSamples(samples.points.map { CGPoint(x: $0.x, y: $0.y) })
                var value = canvas.state(); value["samples"] = values
                reply(200, value)
            case ("POST", "/v1/layout"):
                struct Layout: Decodable { let sidebarHidden: Bool }
                let layout = try JSONDecoder().decode(Layout.self, from: request.body)
                setSidebarHidden(layout.sidebarHidden)
                var value = canvas.state(); value["layout"] = ["sidebarHidden": sidebarHidden]
                reply(200, value)
            case ("POST", "/v1/view"):
                let view = try JSONDecoder().decode(ViewRequest.self, from: request.body)
                try canvas.apply(view); reply(200, canvas.state())
            case ("POST", "/v1/gesture"):
                struct Gesture: Decodable { let phase: String; let mode: String?; let x: Double?; let y: Double? }
                let gesture = try JSONDecoder().decode(Gesture.self, from: request.body)
                if gesture.phase == "end" {
                    canvas.endNavigation()
                } else {
                    guard let x = gesture.x, let y = gesture.y, x.isFinite, y.isFinite,
                          (-2...3).contains(x), (-2...3).contains(y) else {
                        throw SitMapError("Gesture x/y must be finite normalized viewport coordinates between -2 and 3.")
                    }
                    let rect = canvas.viewport
                    let point = NSPoint(x: rect.minX + x * rect.width, y: rect.maxY - y * rect.height)
                    switch gesture.phase {
                    case "begin":
                        guard let mode = NavigationGesture.Mode(rawValue: gesture.mode ?? "pan"),
                              canvas.beginNavigation(mode: mode, at: point) else { throw SitMapError("No navigable ground at the gesture start.") }
                    case "move":
                        guard canvas.moveNavigation(to: point) else { throw SitMapError("Gesture movement is outside the navigable camera range.") }
                    default: throw SitMapError("Gesture phase must be begin, move, or end.")
                    }
                }
                reply(200, canvas.state())
            case ("POST", "/v1/snapshot"):
                struct Options: Decodable { let width: Int?; let height: Int? }
                let options = try JSONDecoder().decode(Options.self, from: request.body)
                snapshots.capture(canvas: canvas, width: options.width ?? 1920, height: options.height ?? 1080) { result in
                    switch result {
                    case .success(let value): reply(200, value)
                    case .failure(let error): reply(422, ["error": error.localizedDescription])
                    }
                }
            default: reply(404, ["error": "Use GET /v1/status, GET/POST /v1/view, POST /v1/layout, POST /v1/gesture, or POST /v1/snapshot."])
            }
        } catch { reply(422, ["error": error.localizedDescription]) }
    }
    @objc private func saveSnapshot() {
        let panel = NSSavePanel(); panel.allowedContentTypes = [.png]; panel.nameFieldStringValue = "SitMap.png"
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            self.snapshots.capture(canvas: self.canvas, width: 3840, height: 2160) { result in
                do {
                    let value = try result.get()
                    guard let base64 = value["imageData"] as? String, let bytes = Data(base64Encoded: base64) else { throw SitMapError("Missing image data.") }
                    try bytes.write(to: url, options: .atomic)
                    self.status.stringValue = "Saved \(url.lastPathComponent)"
                } catch { self.status.stringValue = error.localizedDescription }
            }
        }
    }
}
