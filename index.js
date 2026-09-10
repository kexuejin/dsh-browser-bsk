/**
 * Browser capability seam (`ctx.browser`) backed by the local `bsk` CLI.
 *
 * The harness browser seam is provider-selecting in the official package; this
 * plugin publishes the service directly because it is the only `browser`
 * provider a profile without an Electron browser plugin needs, and it must not
 * import that package (importing it would ship a second, conflicting
 * `browser_session` tool).
 *
 * Consumers inject the service by name and use the subset they need. Methods
 * are implemented over the same `bsk` daemon the browser-skill plugin drives,
 * so a session started here is a real Agent Window session over the user's own
 * logged-in browser profile. Unsupported seam methods are absent rather than
 * stubbed: a consumer that needs one fails loudly at call time instead of
 * silently doing nothing.
 * @module dsh-browser-bsk
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BskError, runBsk } from './bsk.js'

export { BskError } from './bsk.js'

/** Page markup that indicates a human-verification challenge rather than a login form. */
const CHALLENGE_MARKERS = Object.freeze([
  'g-recaptcha',
  'recaptcha/api.js',
  'hcaptcha.com',
  'challenges.cloudflare.com',
  'cf-chl-',
  'turnstile',
  'geetest',
  'captcha',
  'verify you are human',
  '请完成安全验证',
  '滑块验证',
])

/** Locator kinds this backend can resolve; `bsk` accepts CSS selectors and snapshot refs only. */
const SUPPORTED_LOCATORS = Object.freeze(['css'])

/** One active bsk session, keyed by the id the daemon returned. */
/**
 * Resolve a seam element target to a `bsk` selector argument.
 * @param target - `{by, value, index?}` as the seam defines it.
 * @returns the selector string to pass to `--selector`.
 * @throws {BskError} for locator kinds bsk cannot resolve, or for a non-zero index.
 */
function selectorOf(target) {
  if (target === undefined || target === null || typeof target.value !== 'string' || target.value.length === 0) {
    throw new BskError('browser target requires a non-empty value', { code: 'BSK_UNSUPPORTED_TARGET' })
  }
  if (!SUPPORTED_LOCATORS.includes(target.by)) {
    throw new BskError(`this bsk backend resolves ${SUPPORTED_LOCATORS.join('/')} targets only, got "${String(target.by)}"`, { code: 'BSK_UNSUPPORTED_TARGET' })
  }
  if (target.index !== undefined && target.index !== 0) {
    throw new BskError('this bsk backend resolves the first match only (index 0)', { code: 'BSK_UNSUPPORTED_TARGET' })
  }
  return target.value
}

/**
 * The `ctx.browser` service. One instance per context.
 *
 * Implemented surface (what the seam's consumers here call):
 * `open`, `listTabs`, `setValue`, `click`, `key`, `detectChallenge`, `close`.
 */
export class BrowserBsk extends Service {
  /** Backend configuration; every deployment-varying value is configurable here. */
  static Config = z.object({
    bskPath: z.string().default('bsk').description('Path to the bsk CLI binary (defaults to resolving `bsk` from PATH).'),
    timeoutMs: z.number().default(120000).description('Per-command timeout in milliseconds.'),
    sessionWidth: z.number().description('Agent Window outer width in CSS pixels; set together with sessionHeight.'),
    sessionHeight: z.number().description('Agent Window outer height in CSS pixels; set together with sessionWidth.'),
  })

  /** Sessions this service started and has not yet closed. */
  sessions = new Set()

  /**
   * @param ctx - cordis context; `super(ctx, 'browser')` publishes `ctx.browser`.
   * @param config - validated backend configuration.
   */
  constructor(ctx, config = {}) {
    super(ctx, 'browser')
    this.bskPath = config.bskPath ?? 'bsk'
    this.timeoutMs = config.timeoutMs ?? 120000
    this.sessionWidth = config.sessionWidth
    this.sessionHeight = config.sessionHeight
    ctx.effect(() => () => {
      for (const sessionId of [...this.sessions]) void this.close(sessionId)
    })
  }

