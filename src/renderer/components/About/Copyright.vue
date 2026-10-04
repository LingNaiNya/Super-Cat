<template>
  <!-- Plain flex row instead of the 6/18 grid: the copyright line is wider
       than a quarter of the panel and used to overflow into the link column
       (measured: left column 361px wide overlapping links starting at x361). -->
  <div class="copyright">
    <div class="copyright-left">
      <a target="_blank" rel="noopener noreferrer" href="https://github.com/LingNaiNya/Super-Cat">
        &copy;{{ year }} Super Cat
      </a>
      <span class="based-on">
        &middot;
        <a target="_blank" rel="noopener noreferrer" href="https://github.com/agalwood/Motrix">
          {{ $t('about.based-on') }}
        </a>
      </span>
    </div>
    <div class="copyright-right">
      <a target="_blank" rel="noopener noreferrer" href="https://github.com/LingNaiNya/Super-Cat/blob/main/LICENSE">
        {{ $t('about.license') }}
      </a>
      <a target="_blank" rel="noopener noreferrer" href="https://github.com/LingNaiNya/Super-Cat#readme">
        {{ $t('about.about') }}
      </a>
      <a target="_blank" rel="noopener noreferrer" href="https://github.com/LingNaiNya/Super-Cat/issues">
        {{ $t('about.support') }}
      </a>
      <a target="_blank" rel="noopener noreferrer" href="https://github.com/LingNaiNya/Super-Cat/releases">
        {{ $t('about.release') }}
      </a>
    </div>
  </div>
</template>

<script>
  export default {
    name: 'mo-copyright',
    data () {
      const year = new Date().getFullYear()
      return {
        year
      }
    }
  }
</script>

<style lang="scss">
.copyright {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-size: $--font-size-small;
  a {
    color: var(--mo-text-regular);
    text-decoration: none;
    border-radius: $mo-radius-xs;
    transition: $mo-transition-fast;
    &:hover {
      color: var(--mo-primary);
    }
  }
}
.copyright-left {
  text-align: left;
  .based-on {
    color: var(--mo-text-secondary);
    a {
      margin-left: 0;
      color: var(--mo-text-secondary);
      &:hover {
        color: var(--mo-primary);
      }
    }
  }
}

.copyright-right {
  text-align: right;
  a {
    margin-left: 30px;
  }
}
</style>
