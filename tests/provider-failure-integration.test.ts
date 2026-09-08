import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
for (const mode of ['overload', 'rate', 'silence']) {
  test(`real Codex adapter settles ${mode} correctly`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { respondViaCodex } from './src/codex-chat.ts';
      import { ProviderFailure, providerFailureNotice } from './src/provider-failure.ts';
      try {
        const result = await respondViaCodex({systemPrompt:'Test', history:[], userMessage:'Test', userName:'Alice'});
        console.log(JSON.stringify({reply:result.reply}));
      } catch (error) {
        if (!(error instanceof ProviderFailure)) throw error;
        console.log(JSON.stringify({notice:providerFailureNotice(error)}));
      }
    `], { cwd: root, timeout: 15000, env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
      GPT_CODEX_BIN: path.join(root, 'tests/fixtures/provider-failure-server.mjs'),
      TEST_PROVIDER_CASE: mode,
    } })
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
    if (mode === 'silence') assert.equal(result.reply, '')
    else assert.match(result.notice, mode === 'rate' ? /🛑.*429/ : /🛑.*capacity/)
  })
}
