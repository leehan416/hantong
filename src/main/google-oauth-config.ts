export const GOOGLE_CLIENT_ID_ENV = 'HANTONG_GOOGLE_CLIENT_ID'
export const GOOGLE_CLIENT_SECRET_ENV = 'HANTONG_GOOGLE_CLIENT_SECRET'

export interface GoogleOAuthConfig {
  readonly clientId: string
  readonly clientSecret?: string
}

export function loadGoogleOAuthConfig(
  environment: Record<string, string | undefined>
): GoogleOAuthConfig {
  const clientId = environment[GOOGLE_CLIENT_ID_ENV]?.trim()
  if (!clientId || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error(`${GOOGLE_CLIENT_ID_ENV} must contain a Google Desktop OAuth client ID`)
  }
  const clientSecret = environment[GOOGLE_CLIENT_SECRET_ENV]?.trim()
  return clientSecret ? { clientId, clientSecret } : { clientId }
}
