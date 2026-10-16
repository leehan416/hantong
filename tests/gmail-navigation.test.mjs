import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const policy = loadTypeScript(new URL('../src/main/gmail-navigation.ts', import.meta.url))

test('Gmail and Google web sign-in stay within the account session', () => {
  for (const url of [
    'https://mail.google.com/mail/u/0/#inbox',
    'https://accounts.google.com/ServiceLogin?service=mail',
    'https://accounts.google.com/v3/signin/identifier'
  ]) {
    assert.equal(policy.classifyGmailNavigation(url), 'internal', url)
  }
})

test('ordinary HTTPS links leave the Gmail session', () => {
  for (const url of ['https://example.com/', 'https://google.com/', 'https://docs.google.com/']) {
    assert.equal(policy.classifyGmailNavigation(url), 'external', url)
  }
})

test('unsafe schemes, credentials and deceptive hosts never become internal navigation', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/index.html',
    'http://mail.google.com/',
    'https://user:password@mail.google.com/',
    'https://mail.google.com/\n',
    'mailto:test@example.com',
    '',
    'not a URL'
  ]) {
    assert.equal(policy.classifyGmailNavigation(url), 'blocked', url)
  }
  for (const url of ['https://mail.google.com.attacker.example/', 'https://evilmail.google.com/']) {
    assert.equal(policy.classifyGmailNavigation(url), 'external', url)
  }
})

test('Google OAuth authorization endpoints are never opened in the embedded session', () => {
  for (const path of ['/o/oauth2/auth', '/o/oauth2/v2/auth', '/o/oauth2/auth?client_id=test']) {
    assert.equal(policy.classifyGmailNavigation(`https://accounts.google.com${path}`), 'blocked')
  }
})
