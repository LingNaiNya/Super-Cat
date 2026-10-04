<template>
  <div class="mo-history-directory">
    <el-popover
      popper-class="mo-directory-popper"
      trigger="hover"
      :placement="placement"
      :width="width"
    >
      <el-empty class="mo-directory-empty" :image-size="48" v-if="empty" />
      <ul class="mo-directory-list" v-if="favoriteDirectories.length > 0">
        <li
          v-for="directory in favoriteDirectories"
          :key="directory"
          @click.stop="() => handleSelectItem(directory)"
        >
          <span class="mo-directory-path" :title="directory">{{directory}}</span>
          <span class="mo-directory-actions">
            <i
              class="el-icon-star-off icon-history-favorited"
              @click.stop="() => handleCancelFavoriteItem(directory)"
            />
            <i
              class="el-icon-delete icon-history-remove"
              @click.stop="() => handleRemoveItem(directory)"
            />
          </span>
        </li>
      </ul>
      <div class="mo-directory-divider" v-if="showDivider" />
      <ul class="mo-directory-list" v-if="historyDirectories.length > 0">
        <li
          v-for="directory in historyDirectories"
          :key="directory"
          @click.stop="() => handleSelectItem(directory)"
        >
          <span class="mo-directory-path" :title="directory">{{directory}}</span>
          <span class="mo-directory-actions">
            <i
              v-if="showFavoriteAction"
              class="el-icon-star-off icon-history-favorite"
              @click.stop="() => handleFavoriteItem(directory)"
            />
            <i
              class="el-icon-delete icon-history-remove"
              @click.stop="() => handleRemoveItem(directory)"
            />
          </span>
        </li>
      </ul>
      <el-button
        slot="reference"
        :disabled="popoverDisabled"
      >
        <i class="el-icon-time" />
      </el-button>
    </el-popover>
  </div>
</template>

<script>
  import { mapState } from 'vuex'
  import { MAX_NUM_OF_DIRECTORIES } from '@shared/constants'
  import { cloneArray } from '@shared/utils'

  export default {
    name: 'mo-history-directory',
    components: {
    },
    props: {
      width: {
        type: Number,
        default: 360
      },
      placement: {
        type: String,
        default: 'bottom-start'
      }
    },
    data () {
      return {
        visible: false
      }
    },
    computed: {
      ...mapState('preference', {
        historyDirectories: state => {
          return cloneArray(state.config.historyDirectories, true)
        },
        favoriteDirectories: state => {
          return cloneArray(state.config.favoriteDirectories, true)
        }
      }),
      empty () {
        const { favoriteDirectories, historyDirectories } = this
        return favoriteDirectories.length + historyDirectories.length === 0
      },
      popoverDisabled () {
        const { favoriteDirectories, historyDirectories } = this
        return favoriteDirectories.length === 0 &&
          historyDirectories.length === 0
      },
      showDivider () {
        const { favoriteDirectories, historyDirectories } = this
        return favoriteDirectories.length > 0 &&
          historyDirectories.length > 0
      },
      showFavoriteAction () {
        const { favoriteDirectories } = this
        return favoriteDirectories.length < MAX_NUM_OF_DIRECTORIES
      }
    },
    methods: {
      handleIconClick () {
        if (this.popoverDisabled) {
          return
        }

        const { visible } = this
        this.visible = !visible
      },
      handleSelectItem (directory) {
        this.$emit('selected', directory.trim())
        this.visible = false
      },
      handleFavoriteItem (directory) {
        console.log('handleFavoriteItem==>', directory)
        this.$store.dispatch('preference/favoriteDirectory', directory)
      },
      handleCancelFavoriteItem (directory) {
        console.log('handleCancelFavoriteItem==>', directory)
        this.$store.dispatch('preference/cancelFavoriteDirectory', directory)
      },
      handleRemoveItem (directory) {
        console.log('handleRemoveItem==>', directory)
        this.$store.dispatch('preference/removeDirectory', directory)
      }
    }
  }
</script>

<style lang="scss">
.el-popover.mo-directory-popper {
  padding: $--popover-padding 0;
}

.el-empty.mo-directory-empty {
  padding: 20px 0;
}

.mo-directory-divider {
  padding: 0 $--popover-padding;
  margin: 6px 0;
  &::after {
    content: ' ';
    display: block;
    height: 1px;
    width: 100%;
    background: var(--mo-glass-border);
  }
}

.mo-directory-list {
  padding: 0;
  margin: 0;
  list-style: none;
  &> li {
    display: flex;
    align-items: center;
    list-style: none;
    line-height: $--font-line-height-primary;
    /* The rows float inside the glass popover, so they need the row radius
       and a hair of horizontal margin to read as list rows. */
    margin: 2px 6px;
    border-radius: $mo-radius-md;
    font-size: $--font-size-small;
    color: var(--mo-text-regular);
    cursor: pointer;
    outline: none;
    padding: 6px 6px 6px $--popover-padding;
    transition: $mo-transition-base;
    &:focus, &:hover {
      background-color: var(--mo-glass-background-hover);
      color: var(--mo-primary);
      transform: translateY(-1px);
    }
    &:active {
      transform: translateY(0) scale($mo-press-scale);
    }
  }
  .mo-directory-path {
    display: inline-block;
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .mo-directory-actions {
    min-width: 40px;
    text-align: right;
    &> i {
      padding: 3px;
      margin-right: 3px;
      display: inline-block;
      border-radius: $mo-radius-pill;
      transition: $mo-transition-fast;
      &:active {
        transform: scale($mo-press-scale);
      }
    }
  }
  .icon-history-favorite {
    &:focus, &:hover {
      color: var(--mo-accent-amber);
    }
  }
  .icon-history-favorited {
    color: var(--mo-accent-amber);
  }
  .icon-history-remove {
    &:focus, &:hover {
      color: $--color-danger;
    }
  }
}

.theme-dark {
  .mo-directory-divider {
    &::after {
      background: $--dk-border-color-base;
    }
  }
  .mo-directory-list {
    &> li {
      color: $--dk-font-color-base;
      &:focus, &:hover {
        background-color: $--color-primary;
        color: $--color-white;
      }
    }
  }
}
</style>
