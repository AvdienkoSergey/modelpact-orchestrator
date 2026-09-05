/**
 * Every exported name, read from the *emitted* declarations the way a consumer
 * without `@types/node` reads them: `types: []`, `skipLibCheck` off. A node
 * type in a public signature fails here; a node import in a function body does
 * not, because it never reaches the `.d.ts`.
 */
import {
  makeClaudeCliBackend,
  makeClaudeCliProvider,
  orchestrate,
  type Answer,
  type ClaudeCliConfig,
  type Orchestrator,
  type OrchestratorParts,
  type Policy,
  type Side,
  type Spawned,
  type Spawner,
} from "../dist/index.js";

export const values = {
  makeClaudeCliBackend,
  makeClaudeCliProvider,
  orchestrate,
};
export type Types = [
  Answer,
  ClaudeCliConfig,
  Orchestrator,
  OrchestratorParts,
  Policy,
  Side,
  Spawned,
  Spawner,
];
