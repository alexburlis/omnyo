import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Talk to your agents, transcribed on your Mac",
  lede: "Press Control+D, speak, and press it again: Dictation by Paraspeech turns your words into a draft on your own Mac, for Claude Code and Codex.",
  sections: [
    {
      heading: "Speak on your phone, the Mac transcribes",
      body: "Dictate in the iPhone app or any browser. The recording goes to the Mac that runs your Omnyo server, which transcribes it and puts the text in your draft.",
      bullets: ["The phone does no transcription itself"],
      visual: "voice-phone",
    },
    {
      heading: "Teach it your project's names",
      body: "Add names and jargon to the custom dictionary in Settings → Dictation, one per line. The English speech model downloads once, about 550 MB, and only when you click Download model.",
      bullets: [
        "Runs NVIDIA's Parakeet TDT 0.6B v2 on the Mac",
        "The dictionary model loads only while it has words",
      ],
      visual: "voice-dictionary",
    },
  ],
  goodToKnow: [
    {
      label: "Needs",
      value:
        "An Apple-silicon Mac on macOS 14 or later running your Omnyo server.",
    },
    {
      label: "Language",
      value: "English only.",
    },
    {
      label: "Privacy",
      value:
        "Pick Dictation as your voice service to keep audio on your Mac. Automatic may fall back to Codex.",
    },
    {
      label: "Shortcut",
      value:
        "Control+D while Omnyo is focused. It is not system-wide; rebind it in Settings → Keyboard.",
    },
    {
      label: "Limits",
      value:
        "A transcription that runs past 65 seconds stops with a visible error.",
    },
    {
      label: "CLI",
      value:
        "`omnyo voice transcribe <file>` uses the voice service you picked.",
    },
  ],
  faq: [
    {
      question: "Does voice input work with Codex?",
      answer:
        "Yes. Dictation fills the chat composer, so it works the same in Claude Code and Codex chats.",
    },
    {
      question: "Does my audio leave my Mac?",
      answer:
        "Not with Dictation by Paraspeech selected. In the default Automatic mode, Omnyo can use Codex cloud transcription when Dictation is not ready, so pin it with `omnyo settings ai-services set voice local-voice`.",
    },
    {
      question: "Is this Claude Code's own voice mode?",
      answer:
        "No. Dictation by Paraspeech is a plugin that comes with Omnyo. It is built on the same on-device engine as [Paraspeech](https://paraspeech.com/?utm_source=omnyo&utm_medium=referral&utm_campaign=paraspeech_crosspromo_2026q4&utm_content=voice_feature), our Mac dictation app.",
    },
  ],
  relatedFeatures: ["keyboard", "mobile-remote-control", "privacy"],
  relatedGuides: [],
};
