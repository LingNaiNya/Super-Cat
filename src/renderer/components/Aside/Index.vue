<template>
  <el-aside width="78px" :class="['aside', 'hidden-sm-and-down', { 'draggable': asideDraggable }]" :style="vibrancy">
    <div class="aside-inner">
      <mo-logo-mini />

      <!-- The rail is one connected control: the items share edges, and a single
           indicator slides between them. Individual items never move or change
           size, which is what made the old rail flicker while the page beside it
           was transitioning. Tooltips were dropped for the same reason: they
           opened on top of the transition. -->
      <nav class="rail top-rail">
        <span
          v-if="activeIndex.top >= 0"
          class="rail-indicator"
          :style="{ '--rail-offset': activeIndex.top }"
        ></span>
        <button
          v-for="(item, index) in topItems"
          :key="item.key"
          type="button"
          class="rail-item non-draggable"
          :class="{ active: activeIndex.top === index }"
          :aria-label="item.label"
          :aria-current="activeIndex.top === index ? 'page' : null"
          :title="item.label"
          @click="item.action()"
        >
          <mo-icon :name="item.icon" width="20" height="20" />
        </button>
      </nav>

      <!-- Actions, not destinations: creating a task and opening the about panel
           do not change the current page, so they live at the foot of the rail
           where they cannot be mistaken for navigation. -->
      <nav class="rail actions-rail">
        <button
          v-for="item in actionItems"
          :key="item.key"
          type="button"
          class="rail-item non-draggable"
          :aria-label="item.label"
          :title="item.label"
          @click="item.action()"
        >
          <mo-icon :name="item.icon" width="20" height="20" />
        </button>
      </nav>
    </div>
  </el-aside>
</template>

<script>
  import is from 'electron-is'
  import { mapGetters } from 'vuex'
  import { ADD_TASK_TYPE } from '@shared/constants'
  import LogoMini from '@/components/Logo/LogoMini'
  import '@/components/Icons/menu-task'
  import '@/components/Icons/menu-add'
  import '@/components/Icons/menu-dashboard'
  import '@/components/Icons/menu-preference'
  import '@/components/Icons/menu-about'

  export default {
    name: 'mo-aside',
    components: {
      [LogoMini.name]: LogoMini
    },
    computed: {
      ...mapGetters('app', {
        currentPage: 'currentPage'
      }),
      asideDraggable () {
        return is.macOS()
      },
      vibrancy () {
        return is.macOS()
          ? {
            backgroundColor: 'transparent'
          }
          : {}
      },
      /**
       * The rail is described as data so the sliding indicator and the items can
       * never disagree about the order, and so pages are matched by key rather
       * than by comparing route strings in the template.
       */
      topItems () {
        return [
          {
            key: 'task',
            icon: 'menu-task',
            label: this.$t('subnav.task-list'),
            action: () => this.nav('/task')
          },
          {
            key: 'dashboard',
            icon: 'menu-dashboard',
            label: this.$t('subnav.dashboard'),
            action: () => this.nav('/dashboard')
          },
          {
            key: 'preference',
            icon: 'menu-preference',
            label: this.$t('app.preferences'),
            action: () => this.nav('/preference')
          }
        ]
      },
      /**
       * Creating a task and opening the about panel are actions, not
       * destinations: they never become the current page, so they sit in their
       * own group at the foot of the rail.
       */
      actionItems () {
        return [
          {
            key: 'add-task',
            icon: 'menu-add',
            label: this.$t('app.add-task'),
            action: () => this.showAddTask()
          },
          {
            key: 'about',
            icon: 'menu-about',
            label: this.$t('app.about'),
            action: () => this.showAboutPanel()
          }
        ]
      },
      activeIndex () {
        const top = this.topItems.findIndex((item) => item.key === this.currentPage)
        return { top }
      }
    },
    methods: {
      showAddTask (taskType = ADD_TASK_TYPE.URI) {
        this.$store.dispatch('app/showAddTaskDialog', taskType)
      },
      showAboutPanel () {
        this.$store.dispatch('app/showAboutPanel')
      },
      nav (page) {
        this.$router.push({
          path: page
        }).catch(err => {
          console.log(err)
        })
      }
    }
  }
</script>

<style lang="scss">
.aside-inner {
  display: flex;
  height: 100%;
  flex-flow: column;
}

.logo-mini {
  margin-top: 40px;
}

/* One connected control per group: the items share edges and are clipped to a
   single rounded shape, so the group reads as one object rather than as a stack
   of separate buttons. */
.rail {
  position: relative;
  width: 48px;
  margin: 0 auto;
  padding: 5px;
  box-sizing: border-box;
  border-radius: $mo-radius-lg;
  background-color: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.09);
  overflow: hidden;
}

.top-rail {
  margin-top: 28px;
}

/* The actions sit at the foot of the column, pushed down by the free space
   the flex column leaves after the navigation rail. */
.actions-rail {
  margin-top: auto;
  margin-bottom: 28px;
  /* Actions are quieter than destinations: no selected state, softer fill. */
  background-color: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.06);
}

/* A single indicator slides between the items. It sits behind them, so an item
   only ever changes colour, never position or size. The stride is derived from
   the item size and the gap, so the two can be tuned independently. */
.rail-indicator {
  --rail-item-size: 36px;
  --rail-item-gap: 6px;
  position: absolute;
  left: 5px;
  top: 5px;
  width: var(--rail-item-size);
  height: var(--rail-item-size);
  border-radius: $mo-radius-md;
  background-color: rgba(255, 255, 255, 0.16);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  transform: translateY(calc(var(--rail-offset, 0) * (var(--rail-item-size) + var(--rail-item-gap))));
  transition: transform $mo-duration-base $mo-ease-emphasized;
  pointer-events: none;
}

.rail-item {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  margin: 0;
  border: none;
  background: none;
  border-radius: $mo-radius-md;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.72);
  transition: color $mo-duration-fast $mo-ease-standard;

  /* Gap plus item height is the stride the indicator slides by. */
  & + .rail-item {
    margin-top: 6px;
  }

  svg {
    padding: 8px;
    color: inherit;
  }

  &:hover {
    color: #fff;
  }

  /* Same accent language as the tabs and subnavs: the active destination
     picks up the brand primary instead of plain white. */
  &.active {
    color: var(--mo-primary);
  }
}
</style>
