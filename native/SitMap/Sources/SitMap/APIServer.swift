import Foundation
import Network
import SitMapCore

final class APIServer {
    typealias Reply = (Int, [String: Any]) -> Void
    var route: ((HTTPRequest, @escaping Reply) -> Void)?
    var applyLive: ((ViewRequest) throws -> Double)?
    var statusChanged: ((String) -> Void)?
    private var http: NWListener?
    private var websocket: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var live: NWConnection?
    private var handshakes: [UUID: NWConnection] = [:]
    private var pending: (ViewRequest, Int, Double)?
    private var timer: Timer?
    private(set) var received = 0
    private(set) var applied = 0
    private(set) var coalesced = 0
    private(set) var lastSequence = 0
    private(set) var lastApplyTime: Double?
    private(set) var lastError: String?

    var syncState: [String: Any] {
        ["connected": live != nil, "received": received, "applied": applied, "coalesced": coalesced,
         "lastSequence": lastSequence, "lastApplyTime": lastApplyTime as Any? ?? NSNull(),
         "error": lastError as Any? ?? NSNull(), "updateHz": 60]
    }
    private func parameters(port: UInt16) -> NWParameters {
        let tcp = NWProtocolTCP.Options(); tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        return params
    }
    func start() throws {
        let listener = try NWListener(using: parameters(port: 9876))
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.statusChanged?("API 127.0.0.1:9876 · Live sync :9877")
            case .failed(let error): self?.statusChanged?("API unavailable: \(error.localizedDescription)")
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.acceptHTTP(connection) }
        listener.start(queue: .main); http = listener

        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true; ws.maximumMessageSize = 16_384
        ws.setClientRequestHandler(.main) { protocols, headers in
            let origin = headers.first { $0.name.lowercased() == "origin" }?.value
            let url = origin.flatMap(URL.init(string:))
            let validOrigin = origin == nil || (url?.scheme == "chrome-extension" && url?.host?.count == 32)
            let allowed = validOrigin && protocols.contains("sitmap-v1")
            return NWProtocolWebSocket.Response(status: allowed ? .accept : .reject,
                                                 subprotocol: allowed ? "sitmap-v1" : nil)
        }
        let params = parameters(port: 9877)
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        let stream = try NWListener(using: params)
        stream.newConnectionHandler = { [weak self] connection in self?.acceptLive(connection) }
        stream.stateUpdateHandler = { [weak self] state in
            if case .failed(let error) = state { self?.statusChanged?("Live sync unavailable: \(error.localizedDescription)") }
        }
        stream.start(queue: .main); websocket = stream
        let tick = Timer(timeInterval: 1.0/60, repeats: true) { [weak self] _ in self?.update() }
        RunLoop.main.add(tick, forMode: .common); timer = tick
    }
    func stop() {
        timer?.invalidate(); http?.cancel(); websocket?.cancel(); live?.cancel()
        for connection in connections.values { connection.cancel() }
        for connection in handshakes.values { connection.cancel() }
        connections.removeAll()
        handshakes.removeAll()
    }
    private func acceptHTTP(_ connection: NWConnection) {
        guard connections.count < 12 else { connection.cancel(); return }
        let id = UUID(); connections[id] = connection
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.connections.removeValue(forKey: id)
            default: break
            }
        }
        connection.start(queue: .main)
        // Bounded lifetime also covers snapshotters waiting on network tiles.
        DispatchQueue.main.asyncAfter(deadline: .now() + 50) { [weak self] in
            if self?.connections[id] != nil { connection.cancel() }
        }
        receiveHTTP(connection, id: id, buffer: Data())
    }
    private func receiveHTTP(_ connection: NWConnection, id: UUID, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] bytes, _, complete, error in
            guard let self, self.connections[id] != nil else { return }
            var buffer = buffer; if let bytes { buffer.append(bytes) }
            do {
                if let request = try HTTPRequest.parse(buffer) {
                    do { try request.authorize(port: 9876) }
                    catch { self.reply(connection, status: 403, body: ["error": error.localizedDescription]); return }
                    self.route?(request) { status, body in self.reply(connection, status: status, body: body) }
                } else if complete || error != nil { connection.cancel() }
                else { self.receiveHTTP(connection, id: id, buffer: buffer) }
            } catch { self.reply(connection, status: 400, body: ["error": error.localizedDescription]) }
        }
    }
    private func reply(_ connection: NWConnection, status: Int, body: [String: Any]) {
        let bytes = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data("{\"error\":\"JSON encoding failed\"}".utf8)
        var data = Data("HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\nContent-Length: \(bytes.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)
        data.append(bytes)
        connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
    }
    private func acceptLive(_ connection: NWConnection) {
        guard handshakes.count < 8 else { connection.cancel(); return }
        let id = UUID(); handshakes[id] = connection
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            if self?.handshakes.removeValue(forKey: id) != nil { connection.cancel() }
        }
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .ready:
                self.handshakes.removeValue(forKey: id)
                // An explicit new follower takes ownership. A previous socket must
                // not later apply its queued pose or clear the new connection.
                self.live?.cancel(); self.live = connection; self.pending = nil; self.lastError = nil
                self.sendLive(["type": "ready", "apiVersion": 1], to: connection)
                self.receiveLive(connection)
            case .failed, .cancelled:
                self.handshakes.removeValue(forKey: id)
                if self.live === connection { self.live = nil; self.pending = nil }
            default: break
            }
        }
        connection.start(queue: .main)
    }
    private func receiveLive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, self.live === connection else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if error != nil || metadata?.opcode == .close { connection.cancel(); return }
            if let data {
                do {
                    struct Message: Decodable { let camera: ViewRequest; let sequence: Int; let sentAt: Double }
                    let message = try JSONDecoder().decode(Message.self, from: data)
                    try message.camera.validate()
                    if self.pending != nil { self.coalesced += 1 }
                    self.pending = (message.camera, message.sequence, message.sentAt)
                    self.received += 1
                } catch {
                    self.lastError = error.localizedDescription
                    self.sendLive(["type": "error", "error": error.localizedDescription], to: connection)
                }
            }
            self.receiveLive(connection)
        }
    }
    private func update() {
        guard let (camera, sequence, sentAt) = pending, let live else { return }
        pending = nil
        do {
            let nativePitch = try applyLive?(camera)
            applied += 1; lastSequence = sequence
            lastApplyTime = Date().timeIntervalSince1970 * 1000
            lastError = nil
            var message: [String: Any] = ["type": "applied", "sequence": sequence, "sentAt": sentAt,
                                         "appliedAt": lastApplyTime!]
            if let nativePitch { message["nativePitch"] = nativePitch }
            sendLive(message, to: live)
        } catch {
            lastError = error.localizedDescription
            sendLive(["type": "error", "error": error.localizedDescription], to: live)
        }
    }
    private func sendLive(_ value: [String: Any], to connection: NWConnection) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        let context = NWConnection.ContentContext(identifier: "sitmap", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
            if error != nil { connection.cancel() }
        })
    }
}
