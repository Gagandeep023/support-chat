import { describe, expect, it } from "vitest";
import { describeEmbeddingProvider } from "../stores/embedding-conformance.js";
import { HashedEmbeddingProvider } from "./hashed-embedding-provider.js";
import { LocalEmbeddingProvider } from "./local-embedding-provider.js";

// Downloads model weights on first run, so it is opt in.
const enabled = process.env.SUPPORT_CHAT_TEST_LOCAL_EMBEDDINGS === "1";
const suite = enabled ? describe : describe.skip;

// One instance across the file: loading the model per test would dominate.
const shared = new LocalEmbeddingProvider();

if (enabled) {
  describeEmbeddingProvider("local-onnx", () => ({ provider: shared }), { timeoutMs: 180_000 });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const CHUNKS = [
  "Billing > Refunds\n\nRefunds for a failed session are issued within 14 working days to the original payment method.",
  "Charging > Session stops early\n\nError code E4021 means the cable was unplugged at the vehicle end.",
  "Account > Closing your account\n\nYou can close your account from the settings page at any time.",
];

/**
 * What a real embedding model buys over lexical matching.
 *
 * The question shares no words with the answer. Keyword search and hashed
 * bag-of-words both rank by overlap, so neither can bridge "money back" to
 * "refunds", and this is exactly the gap the vector half of hybrid retrieval
 * exists to close.
 */
suite("local embeddings, semantic retrieval", () => {
  const PARAPHRASE = "how do I get my money back after a charge that failed";

  it("ranks the paraphrased answer first", async () => {
    const vectors = await shared.embed([PARAPHRASE, ...CHUNKS]);
    const [query, ...chunks] = vectors as number[][];
    const scores = chunks.map((chunk) => cosine(query as number[], chunk));
    const best = scores.indexOf(Math.max(...scores));
    expect(best).toBe(0);
  }, 120_000);

  it("beats hashed bag-of-words on the same question", async () => {
    // The honest comparison. Hashed embeddings measure lexical overlap, so they
    // should lose here; if they did not, the 300MB dependency would not be
    // earning its place.
    const hashed = new HashedEmbeddingProvider();
    const hashedVectors = await hashed.embed([PARAPHRASE, ...CHUNKS]);
    const [hq, ...hc] = hashedVectors as number[][];
    const hashedScores = hc.map((chunk) => cosine(hq as number[], chunk));

    const localVectors = await shared.embed([PARAPHRASE, ...CHUNKS]);
    const [lq, ...lc] = localVectors as number[][];
    const localScores = lc.map((chunk) => cosine(lq as number[], chunk));

    const hashedMargin = (hashedScores[0] ?? 0) - Math.max(hashedScores[1] ?? 0, hashedScores[2] ?? 0);
    const localMargin = (localScores[0] ?? 0) - Math.max(localScores[1] ?? 0, localScores[2] ?? 0);

    console.log(
      `  paraphrase margin over the next-best chunk:` +
        `\n    hashed bag-of-words ${hashedMargin.toFixed(3)}` +
        `\n    local MiniLM        ${localMargin.toFixed(3)}`,
    );
    expect(localMargin).toBeGreaterThan(hashedMargin);
  }, 120_000);

  it("reports the declared dimension count", async () => {
    const [vector] = await shared.embed(["dimension check"]);
    expect(vector).toHaveLength(shared.dimensions);
  }, 120_000);
});
