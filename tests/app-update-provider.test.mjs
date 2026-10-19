/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Provider is exercised as installed JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AppUpdater } from 'electron-updater/out/AppUpdater.js'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js'

function feed(tags) {
  return `<feed>${tags.map((tag) => `<entry><title>${tag}</title><link href="https://github.com/leehan416/hantong/releases/tag/${tag}" /></entry>`).join('')}</feed>`
}

function provider({ currentVersion, allowPrerelease, tags, latestTag }) {
  const requests = []
  const executor = {
    request: async (options) => {
      requests.push(options.path)
      if (options.path.endsWith('.atom')) return feed(tags)
      if (options.path.endsWith('/latest')) return JSON.stringify({ tag_name: latestTag })
      return `version: ${latestTag}\nfiles:\n  - url: Hantong.zip\n    sha512: abc\npath: Hantong.zip\nsha512: abc\n`
    }
  }
  const instance = new GitHubProvider(
    { provider: 'github', owner: 'leehan416', repo: 'hantong' },
    { currentVersion, allowPrerelease, channel: null, fullChangelog: false },
    { isUseMultipleRangeRequest: false, platform: 'darwin', executor }
  )
  return { instance, requests }
}

test('installed GitHub provider follows alpha feed ordering and selects alpha metadata', async () => {
  const { instance, requests } = provider({
    currentVersion: '0.1.0-alpha.1',
    allowPrerelease: true,
    tags: ['v0.1.0-alpha.10', 'v0.1.0-alpha.2', 'v0.1.0-beta.1', 'v0.1.0'],
    latestTag: 'v0.1.0-alpha.10'
  })
  const update = await instance.getLatestVersion()
  assert.equal(update.tag, 'v0.1.0-alpha.10')
  assert.ok(requests.some((path) => path.endsWith('/alpha-mac.yml')))
})

test('installed GitHub provider stable channel asks GitHub for latest stable tag', async () => {
  const { instance, requests } = provider({
    currentVersion: '0.1.0',
    allowPrerelease: false,
    tags: ['v0.2.0-beta.1', 'v0.1.0'],
    latestTag: 'v0.1.0'
  })
  const update = await instance.getLatestVersion()
  assert.equal(update.tag, 'v0.1.0')
  assert.ok(requests.some((path) => path.endsWith('/latest')))
  assert.ok(requests.some((path) => path.endsWith('/latest-mac.yml')))
})

test('installed GitHub provider promotes alpha to beta metadata when beta leads the feed', async () => {
  const { instance, requests } = provider({
    currentVersion: '0.1.0-alpha.10',
    allowPrerelease: true,
    tags: ['v0.2.0-beta.1', 'v0.1.0-alpha.11', 'v0.1.0'],
    latestTag: 'v0.2.0-beta.1'
  })
  const update = await instance.getLatestVersion()
  assert.equal(update.tag, 'v0.2.0-beta.1')
  assert.ok(requests.some((path) => path.endsWith('/beta-mac.yml')))
})

test('installed GitHub provider promotes alpha to stable metadata when stable leads the feed', async () => {
  const { instance, requests } = provider({
    currentVersion: '0.1.0-alpha.10',
    allowPrerelease: true,
    tags: ['v0.2.0', 'v0.1.0-beta.1', 'v0.1.0-alpha.11'],
    latestTag: 'v0.2.0'
  })
  const update = await instance.getLatestVersion()
  assert.equal(update.tag, 'v0.2.0')
  assert.ok(requests.some((path) => path.endsWith('/latest-mac.yml')))
})

test('installed AppUpdater compares prerelease versions and rejects downgrades', async () => {
  class TestUpdater extends AppUpdater {
    async doDownloadUpdate() {
      return []
    }
  }
  const updater = new TestUpdater(null, {
    version: '0.1.0-alpha.2',
    name: 'Hantong',
    isPackaged: true,
    appUpdateConfigPath: '',
    userDataPath: '/tmp',
    baseCachePath: '/tmp',
    whenReady: async () => undefined,
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined
  })
  updater.allowDowngrade = false
  assert.equal(await updater.isUpdateAvailable({ version: '0.1.0-alpha.10' }), true)
  assert.equal(await updater.isUpdateAvailable({ version: '0.1.0-alpha.1' }), false)
})
