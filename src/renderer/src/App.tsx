import { useEffect, useState } from 'react'
import type { AppInfo } from '../../shared/ipc'

const messages = {
  ko: {
    heading: '한통',
    description: 'Gmail을 위한 한 공간',
    pending: '앱 정보를 불러오고 있어요.',
    error: '앱 정보를 불러오지 못했습니다. 앱을 다시 실행해 주세요.'
  },
  en: {
    heading: 'Hantong',
    description: 'A home for your Gmail',
    pending: 'Loading app information.',
    error: 'Unable to load app information. Please restart the app.'
  }
}

function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [failed, setFailed] = useState(false)
  const locale = info?.locale ?? (navigator.language.startsWith('ko') ? 'ko' : 'en')
  const text = messages[locale]

  useEffect(() => {
    let active = true
    void Promise.resolve()
      .then(() => window.api.getAppInfo())
      .then(
        (result) => {
          if (active) setInfo(result)
        },
        () => {
          if (active) setFailed(true)
        }
      )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return (
    <main className="app-shell">
      <div className="wordmark" aria-hidden="true">
        HANTONG
      </div>
      <h1>{text.heading}</h1>
      <p className="description">{text.description}</p>
      <p className="app-status" role="status">
        {failed ? text.error : info ? `${info.name} ${info.version}` : text.pending}
      </p>
    </main>
  )
}

export default App
