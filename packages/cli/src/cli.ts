#!/usr/bin/env node
import process from 'node:process';
import { runCli } from './index.js';

runCli(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
