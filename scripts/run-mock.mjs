// Starts BitChord with offline fixtures (no YouTube needed) and a throw-away profile.
//   node scripts/run-mock.mjs [--account]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { root } from './stage-app.mjs';

const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env, BITCHORD_MOCK: '1', BITCHORD_USERDATA: process.env.BITCHORD_USERDATA || path.join(os.tmpdir(), 'bitchord-mock') };
if (process.argv.includes('--account')) env.BITCHORD_MOCK_ACCOUNT = '1';
spawn(electron, [root], { env, stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0));
