import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, promises as fsp } from 'fs'
import { join, resolve } from 'path'
import { app, dialog } from 'electron'
import is from 'electron-is'
import { autoUpdater } from 'electron-updater'

import logger from './Logger'
import { getI18n } from '../ui/Locale'

if (is.dev()) {
  // __dirname = dist/electron, repo root is two levels up
  autoUpdater.updateConfigPath = resolve(__dirname, '../../app-update.yml')
  // electron-updater 6.x skips checkForUpdates entirely unless the app is
  // packaged; this flag forces it to use the dev config above
  autoUpdater.forceDevUpdateConfig = true
}

// Verification hooks, set only by the .cache test launcher — production
// users never have them in the environment. AUTOYES answers both dialogs so
// the whole pipeline can run headless; NOSPAWN stops short of executing the
// (fake) installer.
const TEST_MODE = process.env.MO_TEST_UPDATE === '1'
const TEST_AUTOYES = TEST_MODE && process.env.MO_TEST_UPDATE_AUTOYES === '1'
const TEST_NO_SPAWN = TEST_MODE && process.env.MO_TEST_UPDATE_NOSPAWN === '1'

const ENGINE_POLL_MS = 2000

export default class UpdateManager extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = options
    this.i18n = getI18n()

    this.isChecking = false
    this.updater = autoUpdater
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.logger = logger
    this.autoCheckData = {
      checkEnable: this.options.autoCheck,
      userCheck: false
    }
    // Meta of the update package currently being downloaded (null when idle);
    // merged into every download-progress payload so the renderer can show
    // the download as a task row even if the start message was missed
    this.downloadMeta = null
    // single-flight: downloadUpdate() has no dedup of its own — a second
    // click used to start a second full download of the same file
    this.downloading = false
    this.availableDialogOpen = false
    // aria2-engine download state (null when on the electron-updater path)
    this.engineTask = null
    // verified engine package awaiting install (survives engineTask reset)
    this.enginePackage = null
    this.pollTimer = null
    this.cleanupUpdateDir()
    this.init()
  }

  init () {
    // Event: error
    // Event: checking-for-update
    // Event: update-available
    // Event: update-not-available
    // Event: download-progress
    // Event: update-downloaded

    this.updater.on('checking-for-update', this.checkingForUpdate.bind(this))
    this.updater.on('update-available', this.updateAvailable.bind(this))
    this.updater.on('update-not-available', this.updateNotAvailable.bind(this))
    this.updater.on('download-progress', this.updateDownloadProgress.bind(this))
    this.updater.on('update-downloaded', this.updateDownloaded.bind(this))
    this.updater.on('update-cancelled', this.updateCancelled.bind(this))
    this.updater.on('error', this.updateError.bind(this))

    if (this.autoCheckData.checkEnable && !this.isChecking) {
      this.autoCheckData.userCheck = false
      // Defer so Application can attach its listeners after this constructor
      // returns; otherwise the synchronous 'checking-for-update' event is missed
      setImmediate(() => {
        this.updater.checkForUpdates()
          .catch((err) => logger.warn('[Super Cat] auto checkForUpdates failed:', err))
      })
    }
  }

  check () {
    this.autoCheckData.userCheck = true
    this.updater.checkForUpdates()
      .catch((err) => logger.warn('[Super Cat] checkForUpdates failed:', err))
  }

  checkingForUpdate () {
    this.isChecking = true
    this.emit('checking')
  }

  /**
   * Native dialogs used to be parentless and could sink behind the main
   * window — the user assumed the update was dead and re-triggered checks
   * (which, pre-single-flight, also stacked downloads). Parenting them to a
   * visible, restored main window keeps them on top of the app.
   */
  parentWindow () {
    const get = this.options.getWindow
    if (!get) {
      return null
    }
    const win = get('index')
    if (!win || win.isDestroyed()) {
      return null
    }
    if (win.isMinimized()) {
      win.restore()
    }
    if (!win.isVisible()) {
      win.show()
    }
    return win
  }

  showMessageBox (opts) {
    const win = this.parentWindow()
    return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
  }

  // electron-updater emits (info) / (error, message) — not Electron's
  // native (event, info) shape. Keep the first argument only.
  updateAvailable (info) {
    this.emit('update-available', info)
    if (this.availableDialogOpen || this.downloading) {
      // one question at a time; a re-fired check must not stack dialogs
      if (this.downloading) {
        this.notifyDownloading()
      }
      return
    }
    if (is.dev() && !TEST_MODE) {
      // Dev verifies the check flow only: a download here would run a real
      // installer over the installed app. Close out like a declined prompt.
      this.isChecking = false
      logger.info(`[Super Cat] update available (dev, download disabled): ${info.version}`)
      this.showMessageBox({
        type: 'info',
        title: this.i18n.t('app.check-for-updates-title'),
        message: this.i18n.t('app.update-available-dev-message', { version: info.version })
      })
      this.emit('update-cancelled', info)
      return
    }
    if (TEST_AUTOYES) {
      this.startDownload(info)
      return
    }
    this.availableDialogOpen = true
    this.showMessageBox({
      type: 'info',
      title: this.i18n.t('app.check-for-updates-title'),
      message: this.i18n.t('app.update-available-message'),
      buttons: [this.i18n.t('app.yes'), this.i18n.t('app.no')],
      cancelId: 1
    }).then(({ response }) => {
      this.availableDialogOpen = false
      if (response === 0) {
        this.startDownload(info)
      } else {
        this.isChecking = false
        this.emit('update-cancelled', info)
      }
    }).catch(() => {
      this.availableDialogOpen = false
    })
  }

  notifyDownloading () {
    logger.info('[Super Cat] duplicate update trigger ignored (download in progress)')
    if (TEST_AUTOYES) {
      return
    }
    this.showMessageBox({
      type: 'info',
      title: this.i18n.t('app.check-for-updates-title'),
      message: this.i18n.t('app.update-downloading-message')
    }).catch(() => { /* dialog dismissed */ })
  }

  startDownload (info) {
    if (this.downloading) {
      this.notifyDownloading()
      return
    }
    const file = (info.files && info.files[0]) || {}
    const fileName = String(file.url || '').split('/').pop() ||
      (info.version ? `Super-Cat-Setup-${info.version}.exe` : '')
    this.downloadMeta = {
      version: info.version || '',
      fileName,
      totalBytes: Number(file.size) || 0
    }
    this.downloading = true
    // The renderer shows this as a task row in the download list
    this.emit('update-download-start', this.downloadMeta)
    this.engineDownload(info, fileName).then((started) => {
      if (!started) {
        this.fallbackDownload()
      }
    })
  }

  updateDir () {
    return join(app.getPath('userData'), 'update')
  }

  /**
   * Multi-segment download through the aria2 engine (16 connections +
   * resume). Returns false when the engine is unavailable or refused the
   * task — caller then falls back to electron-updater's single stream, so a
   * broken engine can never block updating entirely.
   */
  async engineDownload (info, fileName) {
    const file = info.files && info.files[0]
    const ec = this.options.engineClient
    if (!file || !file.sha512 || !ec) {
      return false
    }
    // The update-available payload carries provider-relative urls (e.g. just
    // "Super-Cat-Setup-1.0.8.exe"); aria2 needs the absolute one. The
    // provider's own resolveFiles() is what the updater itself downloads
    // with, so both paths hit the same URL.
    let fileUrl = /^https?:/i.test(file.url || '') ? file.url : null
    if (!fileUrl) {
      try {
        const provider = this.updater.updateInfoAndProvider &&
          this.updater.updateInfoAndProvider.provider
        // resolveFiles() returns [{ url: URL, info }] — an array, not an object
        const resolved = provider && provider.resolveFiles ? provider.resolveFiles(info) : null
        const first = Array.isArray(resolved) ? resolved[0] : null
        const url = first && first.url ? String(first.url) : ''
        if (/^https?:/i.test(url)) {
          fileUrl = url
        }
      } catch (err) {
        logger.warn('[Super Cat] resolving update url failed:', err.message)
      }
    }
    if (!fileUrl) {
      logger.warn('[Super Cat] engine download skipped: could not resolve an absolute update url')
      return false
    }
    try {
      // EngineClient.call swallows RPC errors into undefined — the shape of
      // getVersion's reply is what proves the engine is alive. A launch-time
      // auto-check can race the engine's own startup, so give it a moment
      // (4 × 700ms) before conceding to the single-stream fallback.
      let alive = false
      for (let i = 0; i < 4 && !alive; i++) {
        // eslint-disable-next-line no-await-in-loop
        const version = await ec.call('getVersion')
        alive = !!(version && version.version)
        if (!alive) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 700))
        }
      }
      if (!alive) {
        return false
      }
      const dir = this.updateDir()
      await fsp.mkdir(dir, { recursive: true })
      const gid = await ec.call('addUri', [decodeURIComponent(fileUrl)], {
        dir,
        out: fileName,
        'auto-file-renaming': 'false',
        'allow-overwrite': 'true',
        continue: 'true',
        split: '16',
        'max-connection-per-server': '16',
        'file-allocation': 'none',
        // default is 60s — a crash/exit inside the first minute would lose the
        // resume control file entirely, which is exactly the case this
        // downloader exists to survive
        'auto-save-interval': '1'
      })
      if (!gid || typeof gid !== 'string') {
        return false
      }
      this.engineTask = {
        gid,
        path: join(dir, fileName),
        sha512: file.sha512,
        info
      }
      logger.info(`[Super Cat] update downloading via engine gid=${gid} ${fileName}`)
      this.pollEngine()
      return true
    } catch (err) {
      logger.warn('[Super Cat] engine download unavailable:', err.message)
      return false
    }
  }

  pollEngine () {
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      this.pollEngineOnce().catch((err) => {
        this.engineFailure(err.message || 'engine poll failed')
      })
    }, ENGINE_POLL_MS)
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref()
    }
  }

  stopPolling () {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  async pollEngineOnce () {
    const task = this.engineTask
    if (!task) {
      this.stopPolling()
      return
    }
    const ec = this.options.engineClient
    const st = await ec.call('tellStatus', task.gid,
      ['status', 'totalLength', 'completedLength', 'downloadSpeed'])
    if (!st) {
      // engine vanished mid-download
      this.engineFailure('engine unavailable during download')
      return
    }
    const total = Number(st.totalLength) || 0
    const transferred = Number(st.completedLength) || 0
    this.emit('download-progress', {
      percent: total ? +(transferred / total * 100).toFixed(2) : 0,
      total,
      transferred,
      bytesPerSecond: Number(st.downloadSpeed) || 0,
      ...(this.downloadMeta || {})
    })
    if (st.status === 'complete') {
      this.stopPolling()
      const ok = await this.verifyFile(task.path, task.sha512)
      if (!ok) {
        this.engineFailure('sha512 verification failed')
        await fsp.unlink(task.path).catch(() => undefined)
        return
      }
      await this.engineDownloaded()
    } else if (st.status === 'error' || st.status === 'removed') {
      this.stopPolling()
      await ec.call('removeDownloadResult', task.gid).catch(() => undefined)
      this.engineFailure('engine reported download error')
    }
  }

  verifyFile (path, sha512Base64) {
    return new Promise((_resolve) => {
      const hash = createHash('sha512')
      const stream = createReadStream(path)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => {
        const got = hash.digest('base64')
        _resolve(got === sha512Base64 || got.replace(/=+$/, '') === sha512Base64.replace(/=+$/, ''))
      })
      stream.on('error', () => _resolve(false))
    })
  }

  async engineDownloaded () {
    const task = this.engineTask
    this.engineTask = null
    // install() runs after the engine shutdown and needs the verified path
    this.enginePackage = task && task.path
    this.downloading = false
    this.isChecking = false
    this.downloadMeta = null
    logger.info(`[Super Cat] update downloaded (engine): ${task && task.info && task.info.version}`)
    this.emit('update-downloaded', task && task.info)
    if (TEST_AUTOYES) {
      this.emit('will-updated')
      return
    }
    await this.showMessageBox({
      title: this.i18n.t('app.check-for-updates-title'),
      message: this.i18n.t('app.update-downloaded-message')
    }).catch(() => undefined)
    this.emit('will-updated')
  }

  engineFailure (reason) {
    logger.warn(`[Super Cat] engine update download failed: ${reason}`)
    this.engineTask = null
    // route through updateError so the task row drops and the toast fires
    if (this.downloading) {
      this.updateError(new Error(reason))
    }
  }

  /** electron-updater's own single-stream downloader (fallback path). */
  fallbackDownload () {
    logger.info('[Super Cat] update falling back to electron-updater download')
    this.updater.downloadUpdate()
      .catch((err) => logger.warn('[Super Cat] downloadUpdate failed:', err))
  }

  updateNotAvailable (info) {
    this.isChecking = false
    this.emit('update-not-available', info)
  }

  /**
   * autoUpdater:download-progress
   * @param {Object} event
   * progress,
   * bytesPerSecond,
   * percent,
   * total,
   * transferred
   */
  updateDownloadProgress (event) {
    this.emit('download-progress', { ...event, ...(this.downloadMeta || {}) })
  }

  updateDownloaded (info) {
    this.downloadMeta = null
    this.downloading = false
    this.emit('update-downloaded', info)
    logger.info(`[Super Cat] update downloaded: ${info && info.version}`)
    if (TEST_AUTOYES) {
      this.isChecking = false
      this.emit('will-updated')
      return
    }
    this.showMessageBox({
      title: this.i18n.t('app.check-for-updates-title'),
      message: this.i18n.t('app.update-downloaded-message')
    }).then(_ => {
      this.isChecking = false
      // Installation is driven by the listener (Application) so it can wait
      // for a full engine shutdown first — see install() below
      this.emit('will-updated')
    })
  }

  /**
   * Engine path: the verified package sits in <userData>/update, run it with
   * electron-updater's own NSIS flags (same silent/--updated semantics the
   * updater uses). Fallback path: hand control back to quitAndInstall.
   */
  install () {
    const pkg = this.enginePackage
    if (pkg) {
      this.enginePackage = null
      if (TEST_NO_SPAWN) {
        logger.info(`[Super Cat] TEST install skipped, would spawn: ${pkg}`)
        return
      }
      logger.info(`[Super Cat] installing from engine package: ${pkg}`)
      const child = spawn(pkg, ['--updated'], { detached: true, stdio: 'ignore' })
      child.on('error', (err) => logger.warn('[Super Cat] installer spawn failed:', err.message))
      child.unref()
      app.quit()
      return
    }
    if (TEST_NO_SPAWN) {
      logger.info('[Super Cat] TEST install skipped (fallback path, would quitAndInstall)')
      return
    }
    this.updater.quitAndInstall()
  }

  updateCancelled () {
    this.isChecking = false
    this.downloading = false
    this.downloadMeta = null
    this.stopPolling()
    this.engineTask = null
    this.enginePackage = null
  }

  updateError (error) {
    const wasDownloading = this.downloading
    this.downloading = false
    this.stopPolling()
    this.engineTask = null
    this.enginePackage = null
    this.downloadMeta = null
    this.isChecking = false
    this.emit('update-error', error, wasDownloading)
    const msg = (error == null)
      ? this.i18n.t('app.update-error-message')
      : ((error && error.stack) || error).toString()

    // Failures are log-only: no error dialog after checking for updates.
    // A failed download is exempt — the row disappears from the task list,
    // so it must surface as a toast instead of vanishing silently.
    this.updater.logger.warn(`[Super Cat] update-error: ${msg}`)
  }

  /**
   * A package left in update/ whose version equals the running one was
   * already installed (the installer does not delete its source) — drop the
   * stale copy. Anything newer is kept so aria2 can resume from it.
   */
  async cleanupUpdateDir () {
    try {
      const dir = this.updateDir()
      const files = await fsp.readdir(dir)
      const current = `Super-Cat-Setup-${app.getVersion()}.exe`
      await Promise.all(files
        .filter((f) => f === current || f === `${current}.aria2`)
        .map((f) => fsp.unlink(join(dir, f)).catch(() => undefined)))
    } catch (err) {
      /* dir may not exist yet */
    }
  }
}
