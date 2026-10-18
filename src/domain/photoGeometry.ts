export type ImageSize = { width: number; height: number };
export function matchingAspect(base: ImageSize, overlay: ImageSize): boolean {
  const values = [base.width, base.height, overlay.width, overlay.height];
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return false;
  return Math.abs(base.width / base.height - overlay.width / overlay.height) <= 0.001;
}
