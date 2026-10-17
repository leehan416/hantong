import type { AppSettings } from '../shared/settings'

// Gmail class names are generated and change often, so prefer roles, hrefs, image paths and the
// Gemini brand name. A selector that stops matching hides nothing and Gmail stays usable.
const SELECTORS = {
  hideGmailLogo: ['a[href="#inbox"]:has(> img[src*="logo_gmail"])'],
  hideGemini: ['button[aria-label*="Gemini"]'],
  hideSidePanel: ['div:has(> div[role="complementary"])'],
  // The storage notice has no locale-independent attribute; its classes are the only hook.
  hideStoragePromo: ['.aiG:has(> .aiz[role="img"])']
} as const satisfies Record<string, readonly string[]>

export function buildGmailCleanupCss(settings: Pick<AppSettings, keyof typeof SELECTORS>): string {
  const selectors = (Object.keys(SELECTORS) as (keyof typeof SELECTORS)[])
    .filter((field) => settings[field])
    .flatMap((field) => SELECTORS[field])
  return selectors.length ? `${selectors.join(',\n')} { display: none !important; }` : ''
}
