<template>
  <el-container class="main panel" direction="horizontal">
    <el-aside width="200px" class="subnav hidden-xs-only">
      <router-view name="subnav" />
    </el-aside>
    <router-view name="form" />
  </el-container>
</template>

<script>
  export default {
    name: 'mo-content-preference',
    created () {
      this.$store.dispatch('preference/fetchPreference')
    }
  }
</script>

<style lang="scss">
.form-preference {
  padding: 16px 7% 64px 16px;

  /* Every preference control shares the same radius, motion and focus
     language as the rest of the app. The dark theme keeps overriding the
     resting background of these inputs from Theme/Dark.scss. */
  .el-input__inner,
  .el-textarea__inner {
    border-radius: $mo-radius-sm;
    transition: $mo-transition-base;
    &:hover {
      border-color: rgba(var(--mo-primary-rgb), 0.55);
    }
    &:focus {
      border-color: rgba(var(--mo-primary-rgb), 0.55);
      box-shadow: 0 0 0 3px var(--mo-focus-ring);
    }
  }
  .el-switch__label {
    font-weight: normal;
    color: var(--mo-text-regular);
    &.is-active {
      color: var(--mo-text-regular);
    }
  }
  .el-checkbox__input.is-checked + .el-checkbox__label {
    color: var(--mo-text-regular);
  }
  .el-form-item {
    a {
      color: var(--mo-text-regular);
      text-decoration: none;
      border-radius: $mo-radius-xs;
      transition: $mo-transition-fast;
      &:hover {
        color: var(--mo-primary);
        text-decoration: underline;
      }
      &:active {
        color: var(--mo-primary);
      }
    }
  }
  .el-form-item.el-form-item--mini {
    margin-bottom: 32px;
  }
  .el-form-item__content {
    color: var(--mo-text-regular);
  }
  .form-item-sub {
    margin-bottom: 8px;
    transition: $mo-transition-base;
    &:last-of-type {
      margin-bottom: 0;
    }
  }
}
.form-actions {
  /* Sticky action bar: mo-glass-chrome() switches the surface to relative,
     so the sticky positioning has to be declared after it. */
  @include mo-glass-chrome($mo-blur-md, 0);
  position: sticky;
  bottom: 0;
  left: auto;
  z-index: 10;
  width: -webkit-fill-available;
  box-sizing: border-box;
  padding: 24px 16px;
  border-top: 1px solid var(--mo-glass-border);
}
/* The bar only exists while the form is dirty: it rises from under the
   bottom edge on the first edit and sinks back once changes are saved or
   discarded. */
.mo-actions-pop-enter-active,
.mo-actions-pop-leave-active {
  transition: transform $mo-duration-base $mo-ease-emphasized,
    opacity $mo-duration-fast $mo-ease-standard;
}
.mo-actions-pop-enter,
.mo-actions-pop-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
.action-link {
  /* Inline block so the press feedback below can actually transform it */
  display: inline-block;
  cursor: pointer;
  color: var(--mo-primary);
  border-radius: $mo-radius-xs;
  transition: $mo-transition-fast;
  &:hover {
    text-decoration: underline;
  }
  &:active {
    transform: scale($mo-press-scale);
  }
}
</style>
