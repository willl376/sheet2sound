// sheet2sound — paper sheet music to sound (Audiveris OMR -> MusicXML -> vexml/VexFlow -> Tone.js).
// Copyright (C) 2026 The sheet2sound contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// vite.config.js — dev server + API route for transcription.
// POST /api/transcribe?name=<original-filename>  with the raw image/PDF bytes in the body.
// Spawns the patched Audiveris CLI (server/transcribe.mjs) and streams back the .mxl.
import { defineConfig } from 'vite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { transcribe } from './server/transcribe.mjs';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.tif', '.tiff', '.bmp']);

function audiverisTranscribePlugin () {
  return {
    name: 'audiveris-transcribe',

    configureServer (server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/transcribe')) return next();

        const { searchParams } = new URL(req.url, 'http://localhost');
        const name = searchParams.get('name') || 'upload';
        const ext = join(name).match(/(\.[^.]+)$/)?.[1]?.toLowerCase() || '';

        if (!ALLOWED_EXT.has(ext)) {
          res.statusCode = 400;
          return res.end(`Unsupported file type "${ext}". Allowed: ${[...ALLOWED_EXT].join(', ')}`);
        }

        // Collect the raw body (KISS: no multipart parsing server-side).
        const chunks = [];
        let total = 0;
        req.on('data', (c) => {
          total += c.length;
          if (total > MAX_UPLOAD_BYTES) {
            res.statusCode = 413;
            res.end('File too large (max 64 MiB)');
            req.destroy();
            return;
          }
          chunks.push(c);
        });

        req.on('end', async () => {
          if (res.writableEnded) return;
          const body = Buffer.concat(chunks);
          if (body.length === 0) {
            res.statusCode = 400;
            return res.end('Empty file');
          }

          const tmpDir = await mkdtemp(join(tmpdir(), 's2s-upload-'));
          const tmpFile = join(tmpDir, `input${ext}`);
          await writeFile(tmpFile, body);

          try {
            const { mxl, log, exitCode, elapsedMs } = await transcribe(tmpFile);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/vnd.recordare.musicxml');
            res.setHeader('X-Audiveris-Exit', String(exitCode));
            res.setHeader('X-Elapsed-Ms', String(elapsedMs));
            res.setHeader('X-Audiveris-Log-B64', Buffer.from(log).toString('base64'));
            res.end(mxl);
          } catch (err) {
            res.statusCode = 500;
            res.end('Transcription failed: ' + (err.message || err).slice(0, 2000));
          } finally {
            await rm(tmpDir, { recursive: true, force: true });
          }
        });

        req.on('error', () => {
          if (!res.writableEnded) res.end('Upload stream error');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [audiverisTranscribePlugin()],
  server: {
    watch: {
      // Scratch/working files must not crash the file watcher (they are only served statically).
      ignored: ['**/artifacts/**', '**/scores/**', '**/tmp/**'],
    },
  },
});