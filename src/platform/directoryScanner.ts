import { requireOptionalNativeModule } from 'expo';
import type { DirectorySnapshot } from '../import/sourceInventory';
interface Scanner {
  scanDirectory(uri: string): Promise<({ ok: true } & DirectorySnapshot) | { ok: false; code: string }>;
  cancel(): void;
}
const scanner = requireOptionalNativeModule<Scanner>('SnarchiveSources');
export async function scanDirectory(uri: string): Promise<DirectorySnapshot> {
  if (!scanner) throw new Error('native-build-required');
  const result = await scanner.scanDirectory(uri);
  if (!result.ok) throw new Error(result.code);
  return result;
}
export function cancelDirectoryScan() { scanner?.cancel(); }
