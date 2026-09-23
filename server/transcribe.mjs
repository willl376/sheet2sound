// server/transcribe.mjs — the Audiveris backend seam.
// Spawns the patched Audiveris CLI in batch/export mode and returns the MusicXML (.mxl).
// Used by the vite dev-server plugin for /api/transcribe, and directly by scripts for tests.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const JAVA_HOME =
  process.env.AUDIVERIS_JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-25.0.4.101-hotspot';

export const AUDIVERIS_BAT =
  process.env.AUDIVERIS_BAT ||
  'C:\\Users\\Wilbur\\Pictures\\audiveris-patched-0.1-patch1\\audiveris-patched-0.1-patch1\\app\\build\\install\\app\\bin\\Audiveris.bat';

/**
 * Transcribe a sheet-music image/PDF into MusicXML.
 *
 * @param {string} inputPath path to the input image or PDF
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=180000] Audiveris hard cap per job (headless OMR is slow)
 * @param {boolean} [opts.all=false] return every exported .mxl (multi-page books), not just the first
 * @returns {Promise<{ mxl: Buffer, log: string, exitCode: number, elapsedMs: number }>}
 *   or, with all=true, { mxlFiles: [{ name, data }], log, exitCode, elapsedMs }
 * @throws {Error} when Audiveris fails or produces no .mxl
 */
export async function transcribe (inputPath, { timeoutMs = 180000, all = false } = {}) {
  const started = Date.now();
  const outDir = await mkdtemp(join(tmpdir(), 's2s-transcribe-'));

  try {
    const { stdout, stderr, exitCode } = await runAudiveris(inputPath, outDir, timeoutMs);
    const log = stdout + '\n' + stderr;

    const files = await readdir(outDir);
    const mxlFiles = files.filter((f) => f.toLowerCase().endsWith('.mxl'));

    if (exitCode !== 0 || mxlFiles.length === 0) {
      const tail = log.split('\n').slice(-30).join('\n');
      throw new Error(`Audiveris exited ${exitCode} with no .mxl output.\n${tail}`);
    }

    if (all) {
      const mxlFilesData = await Promise.all(
        mxlFiles.map(async (f) => ({ name: f, data: await readFile(join(outDir, f)) }))
      );
      return { mxlFiles: mxlFilesData, log, exitCode, elapsedMs: Date.now() - started };
    }

    return { mxl: await readFile(join(outDir, mxlFiles[0])), log, exitCode, elapsedMs: Date.now() - started };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function runAudiveris (inputPath, outDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'cmd.exe',
      ['/c', AUDIVERIS_BAT, '-batch', '-export', '-output', outDir, inputPath],
      {
        env: {
          ...process.env,
          JAVA_HOME,
          PATH: join(JAVA_HOME, 'bin') + ';' + (process.env.PATH || ''),
        },
        windowsHide: true,
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Audiveris timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

// CLI mode: `node server/transcribe.mjs <input.png|pdf>`
if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: node server/transcribe.mjs <input.png|pdf>');
    process.exit(2);
  }
  const started = Date.now();
  const result = await transcribe(input);
  const outFile = join(process.cwd(), 'artifacts', 'cli-transcribe-' + Date.now() + '.mxl');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(outFile, result.mxl);
  const notes = (result.log.match(/exported notes|Exporting/g) || []).length;
  console.log(
    JSON.stringify(
      {
        ok: true,
        mxlBytes: result.mxl.length,
        exitCode: result.exitCode,
        elapsedMs: Date.now() - started,
        savedTo: outFile,
        logTail: result.log.split('\n').slice(-8),
      },
      null,
      2
    )
  );
}