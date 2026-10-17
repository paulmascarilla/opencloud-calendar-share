// Event colors. RFC 7986 COLOR takes a CSS3 color name; they are rendered as soft tints
// mixed with the design system's surface / on-surface roles, so they work in both themes.
export const PALETTE = [
  'royalblue',
  'mediumpurple',
  'orchid',
  'crimson',
  'darkorange',
  'goldenrod',
  'seagreen',
  'teal',
  'slategray'
] as const

export type PaletteColor = (typeof PALETTE)[number]

/** Hex values: calendar-color (Apple / Thunderbird / DAVx⁵) expects #RRGGBB, not a color name. */
export const PALETTE_HEX: Record<PaletteColor, string> = {
  royalblue: '#4169e1',
  mediumpurple: '#9370db',
  orchid: '#da70d6',
  crimson: '#dc143c',
  darkorange: '#ff8c00',
  goldenrod: '#daa520',
  seagreen: '#2e8b57',
  teal: '#008080',
  slategray: '#708090'
}
