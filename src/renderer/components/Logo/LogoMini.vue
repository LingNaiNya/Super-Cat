<template>
  <h1 class="logo-mini">
    <a target="_blank" rel="noopener noreferrer" href="https://github.com/LingNaiNya/Super-Cat">
      <img :src="require('@/assets/super-cat.png')" alt="Super Cat" width="32" height="32" />
    </a>
  </h1>
</template>

<script>
  export default {
    name: 'mo-logo-mini'
  }
</script>

<style lang="scss">
.logo-mini {
  margin: 0;
  padding: 0;
  width: 100%;
  > a {
    display: block;
    width: 36px;
    height: 36px;
    text-align: center;
    font-size: 0;
    outline: none;
    padding: 2px;
    margin: 0 auto;
    img {
      display: block;
      width: 32px;
      height: 32px;
      object-fit: contain;
    }
  }
}
</style>
