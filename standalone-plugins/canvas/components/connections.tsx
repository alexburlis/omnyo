import { useState } from "react";
import { z } from "zod";
import { useRpc } from "@omnyo/plugin-sdk/app";
import { linkInputSchema, type Board, type CanvasRpcContract } from "../contract";
import { useUndoable } from "./undo";

export function Connections({ board, id }: { board: Board; id: string }) {
  const rpc = useRpc<CanvasRpcContract>();
  const undoable = useUndoable(board.threadId);
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const edges = board.edges.filter((edge) => edge.from === id || edge.to === id);

  async function save(from: string, to: string, value: string, remove: boolean) {
    setBusy(true);
    setError(null);

    try {
      const parameters: z.input<typeof linkInputSchema> & { threadId: string } = {
        threadId: board.threadId,
        from,
        to,
        remove,
        expectedRevision: board.revision,
      };

      if (value) parameters.label = value;
      undoable(
        `${remove ? "Remove" : "Connect"} ${from} → ${to}`,
        await rpc.call("board.link", parameters),
      );
      setLabel("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection could not be saved");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="cnv-connections">
      <summary>Connections</summary>
      {error ? (
        <p className="cnv-editor-error" role="alert">
          {error}
        </p>
      ) : null}
      {edges.map((edge) => {
        const from = board.nodes.find((node) => node.id === edge.from)?.title ?? edge.from;
        const to = board.nodes.find((node) => node.id === edge.to)?.title ?? edge.to;

        return (
          <div key={`${edge.from}:${edge.to}`} className="cnv-connection">
            <p>
              {from} → {to}
            </p>
            <label className="cnv-field">
              <span>Relationship</span>
              <input
                key={edge.label}
                aria-label={`Relationship ${from} to ${to}`}
                defaultValue={edge.label ?? ""}
                disabled={busy}
                onBlur={(event) => {
                  const value = event.currentTarget.value;

                  if (value !== (edge.label ?? "")) void save(edge.from, edge.to, value, false);
                }}
              />
            </label>
            <button
              type="button"
              className="cnv-button"
              disabled={busy}
              onClick={() => void save(edge.from, edge.to, edge.label ?? "", true)}
            >
              Remove connection
            </button>
          </div>
        );
      })}
      <label className="cnv-field">
        <span>Connect to</span>
        <select value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">Choose a module</option>
          {board.nodes
            .filter((node) => node.id !== id)
            .map((node) => (
              <option key={node.id} value={node.id}>
                {node.title ?? node.id}
              </option>
            ))}
        </select>
      </label>
      <label className="cnv-field">
        <span>Relationship label</span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="supports, questions, alternative…"
        />
      </label>
      <button
        type="button"
        className="cnv-button"
        disabled={!target || busy}
        onClick={() => void save(id, target, label, false)}
      >
        Add connection
      </button>
    </details>
  );
}
