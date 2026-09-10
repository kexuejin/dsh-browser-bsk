/**
 * Unit tests for the bsk-backed browser seam.
 *
 * Every case drives the service through an injected fake runner, so the suite
 * never starts a real browser session and never needs a running daemon.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import BrowserBsk from '../index.js'

/**
 * Mount the service on a real cordis context.
 *
 * Using the real context exercises the `super(ctx, 'browser')` registration
 * that the loader depends on, instead of a hand-rolled stand-in that could
 * agree with a broken implementation.
 * @param responses - `key` is the joined argv prefix that selects a response.
 */
async function serviceWith(responses) {
  const calls = []
  const ctx = new Context()
  ctx.plugin(BrowserBsk, { bskPath: 'bsk-fake', timeoutMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 0))
  const service = ctx.browser
  service.run = async (argv, signal) => {
    calls.push({ argv, signal })
    for (const [key, value] of Object.entries(responses)) {
      if (argv.join(' ').startsWith(key)) {
        if (value instanceof Error) throw value
        return typeof value === 'function' ? value(argv) : value
      }
    }
    throw new Error(`unexpected bsk call: ${argv.join(' ')}`)
  }
  return { service, calls }
}

test('open returns the session id the daemon reports', async () => {
  const { service, calls } = await serviceWith({ 'session start': { session_id: 'abc' } })
  assert.equal(await service.open('task-1'), 'abc')
  assert.deepEqual(calls[0].argv, ['session', 'start'])
})

test('open fails loudly when the daemon reports no session id', async () => {
  const { service } = await serviceWith({ 'session start': {} })
  await assert.rejects(() => service.open('task-1'), /returned no session_id/)
})

test('open forwards the configured window size', async () => {
  const { service, calls } = await serviceWith({ 'session start': { session_id: 'abc' } })
  service.sessionWidth = 1400
  service.sessionHeight = 900
  await service.open('task-1')
  assert.deepEqual(calls[0].argv, ['session', 'start', '--width', '1400', '--height', '900'])
})

test('listTabs maps daemon tab fields onto the seam shape', async () => {
  const { service } = await serviceWith({
    'tab list': {
      tabs: [
        { tab_id: 7, url: 'https://example.com/login', title: 'Sign in', active: true, scope: 'agent' },
        { tab_id: 8, active: false },
      ],
    },
  })
  assert.deepEqual(await service.listTabs('abc'), [
    { tabId: 7, url: 'https://example.com/login', title: 'Sign in', active: true, scope: 'agent' },
    { tabId: 8, url: undefined, title: undefined, active: false, scope: undefined },
  ])
})

test('listTabs tolerates a missing tabs array', async () => {
  const { service } = await serviceWith({ 'tab list': {} })
  assert.deepEqual(await service.listTabs('abc'), [])
})

test('setValue fills through --selector and --value', async () => {
  const { service, calls } = await serviceWith({ fill: {} })
  await service.setValue('abc', { target: { by: 'css', value: '#user' }, value: 'alice' })
  assert.deepEqual(calls[0].argv, ['fill', '--session', 'abc', '--selector', '#user', '--value', 'alice'])
})

test('setValue rejects locator kinds bsk cannot resolve', async () => {
  const { service } = await serviceWith({ fill: {} })
  await assert.rejects(
    () => service.setValue('abc', { target: { by: 'xpath', value: '//input' }, value: 'x' }),
    /resolves css targets only/,
  )
})

test('setValue rejects a non-string value', async () => {
  const { service } = await serviceWith({ fill: {} })
  await assert.rejects(() => service.setValue('abc', { target: { by: 'css', value: '#a' }, value: 7 }), /requires a string value/)
})

test('click sends the selector', async () => {
  const { service, calls } = await serviceWith({ click: {} })
  await service.click('abc', { target: { by: 'css', value: 'button[type=submit]' } })
  assert.deepEqual(calls[0].argv, ['click', '--session', 'abc', '--selector', 'button[type=submit]'])
})

test('key presses the named key positionally', async () => {
  const { service, calls } = await serviceWith({ press: {} })
  await service.key('abc', { key: 'Enter' })
  assert.deepEqual(calls[0].argv, ['press', 'Enter', '--session', 'abc'])
})

test('key rejects an empty key name', async () => {
  const { service } = await serviceWith({ press: {} })
  await assert.rejects(() => service.key('abc', { key: '' }), /requires a non-empty key name/)
})

test('detectChallenge reports markers found in the page markup', async () => {
  const { service } = await serviceWith({ 'get-html': '<div class="g-recaptcha" data-sitekey="x"></div>' })
  const challenge = await service.detectChallenge('abc')
  assert.equal(challenge?.kind, 'challenge')
  assert.ok(challenge.markers.includes('g-recaptcha'))
})

test('detectChallenge stays silent on an ordinary login form', async () => {
  const { service } = await serviceWith({ 'get-html': '<form><input name="user"><input type="password" name="pw"></form>' })
  assert.equal(await service.detectChallenge('abc'), undefined)
})

test('detectChallenge reads markup returned as a non-string payload', async () => {
  const { service } = await serviceWith({ 'get-html': { html: 'hcaptcha.com/1/api.js' } })
  assert.ok((await service.detectChallenge('abc'))?.markers.includes('hcaptcha.com'))
})

test('close stops the session by positional id and is idempotent for unknown sessions', async () => {
  const { service, calls } = await serviceWith({ 'session stop': {} })
  await service.close('abc')
  assert.deepEqual(calls[0].argv, ['session', 'stop', 'abc'])
})

test('close swallows a failing stop so teardown paths stay no-ops', async () => {
  const { service } = await serviceWith({})
  service.run = async () => {
    const { BskError } = await import('../bsk.js')
    throw new BskError('already gone', { code: 'BSK_COMMAND_FAILED' })
  }
  await service.close('abc')
})

test('close rethrows a timeout rather than hiding it', async () => {
  const { service } = await serviceWith({})
  service.run = async () => {
    const { BskError } = await import('../bsk.js')
    throw new BskError('timed out', { code: 'BSK_TIMEOUT' })
  }
  await assert.rejects(() => service.close('abc'), /timed out/)
})

test('the plugin declares a bundle patch row and a service entry', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: browser-bsk/)
  assert.match(patch, /name: dsh-browser-bsk/)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.main, 'index.js')
})

test('the service opens no tools, so it cannot collide with browser-skill', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('tools.register'))
  assert.ok(!source.includes('ctx.tool'))
})
