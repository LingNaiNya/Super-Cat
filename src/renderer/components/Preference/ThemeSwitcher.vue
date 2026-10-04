<template>
  <div>
    <ul class="theme-switcher">
      <li
        v-for="item in themeOptions"
        :class="['theme-item', item.className, { active: currentValue === item.value }]"
        :key="item.value"
        @click.prevent="() => handleChange(item.value)"
      >
        <div class="theme-thumb"></div>
        <span>{{ item.text }}</span>
      </li>
    </ul>
  </div>
</template>

<script>
  import { APP_THEME } from '@shared/constants'

  export default {
    name: 'mo-theme-switcher',
    props: {
      value: {
        type: String,
        default: APP_THEME.AUTO
      }
    },
    data () {
      return {
        currentValue: this.value
      }
    },
    computed: {
      themeOptions () {
        return [
          {
            className: 'theme-item-auto',
            value: APP_THEME.AUTO,
            text: this.$t('preferences.theme-auto')
          },
          {
            className: 'theme-item-light',
            value: APP_THEME.LIGHT,
            text: this.$t('preferences.theme-light')
          },
          {
            className: 'theme-item-dark',
            value: APP_THEME.DARK,
            text: this.$t('preferences.theme-dark')
          }
        ]
      }
    },
    watch: {
      /* The switcher keeps its highlight in local state; follow the prop or
         an external reset (save / discard) leaves the old swatch lit and the
         control looks like it picked another theme by itself. */
      value (val) {
        if (val !== this.currentValue) {
          this.currentValue = val
        }
      },
      currentValue (val) {
        this.$emit('change', val)
      }
    },
    methods: {
      handleChange (theme) {
        this.currentValue = theme
      }
    }
  }
</script>

<style lang="scss">
.theme-switcher {
  padding: 0;
  margin: 0;
  font-size: 0;
  line-height: 0;
  .theme-item {
    text-align: center;
    display: inline-block;
    margin: 0 16px 0 0;
    cursor: pointer;
    transition: $mo-transition-base;
    span {
      font-size: 13px;
      line-height: 20px;
      color: var(--mo-text-regular);
      transition: $mo-transition-fast;
    }
    &:hover {
      transform: translateY(-1px);
      .theme-thumb {
        border-color: rgba(var(--mo-primary-rgb), 0.55);
      }
    }
    &:active {
      transform: translateY(0) scale($mo-press-scale);
    }
    &.active {
      .theme-thumb {
        border-color: var(--mo-primary);
        box-shadow: 0 0 0 3px var(--mo-focus-ring);
      }
      span {
        color: var(--mo-primary);
      }
    }
    &.theme-item-auto .theme-thumb {
      background: url('~@/assets/theme-auto@2x.png') center center no-repeat;
      background-size: 68px 44px;
    }
    &.theme-item-light .theme-thumb {
      background: url('~@/assets/theme-light@2x.png') center center no-repeat;
      background-size: 68px 44px;
    }
    &.theme-item-dark .theme-thumb {
      background: url('~@/assets/theme-dark@2x.png') center center no-repeat;
      background-size: 68px 44px;
    }
  }
  .theme-thumb {
    box-sizing: border-box;
    border: 1px solid $--border-color-base;
    border-radius: $mo-radius-sm;
    width: 68px;
    height: 44px;
    margin-bottom: 8px;
    transition: $mo-transition-base;
  }
}
</style>
