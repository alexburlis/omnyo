import AVFoundation
import FluidAudio
import Foundation

private struct Configuration: Decodable, Sendable {
  let dictionary: [String]
  let prepare: Bool
}

private struct Request: Decodable {
  let wav: String
}

private struct Reply: Encodable {
  let kind: String
  var text: String? = nil
}

private enum EngineError: Error {
  case invalidDictionary
}

private actor SpeechEngine {
  private let manager = AsrManager()
  private var vocabulary: CustomVocabularyContext?
  private var rescorer: VocabularyRescorer?
  private var spotter: CtcKeywordSpotter?

  func prepare(_ configuration: Configuration) async throws {
    let directory = AsrModels.defaultCacheDirectory(for: .v2)
    if configuration.prepare && !AsrModels.modelsExist(at: directory, version: .v2) {
      try await AsrModels.download(to: directory, version: .v2)
    }
    let models = try AsrModels.loadLocal(from: directory, version: .v2)
    try await manager.loadModels(models)
    var warmState = try TdtDecoderState()
    _ = try await manager.transcribe([Float](repeating: 0, count: 16_000), decoderState: &warmState)
    guard !configuration.dictionary.isEmpty else { return }
    let ctcDirectory = CtcModels.defaultCacheDirectory()
    if configuration.prepare { try await CtcModels.download(to: ctcDirectory, variant: .ctc110m) }
    let ctc = try await CtcModels.loadDirect(from: ctcDirectory, variant: .ctc110m)
    let tokenizer = try await CtcTokenizer.load(from: ctcDirectory)
    let terms = configuration.dictionary.map {
      CustomVocabularyTerm(text: $0, ctcTokenIds: tokenizer.encode($0))
    }
    guard terms.allSatisfy({ !($0.ctcTokenIds ?? []).isEmpty }) else {
      throw EngineError.invalidDictionary
    }
    // Default fuzzy matching changed ordinary "code" into "Kodex" in the real E2E fixture.
    let vocabulary = CustomVocabularyContext(terms: terms, minSimilarity: 0.8)
    let spotter = CtcKeywordSpotter(models: ctc, blankId: ctc.vocabulary.count)
    self.vocabulary = vocabulary
    self.spotter = spotter
    self.rescorer = try await VocabularyRescorer.create(
      spotter: spotter, vocabulary: vocabulary,
      config: VocabularyRescorer.Config(
        spotterRescueEnabled: terms.count > ContextBiasingConstants.largeVocabThreshold),
      ctcModelDirectory: ctcDirectory
    )
    _ = try await spotter.spotKeywordsWithLogProbs(
      audioSamples: [Float](repeating: 0, count: 16_000), customVocabulary: vocabulary)
  }

  func transcribe(_ path: String) async throws -> String {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    guard file.processingFormat.sampleRate == 16_000, file.processingFormat.channelCount == 1,
      let buffer = AVAudioPCMBuffer(
        pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
    else { throw CocoaError(.fileReadCorruptFile) }
    try file.read(into: buffer)
    guard let channel = buffer.floatChannelData?[0] else { throw CocoaError(.fileReadCorruptFile) }
    let samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    var state = try TdtDecoderState()
    let result = try await manager.transcribe(samples, decoderState: &state)
    guard let vocabulary, let rescorer, let spotter, let timings = result.tokenTimings,
      !timings.isEmpty
    else { return result.text }
    let config = ContextBiasingConstants.rescorerConfig(forVocabSize: vocabulary.terms.count)
    let similarity = max(config.minSimilarity, vocabulary.minSimilarity)
    guard
      rescorer.hasPotentialCtcTokenRescoreCandidate(
        transcript: result.text, tokenTimings: timings, minSimilarity: similarity)
    else { return result.text }
    let ctc = try await spotter.spotKeywordsWithLogProbs(
      audioSamples: samples, customVocabulary: vocabulary)
    return rescorer.ctcTokenRescore(
      transcript: result.text, tokenTimings: timings, logProbs: ctc.logProbs,
      frameDuration: ctc.frameDuration, cbw: config.cbw,
      marginSeconds: ContextBiasingConstants.defaultMarginSeconds, minSimilarity: similarity
    ).text
  }
}

@main
private struct LocalVoice {
  static func send(_ reply: Reply) throws {
    var data = try JSONEncoder().encode(reply)
    data.append(10)
    try FileHandle.standardOutput.write(contentsOf: data)
  }

  static func main() async {
    AppLogger.minimumLevel = .fault
    AppLogger.mirrorsToConsole = false
    let engine = SpeechEngine()
    var lines = FileHandle.standardInput.bytes.lines.makeAsyncIterator()
    do {
      guard let line = try await lines.next() else { return }
      let configuration = try JSONDecoder().decode(Configuration.self, from: Data(line.utf8))
      try await engine.prepare(configuration)
      try send(Reply(kind: "ready"))
      while let line = try await lines.next() {
        do {
          let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
          let text = try await engine.transcribe(request.wav)
          try send(Reply(kind: "transcript", text: text))
        } catch { try send(Reply(kind: "error")) }
      }
    } catch { try? send(Reply(kind: "error")) }
  }
}
