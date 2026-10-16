export const APP_INFO_CHANNEL = 'hantong:app-info'

export interface AppInfo {
  name: string
  version: string
  locale: 'ko' | 'en'
}

export interface HantongApi {
  getAppInfo: () => Promise<AppInfo>
}
