import Foundation

struct InstallError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

struct PublicRelease {
  let version: String
  let download: URL
  let digest: Data
  let size: Int

  static func isVersion(_ value: String) -> Bool {
    value.range(of: #"\A[0-9]+\.[0-9]+\.[0-9]+\z"#, options: .regularExpression) != nil
  }

  init(_ data: Data, minimum: String) throws {
    let pattern =
      #"\Aversion: ([0-9]+\.[0-9]+\.[0-9]+)\nreleaseDate: "[0-9T:.Z-]+"\nfiles:\n  - url: (omnyo-[0-9]+\.[0-9]+\.[0-9]+-arm64\.zip)\n    sha512: ([A-Za-z0-9+/]{86}==)\n    size: ([1-9][0-9]*)\nomnyoPrivate:\n  appId: dev\.omnyo\.beta\n  teamId: Z7T4C33A35\n  runtimeVersion: ([0-9]+\.[0-9]+\.[0-9]+)\n  protocolVersion: [1-9][0-9]*\n?\z"#
    guard data.count <= 8192, Self.isVersion(minimum),
      let text = String(data: data, encoding: .utf8),
      let regex = try? NSRegularExpression(pattern: pattern),
      let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
    else {
      throw InstallError("The Mac release information could not be verified. Try again.")
    }
    let source = text as NSString
    let version = source.substring(with: match.range(at: 1))
    let filename = source.substring(with: match.range(at: 2))
    guard version.compare(minimum, options: .numeric) != .orderedAscending,
      filename == "omnyo-\(version)-arm64.zip",
      source.substring(with: match.range(at: 5)) == version,
      let digest = Data(base64Encoded: source.substring(with: match.range(at: 3))),
      digest.count == 64,
      let size = Int(source.substring(with: match.range(at: 4))), size <= 2_000_000_000,
      let download = URL(
        string: "https://github.com/alexburlis/omnyo-releases/releases/download/macos/" + filename)
    else {
      throw InstallError("The Mac release does not match this installer. Try again later.")
    }
    self.version = version
    self.download = download
    self.digest = digest
    self.size = size
  }
}
