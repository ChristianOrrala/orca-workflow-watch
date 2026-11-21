import type { MetroSize } from './protocol'

/** The metro line sizes the panel draws, smallest first. */
export const METRO_SIZES: readonly MetroSize[] = ['compact', 'comfortable', 'large']
export const DEFAULT_METRO_SIZE: MetroSize = 'comfortable'

/** The "Metro line size" setting as one of its three values, else the default. */
export function metroSize(value: unknown): MetroSize {
  const wanted = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (METRO_SIZES as readonly string[]).includes(wanted) ? (wanted as MetroSize) : DEFAULT_METRO_SIZE
}
