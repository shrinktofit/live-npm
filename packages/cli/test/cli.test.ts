import { describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

describe('runCli', () => {
  it('rejects removed direct target commands', async () => {
    await expect(runCli(['once', './node_modules'])).rejects.toThrow('Unknown argument');
    await expect(runCli(['watch', './node_modules'])).rejects.toThrow('Unknown argument');
  });
});
