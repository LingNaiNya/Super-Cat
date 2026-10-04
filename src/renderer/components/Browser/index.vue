<template>
  <div ref="webviewViewport" class="webview-viewport">
    <iframe
      class="mo-webview"
      ref="iframe"
      :src="src"
    ></iframe>
  </div>
</template>

<script>
  import is from 'electron-is'
  import { webContents } from '@electron/remote'
  import { Loading } from 'element-ui'

  export default {
    name: 'mo-browser',
    components: {
    },
    props: {
      src: {
        type: String,
        default: ''
      }
    },
    data () {
      return {
        loading: null
      }
    },
    computed: {
      isRenderer: () => is.renderer()
    },
    mounted () {
      const { iframe } = this.$refs

      iframe.addEventListener('did-start-loading', this.loadStart.bind(this))
      iframe.addEventListener('did-stop-loading', this.loadStop.bind(this))
      iframe.addEventListener('dom-ready', this.ready.bind(this))
    },
    methods: {
      loadStart () {
        const { webviewViewport } = this.$refs
        this.loading = Loading.service({
          target: webviewViewport
        })
      },
      loadStop () {
        this.$nextTick(() => {
          this.loading.close()
        })
      },
      ready () {
        const { iframe } = this.$refs

        const wc = webContents.fromId(iframe.getWebContentsId())
        wc.setWindowOpenHandler((event, url) => {
          event.preventDefault()
          this.$electron.ipcRenderer.send('command', 'application:open-external', url)
        })
      }
    }
  }
</script>

<style lang="scss">
.webview-viewport {
  position: relative;
  /* The embedded page is a surface of its own: the radius keeps it inside
     the panel, the hairline separates it from the glass behind it, and the
     clipping is what makes the radius visible on the iframe corners. */
  border-radius: $mo-radius-md;
  border: 1px solid var(--mo-glass-border);
  overflow: hidden;
}
.mo-webview {
  display: inline-flex;
  flex: 1;
  flex-basis: auto;
  /* A host may not clip its children, so the frame carries the radius too */
  border-radius: inherit;
}
</style>
