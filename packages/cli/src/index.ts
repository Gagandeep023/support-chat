import { parseArgs } from "node:util";
import { dev } from "./commands/dev.js";
import { doctor } from "./commands/doctor.js";
import { evaluate } from "./commands/evaluate.js";
import { bold, cyan, dim, red } from "./output.js";

const USAGE = `${bold("support-chat")} ${dim("- embeddable AI support chat")}

${bold("Usage")}
  support-chat dev      [--port 4000] [--docs ./docs] [--model <id>] [--db ./local.db]
                        [--embeddings none|hashed|local]
  support-chat doctor   [--model <id>] [--top-k 8]
  support-chat eval     --cases ./cases.jsonl [--docs ./docs] [--model <id>]

${bold("Commands")}
  dev       Run everything locally with no database, no Redis, and no API key.
  doctor    Check that the configured model can actually do the job.
  eval      Score a model against your own documentation.

${bold("Environment")}
  ANTHROPIC_API_KEY        Use the Anthropic API.
  SUPPORT_CHAT_BASE_URL    Any OpenAI-compatible endpoint (Moonshot, Groq,
  SUPPORT_CHAT_MODEL       Together, Fireworks, OpenRouter, vLLM, Ollama).
  SUPPORT_CHAT_API_KEY     Key for that endpoint, when it needs one.

  With none of these set, replies are scripted so the loop still runs.
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case "dev": {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: "string", short: "p" },
          docs: { type: "string", short: "d" },
          model: { type: "string", short: "m" },
          db: { type: "string" },
          embeddings: { type: "string", short: "e" },
        },
      });
      await dev({
        port: Number(values.port ?? 4000),
        ...(values.docs ? { docs: values.docs } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.db ? { db: values.db } : {}),
        ...(values.embeddings ? { embeddings: values.embeddings } : {}),
      });
      // dev holds the process open until interrupted.
      return -1;
    }

    case "doctor": {
      const { values } = parseArgs({
        args: rest,
        options: {
          model: { type: "string", short: "m" },
          "top-k": { type: "string" },
        },
      });
      return doctor({
        ...(values.model ? { model: values.model } : {}),
        ...(values["top-k"] ? { topK: Number(values["top-k"]) } : {}),
      });
    }

    case "eval": {
      const { values } = parseArgs({
        args: rest,
        options: {
          cases: { type: "string", short: "c" },
          docs: { type: "string", short: "d" },
          model: { type: "string", short: "m" },
        },
      });
      if (!values.cases) {
        console.error(red("  eval needs --cases pointing at a .jsonl file"));
        return 1;
      }
      return evaluate({
        cases: values.cases,
        ...(values.docs ? { docs: values.docs } : {}),
        ...(values.model ? { model: values.model } : {}),
      });
    }

    default: {
      console.error(`${red(`Unknown command: ${command}`)}\n`);
      console.log(`Try ${cyan("support-chat help")}.`);
      return 1;
    }
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(red(`\n  ${error instanceof Error ? error.message : String(error)}\n`));
    process.exit(1);
  });
