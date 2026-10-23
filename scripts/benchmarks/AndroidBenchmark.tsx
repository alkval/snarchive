// Development entry ONLY, in an isolated workspace/disposable emulator. Never imported by index.ts or App.tsx.
// Read captured synthetic benchmark inputs from document/s28-input.json; write document/s28-results.json.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';

type Case = { name: string; samples: number; sql: string; baselineSql: string; params: (string | number | null)[]; expected: unknown[] };
type Input = { sizes: { database: string; count: number; cases: Case[] }[] };
function quantiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], samplesMs: values };
}
async function benchmark(progress: (message: string) => void) {
  if (!__DEV__) throw new Error('Development benchmark only');
  const input = JSON.parse(await new File(Paths.document, 's28-input.json').text()) as Input;
  const results: unknown[] = [];
  for (const size of input.sizes) {
    if (!/^library-(1000|10000|50000)\.db$/.test(size.database)) throw new Error('Unexpected benchmark database');
    const db = await openDatabaseAsync(size.database, { useNewConnection: true });
    try {
      const version = await db.getFirstAsync<{ version: string }>('SELECT sqlite_version() AS version');
      for (const item of size.cases) {
        const execute = async (variant: 'before' | 'after') => {
          const start = performance.now();
          const result = await db.getFirstAsync<{ data: string }>(variant === 'before' ? item.baselineSql : item.sql, ...item.params);
          const rows = JSON.parse(result?.data ?? '[]') as unknown[];
          const elapsed = performance.now() - start;
          if (JSON.stringify(rows) !== JSON.stringify(item.expected)) throw new Error(`Result mismatch: ${size.count}/${item.name}/${variant}`);
          return elapsed;
        };
        await execute('before'); await execute('after');
        const times: Record<'before' | 'after', number[]> = { before: [], after: [] };
        for (let i = 0; i < item.samples; i++) for (const variant of i % 2 ? ['after', 'before'] as const : ['before', 'after'] as const)
          times[variant].push(await execute(variant));
        results.push({ count: size.count, name: item.name, sqlite: version?.version, rows: item.expected.length, before: quantiles(times.before), after: quantiles(times.after) });
        progress(`${size.count}: ${item.name}`);
      }
    } finally { await db.closeAsync(); }
  }
  return { completed: true, results };
}
let running: Promise<unknown> | null = null;
export default function AndroidBenchmark() {
  const [status, setStatus] = useState('Running synthetic query benchmark');
  useEffect(() => {
    let active = true;
    // Avoid running twice if development Strict Mode replays the effect.
    if (!running) running = benchmark(message => { if (active) setStatus(message); }).then(async result => {
      const file = new File(Paths.document, 's28-results.json');
      await file.write(JSON.stringify(result)); return result;
    }).catch(async error => {
      const file = new File(Paths.document, 's28-results.json');
      await file.write(JSON.stringify({ completed: false, error: String(error) }));
      throw error;
    });
    void running.then(() => { if (active) setStatus('Synthetic query benchmark complete'); }, () => { if (active) setStatus('Benchmark failed; read s28-results.json'); });
    return () => { active = false; };
  }, []);
  return <View style={{ flex: 1, padding: 40, backgroundColor: '#FFFFFF', justifyContent: 'center' }}><Text style={{ color: '#111114' }}>{status}</Text></View>;
}
