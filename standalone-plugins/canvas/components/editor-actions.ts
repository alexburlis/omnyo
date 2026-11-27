import type { CanvasNode, Composition, EditInput, HistoryEntry, NodeInspection } from "../contract";
import type { DatasetPushInput, NodeBinding, SourceInput } from "../source-contract";
import type { RenderVerification } from "../workspace-contract";

export interface EditorActions {
  readHistory(changeId: string): Promise<HistoryEntry>;
  loadHistory(): Promise<void>;
  refreshHistory(): Promise<void>;
  inspect(id: string): Promise<NodeInspection>;
  edit(input: EditInput): Promise<void>;
  verify(id: string): Promise<RenderVerification>;
  undo(changeId?: string): Promise<void>;
  redo(changeId?: string): Promise<void>;
  duplicate(id: string): Promise<void>;
  compose(composition: Composition, label?: string): Promise<void>;
  move(id: string, position: { x: number; y: number } | null): Promise<void>;
  reference(node: CanvasNode): void;
  pin(node: CanvasNode): Promise<void>;
  hide(node: CanvasNode): Promise<void>;
  resetPosition(node: CanvasNode): Promise<void>;
  saveSource(input: SourceInput): Promise<void>;
  refreshSource(id: string): Promise<void>;
  pauseSource(id: string, paused: boolean): Promise<void>;
  pushDataset(input: DatasetPushInput): Promise<void>;
  addModule(binding: NodeBinding): Promise<void>;
}
