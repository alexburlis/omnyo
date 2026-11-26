import Foundation

let hash = Data(repeating: 0, count: 64).base64EncodedString()
let valid = """
  version: 1.0.139
  releaseDate: "2026-11-21T14:56:42.181Z"
  files:
    - url: omnyo-1.0.139-arm64.zip
      sha512: \(hash)
      size: 239818448
  omnyoPrivate:
    appId: dev.omnyo.beta
    teamId: Z7T4C33A35
    runtimeVersion: 1.0.139
    protocolVersion: 258

  """
let release = try PublicRelease(Data(valid.utf8), minimum: "1.0.139")
precondition(
  PublicRelease.feed.absoluteString
    == "https://github.com/alexburlis/omnyo/releases/download/macos/public-beta-mac.yml"
)
precondition(release.version == "1.0.139")
precondition(release.size == 239_818_448)
precondition(
  release.download.absoluteString
    == "https://github.com/alexburlis/omnyo/releases/download/macos/omnyo-1.0.139-arm64.zip"
)
precondition(release.digest == Data(repeating: 0, count: 64))
let cases = [
  valid.replacingOccurrences(of: "1.0.139", with: "1.0.138"),
  valid.replacingOccurrences(of: "arm64.zip", with: "x64.zip"),
  valid.replacingOccurrences(
    of: "omnyo-1.0.139-arm64.zip", with: "https://evil.example/payload.zip"),
  valid.replacingOccurrences(of: "omnyo-1.0.139-arm64.zip", with: "omnyo-1.0.138-arm64.zip"),
  valid.replacingOccurrences(of: "Z7T4C33A35", with: "OTHERTEAM1"),
  valid.replacingOccurrences(of: "dev.omnyo.beta", with: "dev.omnyo.private"),
  valid.replacingOccurrences(of: "runtimeVersion: 1.0.139", with: "runtimeVersion: 1.0.138"),
  valid.replacingOccurrences(of: hash, with: "invalid"),
  valid.replacingOccurrences(of: "239818448", with: "3000000000"),
  valid.replacingOccurrences(of: "239818448", with: "0"),
  valid + "version: 1.0.140\n",
  valid + String(repeating: " ", count: 8192),
]
for invalid in cases {
  do {
    _ = try PublicRelease(Data(invalid.utf8), minimum: "1.0.139")
    fatalError("Invalid release was accepted")
  } catch is InstallError {}
}
_ = try PublicRelease(
  Data(valid.replacingOccurrences(of: "1.0.139", with: "1.0.140").utf8), minimum: "1.0.139")
print("Public release checks passed: exact pin, forward update and \(cases.count) rejection cases")
