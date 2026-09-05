/**
 * The dev server's half of the demo: four routes over one `Demo`.
 *
 * A Vite plugin rather than a server of its own, so there is one command and
 * one port. There is also one orchestrator for the whole process — this is a
 * demo you run on your own machine, and a second tab looking at the same
 * conversation is a feature rather than a race.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

import type { AskEvent, Setup } from "../src/protocol.js";
import { CLOUDS, LOCALS, POLICIES } from "../src/protocol.js";
import { Demo } from "./state.js";

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
};

const sendJson = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** A picked value or the first of the list; a demo does not need a 400 for this. */
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  const first = allowed[0] as T;
  return allowed.find((one) => one === value) ?? first;
};

const asSetup = (body: unknown): Setup => {
  const sent = (body ?? {}) as Partial<Record<keyof Setup, unknown>>;
  return {
    policy: oneOf(sent.policy, POLICIES),
    local: oneOf(sent.local, LOCALS),
    cloud: oneOf(sent.cloud, CLOUDS),
  };
};

export const orchestratorApi = (): Plugin => ({
  name: "orchestrator-demo-api",
  configureServer: (server) => {
    const demo = new Demo();

    server.middlewares.use("/api/state", (_request, response) => {
      void demo.state().then((state) => {
        sendJson(response, state);
      });
    });

    server.middlewares.use("/api/setup", (request, response) => {
      void readBody(request)
        .then((body) => {
          demo.reconfigure(asSetup(body));
          return demo.state();
        })
        .then((state) => {
          sendJson(response, state);
        });
    });

    server.middlewares.use("/api/reset", (_request, response) => {
      demo.reset();
      void demo.state().then((state) => {
        sendJson(response, state);
      });
    });

    // NDJSON and not SSE: the turn is a POST, and `EventSource` cannot send
    // one. The lines are the same events either way.
    server.middlewares.use("/api/ask", (request, response) => {
      void readBody(request).then(async (body) => {
        const input = (body as { input?: unknown } | null)?.input;
        if (typeof input !== "string" || input.trim() === "") {
          sendJson(response, { kind: "done", state: await demo.state() });
          return;
        }
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        });
        const emit = (event: AskEvent): void => {
          response.write(`${JSON.stringify(event)}\n`);
        };
        await demo.ask(input, emit);
        response.end();
      });
    });
  },
});
