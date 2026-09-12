import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { newTenantId } from "@gagandeep023/support-chat-core";
import { createSupportChat } from "@gagandeep023/support-chat-server";
import {
  MemoryCacheStore,
  MemoryDataStore,
  MemoryVectorStore,
} from "@gagandeep023/support-chat-server/adapters/memory";
import { SqliteDataStore } from "@gagandeep023/support-chat-server/adapters/sqlite";
import { loadDocuments, SAMPLE_DOCUMENT } from "../docs.js";
import { resolveChatProvider, resolveEmbeddings } from "../providers.js";
import { bold, cyan, dim, heading, yellow } from "../output.js";

const PUBLISHABLE_KEY = "pk_dev_local";
const SECRET = "dev-secret-not-for-production";
const BASE_PATH = "/support-chat";

export interface DevOptions {
  port: number;
  docs?: string;
  model?: string;
  /** SQLite file. Omit to keep everything in memory. */
  db?: string;
  /** none | hashed | local */
  embeddings?: string;
}

/**
 * Zero-infrastructure dev server.
 *
 * Memory stores, memory retrieval, and a scripted model if no key is set, so the
 * whole loop runs with nothing installed and nothing configured. That is the
 * point: a plug-and-play claim is false if evaluating it takes more than a
 * minute, and nobody sets up Postgres to decide whether they like something.
 *
 * State lives in memory, so a server restart starts over. A page refresh is fine
 * (the widget stores its conversation id and resumes).
 */
export async function dev(options: DevOptions): Promise<void> {
  const data = options.db ? new SqliteDataStore({ location: options.db }) : new MemoryDataStore();
  await data.init();
  const seed = {
    id: newTenantId(),
    name: "Local development",
    publishableKey: PUBLISHABLE_KEY,
    settings: {},
    createdAt: new Date().toISOString(),
  };
  const tenant = data instanceof SqliteDataStore ? (data.seedTenant(seed), seed) : data.seedTenant(seed);

  const { provider, description, simulated } = resolveChatProvider(
    options.model ? { model: options.model } : {},
  );

  const { embeddings, description: embeddingDescription } = resolveEmbeddings(
    options.embeddings,
  );

  const chat = createSupportChat({
    data,
    cache: new MemoryCacheStore(),
    secretKey: SECRET,
    basePath: BASE_PATH,
    ai: {
      chat: provider,
      ...(embeddings ? { embeddings, vectors: new MemoryVectorStore() } : {}),
    },
    routing: { acceptWindowMs: 20_000 },
  });

  const documents = options.docs ? await loadDocuments(options.docs) : [SAMPLE_DOCUMENT];
  let chunks = 0;
  for (const document of documents) {
    chunks += (await chat.ingest(tenant.id, document)).chunks;
  }

  const widgetBundle = await readWidgetBundle();
  const page = demoPage();

  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith(`${BASE_PATH}/widget.js`)) {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(widgetBundle);
      return;
    }
    if (url === "/" || url.startsWith("/?")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    response.writeHead(404).end("Not found");
  });

  chat.attach(server);

  // Drain on SIGTERM rather than dropping sockets, so the same shutdown path
  // that production uses is exercised in development too.
  const shutdown = async () => {
    console.log(dim("\nDraining connections..."));
    await chat.drain("shutdown");
    await chat.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>((resolve) => server.listen(options.port, resolve));

  heading("support-chat dev");
  console.log(`  ${bold("Open")}       ${cyan(`http://localhost:${options.port}`)}`);
  console.log(`  ${bold("Model")}      ${description}`);
  console.log(`  ${bold("Embeddings")} ${embeddingDescription}`);
  console.log(
    `  ${bold("Knowledge")}  ${documents.length} document${documents.length === 1 ? "" : "s"}, ${chunks} chunks` +
      (options.docs ? "" : dim("  (built-in sample; pass --docs ./docs)")),
  );
  console.log(
    `  ${bold("Storage")}    ` +
      (options.db
        ? `sqlite at ${options.db}`
        : `in memory ${dim("(restarting the server starts over; pass --db ./local.db to keep it)")}`),
  );
  if (simulated) {
    console.log(
      `\n  ${yellow("No model configured.")} Replies are scripted. Set ANTHROPIC_API_KEY,\n` +
        `  or SUPPORT_CHAT_BASE_URL and SUPPORT_CHAT_MODEL, for real answers.`,
    );
  }
  console.log(dim("\n  Ctrl-C to stop.\n"));
}

async function readWidgetBundle(): Promise<string> {
  const require = createRequire(import.meta.url);
  const path = require.resolve("@gagandeep023/support-chat-widget/browser");
  return readFile(path, "utf8");
}

function demoPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>support-chat dev</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 48px 24px; display: flex; justify-content: center;
    background: Canvas; color: CanvasText;
  }
  main { max-width: 44rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
  p { color: color-mix(in srgb, CanvasText 70%, Canvas); }
  code { background: color-mix(in srgb, CanvasText 8%, Canvas); padding: .15em .4em; border-radius: 4px; }
  ul { padding-left: 1.2rem; }
  li { margin: .35rem 0; }
</style>
</head>
<body>
<main>
  <h1>support-chat is running</h1>
  <p>This page exists only to host the widget. The bubble is in the bottom right.</p>
  <p>Things worth trying:</p>
  <ul>
    <li>Ask something the sample docs cover, such as <code>what does error E4021 mean?</code></li>
    <li>Ask something they do not cover, and watch it decline to guess.</li>
    <li>Click <em>Talk to a person</em> to queue for a human agent.</li>
    <li>Refresh the page: the conversation resumes from where it left off.</li>
  </ul>
  <p>To embed this on a real site, serve the same script and element:</p>
  <pre><code>&lt;script src="${BASE_PATH}/widget.js"&gt;&lt;/script&gt;
&lt;support-chat publishable-key="${PUBLISHABLE_KEY}"&gt;&lt;/support-chat&gt;</code></pre>
</main>
<script src="${BASE_PATH}/widget.js"></script>
<support-chat publishable-key="${PUBLISHABLE_KEY}" heading="Support"></support-chat>
</body>
</html>`;
}
