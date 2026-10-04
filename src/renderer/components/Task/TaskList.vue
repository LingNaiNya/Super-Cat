<template>
  <mo-drag-select
    class="task-list"
    v-if="taskList.length > 0"
    attribute="attr"
    @change="handleDragSelectChange"
  >
    <div
      v-for="(item, index) in taskList"
      :key="item.gid"
      :attr="item.gid"
      :class="getItemClass(item)"
      :style="getItemStyle(index)"
    >
      <mo-task-item
        :task="item"
      />
    </div>
  </mo-drag-select>
  <div class="no-task" v-else>
    <div class="no-task-inner">
      {{ $t('task.no-task') }}
    </div>
  </div>
</template>

<script>
  import { mapState } from 'vuex'
  import { cloneDeep } from 'lodash'
  import DragSelect from '@/components/DragSelect/Index'
  import TaskItem from './TaskItem'

  export default {
    name: 'mo-task-list',
    components: {
      [DragSelect.name]: DragSelect,
      [TaskItem.name]: TaskItem
    },
    data () {
      const selectedList = cloneDeep(this.$store.state.task.selectedList) || []
      return {
        selectedList
      }
    },
    computed: {
      ...mapState('task', {
        taskList: state => state.taskList,
        selectedGidList: state => state.selectedGidList
      })
    },
    methods: {
      handleDragSelectChange (selectedList) {
        this.selectedList = selectedList
        this.$store.dispatch('task/selectTasks', cloneDeep(selectedList))
      },
      getItemClass (item) {
        const isSelected = this.selectedList.includes(item.gid)
        return {
          selected: isSelected
        }
      },
      /**
       * Rows fade in one after another when a list opens or the status filter
       * changes. Short delays and a low cap: a long cascade reads as the list
       * being slow rather than as content arriving.
       */
      getItemStyle (index) {
        return {
          '--mo-enter-delay': `${Math.min(index * 22, 180)}ms`
        }
      }
    },
    watch: {
      selectedGidList (newVal) {
        this.selectedList = newVal
      }
    }
  }
</script>

<style lang="scss">
.task-list {
  padding: 16px 16px 64px;
  min-height: 100%;
  box-sizing: border-box;

  /* Task rows enter with the shared gesture, staggered through
     --mo-enter-delay. The drag selection box is skipped, it is injected into
     this container and must not be transformed while the user drags. */
  > div:not([data-drag-box-component]) {
    animation: mo-fade-up $mo-duration-slow $mo-ease-emphasized both;
    animation-delay: var(--mo-enter-delay, 0ms);
  }
}
.no-task {
  display: flex;
  height: 100%;
  text-align: center;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--mo-text-secondary);
  user-select: none;
  animation: mo-fade-up $mo-duration-slow $mo-ease-emphasized both;
}
.no-task-inner {
  width: 100%;
  padding-top: 360px;
  background: transparent url('~@/assets/no-task.svg') top center no-repeat;
}
</style>
