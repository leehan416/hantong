export function createLoginLaunchStartupController(dependencies: {
  showWindow: () => void
  hideDock: () => void
}): { requestReveal: () => void; start: (wasOpenedAtLogin: boolean) => void } {
  let ready = false
  let revealRequested = false
  return {
    requestReveal: () => {
      revealRequested = true
      if (ready) dependencies.showWindow()
    },
    start: (wasOpenedAtLogin) => {
      ready = true
      if (wasOpenedAtLogin && !revealRequested) dependencies.hideDock()
      else dependencies.showWindow()
    }
  }
}
