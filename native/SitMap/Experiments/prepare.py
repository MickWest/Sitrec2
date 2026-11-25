from pathlib import Path
import shutil

experiment = Path(__file__).resolve().parent
source = experiment.parent
target = source / 'build/Experimental/Package'
target.mkdir(parents=True, exist_ok=True)
shutil.copy2(source / 'Package.swift', target / 'Package.swift')
package = (target / 'Package.swift').read_text()
package = package.replace('.target(name: "SitMapCore"),', '.target(name: "SitMapCore"),\n        .target(name: "RendererRuntime", publicHeadersPath: "include"),')
package = package.replace('dependencies: ["SitMapCore"]),', 'dependencies: ["SitMapCore", "RendererRuntime"]),', 1)
(target / 'Package.swift').write_text(package)
shutil.copytree(source / 'Sources', target / 'Sources', dirs_exist_ok=True)
shutil.copytree(source / 'Tests', target / 'Tests', dirs_exist_ok=True)
shutil.copy2(experiment / 'WireframeExperiment.swift', target / 'Sources/SitMap/WireframeExperiment.swift')
shutil.copy2(experiment / 'RendererSidebar.swift', target / 'Sources/SitMap/RendererSidebar.swift')
runtime = target / 'Sources/RendererRuntime'
(runtime / 'include').mkdir(parents=True, exist_ok=True)
shutil.copy2(experiment / 'RuntimeAccess.h', runtime / 'include/RuntimeAccess.h')
shutil.copy2(experiment / 'RuntimeAccess.m', runtime / 'RuntimeAccess.m')
app = target / 'Sources/SitMap/App.swift'
text = app.read_text()
text = text.replace('let app = NSApplication.shared', '''WireframeExperiment.shared.initialize()
        if CommandLine.arguments.contains("--probe-renderer") {
            do {
                let result = try WireframeExperiment.shared.selfTest()
                let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
                print(String(data: data, encoding: .utf8)!); return
            } catch { print("FAIL: \\(error)"); exit(1) }
        }
        let app = NSApplication.shared''')
text = text.replace('window.title = "SitMap"', 'window.title = "SitMap — Wireframe Experiment"')
text = text.replace('root.layoutSubtreeIfNeeded(); applyFields()', 'root.layoutSubtreeIfNeeded(); applyFields()\n        WireframeExperiment.shared.attach(canvas.map)')
# Keep camera and renderer panels in the existing padded sidebar. Only one is visible.
start = text.index('        let header = NSTextField(labelWithString: "CAMERA REQUEST")')
end = text.index('        let legal = NSButton', start)
block = text[start:end].replace('sidebar.addArrangedSubview(', 'cameraSection.addArrangedSubview(')
text = text[:start] + '''        let cameraSection = NSStackView()
        cameraSection.orientation = .vertical; cameraSection.alignment = .leading; cameraSection.spacing = 12
        let rendererPanel = RendererSidebar(frame: .zero)
        rendererPanel.installSwitcher(in: sidebar, camera: cameraSection)
''' + block + text[end:]
# Make controls visible on the first experiment launch, regardless of the normal app's preference.
text = text.replace('private var sidebarHidden = UserDefaults.standard.bool(forKey: "SitMapSidebarHidden")', 'private var sidebarHidden = false')
text = text.replace('value["layout"] = ["sidebarHidden": sidebarHidden]', 'value["layout"] = ["sidebarHidden": sidebarHidden]\n                value["experiment"] = WireframeExperiment.shared.state()')
text = text.replace('switch (request.method, request.path) {', '''switch (request.method, request.path) {
            case ("GET", "/v1/experiment"):
                reply(200, WireframeExperiment.shared.state())
            case ("POST", "/v1/experiment"):
                guard let values = try JSONSerialization.jsonObject(with: request.body) as? [String: Any] else {
                    throw SitMapError("Expected a settings object.")
                }
                try WireframeExperiment.shared.configure(values)
                reply(200, WireframeExperiment.shared.state())''')
app.write_text(text)
print(target)
