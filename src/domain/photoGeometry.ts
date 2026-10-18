export type ImageSize = { width: number; height: number };
export function matchingAspect(base: ImageSize, overlay: ImageSize): boolean {
  const values = [base.width, base.height, overlay.width, overlay.height];
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return false;
  return Math.abs(base.width / base.height - overlay.width / overlay.height) <= 0.001;
}

/** Container rotation describes display orientation, not encoded frame dimensions. */
export function videoDisplaySize(width?: number, height?: number, rotation?: number): ImageSize | null {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) return null;
  if (rotation === 0 || rotation === 180) return { width, height };
  if (rotation === 90 || rotation === 270) return { width: height, height: width };
  return null;
}
export function seekTarget(current: number, delta: number, duration: number): number {
  if (![current, delta, duration].every(Number.isFinite) || duration <= 0) return 0;
  return Math.max(0, Math.min(duration, current + delta));
}

export function videoControlsReady(status: string, duration: number): boolean {
  return status === 'readyToPlay' || (status === 'idle' && Number.isFinite(duration) && duration > 0);
}
