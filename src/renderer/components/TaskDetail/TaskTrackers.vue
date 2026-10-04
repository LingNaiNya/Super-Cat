<template>
  <el-form
    ref="form"
    :model="form"
    :label-width="formLabelWidth"
    v-if="task"
  >
    <div
      class="tracker-list"
      v-if="announceList"
    >
      <el-input
        readonly
        autosize
        type="textarea"
        auto-complete="off"
        v-model="announceList">
      </el-input>
    </div>
  </el-form>
</template>

<script>
  import is from 'electron-is'
  import {
    calcFormLabelWidth,
    checkTaskIsBT,
    checkTaskIsSeeder
  } from '@shared/utils'
  import { convertTrackerDataToLine } from '@shared/utils/tracker'
  import { EMPTY_STRING } from '@shared/constants'

  export default {
    name: 'mo-task-trackers',
    props: {
      task: {
        type: Object
      }
    },
    data () {
      const { locale } = this.$store.state.preference.config
      return {
        form: {},
        formLabelWidth: calcFormLabelWidth(locale),
        locale
      }
    },
    computed: {
      isRenderer: () => is.renderer(),
      isBT () {
        return checkTaskIsBT(this.task)
      },
      isSeeder () {
        return checkTaskIsSeeder(this.task)
      },
      announceList () {
        if (!this.isBT) {
          return EMPTY_STRING
        }

        const { bittorrent } = this.task
        const data = bittorrent.announceList.map((i) => i[0])
        return convertTrackerDataToLine(data)
      }
    },
    methods: {
    }
  }
</script>

<style lang="scss">
.tracker-list {
  padding: 0;
  margin: 0;
  font-size: $--font-size-small;

  /* The announce list is read only, but it still shares the hover and focus
     affordance of every other form control in the app. */
  textarea {
    line-height: 2;
    transition: $mo-transition-base;

    &:hover {
      border-color: rgba(var(--mo-primary-rgb), 0.55);
    }

    &:focus {
      border-color: rgba(var(--mo-primary-rgb), 0.55);
      box-shadow: 0 0 0 3px var(--mo-focus-ring);
    }
  }
}
</style>
