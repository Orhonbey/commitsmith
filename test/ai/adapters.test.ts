import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClaudeTool } from '../../src/ai/claudeTool';
import { createCodexTool } from '../../src/ai/codexTool';
import { detectTools } from '../../src/ai/registry';
import { AiError } from '../../src/ai/types';
import { SPLIT_SCHEMA } from '../../src/prompt/prompts';

const FAKE = resolve(__dirname, '../fixtures/fake-ai.mjs');
const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/claude-output.json'), 'utf8'));
const isWin = process.platform === 'win32';

describe('ai adapters', () => {
  let dir: string;
  let shim: string;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const argsFile = () => join(dir, 'args.json');
  const recorded = () => JSON.parse(readFileSync(argsFile(), 'utf8')) as { args: string[]; stdin: string };
  const runOpts = (extra: object = {}) => ({ model: 'sonnet', cwd: dir, timeoutMs: 10000, ...extra });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'commitsmith-ai-'));
    if (isWin) {
      shim = join(dir, 'fake ai.cmd'); // space on purpose
      writeFileSync(shim, `@echo off\r\nnode "${FAKE}" %*\r\n`);
    } else {
      shim = join(dir, 'fake-ai.sh');
      writeFileSync(shim, `#!/bin/sh\nexec node "${FAKE}" "$@"\n`, { mode: 0o755 });
    }
    setEnv('FAKE_ARGS_FILE', argsFile());
    setEnv('FAKE_MODE', 'ok');
    setEnv('FAKE_OUT', JSON.stringify(FIXTURE));
    setEnv('FAKE_PID_FILE', join(dir, 'pid'));
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('claude passes model, no tools, no --bare', async () => {
    await createClaudeTool({ exeOverride: shim }).run('hello prompt', runOpts());
    const { args, stdin } = recorded();
    assert.equal(stdin, 'hello prompt');
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    assert.ok(args.includes('--tools'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(!args.includes('--bare'));
  });

  it('claude passes a real schema intact through the shell shim', async () => {
    setEnv('FAKE_OUT', JSON.stringify({ ...FIXTURE, structured_output: { ok: 1 } }));
    const out = await createClaudeTool({ exeOverride: shim }).run('p', runOpts({ jsonSchema: SPLIT_SCHEMA }));
    const { args } = recorded();
    assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), SPLIT_SCHEMA);
    assert.deepEqual(JSON.parse(out), { ok: 1 });
  });

  it('claude parses result field', async () => {
    const out = await createClaudeTool({ exeOverride: shim }).run('p', runOpts());
    assert.equal(out, FIXTURE.result);
  });

  it('codex reads -o file and uses read-only sandbox', async () => {
    setEnv('FAKE_OUT', 'feat: add thing');
    const out = await createCodexTool({ exeOverride: shim }).run('p', runOpts({ model: 'gpt-x' }));
    const { args } = recorded();
    assert.equal(out, 'feat: add thing');
    assert.equal(args[args.indexOf('-s') + 1], 'read-only');
    assert.ok(args.includes('--ephemeral'));
    assert.equal(args[args.indexOf('-m') + 1], 'gpt-x');
    assert.equal(args[args.length - 1], '-');
  });

  it('codex writes the schema to a file and removes it afterwards', async () => {
    setEnv('FAKE_OUT', '{"a":1}');
    await createCodexTool({ exeOverride: shim }).run('p', runOpts({ jsonSchema: SPLIT_SCHEMA }));
    const { args } = recorded();
    const f = args[args.indexOf('--output-schema') + 1];
    assert.ok(f);
    assert.ok(!existsSync(f));
  });

  it('codex models from cache', async () => {
    const home = join(dir, 'codexhome');
    mkdirSync(home);
    writeFileSync(
      join(home, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'm-1', display_name: 'Model One', visibility: 'list' },
          { slug: 'm-2', display_name: 'Model Two', visibility: 'hide' },
          { slug: 'm-3', display_name: 'Model Three', visibility: 'list' },
        ],
      }),
    );
    const models = await createCodexTool({ exeOverride: shim, codexHome: home }).listModels(['fallback']);
    assert.deepEqual(models.map((m) => m.id), ['m-1', 'm-3']);
    assert.equal(models[0].label, 'Model One');
    const none = await createCodexTool({ exeOverride: shim, codexHome: join(dir, 'nope') }).listModels(['fallback']);
    assert.deepEqual(none.map((m) => m.id), ['fallback']);
  });

  it('claude lists built-in and extra models', async () => {
    const models = await createClaudeTool({ exeOverride: shim }).listModels(['claude-x', 'haiku']);
    assert.deepEqual(models.map((m) => m.id), ['haiku', 'sonnet', 'opus', 'claude-x']);
  });

  it('exit non-zero -> AiError exit with stderr tail', async () => {
    setEnv('FAKE_MODE', 'exit');
    await assert.rejects(createClaudeTool({ exeOverride: shim }).run('p', runOpts()), (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.kind, 'exit');
      assert.match(e.stderrTail, /not logged in/);
      return true;
    });
  });

  it('garbage when jsonSchema set -> AiError badOutput', async () => {
    setEnv('FAKE_MODE', 'garbage');
    for (const tool of [createClaudeTool({ exeOverride: shim }), createCodexTool({ exeOverride: shim })]) {
      await assert.rejects(tool.run('p', runOpts({ jsonSchema: { type: 'object' } })), (e: unknown) => {
        assert.ok(e instanceof AiError);
        assert.equal(e.kind, 'badOutput');
        return true;
      });
    }
  });

  it('hang -> AiError timeout within timeoutMs + 2s, process gone', async () => {
    setEnv('FAKE_MODE', 'hang');
    const t0 = Date.now();
    await assert.rejects(createClaudeTool({ exeOverride: shim }).run('p', runOpts({ timeoutMs: 1500 })), (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.kind, 'timeout');
      return true;
    });
    assert.ok(Date.now() - t0 < 3500, 'took too long');
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(pid, 0), 'fake process still alive');
  });

  it('abort signal -> AiError cancelled', async () => {
    setEnv('FAKE_MODE', 'hang');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    await assert.rejects(createCodexTool({ exeOverride: shim }).run('p', runOpts({ signal: ac.signal })), (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.kind, 'cancelled');
      return true;
    });
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(createClaudeTool({ exeOverride: shim }).run('p', runOpts({ signal: pre.signal })), /Cancelled/);
  });

  it('detect returns undefined for missing exe, path for present', async () => {
    assert.equal(await createClaudeTool({ exeOverride: join(dir, 'nope.cmd') }).detect(), undefined);
    assert.equal(await createClaudeTool({ exeOverride: shim }).detect(), shim);
    const res = await detectTools([
      createClaudeTool({ exeOverride: shim }),
      createCodexTool({ exeOverride: join(dir, 'nope') }),
    ]);
    assert.equal(res[0].exe, shim);
    assert.equal(res[1].exe, undefined);
  });
});
