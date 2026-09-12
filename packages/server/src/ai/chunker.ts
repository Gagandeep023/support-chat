export interface SourceDocument {
  id: string;
  title: string;
  url?: string | null;
  content: string;
}

export interface TextChunk {
  ordinal: number;
  text: string;
  headingPath: string[];
  tokenCount: number;
}

export interface ChunkOptions {
  targetChars?: number;
  overlapChars?: number;
}

/**
 * Structure-aware chunking.
 *
 * Splits on markdown headings first and only falls back to a character window
 * inside an oversized section, because fixed-size splitting cuts sentences in
 * half and produces chunks that retrieve well and read badly.
 *
 * The heading path is prepended to the chunk text rather than kept as metadata,
 * and that one detail is among the cheapest large wins available here: a chunk
 * reading "You can request one within 30 days" is unanswerable on its own, while
 * "Billing > Refunds > Eligibility" in front of it makes it usable. It has to be
 * in the indexed text so it influences retrieval, not just the rendered prompt.
 */
export function chunkDocument(
  document: SourceDocument,
  options: ChunkOptions = {},
): TextChunk[] {
  const targetChars = options.targetChars ?? 1800;
  const overlapChars = options.overlapChars ?? 240;

  const sections = splitByHeadings(document.content, document.title);
  const chunks: TextChunk[] = [];

  for (const section of sections) {
    const prefix = section.headingPath.join(" > ");
    for (const body of windowText(section.body, targetChars, overlapChars)) {
      const text = prefix ? `${prefix}\n\n${body}` : body;
      chunks.push({
        ordinal: chunks.length,
        text,
        headingPath: section.headingPath,
        tokenCount: Math.ceil(text.length / 4),
      });
    }
  }

  return chunks;
}

interface Section {
  headingPath: string[];
  body: string;
}

function splitByHeadings(content: string, title: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let path: string[] = [title];
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) sections.push({ headingPath: [...path], body });
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const depth = heading[1]?.length ?? 1;
      const text = (heading[2] ?? "").trim();
      path = [title, ...path.slice(1, depth - 1), text].filter(Boolean);
      continue;
    }
    buffer.push(line);
  }
  flush();

  return sections.length > 0 ? sections : [{ headingPath: [title], body: content.trim() }];
}

function windowText(body: string, targetChars: number, overlapChars: number): string[] {
  if (body.length <= targetChars) return [body];

  const paragraphs = body.split(/\n{2,}/);
  const windows: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > targetChars) {
      windows.push(current.trim());
      current = `${current.slice(-overlapChars)}\n\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) windows.push(current.trim());

  return windows;
}
