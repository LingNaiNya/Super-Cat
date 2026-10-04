<template>
  <div class="mo-donut" :class="{ empty: isPristine }">
    <svg class="donut-svg" viewBox="0 0 42 42" role="presentation">
      <circle
        class="donut-track"
        cx="21"
        cy="21"
        :r="radius"
        :stroke-width="strokeWidth"
      />
      <circle
        v-for="segment in resolved"
        :key="segment.key"
        class="donut-segment"
        cx="21"
        cy="21"
        :r="radius"
        :stroke-width="strokeWidth"
        :stroke="segment.color"
        :style="segment.style"
      />
    </svg>
    <div class="donut-center">
      <strong>{{ total }}</strong>
      <span>{{ caption }}</span>
    </div>
  </div>
</template>

<script>
  export default {
    name: 'mo-donut-chart',
    props: {
      segments: {
        type: Array,
        default: () => []
      },
      caption: {
        type: String,
        default: ''
      }
    },
    data () {
      return {
        // 2 * PI * r evaluates to 100, so dash values can be percentages
        radius: 15.9155,
        strokeWidth: 3.6
      }
    },
    computed: {
      total () {
        return this.segments.reduce((sum, segment) => sum + (Number(segment.value) || 0), 0)
      },
      isPristine () {
        return this.total <= 0
      },
      resolved () {
        const { total, isPristine } = this
        let offset = 0

        return this.segments
          .map((segment) => {
            const value = Number(segment.value) || 0
            const ratio = isPristine ? 0 : value / total
            const result = {
              key: segment.key,
              color: segment.color,
              ratio,
              offset,
              value
            }
            offset += ratio * 100
            return result
          })
          .filter((segment) => segment.value > 0)
          .map((segment) => {
            return {
              ...segment,
              style: {
                strokeDasharray: `${(segment.ratio * 100).toFixed(3)} ${(100 - segment.ratio * 100).toFixed(3)}`,
                strokeDashoffset: (-segment.offset).toFixed(3)
              }
            }
          })
      }
    }
  }
</script>

<style lang="scss">
.mo-donut {
  position: relative;
  width: 128px;
  height: 128px;
  margin: 0 auto;

  .donut-svg {
    display: block;
    width: 100%;
    height: 100%;
    /* start the first segment at 12 o'clock */
    transform: rotate(-90deg);
  }

  .donut-track {
    fill: none;
    /* Text colour, not the translucent glass border: the latter is white on a
       white card and the empty dial would disappear. */
    stroke: var(--mo-text-secondary);
    opacity: 0.22;
  }

  .donut-segment {
    fill: none;
    stroke-linecap: round;
    transition: stroke-dasharray $mo-duration-slow $mo-ease-emphasized,
      stroke-dashoffset $mo-duration-slow $mo-ease-emphasized,
      stroke $mo-duration-base $mo-ease-standard;
  }

  .donut-center {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    pointer-events: none;

    strong {
      font-size: 26px;
      font-weight: 600;
      line-height: 1;
      color: var(--mo-text-primary);
      font-variant-numeric: tabular-nums;
    }

    span {
      margin-top: 4px;
      font-size: 11px;
      color: var(--mo-text-secondary);
    }
  }

  &.empty .donut-center strong {
    opacity: 0.5;
  }
}
</style>
