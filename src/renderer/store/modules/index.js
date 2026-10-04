/**
 * The file enables `@/store/index.js` to import all vuex modules
 * in a one-shot manner. It also lists the modules that must be registered
 * explicitly, because `require.context` only sees the files placed directly
 * inside this folder.
 */

import dashboard from './dashboard'

const files = require.context('.', false, /\.js$/)
const modules = {
  dashboard
}

files.keys().forEach(key => {
  if (key === './index.js' || key === './dashboard.js') return
  modules[key.replace(/(\.\/|\.js)/g, '')] = files(key).default
})

export default modules
