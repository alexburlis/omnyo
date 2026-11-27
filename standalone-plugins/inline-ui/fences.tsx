import type {
  ExperimentalCodeFenceRendererProps,
  PluginMessageDirectiveProps,
} from "@omnyo/plugin-sdk/app";
import { ReadableFallback } from "./invalid";
import { parseRecordFence, recordFenceLanguages, type RecordFenceLanguage } from "./record-fields";
import { FileCard, StatusTable } from "./records";

function recordLanguage(language: string): RecordFenceLanguage | null {
  return recordFenceLanguages.find((name) => name === language) ?? null;
}

export function RecordFence(props: ExperimentalCodeFenceRendererProps) {
  const { Original, status } = props;
  const language = recordLanguage(props.language);

  if (language === null || status === "streaming") return <Original />;
  const parsed = parseRecordFence(language, props.code);

  if (!parsed.ok) {
    return parsed.attributes ? (
      <ReadableFallback attributes={parsed.attributes} reason={parsed.reason} source={props.code} />
    ) : (
      <Original />
    );
  }

  const directive: PluginMessageDirectiveProps = {
    attributes: parsed.attributes,
    source: props.code,
    message: props.message,
    openWorkspaceFile: null,
  };

  return language === "status-table" ? <StatusTable {...directive} /> : <FileCard {...directive} />;
}
