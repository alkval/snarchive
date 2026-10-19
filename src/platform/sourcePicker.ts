import * as DocumentPicker from 'expo-document-picker';
import { Directory } from 'expo-file-system';

export type SourceSelection = { kind: 'zip' | 'directory'; uri: string };
export interface SourcePicker {
  selectArchives(): Promise<SourceSelection[]>;
  selectDirectory(): Promise<SourceSelection>;
  /** One Snarchive backup for read-only inspection. Never fed into the Snapchat import flow. */
  selectBackup(): Promise<string | null>;
}

/** Selection only. A URI is not proof of readable, durable, or imported data. */
export const sourcePicker: SourcePicker = {
  async selectArchives() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/zip', 'application/x-zip-compressed'],
      multiple: true,
      copyToCacheDirectory: false,
    });
    return result.canceled ? [] : result.assets.map(({ uri }) => ({ kind: 'zip', uri }));
  },
  async selectBackup() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/zip', 'application/x-zip-compressed'],
      multiple: false,
      copyToCacheDirectory: false,
    });
    return result.canceled ? null : result.assets[0]?.uri ?? null;
  },
  async selectDirectory() {
    const directory = await Directory.pickDirectoryAsync();
    return { kind: 'directory', uri: directory.uri };
  },
};
