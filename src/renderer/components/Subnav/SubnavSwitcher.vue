<template>
  <el-dropdown @command="handleRoute" class="subnav-switch" size="medium">
    <h4 class="subnav-title">
      {{ title }}
      <i class="el-icon-arrow-down el-icon--right" />
    </h4>
    <el-dropdown-menu slot="dropdown" class="subnav-switch-dropdown">
      <el-dropdown-item :command="sn.route" v-for="sn in subnavs" :key="sn.key">
        {{ sn.title }}
      </el-dropdown-item>
    </el-dropdown-menu>
  </el-dropdown>
</template>

<script>
  export default {
    name: 'mo-subnav-switcher',
    props: {
      title: {
        type: String
      },
      subnavs: {
        type: Array
      }
    },
    methods: {
      handleRoute (route) {
        this.$router.push({
          path: route
        }).catch(err => {
          console.log(err)
        })
      }
    }
  }
</script>

<style lang='scss'>
.subnav-switch-dropdown {
  /* Theme/Element.scss already glasses .el-dropdown-menu, so this only keeps
     the oversized item typography and its reading colour. */
  & .el-dropdown-menu__item {
    font-size: 16px;
    color: var(--mo-text-regular);
  }
}
.subnav-switch {
  cursor: pointer;
  border-radius: $mo-radius-sm;
  transition: $mo-transition-base;
  & .subnav-title {
    color: var(--mo-text-primary);
    font-size: 16px;
    transition: $mo-transition-fast;
  }
  &:hover .subnav-title {
    color: var(--mo-primary);
  }
  &:active {
    transform: scale($mo-press-scale);
  }
}
.theme-dark {
  .subnav-switch-dropdown {
    /* The glass comes from Theme/Element.scss in both themes, only the text
       colours need a dark override. */
    color: $--dk-subnav-text-color;
    & .el-dropdown-menu__item {
      color: $--dk-subnav-text-color;
      &.selected {
        color: $--color-primary;
      }
      &.hover,
      &:hover {
        background-color: $--color-primary;
        color: $--dk-titlebar-close-active-color;
      }
    }
  }
  & .el-dropdown {
    & .subnav-title {
      color: $--dk-subnav-action-color;
    }
    &:hover .subnav-title {
      color: var(--mo-primary);
    }
  }
}
</style>
