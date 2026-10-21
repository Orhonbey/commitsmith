import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { cleanMessage } from '../../src/message/clean';

describe('cleanMessage', () => {
  it('strips fences and quotes', () => {
    assert.equal(cleanMessage('```\nfix: x\n```', true), 'fix: x');
    assert.equal(cleanMessage('"fix: x"', true), 'fix: x');
  });

  it('strips AI trailers', () => {
    const raw = [
      'feat: add thing',
      '',
      'Body line.',
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      'Claude-Session: abc',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      'Co-authored-by: Codex <codex@openai.com>',
      'Co-Authored-By: Ali <ali@x.com>',
    ].join('\n');
    const out = cleanMessage(raw, true);
    assert.ok(!/claude|codex|anthropic|openai|Session|Generated|🤖/i.test(out), out);
    assert.ok(out.includes('Co-Authored-By: Ali <ali@x.com>'));
    assert.ok(out.includes('Body line.'));
  });

  it('stripAttribution false keeps trailers', () => {
    const raw = 'fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
    assert.equal(cleanMessage(raw, false), raw);
  });

  it('collapses 3+ blank lines and trims', () => {
    assert.equal(cleanMessage('\n\n fix: x\n\n\n\n\nbody \n\n', true), 'fix: x\n\nbody');
  });
});
