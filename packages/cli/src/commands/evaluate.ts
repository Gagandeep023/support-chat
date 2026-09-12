import { readFile } from "node:fs/promises";
import {
  EscalationDetector,
  KeywordIndex,
  Retriever,
  assemblePrompt,
} from "@gagandeep023/support-chat-server";
import type { VectorChunk } from "@gagandeep023/support-chat-server";
import { chunkDocument } from "@gagandeep023/support-chat-server";
import { loadDocuments, SAMPLE_DOCUMENT } from "../docs.js";
import { resolveChatProvider } from "../providers.js";
import { FAIL, PASS, bold, dim, heading, red, green } from "../output.js";

export interface EvalOptions {
  cases: string;
  docs?: string;
  model?: string;
}

/**
 * One eval case.
 *
 * `grounded` and `escalate` are the two things that actually decide whether a
 * model is safe on this workload, and both are cheap to label. `mustMention`
 * catches an answer that is technically grounded but omits the fact that
 * mattered.
 */
interface EvalCase {
  question: string;
  grounded?: boolean;
  escalate?: boolean;
  mustMention?: string[];
}

interface CaseResult {
  question: string;
  failures: string[];
}

/**
 * Score a model against the customer's own documentation.
 *
 * Without this, "run whatever model you like" is a decision handed over with no
 * way to check the answer. With it, model choice becomes measurable, and the
 * same labelled set is what would later justify a fine-tuned classifier.
 */
export async function evaluate(options: EvalOptions): Promise<number> {
  const cases = await readCases(options.cases);
  const documents = options.docs ? await loadDocuments(options.docs) : [SAMPLE_DOCUMENT];
  const { provider, description, simulated } = resolveChatProvider(
    options.model ? { model: options.model } : {},
  );

  const keywords = new KeywordIndex();
  for (const document of documents) {
    keywords.add(
      chunkDocument(document).map<VectorChunk>((piece, index) => ({
        id: `${document.id}_${index}`,
        documentId: document.id,
        tenantId: "eval",
        ordinal: piece.ordinal,
        text: piece.text,
        headingPath: piece.headingPath,
        documentTitle: document.title,
        documentUrl: document.url ?? null,
        embedding: [],
        embeddingModel: "none",
        tokenCount: piece.tokenCount,
      })),
    );
  }

  const retriever = new Retriever(null, keywords, null);
  const detector = new EscalationDetector(provider);

  heading("support-chat eval");
  console.log(dim(`  ${cases.length} cases against ${description}`));
  if (simulated) {
    console.log(
      dim("  No model configured, so answer quality is not being measured.\n"),
    );
  }
  console.log();

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    results.push(await runCase(testCase, retriever, detector, provider));
  }

  for (const result of results) {
    const label = result.question.length > 56
      ? `${result.question.slice(0, 53)}...`
      : result.question;
    console.log(`  ${label.padEnd(58, " ")} ${result.failures.length === 0 ? PASS : FAIL}`);
    for (const failure of result.failures) console.log(`      ${red(failure)}`);
  }

  const failed = results.filter((r) => r.failures.length > 0).length;
  const passed = results.length - failed;
  const rate = results.length === 0 ? 0 : Math.round((passed / results.length) * 100);
  console.log(
    `\n  ${bold(`${passed}/${results.length}`)} passed (${rate}%)` +
      (failed === 0 ? ` ${green("all good")}` : ""),
  );
  console.log();
  return failed > 0 ? 1 : 0;
}

async function runCase(
  testCase: EvalCase,
  retriever: Retriever,
  detector: EscalationDetector,
  provider: ReturnType<typeof resolveChatProvider>["provider"],
): Promise<CaseResult> {
  const failures: string[] = [];
  const retrieval = await retriever.retrieve("eval", testCase.question);

  if (testCase.grounded !== undefined && retrieval.grounded !== testCase.grounded) {
    failures.push(
      `expected retrieval to be ${testCase.grounded ? "grounded" : "empty"}, got ${
        retrieval.grounded ? "grounded" : "empty"
      }`,
    );
  }

  let answer = "";
  try {
    const prompt = assemblePrompt({
      history: [],
      question: testCase.question,
      context: retrieval.chunks,
    });
    for await (const delta of provider.complete({
      system: prompt.system,
      messages: prompt.messages,
      context: prompt.context,
      maxOutputTokens: 512,
      quality: "fast",
    })) {
      if (delta.type === "text") answer += delta.text;
    }
  } catch (error) {
    failures.push(`model call failed: ${error instanceof Error ? error.message : "error"}`);
  }

  for (const phrase of testCase.mustMention ?? []) {
    if (!answer.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push(`answer never mentioned "${phrase}"`);
    }
  }

  if (testCase.escalate !== undefined) {
    const verdict = await detector.detect({
      question: testCase.question,
      answer,
      grounded: retrieval.grounded,
      consecutiveUngrounded: retrieval.grounded ? 0 : 2,
    });
    if (verdict.escalate !== testCase.escalate) {
      failures.push(
        `expected escalate=${testCase.escalate}, got ${verdict.escalate} (${verdict.trigger})`,
      );
    }
  }

  return { question: testCase.question, failures };
}

/** JSONL: one case per line, so a set can be appended to from a transcript dump. */
async function readCases(path: string): Promise<EvalCase[]> {
  const raw = await readFile(path, "utf8");
  const cases: EvalCase[] = [];
  raw.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) return;
    try {
      const parsed = JSON.parse(trimmed) as EvalCase;
      if (typeof parsed.question !== "string") {
        throw new Error("missing a question");
      }
      cases.push(parsed);
    } catch (error) {
      throw new Error(
        `${path}:${index + 1} is not a valid case: ${
          error instanceof Error ? error.message : "parse error"
        }`,
      );
    }
  });
  return cases;
}
