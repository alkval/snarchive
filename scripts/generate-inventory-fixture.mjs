import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const work = fileURLToPath(new URL('../work/', import.meta.url));
await mkdir(work, { recursive: true });
const root = await mkdtemp(`${work}inventory-fixture-`);
await mkdir(`${root}/part-a/memories`, { recursive: true });
await mkdir(`${root}/part-b/json`, { recursive: true });
for (const filename of ['2026-02-05_a-main.jpg', '2026-02-05_a-overlay.png', '2026-02-05_b-main.mp4', '2026-02-05_c-overlay.png']) {
  await writeFile(`${root}/part-a/memories/${filename}`, 'SYNTHETIC INVENTORY PLACEHOLDER. Not valid image/video data.\n');
}
const row = id => ({ Date: '2026-02-05 17:48:47 UTC', 'Media Type': 'Image', 'Download Link': `https://example.invalid/?mid=${id}` });
await writeFile(`${root}/part-b/json/memories_history.json`, JSON.stringify({ 'Saved Media': [row('a'), row('a'), row('d')] }));
await writeFile(`${root}/part-a/index.html`, '<p>Synthetic export index. The scanner must not execute HTML.</p>');
console.log(`Synthetic filename/metadata fixture: ${root}`);
console.log('Expected combined preview: 2 media-present, 1 metadata-only, 1 overlay-only, 1 repeated row, 1 other file.');
console.log('Placeholder media are intentionally invalid. Use only for inventory tests, never playback validation.');
