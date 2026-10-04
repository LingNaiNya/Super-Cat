<template>
  <el-drawer
    custom-class="panel task-detail-drawer"
    size="61.8%"
    direction="ltr"
    v-if="gid"
    :title="$t('task.task-detail-title')"
    :with-header="true"
    :show-close="true"
    :destroy-on-close="true"
    :visible="visible"
    :before-close="handleClose"
    @closed="handleClosed"
  >
    <el-tabs
      tab-position="top"
      class="task-detail-tab"
      value="general"
      :before-leave="handleTabBeforeLeave"
      @tab-click="handleTabClick"
    >
      <el-tab-pane name="general">
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-info"></i></span>
        <mo-task-general :task="task" />
      </el-tab-pane>
      <el-tab-pane name="activity" lazy>
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-s-grid"></i></span>
        <mo-task-activity ref="taskGraphic" :task="task" />
      </el-tab-pane>
      <el-tab-pane name="trackers" lazy v-if="isBT">
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-discover"></i></span>
        <mo-task-trackers :task="task" />
      </el-tab-pane>
      <el-tab-pane name="peers" lazy v-if="isBT">
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-s-custom"></i></span>
        <mo-task-peers :peers="peers" />
      </el-tab-pane>
      <el-tab-pane name="files" lazy>
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-files"></i></span>
        <mo-task-files
          ref="detailFileList"
          mode="DETAIL"
          :files="fileList"
          @selection-change="handleSelectionChange"
        />
      </el-tab-pane>
    </el-tabs>
    <div class="task-detail-actions">
      <div class="action-wrapper action-wrapper-left" v-if="optionsChanged">
        <el-button @click="resetChanged">
          {{$t('app.reset')}}
        </el-button>
      </div>
      <div class="action-wrapper action-wrapper-center">
        <mo-task-item-actions mode="DETAIL" :task="task" />
      </div>
      <div class="action-wrapper action-wrapper-right" v-if="optionsChanged">
        <el-button type="primary" @click="saveChanged">
          {{$t('app.save')}}
        </el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script>
  import is from 'electron-is'
  import { debounce, merge } from 'lodash'
  import {
    calcFormLabelWidth,
    checkTaskIsBT,
    checkTaskIsSeeder,
    getFileName,
    getFileExtension
  } from '@shared/utils'
  import {
    EMPTY_STRING,
    NONE_SELECTED_FILES,
    SELECTED_ALL_FILES,
    TASK_STATUS
  } from '@shared/constants'
  import TaskItemActions from '@/components/Task/TaskItemActions'
  import TaskGeneral from './TaskGeneral'
  import TaskActivity from './TaskActivity'
  import TaskTrackers from './TaskTrackers'
  import TaskPeers from './TaskPeers'
  import TaskFiles from './TaskFiles'

  const cached = {
    files: []
  }

  export default {
    name: 'mo-task-detail',
    components: {
      [TaskItemActions.name]: TaskItemActions,
      [TaskGeneral.name]: TaskGeneral,
      [TaskActivity.name]: TaskActivity,
      [TaskTrackers.name]: TaskTrackers,
      [TaskPeers.name]: TaskPeers,
      [TaskFiles.name]: TaskFiles
    },
    props: {
      gid: {
        type: String
      },
      task: {
        type: Object
      },
      files: {
        type: Array,
        default: function () {
          return []
        }
      },
      peers: {
        type: Array,
        default: function () {
          return []
        }
      },
      visible: {
        type: Boolean,
        default: false
      }
    },
    data () {
      const { locale } = this.$store.state.preference.config
      return {
        form: {},
        formLabelWidth: calcFormLabelWidth(locale),
        locale,
        activeTab: 'general',
        graphicWidth: 0,
        optionsChanged: false,
        filesSelection: EMPTY_STRING,
        selectionChangedCount: 0
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
      taskStatus () {
        const { task, isSeeder } = this
        if (isSeeder) {
          return TASK_STATUS.SEEDING
        } else {
          return task.status
        }
      },
      fileList () {
        const { files } = this
        const result = files.map((item) => {
          const name = getFileName(item.path)
          const extension = getFileExtension(name)
          return {
            idx: Number(item.index),
            selected: item.selected === 'true',
            path: item.path,
            name,
            extension: `.${extension}`,
            length: parseInt(item.length, 10),
            completedLength: item.completedLength
          }
        })
        merge(cached.files, result)
        return cached.files
      },
      selectedFileList () {
        const { fileList } = this
        const result = fileList.filter((item) => item.selected)

        return result
      }
    },
    mounted () {
      window.addEventListener('resize', this.handleAppResize)
    },
    destroyed () {
      window.removeEventListener('resize', this.handleAppResize)
      document.documentElement.classList.remove('task-detail-open')
      cached.files = []
    },
    watch: {
      gid () {
        cached.files = []
      },
      /* Drives the html flag the left rail layers itself above the drawer
         with (the drawer emerges from beneath the rail), see the style
         block at the bottom of this file. Add on open — but removal is
         deferred to the @closed event: taking the flag away the moment
         visible flips false would drop the rail below the drawer WHILE the
         retract animation is still playing, and the panel would slide out
         OVER the rail instead of shrinking back underneath it. */
      visible: {
        immediate: true,
        handler (visible) {
          if (visible && this.gid) {
            document.documentElement.classList.add('task-detail-open')
          }
        }
      },
      /* The rail paints (and now clicks) above the drawer, so leaving the
         task page — or opening another rail panel — must take the detail
         with it instead of stranding it over the new view. */
      '$route' () {
        if (this.visible) {
          this.$store.dispatch('task/hideTaskDetail')
        }
      },
      '$store.state.app.addTaskVisible' (visible) {
        if (visible) {
          this.$store.dispatch('task/hideTaskDetail')
        }
      },
      '$store.state.app.aboutPanelVisible' (visible) {
        if (visible) {
          this.$store.dispatch('task/hideTaskDetail')
        }
      }
    },
    methods: {
      handleClose (done) {
        window.removeEventListener('resize', this.handleAppResize)
        this.$store.dispatch('task/hideTaskDetail')
      },
      handleClosed (done) {
        // The retract animation has fully played out now — only now is it
        // safe to let the rail fall back below the page.
        document.documentElement.classList.remove('task-detail-open')
        this.$store.dispatch('task/updateCurrentTaskGid', EMPTY_STRING)
        this.$store.dispatch('task/updateCurrentTaskItem', null)
        this.optionsChanged = false
        this.resetFaskFilesSelection()
      },
      handleTabBeforeLeave (activeName, oldActiveName) {
        this.activeTab = activeName
        this.optionsChanged = false
        switch (oldActiveName) {
        case 'peers':
          this.$store.dispatch('task/toggleEnabledFetchPeers', false)
          break
        case 'files':
          this.resetFaskFilesSelection()
          break
        }
      },
      handleTabClick (tab) {
        const { name } = tab
        switch (name) {
        case 'peers':
          this.$store.dispatch('task/toggleEnabledFetchPeers', true)
          break
        case 'files':
          setImmediate(() => {
            this.updateFilesListSelection()
          })
          break
        }
      },
      resetChanged () {
        const { activeTab } = this
        switch (activeTab) {
        case 'files':
          this.resetFaskFilesSelection()
          this.updateFilesListSelection()
          break
        }
        this.optionsChanged = false
      },
      saveChanged () {
        const { activeTab } = this
        switch (activeTab) {
        case 'files':
          this.saveFaskFilesSelection()
          break
        }
        this.optionsChanged = false
      },
      handleAppResize () {
        debounce(() => {
          console.log('resize===>', this.activeTab, this.$refs.taskGraphic)
          if (this.activeTab === 'activity' && this.$refs.taskGraphic) {
            this.$refs.taskGraphic.updateGraphicWidth()
          }
        }, 250)
      },
      updateFilesListSelection () {
        if (!this.$refs.detailFileList) {
          return
        }

        const { selectedFileList } = this
        this.$refs.detailFileList.toggleSelection(selectedFileList)
      },
      handleSelectionChange (val) {
        this.filesSelection = val
        this.selectionChangedCount += 1
        if (this.selectionChangedCount > 1) {
          this.optionsChanged = true
        }
      },
      resetFaskFilesSelection () {
        this.filesSelection = EMPTY_STRING
        this.selectionChangedCount = 0
      },
      saveFaskFilesSelection () {
        const { gid, filesSelection } = this
        if (filesSelection === NONE_SELECTED_FILES) {
          this.$msg.warning(this.$t('task.select-at-least-one'))
          return
        }

        const options = {
          selectFile: filesSelection !== SELECTED_ALL_FILES ? filesSelection : EMPTY_STRING
        }
        this.$store.dispatch('task/changeTaskOption', { gid, options })
      }
    }
  }
</script>

<style lang="scss">
/* The compound selector keeps the drawer surface winning over Element UI's
   own opaque .el-drawer rule whatever order the bundles end up in. */
.el-drawer.task-detail-drawer {
  /* Docked flush to the LEFT window edge (direction="ltr"), so the overlay
     radius stays 0 and only the leading — right — edge keeps a hairline. */
  @include mo-glass-overlay($mo-blur-xl, 0);
  /* The glass mixin injects position: relative, which defeats Element's
     `.el-drawer { position: absolute }` + `.ltr { left: 0 }` anchor — the
     panel would settle in flow instead of on the window edge. Restore it. */
  position: absolute;
  border-width: 0 1px 0 0;
  border-color: var(--mo-glass-border);
  min-width: 478px;
  .el-drawer__header {
    @include mo-glass-chrome($mo-blur-sm, 0);
    /* 40px top inset drops the title row and the close button below the
       fixed window title-bar strip (z-index 5000, 36px tall) — otherwise
       the strip swallows every click meant for the close button.
       94px left inset clears the 78px rail the drawer slides beneath —
       without it the title itself hides under the rail's black bar. */
    padding: 40px 16px 12px 94px;
    margin-bottom: 0;
    border-bottom: 1px solid var(--mo-glass-border);
    color: var(--mo-text-primary);
  }
  .el-drawer__close-btn {
    border-radius: $mo-radius-xs;
    transition: $mo-transition-fast;
    &:hover {
      color: var(--mo-primary);
    }
  }
  .el-drawer__body {
    position: relative;
    overflow: hidden;
  }
  /* Every control inside the drawer shares the app focus language */
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
  .task-detail-actions {
    @include mo-glass-chrome($mo-blur-md, $mo-radius-md);
    /* The mixin switches the surface to relative, sticky is restored here */
    position: sticky;
    left: 0;
    bottom: 1rem;
    z-index: inherit;
    width: 100%;
    text-align: center;
    font-size: 0;
    padding: 4px 12px;
    border: 1px solid var(--mo-glass-border);
    display: flex;
    align-content: space-between;
    justify-content: space-between;
    .task-item-actions {
      display: inline-block;
      &> .task-item-action {
        margin: 0 0.5rem;
      }
    }
  }
  .task-detail-drawer-title {
    &> span, &> ul {
      vertical-align: middle;
    }
  }
  .action-wrapper {
    flex: 1;
  }
  .action-wrapper-left {
    text-align: left;
  }
  .action-wrapper-center {
    padding: 1px 0;
    &> .task-item-actions {
      margin: 0 auto;
    }
  }
  .action-wrapper-right {
    text-align: right;
  }
}

/* With direction="ltr" Element's stock keyframes already do exactly what
   the drawer should: enter travelling left→right from off-screen
   (ltr-drawer-in) and retract back to the left edge on close
   (ltr-drawer-out) — no override needed.

   The left rail (tab bar) paints ABOVE the drawer so the panel emerges
   from beneath it. It stays fully interactive: the component's $route /
   addTask / aboutPanel watchers close the detail when the rail navigates
   or opens another panel. */
.task-detail-open .aside {
  /* el-aside is static by default — z-index needs a positioning context. */
  position: relative;
  z-index: 2020;
}

.task-detail-tab {
  height: 100%;
  /* The bottom padding keeps the scrolling tabs clear of the sticky
     .task-detail-actions bar that floats above them. The left inset (rail
     78px + 16px gap) keeps the first tab icon and the form content out
     from under the rail the drawer is layered beneath. */
  padding: 0.5rem 1.25rem 3.5rem 94px;
  display: flex;
  flex-direction: column;
  /* The icon tabs are small controls sitting on the drawer glass */
  .el-tabs__item {
    border-radius: $mo-radius-sm;
    color: var(--mo-text-secondary);
    transition: $mo-transition-base;
    &:hover {
      color: var(--mo-primary);
    }
    &.is-active {
      color: var(--mo-primary);
      background-color: rgba(var(--mo-primary-rgb), 0.14);
    }
  }
  .task-detail-tab-label {
    padding: 0 0.75rem;
  }
  .el-tabs__content {
    position: relative;
    height: 100%;
  }
  .el-tab-pane {
    overflow-x: hidden;
    overflow-y: auto;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }
}

.tab-panel-actions {
  display: flex;
  justify-content: space-between;
  position: absolute;
  bottom: -28px;
  left: 0;
  width: 100%;
}

/* Element UI appends the modal scrim to <body>, so it can only be themed by a
   global rule. It is made fully transparent on purpose: the depth comes from
   the blur applied to the dialog wrapper below, and dimming the whole window on
   top of that only made the app look like it had switched off.

   The blur deliberately lives on the wrappers rather than on the scrim: the
   scrim is a sibling of the dialog with a lower z-index, so a backdrop-filter
   on it would blur the dialog along with the page behind it. A wrapper is the
   dialog's ancestor, and an ancestor's backdrop-filter never applies to its own
   subtree, so the panel stays sharp. */
div.v-modal {
  background-color: transparent;
  opacity: 0;
}

.el-dialog__wrapper,
.el-message-box__wrapper,
.el-drawer__wrapper {
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(7px);
}
</style>
