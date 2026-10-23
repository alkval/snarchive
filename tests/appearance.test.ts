import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AppearancePreferences, darkAppearance, isAppearanceChoice, type AppearanceChoice } from '../src/domain/appearance.ts';
import { AppearanceStore } from '../src/storage/appearanceStore.ts';
import type { SqlConnection } from '../src/storage/previewStore.ts';

class DB {
  raw = new DatabaseSync(':memory:');
  failCommit = false;
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { this.raw.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.raw.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.raw.prepare(sql).all(...p) as T[]; }
  async withExclusiveTransactionAsync(work: (tx: SqlConnection) => Promise<void>) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      await work(this);
      if (this.failCommit) throw new Error('synthetic-commit-failure');
      this.raw.exec('COMMIT');
    } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
}
async function storage(t: { after(fn: () => void): void }) {
  const db = new DB(); t.after(() => db.raw.close());
  const store = new AppearanceStore(db); await store.initialize(); return { db, store };
}
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('System follows light, dark and unspecified devices; explicit choices ignore the device', () => {
  for (const system of ['light', 'dark', null, undefined] as const) {
    assert.equal(darkAppearance('system', system), system === 'dark');
    assert.equal(darkAppearance('light', system), false);
    assert.equal(darkAppearance('dark', system), true);
  }
  for (const value of ['', 'auto', 'Dark', null, {}, 1]) assert.equal(isAppearanceChoice(value), false);
});

test('new device preferences default to System without creating a library or a preference row', async t => {
  const { db, store } = await storage(t);
  assert.equal(await store.load(), 'system');
  assert.deepEqual(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ['appearance']);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM appearance').get()!.n, 0);
  await store.initialize(); assert.equal(await store.load(), 'system');
});

test('each choice persists through a fresh store and preferences model', async t => {
  const { db, store } = await storage(t);
  const first = new AppearancePreferences(store); await first.load();
  for (const choice of ['dark', 'light', 'system'] as const) {
    assert.equal(await first.choose(choice), true);
    const reopened = new AppearanceStore(db); await reopened.initialize();
    const next = new AppearancePreferences(reopened); await next.load();
    assert.equal(next.snapshot().choice, choice);
  }
});

test('a future preferences schema is preserved and neither read nor overwritten', async t => {
  const { db, store } = await storage(t); await store.save('dark');
  db.raw.exec('PRAGMA user_version=2');
  await assert.rejects(store.initialize(), /unsupported-preferences-version/);
  await assert.rejects(store.load(), /unsupported-preferences-version/);
  await assert.rejects(store.save('light'), /unsupported-preferences-version/);
  assert.equal(db.raw.prepare('SELECT choice FROM appearance').get()!.choice, 'dark');
  assert.equal(db.raw.prepare('PRAGMA user_version').get()!.user_version, 2);
});

test('invalid persisted choices are not silently overwritten; invalid writes are rejected', async t => {
  const { db, store } = await storage(t);
  db.raw.exec("PRAGMA ignore_check_constraints=ON; INSERT INTO appearance VALUES(1,'future-choice'); PRAGMA ignore_check_constraints=OFF");
  const preferences = new AppearancePreferences(store);
  assert.equal(await preferences.load(), false);
  assert.equal(await preferences.choose('light'), false);
  await assert.rejects(store.save('auto' as AppearanceChoice), /invalid-appearance/);
  assert.equal(db.raw.prepare('SELECT choice FROM appearance').get()!.choice, 'future-choice');
});

test('initial loading blocks choices and duplicate loads; no normal screen precedes the saved choice', async () => {
  const read = held<AppearanceChoice>(); let loads = 0, writes = 0;
  const preferences = new AppearancePreferences({ load: () => { loads++; return read.promise; }, save: async () => { writes++; } });
  const loading = preferences.load();
  assert.equal(preferences.snapshot().initialized, false);
  assert.equal(await preferences.load(), false);
  assert.equal(await preferences.choose('light'), false);
  read.resolve('dark'); await loading;
  assert.equal(preferences.snapshot().initialized, true);
  assert.equal(preferences.snapshot().choice, 'dark');
  assert.equal(await preferences.load(), true); // a repeated effect does not reload
  assert.equal(loads, 1); assert.equal(writes, 0);
});