  /**
   * Run one bsk invocation through the configured binary.
   * @param argv - Full argument list.
   * @param signal - Optional cancellation.
   */
  run(argv, signal) {
    return runBsk(argv, { bskPath: this.bskPath, timeoutMs: this.timeoutMs, signal })
  }

  /**
   * Start a browser session.
   * @param label - Provider-owned label; logged only, because bsk does not key sessions by label.
   * @param signal - Optional cancellation.
   * @returns the new session id.
   */
  async open(label, signal) {
    const args = []
    if (typeof this.sessionWidth === 'number' && typeof this.sessionHeight === 'number') {
      args.push('--width', String(this.sessionWidth), '--height', String(this.sessionHeight))
    }
    const payload = await this.run(['session', 'start', ...args], signal)
    const sessionId = payload?.session_id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new BskError(`bsk session start returned no session_id (label=${String(label)})`, { code: 'BSK_BAD_OUTPUT' })
    }
    this.sessions.add(sessionId)
    return sessionId
  }

  /**
   * List the session's visible tabs.
   * @param session - Session id.
   * @param signal - Optional cancellation.
   * @returns `{tabId, url, title, active}[]`; `url` and `active` are what consumers read.
   */
  async listTabs(session, signal) {
    const payload = await this.run(['tab', 'list', '--session', session], signal)
    const tabs = Array.isArray(payload?.tabs) ? payload.tabs : []
    return tabs.map(tab => ({
      tabId: tab?.tab_id,
      url: typeof tab?.url === 'string' ? tab.url : undefined,
      title: typeof tab?.title === 'string' ? tab.title : undefined,
      active: tab?.active === true,
      scope: tab?.scope,
    }))
  }

  /**
   * Set one form field's value.
   * @param session - Session id.
   * @param request - `{target, value}`; the value is written from memory to the page only.
   * @param signal - Optional cancellation.
   */
  async setValue(session, request, signal) {
    const selector = selectorOf(request?.target)
    if (typeof request?.value !== 'string') {
      throw new BskError('browser setValue requires a string value', { code: 'BSK_UNSUPPORTED_TARGET' })
    }
    await this.run(['fill', '--session', session, '--selector', selector, '--value', request.value], signal)
  }

  /**
   * Click one element.
   * @param session - Session id.
   * @param request - `{target}`.
   * @param signal - Optional cancellation.
   */
  async click(session, request, signal) {
    await this.run(['click', '--session', session, '--selector', selectorOf(request?.target)], signal)
  }

  /**
   * Press one named key, e.g. `Enter`.
   * @param session - Session id.
   * @param request - `{key}`.
   * @param signal - Optional cancellation.
   */
  async key(session, request, signal) {
    if (typeof request?.key !== 'string' || request.key.length === 0) {
      throw new BskError('browser key requires a non-empty key name', { code: 'BSK_UNSUPPORTED_TARGET' })
    }
    await this.run(['press', request.key, '--session', session], signal)
  }

  /**
   * Detect a human-verification challenge on the session's active tab.
   *
   * Reads the page markup instead of running page script: this backend has no
   * evaluation surface, and challenge widgets are identifiable from their
   * embed markup.
   * @param session - Session id.
   * @param signal - Optional cancellation.
   * @returns the matched markers when the page shows a challenge, otherwise `undefined`.
   */
  async detectChallenge(session, signal) {
    const markup = await this.run(['get-html', '--session', session], signal)
    const html = typeof markup === 'string' ? markup : JSON.stringify(markup ?? '')
    const haystack = html.toLowerCase()
    const matched = CHALLENGE_MARKERS.filter(marker => haystack.includes(marker))
    return matched.length === 0 ? undefined : { kind: 'challenge', markers: matched }
  }

  /**
   * Close a session. Idempotent: an already-closed or unknown session is a no-op.
   * @param session - Session id.
   */
  async close(session) {
    this.sessions.delete(session)
    try {
      await this.run(['session', 'stop', session])
    } catch (error) {
      if (error instanceof BskError && error.code === 'BSK_COMMAND_FAILED') return
      throw error
    }
  }
}

/** Plugin name, as referenced by the bundle patch row. */
export const name = 'dsh-browser-bsk'

export default BrowserBsk
