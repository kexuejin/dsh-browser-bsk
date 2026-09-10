/**
 * End-to-end check of the bridge against the real bsk daemon: start a session,
 * drive a real login form through the seam methods, and close it.
 */
import { Context } from '@deepseek-ai/cordis'
import BrowserBsk from './index.js'

const ctx = new Context()
ctx.plugin(BrowserBsk, { bskPath: 'bsk', timeoutMs: 60000 })
await new Promise(r => setTimeout(r, 100))
const browser = ctx.browser
console.log('service:', browser?.constructor?.name)

const session = await browser.open('e2e-login')
console.log('1) open ->', session)
try {
  const { execFileSync } = await import('node:child_process')
  execFileSync('bsk', ['navigate', 'http://127.0.0.1:8123/', '--session', session], { stdio: 'ignore' })
  const tabs = await browser.listTabs(session)
  console.log('2) listTabs ->', JSON.stringify(tabs.filter(t => t.url?.includes('8123')).map(t => ({ url: t.url, active: t.active }))))

  const challenge = await browser.detectChallenge(session)
  console.log('3) detectChallenge ->', challenge)

  await browser.setValue(session, { target: { by: 'css', value: '#user' }, value: 'alice' })
  await browser.setValue(session, { target: { by: 'css', value: '#pass' }, value: 's3cret' })
  console.log('4) setValue x2 -> ok')

  await browser.click(session, { target: { by: 'css', value: '#submit' } })
  await new Promise(r => setTimeout(r, 800))
  const out = execFileSync('bsk', ['evaluate', "document.getElementById('hdr').textContent", '--session', session], { encoding: 'utf8' })
  console.log('5) after click, header ->', out.trim().slice(0, 80))
} finally {
  await browser.close(session)
  console.log('6) close -> ok')
}
