// Stand-in for the Claude / Codex CLIs. Behaviour comes from env:
// FAKE_MODE=ok|exit|hang|garbage, FAKE_OUT, FAKE_ARGS_FILE, FAKE_PID_FILE.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, stdin }));
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));

const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'exit') {
  process.stderr.write('Error: not logged in. Run `login` first.\n');
  process.exit(3);
}
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  const out = mode === 'garbage' ? 'this is not json {' : (process.env.FAKE_OUT ?? '');
  const oi = args.indexOf('-o');
  if (oi >= 0) writeFileSync(args[oi + 1], out);
  else process.stdout.write(out);
}
