<template>
  <span class="mo-animated-number">{{ display }}</span>
</template>

<script>
  const DEFAULT_DURATION = 520

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

  export default {
    name: 'mo-animated-number',
    props: {
      value: {
        type: Number,
        default: 0
      },
      duration: {
        type: Number,
        default: DEFAULT_DURATION
      },
      /**
       * Formatter applied to the tweened value, e.g. bytesToSize.
       */
      formatter: {
        type: Function
      },
      /**
       * Number of decimals kept while tweening. Progress style values want
       * more than speed values.
       */
      precision: {
        type: Number,
        default: 2
      }
    },
    data () {
      return {
        current: 0
      }
    },
    computed: {
      display () {
        if (this.formatter) {
          return this.formatter(this.current)
        }
        return this.current
      }
    },
    watch: {
      value: {
        immediate: true,
        handler (value) {
          this.animate(Number(value) || 0)
        }
      }
    },
    beforeDestroy () {
      this.cancel()
    },
    methods: {
      cancel () {
        if (this.frame) {
          window.cancelAnimationFrame(this.frame)
          this.frame = null
        }
      },
      animate (target) {
        if (!window.requestAnimationFrame) {
          this.current = target
          return
        }

        this.cancel()

        const from = this.current
        const distance = target - from
        if (Math.abs(distance) < Math.pow(10, -this.precision)) {
          this.current = target
          return
        }

        const start = window.performance ? window.performance.now() : Date.now()
        const step = (now) => {
          const elapsed = now - start
          const progress = Math.min(1, elapsed / this.duration)
          const next = from + distance * easeOutCubic(progress)

          if (progress >= 1) {
            this.current = target
            this.frame = null
            return
          }

          this.current = next
          this.frame = window.requestAnimationFrame(step)
        }

        this.frame = window.requestAnimationFrame(step)
      }
    }
  }
</script>

<style lang="scss">
.mo-animated-number {
  /* Digits keep a fixed width so tweening never shifts the layout */
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}
</style>
