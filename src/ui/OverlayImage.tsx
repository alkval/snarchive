import { useMemo, useState } from 'react';
import { Image, PixelRatio, View, useWindowDimensions, StyleSheet } from 'react-native';
import { containedSize } from '../domain/viewerGestures';
import type { ImageSize } from '../domain/photoGeometry';

/** Use the base media's actual drawn rectangle, including small export rounding differences. Extra decode detail
 * targets at most four megapixels (up to twice the displayed size); no original is rewritten. */
export function OverlayImage({ uri, media, onError }: { uri: string; media: ImageSize; onError?(): void }) {
  const screen = useWindowDimensions();
  const [size, setSize] = useState({ width: screen.width, height: screen.height });
  const drawn = containedSize(media, size);
  const source = useMemo(() => ({ uri }), [uri]);
  const pixels = drawn.width * drawn.height * PixelRatio.get() ** 2;
  const decodeMultiplier = Math.max(1, Math.min(2, Math.sqrt(4_000_000 / Math.max(1, pixels))));
  return <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={event => {
    const { width, height } = event.nativeEvent.layout;
    setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
  }}>
    <Image accessible={false} source={source} fadeDuration={0} resizeMode="stretch" resizeMethod="resize" resizeMultiplier={decodeMultiplier}
      onError={onError} style={{ position: 'absolute', width: drawn.width, height: drawn.height,
        left: (size.width - drawn.width) / 2, top: (size.height - drawn.height) / 2 }} />
  </View>;
}
