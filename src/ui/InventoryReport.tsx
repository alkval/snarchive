import type { InventoryPreview } from '../import/sourceInventory';
import { en } from '../i18n/en';
import { Group, Row } from './kit';

export function InventoryReport({ preview, footer }: { preview: InventoryPreview; footer: string }) {
  const { summary } = preview.inventory;
  const rows: [string, number, boolean][] = [
    [en.report.folders, preview.sources.length, false], [en.report.media, summary.mediaPresent, false],
    [en.report.metadataOnly, summary.metadataOnly, false], [en.report.orphan, summary.orphanOverlays, false],
    [en.report.conflicts, summary.needsResolution, true], [en.report.unmatched, summary.unmatchedMetadata, true],
    [en.report.repeated, preview.inventory.repeatedRows, false], [en.report.warnings, preview.inventory.diagnostics.length, true],
    [en.report.other, preview.otherFiles, false],
  ];
  // Rows that need attention are marked only when they are non-zero.
  return <Group header={en.preview} footer={footer} inset={16}>
    {rows.map(([label, count, attention]) => <Row key={label} title={label} value={count.toLocaleString()} tone={attention && count > 0 ? 'warning' : undefined}
      icon={attention && count > 0 ? 'alert-circle-outline' : undefined} />)}
  </Group>;
}
