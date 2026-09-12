import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { SourceDocument } from "@gagandeep023/support-chat-server";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".mdx"]);

/** Read a directory tree of markdown and text files as ingestable documents. */
export async function loadDocuments(root: string): Promise<SourceDocument[]> {
  const info = await stat(root).catch(() => null);
  if (!info) throw new Error(`No such directory: ${root}`);

  if (info.isFile()) {
    return [await toDocument(root, root)];
  }

  const documents: SourceDocument[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        documents.push(await toDocument(path, root));
      }
    }
  };
  await walk(root);
  return documents;
}

async function toDocument(path: string, root: string): Promise<SourceDocument> {
  const content = await readFile(path, "utf8");
  const id = relative(root, path) || path;
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return {
    // A stable id keyed on the path, so re-ingesting replaces rather than
    // duplicates and a deleted file can be detected as a deletion.
    id: id.split(sep).join("/"),
    title: heading ?? id.replace(/\.[^.]+$/, "").split(sep).join(" / "),
    url: null,
    content,
  };
}

export const SAMPLE_DOCUMENT: SourceDocument = {
  id: "sample-charging-help",
  title: "Charging help",
  url: null,
  content: `# Charging help

## Session stops early

Error code E4021 means the cable was unplugged at the vehicle end. Plug it back in and
start a new session. If it happens twice at the same bay, the bay needs an engineer.

## Refunds

Refunds for a failed session are issued within 14 working days to the original payment
method. We cannot refund to a different card.

## Starting a session

Hold your card against the reader, or start the session from the app. The bay light
turns green when charging begins.
`,
};
