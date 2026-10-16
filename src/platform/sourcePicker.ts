import * as DocumentPicker from 'expo-document-picker';
import { Directory } from 'expo-file-system';

export type SourceSelection = { kind: 'zip' | 'directory'; uri: string };
export interface SourcePicker {
  selectArchives(): Promise<SourceSelection[]>;
  selectDirectory(): Promise<SourceSelection>;
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
  async selectDirectory() {
    const directory = await Directory.pickDirectoryAsync();
    return { kind: 'directory', uri: directory.uri };
  },
};
