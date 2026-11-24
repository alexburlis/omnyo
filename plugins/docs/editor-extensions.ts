import { getHTMLFromFragment } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import {
  Fragment,
  type Mark as ProseMirrorMark,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";

export const TightTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tight: {
        default: true,
        parseHTML: (element) =>
          element.getAttribute("data-tight") === "true" ||
          !element.querySelector("p"),
        renderHTML: (attributes) => ({
          "data-tight": attributes.tight ? "true" : null,
        }),
      },
    };
  },
});

interface TableMarkdownState {
  out: string;
  inTable: boolean;
  write(value: string): void;
  ensureNewLine(): void;
  closeBlock(node: ProseMirrorNode): void;
  render(node: ProseMirrorNode, parent: ProseMirrorNode, index: number): void;
  renderInline(node: ProseMirrorNode): void;
}

function tableChildren(node: ProseMirrorNode): readonly ProseMirrorNode[] {
  return node.content.content;
}

function hasMergedCell(node: ProseMirrorNode): boolean {
  return node.attrs.colspan > 1 || node.attrs.rowspan > 1;
}

function isMarkdownTable(node: ProseMirrorNode): boolean {
  const [header, ...body] = tableChildren(node);

  if (!header) return false;

  if (
    tableChildren(header).some(
      (cell) =>
        cell.type.name !== "tableHeader" ||
        hasMergedCell(cell) ||
        cell.childCount > 1,
    )
  ) {
    return false;
  }

  return !body.some((row) =>
    tableChildren(row).some(
      (cell) =>
        cell.type.name === "tableHeader" ||
        hasMergedCell(cell) ||
        cell.childCount > 1,
    ),
  );
}

function renderTableCell(
  state: TableMarkdownState,
  cell: ProseMirrorNode,
): void {
  const content = cell.firstChild;

  if (!content) return;
  const start = state.out.length;

  if (content.type.name === "image") state.render(content, cell, 0);
  else if (content.childCount > 0) state.renderInline(content);
  state.out =
    state.out.slice(0, start) + state.out.slice(start).replaceAll("|", "\\|");
}

export const MarkdownTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: TableMarkdownState, node: ProseMirrorNode) {
          if (!isMarkdownTable(node)) {
            state.write(
              getHTMLFromFragment(Fragment.from(node), node.type.schema),
            );
            state.closeBlock(node);

            return;
          }

          state.inTable = true;
          node.forEach((row, _offset, rowIndex) => {
            state.write("| ");
            row.forEach((cell, _cellOffset, cellIndex) => {
              if (cellIndex > 0) state.write(" | ");
              renderTableCell(state, cell);
            });
            state.write(" |");
            state.ensureNewLine();

            if (rowIndex === 0) {
              state.write(
                `| ${Array.from({ length: row.childCount }, () => "---").join(" | ")} |`,
              );
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
          state.inTable = false;
        },
        parse: {},
      },
    };
  },
});

interface LinkMarkdownState {
  inAutolink?: boolean;
}

function isPlainUrl(
  mark: ProseMirrorMark,
  parent: ProseMirrorNode,
  index: number,
): boolean {
  if (mark.attrs.title || !/^\w+:/.test(mark.attrs.href)) return false;
  const content = parent.child(index);

  if (
    !content.isText ||
    content.text !== mark.attrs.href ||
    content.marks[content.marks.length - 1] !== mark
  ) {
    return false;
  }

  return (
    index === parent.childCount - 1 ||
    !mark.isInSet(parent.child(index + 1).marks)
  );
}

export const MarkdownLink = Link.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: {
          open(
            state: LinkMarkdownState,
            mark: ProseMirrorMark,
            parent: ProseMirrorNode,
            index: number,
          ) {
            state.inAutolink = isPlainUrl(mark, parent, index);

            return state.inAutolink ? "<" : "[";
          },
          close(state: LinkMarkdownState, mark: ProseMirrorMark) {
            const { inAutolink } = state;
            state.inAutolink = undefined;

            if (inAutolink) return ">";
            const href = String(mark.attrs.href).replace(/[()"]/g, "\\$&");

            const title = mark.attrs.title
              ? ` "${String(mark.attrs.title).replace(/[\\"]/g, "\\$&")}"`
              : "";

            return `](${href}${title})`;
          },
          mixable: true,
        },
        parse: {},
      },
    };
  },
});
