export const GOOGLE_CLIENT_ID_ENV = 'HANTONG_GOOGLE_CLIENT_ID'

export interface GoogleOAuthConfig {
  readonly clientId: string
}

export function loadGoogleOAuthConfig(
  environment: Record<string, string | undefined>
): GoogleOAuthConfig {
  const clientId = environment[GOOGLE_CLIENT_ID_ENV]?.trim()
  if (!clientId || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error(`${GOOGLE_CLIENT_ID_ENV} must contain a Google Desktop OAuth client ID`)
  }
  return { clientId }
}
