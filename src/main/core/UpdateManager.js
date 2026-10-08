import { EventEmitter } from 'events'
import { resolve } from 'path'
import { dialog } from 'electron'
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

  // electron-updater emits (info) / (error, message) — not Electron's
  // native (event, info) shape. Keep the first argument only.
  updateAvailable (info) {
    this.emit('update-available', info)
    if (is.dev()) {
      // Dev verifies the check flow only: a download here would run a real
      // installer over the installed app. Close out like a declined prompt.
      this.isChecking = false
      logger.info(`[Super Cat] update available (dev, download disabled): ${info.version}`)
      dialog.showMessageBox({
        type: 'info',
        title: this.i18n.t('app.check-for-updates-title'),
        message: this.i18n.t('app.update-available-dev-message', { version: info.version })
      })
      this.emit('update-cancelled', info)
      return
    }
    dialog.showMessageBox({
      type: 'info',
      title: this.i18n.t('app.check-for-updates-title'),
      message: this.i18n.t('app.update-available-message'),
      buttons: [this.i18n.t('app.yes'), this.i18n.t('app.no')],
      cancelId: 1
    }).then(({ response }) => {
      if (response === 0) {
        this.startDownload(info)
      } else {
        this.isChecking = false
        this.emit('update-cancelled', info)
      }
    })
  }

  startDownload (info) {
    const file = (info.files && info.files[0]) || {}
    const fileName = String(file.url || '').split('/').pop() ||
      (info.version ? `Super-Cat-Setup-${info.version}.exe` : '')
    this.downloadMeta = {
      version: info.version || '',
      fileName,
      totalBytes: Number(file.size) || 0
    }
    // The renderer shows this as a task row in the download list
    this.emit('update-download-start', this.downloadMeta)
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
    this.emit('update-downloaded', info)
    logger.info(`[Super Cat] update downloaded: ${info && info.version}`)
    dialog.showMessageBox({
      title: this.i18n.t('app.check-for-updates-title'),
      message: this.i18n.t('app.update-downloaded-message')
    }).then(_ => {
      this.isChecking = false
      // Installation is driven by the listener (Application) so it can wait
      // for a full engine shutdown first — see install() below
      this.emit('will-updated')
    })
  }

  install () {
    this.updater.quitAndInstall()
  }

  updateCancelled () {
    this.isChecking = false
    this.downloadMeta = null
  }

  updateError (error) {
    const wasDownloading = !!this.downloadMeta
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
}
