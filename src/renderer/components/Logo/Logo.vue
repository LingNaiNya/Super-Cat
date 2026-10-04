<template>
  <div class="logo">
    <a target="_blank" rel="noopener noreferrer" href="https://github.com/LingNaiNya/Super-Cat">
      <img
        :src="require('@/assets/super-cat.png')"
        alt=""
        :style="{ width: width + 'px', height: height + 'px' }"
      />
      <span>Super Cat</span>
    </a>
  </div>
</template>

<script>
  export default {
    name: 'mo-logo',
    props: {
      width: {
        type: Number,
        default: 62
      },
      height: {
        type: Number,
        default: 14
      }
    }
  }
</script>

<style lang="scss">
.logo {
  display: inline-block;
  margin: 0;
  padding: 0;
  /* The panel's .app-version is a flex row: without pinning, the img gets
     stretched to fill it (measured 725x512) and the wordmark wraps below. */
  flex: 0 0 auto;
  > a {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
    outline: none;
    border: none;
    text-align: center;
    font-size: 0;
    color: var(--mo-text-primary);
    text-decoration: none;
    img {
      display: block;
      flex: 0 0 auto;
      object-fit: contain;
    }
    span {
      flex: 0 0 auto;
      white-space: nowrap;
      font-size: 16px;
      font-weight: 600;
      line-height: 1;
      letter-spacing: 0.02em;
      color: var(--mo-text-primary);
    }
  }
}
</style>
