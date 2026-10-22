// 一時的なエクスポート（作業中）
import { tickFx } from './fx';
import { MAT } from './materials';
export * from './bowl';
export const COUNTER_TOP_Y = 1.0;
export const COUNTER_SHELF_Y = 1.16;
export const galleryMaterials = { counter: MAT.woodCounter, lightWood: MAT.woodLight };
export function tickModels(t: number): void {
  tickFx(t);
}