test('a failed read opens the app in System; retry keeps it mounted and loads the saved choice', async () => {
  const read = held<AppearanceChoice>(); let calls = 0;
  const preferences = new AppearancePreferences({ load: async () => { if (++calls === 1) throw new Error('private path'); return read.promise; }, save: async () => {} });
  await preferences.load();
  assert.deepEqual(preferences.snapshot(), { choice: 'system', initialized: true, loaded: false, loading: false, pending: null, error: 'load' });
  assert.equal(await preferences.choose('dark'), false);
  const retry = preferences.load();
  assert.equal(preferences.snapshot().initialized, true); // settings is not unmounted on retry
  read.resolve('light'); assert.equal(await retry, true);
  assert.equal(preferences.snapshot().choice, 'light'); assert.equal(preferences.snapshot().error, null);
});

test('a held save retains the old theme, rejects double taps and a concurrent load, then applies once', async () => {
  const write = held<void>(); const writes: AppearanceChoice[] = [];
  const preferences = new AppearancePreferences({ load: async () => 'system', save: choice => { writes.push(choice); return write.promise; } });
  await preferences.load();
  const saving = preferences.choose('dark');
  assert.equal(preferences.snapshot().choice, 'system'); assert.equal(preferences.snapshot().pending, 'dark');
  assert.equal(await preferences.choose('light'), false);
  assert.equal(await preferences.choose('dark'), false);
  await preferences.load(); assert.equal(preferences.snapshot().pending, 'dark');
  write.resolve(); assert.equal(await saving, true);
  assert.deepEqual(writes, ['dark']); assert.equal(preferences.snapshot().choice, 'dark'); assert.equal(preferences.snapshot().pending, null);
});

test('a failed transaction keeps both the saved preference and active choice; a retry succeeds', async t => {
  const { db, store } = await storage(t); await store.save('dark');
  const preferences = new AppearancePreferences(store); await preferences.load();
  db.failCommit = true;
  assert.equal(await preferences.choose('light'), false);
  assert.equal(preferences.snapshot().choice, 'dark'); assert.equal(preferences.snapshot().error, 'save');
  assert.equal(db.raw.prepare('SELECT choice FROM appearance').get()!.choice, 'dark');
  db.failCommit = false;
  assert.equal(await preferences.choose('light'), true);
  assert.equal(preferences.snapshot().choice, 'light'); assert.equal(preferences.snapshot().error, null);
  assert.equal(await store.load(), 'light');
});

test('Back during a save does not cancel the app-owned write; a reopened screen sees its result', async () => {
  const write = held<void>();
  const preferences = new AppearancePreferences({ load: async () => 'system', save: () => write.promise });
  await preferences.load();
  let oldUpdates = 0, reopenedUpdates = 0;
  const close = preferences.subscribe(() => { oldUpdates++; });
  const saving = preferences.choose('dark'); close();
  const reopen = preferences.subscribe(() => { reopenedUpdates++; });
  write.resolve(); await saving; reopen();
  assert.equal(oldUpdates, 1); assert.equal(reopenedUpdates, 1); assert.equal(preferences.snapshot().choice, 'dark');
});

test('a failed save can be dismissed by selecting the still-active choice without another write', async () => {
  let writes = 0;
  const preferences = new AppearancePreferences({ load: async () => 'dark', save: async () => { writes++; throw new Error('private detail'); } });
  await preferences.load(); await preferences.choose('light');
  assert.equal(await preferences.choose('dark'), true);
  assert.equal(preferences.snapshot().error, null); assert.equal(preferences.snapshot().choice, 'dark'); assert.equal(writes, 1);
});

test('invalid repository output is a retryable load failure and no raw error enters state', async () => {
  const preferences = new AppearancePreferences({ load: async () => 'untrusted' as AppearanceChoice, save: async () => {} });
  await preferences.load();
  assert.equal(preferences.snapshot().error, 'load'); assert.equal(preferences.snapshot().loaded, false);
  assert.equal(JSON.stringify(preferences.snapshot()).includes('untrusted'), false);
});
