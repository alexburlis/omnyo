import { useEffect, useState } from "react";
import { nextSemanticDetail, type SemanticDetail } from "../lib/semantic";

export function useSemanticDetail(zoom: number, compact = false): SemanticDetail {
  const [detail, setDetail] = useState<SemanticDetail>(() => nextSemanticDetail("evidence", zoom));

  useEffect(() => setDetail((previous) => nextSemanticDetail(previous, zoom)), [zoom]);

  return compact ? "evidence" : detail;
}
