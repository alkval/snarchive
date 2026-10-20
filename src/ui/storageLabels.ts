import type { StorageEntry } from '../integrity/storageCleanup.ts';
import { en } from '../i18n/en.ts';

/** Decimal units; sizes are estimates of freed space, so one decimal is enough. */
export function storageSize(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
/** Local calendar date of a modification time. */
export function storageDay(millis: number): string {
  const date = new Date(millis), pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The copy's own identifier: the "millis-random" part of quarantine/<hash>-<millis>-<random>.damaged. Several copies
 * of one original share the hash (and often size and date), so only this tells them apart; it never changes and
 * matches the file name. A path of another shape (never listed) falls back to its whole file name. */
export function quarantineCopyId(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return /^[a-f0-9]{64}-([0-9]{1,19}-[a-f0-9]{8})\.damaged$/.exec(name)?.[1] ?? name;
}

/** What a listed file is called on screen and to assistive technology, in the list and in the confirmation alike. */
export function storageEntryLabel(entry: StorageEntry): { title: string; detail: string; accessibilityLabel: string } {
  const title = entry.kind === 'object' ? en.storageObjectTitle(entry.hash) : en.storageQuarantineTitle(quarantineCopyId(entry.path), entry.hash);
  const detail = en.storageDetail(storageSize(entry.bytes), storageDay(entry.modified));
  return { title, detail, accessibilityLabel: `${title}, ${detail}` };
}
