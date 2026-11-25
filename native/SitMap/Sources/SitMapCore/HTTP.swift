import Foundation

public struct HTTPRequest {
    public let method: String
    public let path: String
    public let headers: [String: String]
    public let body: Data

    /// One bounded request per connection. No chunked bodies or pipelining.
    public static func parse(_ data: Data) throws -> HTTPRequest? {
        guard data.count <= 65_536 else { throw SitMapError("Request exceeds 64 KiB.") }
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else {
            if data.count > 8192 { throw SitMapError("Headers exceed 8 KiB.") }
            return nil
        }
        guard end.upperBound <= 8192,
              let head = String(data: data[..<end.lowerBound], encoding: .utf8) else {
            throw SitMapError("Invalid HTTP headers.")
        }
        let lines = head.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count == 3, first[2] == "HTTP/1.1", first[1].hasPrefix("/") else {
            throw SitMapError("Expected an HTTP/1.1 request.")
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw SitMapError("Malformed HTTP header.") }
            let key = line[..<colon].lowercased()
            guard headers[key] == nil else { throw SitMapError("Duplicate HTTP header.") }
            headers[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard headers["transfer-encoding"] == nil else { throw SitMapError("Chunked requests are not supported.") }
        guard let count = Int(headers["content-length"] ?? "0"), (0...57_344).contains(count) else {
            throw SitMapError("Invalid Content-Length.")
        }
        guard data.count >= end.upperBound + count else { return nil }
        guard data.count == end.upperBound + count else { throw SitMapError("HTTP pipelining is not supported.") }
        return HTTPRequest(method: String(first[0]), path: String(first[1]), headers: headers,
                           body: Data(data[end.upperBound...]))
    }

    public func authorize(port: UInt16) throws {
        guard ["127.0.0.1:\(port)", "localhost:\(port)"].contains(headers["host"] ?? "") else {
            throw SitMapError("Only loopback Host headers are accepted.")
        }
        if let origin = headers["origin"] {
            guard let url = URL(string: origin), url.scheme == "chrome-extension",
                  let host = url.host, host.count == 32, host.allSatisfy({ ("a"..."p").contains(String($0)) }) else {
                throw SitMapError("Browser requests must use SitrecBridge.")
            }
        }
        if method == "POST" {
            guard headers["x-sitmap-client"] == "SitrecBridge-v1",
                  headers["content-type"]?.split(separator: ";").first == "application/json" else {
                throw SitMapError("POST requires application/json and X-SitMap-Client: SitrecBridge-v1.")
            }
        }
    }
}
