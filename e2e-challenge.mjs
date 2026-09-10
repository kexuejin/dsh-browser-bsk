/** Positive control: a page carrying challenge markup must be detected. */
import { Context } from '@deepseek-ai/cordis'
import BrowserBsk from './index.js'
import { execFileSync } from 'node:child_process'

const ctx = new Context()
ctx.plugin(BrowserBsk, { bskPath: 'bsk', timeoutMs: 60000 })
await new Promise(r => setTimeout(r, 100))
const session = await ctx.browser.open('e2e-challenge')
try {
  execFileSync('bsk', ['navigate', 'http://127.0.0.1:8123/captcha.html', '--session', session], { stdio: 'ignore' })
  const challenge = await ctx.browser.detectChallenge(session)
  console.log('challenge detected ->', JSON.stringify(challenge))
} finally {
  await ctx.browser.close(session)
}
