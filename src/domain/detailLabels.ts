import type { DetailRow } from '../storage/memoryDetails.ts';
import { en } from '../i18n/en.ts';

export function detailFields(row: DetailRow): { label: string; value: string }[] {
  const role = (value: string) => Object.hasOwn(en.detailsRoles, value) ? en.detailsRoles[value as keyof typeof en.detailsRoles] : value;
  switch (row.section) {
    case 'originals': return [
      { label: role(row.role), value: en.detailsBytes(row.bytes) },
      { label: en.detailsHash, value: row.hash }, { label: en.detailsPath, value: row.path },
    ];
    case 'dates': return [{ label: Object.hasOwn(en.detailsDateKinds, row.kind) ? en.detailsDateKinds[row.kind as keyof typeof en.detailsDateKinds] : row.kind, value: row.value }];
    case 'sources': return [
      { label: Object.hasOwn(en.detailsKinds, row.kind) ? en.detailsKinds[row.kind as keyof typeof en.detailsKinds] : row.kind, value: role(row.role) },
      { label: en.detailsSourceId, value: row.key1 },
      { label: en.detailsExportPath, value: row.path },
      { label: Object.hasOwn(en.detailsStates, row.state) ? en.detailsStates[row.state as keyof typeof en.detailsStates] : row.state, value: row.hash ? `${en.detailsHash}: ${row.hash}` : '—' },
    ];
  }
}
