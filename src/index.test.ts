import { expect, test } from "vitest";

import * as entry from "./index.js";

test("the entry point loads", () => {
  expect(entry).toBeTypeOf("object");
});
