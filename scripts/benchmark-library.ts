// Synthetic, query-only benchmark. Usage: node --experimental-strip-types scripts/benchmark-library.ts [new-output-directory] [samples]
// Produces standalone SQLite files, captured queries/expected rows for Android, and host timings. Never opens an app database.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { BenchmarkDatabase, seedLibrary } from './benchmarks/libraryFixture.ts';
import { baselineSql } from './benchmarks/chronologicalBaseline.ts';
import { defaultFilters, type LibraryFilters } from '../src/domain/libraryFilters.ts';
import { keyOf, type Direction, type SequenceKey } from '../src/domain/memoryNavigation.ts';

const samples = Number(process.argv[3] ?? 9);
if (!Number.isInteger(samples) || samples < 3 || samples > 30 || process.argv.length > 4) throw new Error('Expected [new-output-directory] [samples 3..30]');
const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'snarchive-library-benchmark-'));
if (process.argv[2]) mkdirSync(out); // Refuse to overwrite an existing directory or database.
const report = { node: process.version, sqlite: '', cpu: cpus()[0]?.model, platform: platform(), arch: arch(), samples, sizes: [] as unknown[] };
const androidInput: { sizes: { count: number; database: string; cases: unknown[] }[] } = { sizes: [] };
const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], samplesMs: values };
};
for (const count of [1_000, 10_000, 50_000]) {
  const path = join(out, `library-${count}.db`), db = new BenchmarkDatabase(path);
  try {
    const store = await seedLibrary(db, count);
    report.sqlite = (db.raw.prepare('SELECT sqlite_version() v').get() as { v: string }).v;
    const anchor = keyOf((await store.chronologicalPage(null, 1))[0]!);
    // A key around the middle of the fixture's years, and an ID that need not match the active filter.
    const middle = { day: '2020-10-24', time: '', id: `bench-${String(Math.floor(count / 2)).padStart(8, '0')}` };
    const scenarios: { name: string; anchor: SequenceKey | null; direction: Direction; filters: LibraryFilters; limit: number }[] = [
      { name: 'first-all', anchor: null, direction: 'next', filters: defaultFilters, limit: 31 },
      { name: 'deep-next', anchor: middle, direction: 'next', filters: defaultFilters, limit: 20 },
      { name: 'deep-previous', anchor: middle, direction: 'previous', filters: defaultFilters, limit: 20 },
      { name: 'photos', anchor: null, direction: 'next', filters: { ...defaultFilters, media: 'photos' }, limit: 31 },
      { name: 'favorite-photos', anchor: null, direction: 'next', filters: { ...defaultFilters, favorites: true, media: 'photos' }, limit: 31 },
      { name: 'month', anchor, direction: 'next', filters: { ...defaultFilters, month: '2020-10' }, limit: 31 },
      { name: 'on-this-day', anchor: null, direction: 'next', filters: { ...defaultFilters, onThisDay: '2026-10-24' }, limit: 31 },
      { name: 'empty-leap-day', anchor: null, direction: 'next', filters: { ...defaultFilters, onThisDay: '2028-02-29' }, limit: 31 },
      { name: 'unknown-date-tail', anchor: { day: '', time: '', id: 'bench-00000000' }, direction: 'next', filters: defaultFilters, limit: 31 },
    ];
    const cases = [], deviceCases = [];
    for (const scenario of scenarios) {
      const read = () => scenario.anchor ? store.chronologicalAdjacent(scenario.anchor, scenario.direction, scenario.limit, scenario.filters)
        : store.chronologicalPage(null, scenario.limit, scenario.filters);
      db.queryTransform = null;
      const expected = await read(), query = db.lastQuery!;
      const baseline = baselineSql(scenario.direction);
      db.queryTransform = () => baseline;
      assert.deepEqual(await read(), expected);
      const times: Record<'before' | 'after', number[]> = { before: [], after: [] };
      // Warm both variants once above, then alternate which goes first in each pair.
      for (let i = 0; i < samples; i++) for (const variant of i % 2 ? ['after', 'before'] as const : ['before', 'after'] as const) {
        db.queryTransform = variant === 'before' ? () => baseline : null;
        const start = performance.now(); const rows = await read(); times[variant].push(performance.now() - start);
        assert.deepEqual(rows, expected);
      }
      cases.push({ ...scenario, rows: expected.length, before: quantiles(times.before), after: quantiles(times.after) });
      // This contains SQL only from the production query and the frozen baseline, with synthetic bound values.
      const captured = { name: scenario.name, samples, sql: query.sql, baselineSql: baseline, params: query.params, expected };
      writeFileSync(join(out, `query-${count}-${scenario.name}.json`), JSON.stringify(captured));
      deviceCases.push({ ...captured, samples: Math.min(samples, 5) });
    }
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    report.sizes.push({ count, databasePath: path, maxReturned: db.maxReturned, cases });
    androidInput.sizes.push({ count, database: `library-${count}.db`, cases: deviceCases });
    console.log(`Completed ${count} synthetic memories`, JSON.stringify(cases.map(c => ({ name: c.name, before: c.before.medianMs, after: c.after.medianMs }))));
  } finally { db.raw.close(); }
}
writeFileSync(join(out, 'android-input.json'), JSON.stringify(androidInput));
writeFileSync(join(out, 'host-results.json'), JSON.stringify(report, null, 2));
console.log(`Results and Android inputs: ${out}`);
