/**
 * Thin `bsk` CLI runner for the browser seam backend.
 *
 * Every call shells out to the same `bsk` daemon the browser-skill plugin
 * drives, so sessions, the Agent Window, and the user's own browser profile
 * are shared with it rather than duplicated.
 * @module dsh-browser-bsk/bsk
 */
import { execFile } from 'node:child_process'

/** One `bsk` invocation failure: the CLI exited non-zero, timed out, or aborted. */
export class BskError extends Error {
  /**
   * @param message - operator-facing detail (command, argv, stderr).
   * @param options - `code` classifies the failure; `cause` keeps the original error.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BskError'
    this.code = options.code ?? 'BSK_COMMAND_FAILED'
  }
}

/** Strip the CLI's ANSI styling so error text and JSON stay machine-readable. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- CLI output carries cursor/style escapes.
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
}

/**
 * Run one `bsk` invocation and return its parsed `--json` payload.
 *
 * `--json` is always appended: every caller here needs structured output, and
 * a human-readable run would make the daemon's exit codes the only signal.
 * @param argv - Full argument list, e.g. `['session', 'start']`.
 * @param options - `bskPath`, `timeoutMs`, and an optional abort `signal`.
 * @returns the parsed JSON payload.
 * @throws {BskError} when the CLI fails, times out, or emits non-JSON output.
 */
export function runBsk(argv, options) {
  const { bskPath, timeoutMs, signal } = options
  const full = [...argv, '--json']
  return new Promise((resolve, reject) => {
    execFile(
      bskPath,
      full,
      { timeout: timeoutMs, signal, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stripAnsi(String(stderr || error.message)).trim().split('\n').slice(-3).join(' | ')
          const code = error.name === 'AbortError'
            ? 'BSK_ABORTED'
            : error.killed === true || error.signal === 'SIGTERM'
              ? 'BSK_TIMEOUT'
              : 'BSK_COMMAND_FAILED'
          reject(new BskError(`bsk ${full.join(' ')} failed: ${detail}`, { code, cause: error }))
          return
        }
        const text = stripAnsi(String(stdout)).trim()
        if (text.length === 0) {
          resolve(undefined)
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (cause) {
          reject(new BskError(`bsk ${full.join(' ')} returned non-JSON output: ${text.slice(0, 200)}`, { code: 'BSK_BAD_OUTPUT', cause }))
        }
      },
    )
  })
}
