// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "OmnyoLocalVoice",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(
      url: "https://github.com/alexburlis/FluidAudio.git",
      revision: "93468021dcad336a8fda232e91dd61f616a20afd", traits: []
    )
  ],
  targets: [
    .executableTarget(
      name: "OmnyoLocalVoice", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
      path: "Sources/LocalVoice"
    )
  ]
)
