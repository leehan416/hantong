import type { AppSettings } from '../shared/settings'

// Gmail class names are generated and change often, so prefer roles, hrefs, image paths and
// labels. Top-bar labels follow the account's Gmail language; Korean and English are matched.
// A selector that stops matching hides nothing and Gmail stays usable.
const SELECTORS = {
  hideGmailLogo: ['a[href="#inbox"]:has(> img[src*="logo_gmail"])'],
  hideHeaderButtons: [
    // The Gemini button ("Gemini에 질문") is a tooltip-wrapped button outside the banner.
    'span[data-is-tooltip-wrapper]:has(> button[aria-label*="Gemini"])',
    'button[aria-label*="Gemini"]',
    ':is(header, #gb, [role="banner"]) [aria-label="지원"]',
    ':is(header, #gb, [role="banner"]) [aria-label="Support"]',
    ':is(header, #gb, [role="banner"]) [aria-label="설정"]',
    ':is(header, #gb, [role="banner"]) [aria-label="Settings"]',
    ':is(header, #gb, [role="banner"]) [aria-label="Google 앱"]',
    ':is(header, #gb, [role="banner"]) [aria-label="Google apps"]',
    'a[href*="/about/products"]'
  ],
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
