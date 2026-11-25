import AppKit

final class RendererSidebar: NSStackView, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    private let model = WireframeExperiment.shared
    private let search = NSSearchField()
    private let category = NSPopUpButton()
    private let changedOnly = NSButton(checkboxWithTitle: "Changed only", target: nil, action: nil)
    private let count = NSTextField(labelWithString: "")
    private let message = NSTextField(wrappingLabelWithString: "Changes apply immediately. Private controls may have no effect in the current map mode.")
    private let table = NSTableView()
    private var rows: [WireframeExperiment.Control] = []
    private var rebuilding = false
    private var cameraSection: NSView?
    private var rendererSection: NSView?
    private var mode: NSSegmentedControl?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        orientation = .vertical; alignment = .leading; spacing = 10
        let title = NSTextField(labelWithString: "RENDERER EXPERIMENT")
        title.font = .systemFont(ofSize: 11, weight: .semibold); title.textColor = .secondaryLabelColor
        addArrangedSubview(title)
        search.placeholderString = "Search all renderer settings"; search.delegate = self
        search.setAccessibilityLabel("Search renderer settings")
        addArrangedSubview(search)
        category.addItems(withTitles: ["All categories"] + Set(model.controls.map(\.group)).sorted())
        category.target = self; category.action = #selector(filterChanged)
        addArrangedSubview(category)
        changedOnly.target = self; changedOnly.action = #selector(filterChanged)
        addArrangedSubview(changedOnly)
        count.font = .systemFont(ofSize: 11); count.textColor = .secondaryLabelColor; addArrangedSubview(count)
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("settings"))
        column.resizingMask = .autoresizingMask; table.addTableColumn(column)
        table.headerView = nil; table.rowHeight = 62; table.intercellSpacing = NSSize(width: 0, height: 2)
        table.delegate = self; table.dataSource = self; table.usesAlternatingRowBackgroundColors = true
        table.selectionHighlightStyle = .none; table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.setAccessibilityLabel("Renderer settings")
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder; scroll.drawsBackground = false
        addArrangedSubview(scroll)
        scroll.heightAnchor.constraint(equalToConstant: 470).isActive = true
        let reset = NSButton(title: "Reset All Experimental Changes", target: self, action: #selector(resetAll))
        addArrangedSubview(reset)
        message.font = .systemFont(ofSize: 11); message.textColor = .secondaryLabelColor
        addArrangedSubview(message)
        for view in [search, category, scroll, message] {
            view.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        }
        model.changed = { [weak self] in
            DispatchQueue.main.async { self?.reload() }
        }
        reload()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    func installSwitcher(in parent: NSStackView, camera: NSView) {
        cameraSection = camera; rendererSection = self
        let switcher = NSSegmentedControl(labels: ["Camera", "Renderer"], trackingMode: .selectOne,
                                          target: self, action: #selector(switchSection(_:)))
        switcher.selectedSegment = 1; mode = switcher
        parent.addArrangedSubview(switcher); parent.addArrangedSubview(camera); parent.addArrangedSubview(self)
        widthAnchor.constraint(equalTo: parent.widthAnchor, constant: -40).isActive = true
        camera.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        switcher.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        camera.isHidden = true
    }
    @objc private func switchSection(_ sender: NSSegmentedControl) {
        window?.makeFirstResponder(nil)
        cameraSection?.isHidden = sender.selectedSegment != 0
        rendererSection?.isHidden = sender.selectedSegment != 1
    }
    @objc private func filterChanged() { window?.makeFirstResponder(nil); reload() }
    func controlTextDidChange(_ obj: Notification) {
        if obj.object as AnyObject? === search { reload() }
    }
    func controlTextDidEndEditing(_ obj: Notification) {
        guard !rebuilding, let field = obj.object as? NSTextField, field !== search,
              field.identifier != nil else { return }
        applyField(field)
    }
    private func reload() {
        rebuilding = true; defer { rebuilding = false }
        let query = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        rows = model.controls.filter { c in
            (category.indexOfSelectedItem == 0 || c.group == category.titleOfSelectedItem)
                && (changedOnly.state != .on || model.isEdited(c))
                && (query.isEmpty || c.key.localizedCaseInsensitiveContains(query)
                    || c.label.localizedCaseInsensitiveContains(query) || c.group.localizedCaseInsensitiveContains(query))
        }
        count.stringValue = "\(rows.count) shown · \(model.controls.filter(\.writable).count) editable · \(model.controls.count) total"
        table.reloadData()
    }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard rows.indices.contains(row) else { return nil }
        let control = rows[row]
        let view = NSTableCellView()
        let label = NSTextField(labelWithString: control.label)
        label.font = .systemFont(ofSize: 11, weight: model.isEdited(control) ? .semibold : .regular)
        label.lineBreakMode = .byTruncatingTail
        label.toolTip = "\(control.key)\n\(control.group)\nType: \(control.encoding)\nEffect unverified in this map mode."
        let type = NSTextField(labelWithString: control.writable ? control.kind : "Read-only")
        type.font = .systemFont(ofSize: 9); type.textColor = .secondaryLabelColor
        let editor: NSControl
        if control.encoding == "B" {
            let check = NSButton(checkboxWithTitle: "Enabled", target: self, action: #selector(toggle(_:)))
            check.state = (model.value(control) as? NSNumber)?.boolValue == true ? .on : .off
            editor = check
        } else {
            let field = NSTextField(string: model.text(control))
            field.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            field.target = self; field.action = #selector(applyField(_:)); field.delegate = self
            field.toolTip = control.encoding.hasPrefix("{") ? "Typed fields in runtime order; edit as a JSON array. Field names are not exposed by Apple."
                : "\(control.key) — press Return to apply. Enum labels and semantic limits are not exposed by Apple."
            editor = field
        }
        editor.identifier = NSUserInterfaceItemIdentifier(control.key)
        editor.isEnabled = control.writable && control.error == nil; editor.setAccessibilityLabel(control.key)
        let reset = NSButton(image: NSImage(systemSymbolName: "arrow.counterclockwise", accessibilityDescription: "Reset \(control.key)")!, target: self, action: #selector(resetOne(_:)))
        reset.bezelStyle = .inline; reset.identifier = NSUserInterfaceItemIdentifier(control.key)
        reset.isEnabled = model.isEdited(control); reset.toolTip = "Restore launch value"
        for child in [label, type, editor, reset] { child.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(child) }
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: view.topAnchor, constant: 5),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
            type.leadingAnchor.constraint(equalTo: label.leadingAnchor),
            type.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 4),
            editor.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 90),
            editor.centerYAnchor.constraint(equalTo: type.centerYAnchor),
            editor.trailingAnchor.constraint(equalTo: reset.leadingAnchor, constant: -3),
            reset.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -5),
            reset.centerYAnchor.constraint(equalTo: editor.centerYAnchor), reset.widthAnchor.constraint(equalToConstant: 20)
        ])
        return view
    }
    private func report(_ body: () throws -> Void) {
        do { try body(); message.stringValue = "Applied. Changes last for this app session."; message.textColor = .secondaryLabelColor }
        catch { message.stringValue = error.localizedDescription; message.textColor = .systemRed }
    }
    @objc private func applyField(_ field: NSTextField) {
        guard let key = field.identifier?.rawValue, let control = model.controls.first(where: { $0.key == key }) else { return }
        guard field.stringValue != model.text(control) else { return }
        report { try model.applyText(field.stringValue, control: control) }
    }
    @objc private func toggle(_ sender: NSButton) {
        guard let key = sender.identifier?.rawValue else { return }
        report { try model.configure([key: sender.state == .on]) }
    }
    @objc private func resetOne(_ sender: NSButton) {
        guard let key = sender.identifier?.rawValue else { return }
        report { try model.reset(key) }
    }
    @objc private func resetAll() { report { try model.reset() } }
}
