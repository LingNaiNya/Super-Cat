<template>
  <div :key="task.gid" class="task-item" v-on:dblclick="onDbClick">
    <div class="task-name" :title="taskFullName">
      <span>{{ taskFullName }}</span>
    </div>
    <mo-task-item-actions mode="LIST" :task="task" />
    <div class="task-progress">
      <mo-task-progress
        :completed="Number(task.completedLength)"
        :total="Number(task.totalLength)"
        :status="taskStatus"
      />
      <mo-task-progress-info :task="task" />
    </div>
  </div>
</template>

<script>
  import { checkTaskIsSeeder, getTaskName } from '@shared/utils'
  import { TASK_STATUS } from '@shared/constants'
  import { openItem, getTaskFullPath } from '@/utils/native'
  import TaskItemActions from './TaskItemActions'
  import TaskProgress from './TaskProgress'
  import TaskProgressInfo from './TaskProgressInfo'

  export default {
    name: 'mo-task-item',
    components: {
      [TaskItemActions.name]: TaskItemActions,
      [TaskProgress.name]: TaskProgress,
      [TaskProgressInfo.name]: TaskProgressInfo
    },
    props: {
      task: {
        type: Object
      }
    },
    computed: {
      taskFullName () {
        return getTaskName(this.task, {
          defaultName: this.$t('task.get-task-name'),
          maxLen: -1
        })
      },
      taskName () {
        return getTaskName(this.task, {
          defaultName: this.$t('task.get-task-name')
        })
      },
      isSeeder () {
        return checkTaskIsSeeder(this.task)
      },
      taskStatus () {
        const { task, isSeeder } = this
        if (isSeeder) {
          return TASK_STATUS.SEEDING
        } else {
          return task.status
        }
      }
    },
    methods: {
      onDbClick () {
        const { status } = this.task
        const { COMPLETE, WAITING, PAUSED } = TASK_STATUS
        if (status === COMPLETE) {
          this.openTask()
        } else if ([WAITING, PAUSED].includes(status) !== -1) {
          this.toggleTask()
        }
      },
      async openTask () {
        const { taskName } = this
        this.$msg.info(this.$t('task.opening-task-message', { taskName }))
        const fullPath = getTaskFullPath(this.task)
        const result = await openItem(fullPath)
        if (result) {
          this.$msg.error(this.$t('task.file-not-exist'))
        }
      },
      toggleTask () {
        this.$store.dispatch('task/toggleTask', this.task)
      }
    }
  }
</script>

<style lang="scss">
.task-item {
  @include mo-glass-surface($mo-blur-md, $mo-radius-lg);
  @include mo-glass-sheen();
  position: relative;
  min-height: 78px;
  padding: 16px 12px;
  margin-bottom: 16px;
  transition: transform $mo-duration-base $mo-ease-emphasized,
    box-shadow $mo-duration-base $mo-ease-standard,
    border-color $mo-duration-base $mo-ease-standard,
    background-color $mo-duration-base $mo-ease-standard;

  /* Brand light on the leading edge, revealed on hover */
  &::after {
    content: '';
    position: absolute;
    left: 0;
    top: 18%;
    bottom: 18%;
    width: 2px;
    border-radius: $mo-radius-pill;
    opacity: 0;
    background-image: linear-gradient(180deg, var(--mo-accent-cyan), var(--mo-primary));
    transition: opacity $mo-duration-fast $mo-ease-standard;
  }

  /* Colour and shadow only: a row that shifts under the cursor makes a long
     list feel restless while the pointer travels down it. */
  &:hover {
    border-color: rgba(var(--mo-primary-rgb), 0.45);
    background-color: var(--mo-glass-background-hover);
    box-shadow: var(--mo-glass-shadow-hover);

    &::after {
      opacity: 1;
    }
  }

  &:active {
    transform: scale(0.998);
  }

  .task-item-actions {
    position: absolute;
    top: 16px;
    right: 12px;
  }
}

.selected .task-item {
  border-color: rgba(var(--mo-primary-rgb), 0.6);
  box-shadow: 0 0 0 1px rgba(var(--mo-primary-rgb), 0.35), var(--mo-glass-shadow);

  &::after {
    opacity: 1;
    transform: scaleY(1);
  }
}

.task-name {
  margin-bottom: 1.5rem;
  margin-right: 200px;
  word-break: break-all;
  min-height: 26px;
  &> span {
    font-size: 14px;
    line-height: 26px;
    color: var(--mo-text-primary);
    overflow : hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
}
</style>
