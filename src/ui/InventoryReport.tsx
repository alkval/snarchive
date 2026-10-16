import { StyleSheet, Text, View } from 'react-native';
import type { InventoryPreview } from '../import/sourceInventory';
import { en } from '../i18n/en';

export function InventoryReport({ preview, color }: { preview: InventoryPreview; color: string }) {
  const { summary } = preview.inventory;
  const rows: [string, number][] = [
    [en.report.folders, preview.sources.length], [en.report.media, summary.mediaPresent],
    [en.report.metadataOnly, summary.metadataOnly], [en.report.orphan, summary.orphanOverlays],
    [en.report.conflicts, summary.needsResolution], [en.report.unmatched, summary.unmatchedMetadata],
    [en.report.repeated, preview.inventory.repeatedRows], [en.report.warnings, preview.inventory.diagnostics.length],
    [en.report.other, preview.otherFiles],
  ];
  return <View style={styles.report}>
    <Text accessibilityRole="header" style={[styles.heading, { color }]}>{en.preview}</Text>
    {rows.map(([label, count]) => <Text key={label} style={[styles.body, { color }]}>{label}: {count}</Text>)}
    <Text style={[styles.body, { color }]}>{en.previewNote}</Text>
  </View>;
}
const styles = StyleSheet.create({ report: { gap: 10, marginTop: 20 }, heading: { fontSize: 22, fontWeight: '600' }, body: { fontSize: 16, lineHeight: 24 } });
