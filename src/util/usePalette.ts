// Reading the palette from a component.
//
// Most of the app never needs this: its colours are CSS variables, so a theme
// change repaints them with no React involved. The exception is the handful of
// places that draw a colour through an inline style or an SVG attribute, where
// a variable cannot reach -- those have to be told to render again.

import { useSyncExternalStore } from "react";
import { adapt, currentPalette, onPalette, type Palette } from "./theme";

/** The palette in force, re-rendering the component when it changes. */
export function usePalette(): Palette {
  return useSyncExternalStore(onPalette, currentPalette, currentPalette);
}

/** `adapt` bound to the palette in force, for a component that draws its own
 *  colours. Returns a new function identity on every palette change, which is
 *  what makes a `useMemo` over it recompute. */
export function useAdapt(): (hex: string, target?: number) => string {
  const p = usePalette();
  return (hex, target) => adapt(hex, target, p);
}
