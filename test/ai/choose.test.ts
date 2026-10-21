import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { chooseTool, type ToolEntry } from '../../src/ai/choose';

const claude = (found = true, models = ['sonnet', 'opus']): ToolEntry => ({ id: 'claude', found, models });
const codex = (found = true, models = ['gpt-5']): ToolEntry => ({ id: 'codex', found, models });

describe('chooseTool', () => {
  it('uses the configured tool and saved model', () => {
    assert.deepEqual(chooseTool([claude(), codex()], { tool: 'codex', toolSetByUser: true, model: 'gpt-5' }), { kind: 'ok', id: 'codex', model: 'gpt-5' });
    assert.deepEqual(chooseTool([claude(), codex()], { tool: 'claude', toolSetByUser: false, model: '' }), { kind: 'ok', id: 'claude', model: 'sonnet' });
  });

  it('falls back to another detected tool only when the user never chose one', () => {
    assert.deepEqual(chooseTool([claude(false), codex()], { tool: 'claude', toolSetByUser: false, model: '' }), { kind: 'ok', id: 'codex', model: 'gpt-5' });
  });

  it('a tool the user chose that is missing is reported, never silently replaced', () => {
    assert.deepEqual(chooseTool([claude(false), codex()], { tool: 'claude', toolSetByUser: true, model: 'opus' }), { kind: 'missing', id: 'claude' });
  });

  it('a detected tool without models is reported as such', () => {
    assert.deepEqual(chooseTool([claude(true, []), codex()], { tool: 'claude', toolSetByUser: true, model: '' }), { kind: 'noModels', id: 'claude' });
    assert.deepEqual(chooseTool([claude(true, []), codex(false)], { tool: 'claude', toolSetByUser: false, model: '' }), { kind: 'noModels', id: 'claude' });
  });

  it('nothing detected', () => {
    assert.deepEqual(chooseTool([claude(false), codex(false)], { tool: 'claude', toolSetByUser: false, model: '' }), { kind: 'none' });
  });
});
