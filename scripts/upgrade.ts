#!/usr/bin/env bun
import { main } from "./service.ts";

main(["upgrade", ...process.argv.slice(2)]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
