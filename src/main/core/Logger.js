import is from 'electron-is'
import logger from 'electron-log'

logger.transports.file.level = is.production() ? 'info' : 'silly'
logger.info('[Super Cat] Logger init')
logger.warn('[Super Cat] Logger init')

export default logger
