import { Image } from 'react-native';
import type { ImportStore, LibraryRow } from '../storage/importStore';
import { originalUri, originalVideo, thumbnail, type LocalVideo } from './originalImporter';
import { matchingAspect, videoDisplaySize, type ImageSize } from '../domain/photoGeometry';
import { en } from '../i18n/en';
export type Photo = { uri: string; size: ImageSize };
export type ViewerMedia = { base: Photo | null; overlay: Photo | null; video: LocalVideo | null; poster: string | null; status: string; overlayStatus: string };
function measure(uri: string): Promise<Photo> { return new Promise((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ uri, size: { width, height } }), reject)); }
export async function loadViewerMedia(store: ImportStore, row: LibraryRow): Promise<ViewerMedia> {
  const result: ViewerMedia = { base: null, overlay: null, video: null, poster: null, status: '', overlayStatus: '' };
  if (row.photos + row.videos !== 1) { result.status = en.libraryVariants; return result; }
  try {
    const objects = await store.objects(row.id), object = objects.find(o => o.role === (row.videos ? 'video' : 'photo'));
    if (!object) throw new Error('missing-object');
    if (row.videos) {
      result.video = await originalVideo(object);
      result.poster = await thumbnail(object, true).catch(() => null);
      if (row.overlays > 1) result.overlayStatus = en.libraryOverlayVariants;
      else {
        const layer = objects.find(o => o.role === 'overlay'), size = videoDisplaySize(result.video.width, result.video.height, result.video.rotation);
        if (layer && size) try {
          const image = await measure(await originalUri(layer));
          if (matchingAspect(size, image.size)) result.overlay = image; else result.overlayStatus = en.libraryOverlaySize;
        } catch { result.overlayStatus = en.libraryOverlayFailed; }
      }
      return result;
    }
    result.base = await measure(await originalUri(object));
    void Image.prefetch(result.base.uri).catch(() => {});
    if (row.overlays > 1) { result.overlayStatus = en.libraryOverlayVariants; return result; }
    const layer = objects.find(o => o.role === 'overlay');
    if (layer) try {
      const image = await measure(await originalUri(layer));
      if (matchingAspect(result.base.size, image.size)) { result.overlay = image; void Image.prefetch(image.uri).catch(() => {}); }
      else result.overlayStatus = en.libraryOverlaySize;
    } catch { result.overlayStatus = en.libraryOverlayFailed; }
  } catch { result.status = row.videos ? en.libraryVideoFailed : en.libraryPhotoFailed; }
  return result;
}
