<template>
  <el-container class="main panel" direction="vertical">
    <el-header
      class="panel-header p2p-header"
      height="84"
    >
      <h4 class="p2p-heading">{{ $t('p2p.title') }}</h4>
      <div class="p2p-header-actions">
        <el-tag
          v-if="statusTag"
          size="small"
          :type="statusTag.type"
        >{{ statusTag.text }}</el-tag>
      </div>
    </el-header>

    <el-main class="panel-content p2p-content">
      <!-- 页面内缩落在这里（同 .task-list / .form-preference 的惯例），
           不能写在 el-main 上：主题的 .panel-content 清零规则会把它吃掉。 -->
      <div class="p2p-body">
        <div
          v-if="!loaded"
          class="p2p-loading"
        >
          {{ $t('p2p.loading') }}
        </div>

        <template v-else>
          <div
            v-if="lastError"
            class="p2p-alert error"
          >
            <span>{{ lastError.message }}</span>
            <el-button
              size="mini"
              round
              @click="onResetError"
            >{{ $t('p2p.dismiss') }}</el-button>
          </div>

          <div
            v-if="endpointWarningText"
            class="p2p-alert warn"
          >
            {{ endpointWarningText }}
          </div>

          <!-- 未入群：创建 / 加入 -->
          <div
            v-if="!inGroup"
            class="p2p-onboard"
          >
            <section class="p2p-card">
              <h5>{{ $t('p2p.create-title') }}</h5>
              <p class="p2p-desc">{{ $t('p2p.create-desc') }}</p>
              <el-input
                v-model="createForm.name"
                size="small"
                :placeholder="$t('p2p.group-name-ph')"
              />
              <el-button
                type="primary"
                size="small"
                :loading="busy === 'create'"
                @click="onCreate"
              >{{ $t('p2p.create-action') }}</el-button>
            </section>

            <section class="p2p-card">
              <h5>{{ $t('p2p.join-title') }}</h5>
              <p class="p2p-desc">{{ $t('p2p.join-desc') }}</p>
              <el-input
                v-model="joinForm.code"
                type="textarea"
                :rows="3"
                :placeholder="$t('p2p.code-ph')"
              />
              <el-button
                type="primary"
                size="small"
                :loading="busy === 'join'"
                @click="onJoin"
              >{{ $t('p2p.join-action') }}</el-button>
            </section>
          </div>

          <!-- 等待审批 -->
          <div
            v-else-if="status === 'joining'"
            class="p2p-card p2p-joining"
          >
            <h5>{{ $t('p2p.joining-title') }}</h5>
            <p class="p2p-desc">{{ $t('p2p.joining-desc') }}</p>
            <i class="el-icon-loading" />
          </div>

          <!-- 已入群 -->
          <div
            v-else
            class="p2p-group"
          >
            <section class="p2p-card p2p-info">
              <div class="p2p-card-head">
                <h5>{{ isOwner ? $t('p2p.invite-title') : $t('p2p.my-info-title') }}</h5>
                <div class="p2p-info-side">
                  <span
                    v-if="groupName || members.length"
                    class="p2p-desc p2p-group-badge"
                  >{{ groupName }} · {{ $t('p2p.group-meta', { count: members.length }) }}</span>
                  <el-button
                    v-if="isOwner"
                    size="mini"
                    round
                    @click="onResetCode"
                  >{{ $t('p2p.invite-reset') }}</el-button>
                </div>
              </div>
              <div
                v-if="isOwner"
                class="p2p-code"
                :title="$t('p2p.invite-copy-hint')"
                @click="copyText(group.codeText, 'p2p.code-copied')"
              >
                {{ group.codeText || '—' }}
              </div>
              <p
                v-if="isOwner"
                class="p2p-desc"
              >
                {{ $t('p2p.invite-meta', { addr: endpointText, source: sourceText }) }}
              </p>
              <div
                class="p2p-section"
                :class="{ 'is-first': !isOwner }"
              >
                <div class="p2p-vip-line">
                  <span class="p2p-field-label">{{ $t('p2p.vip-title') }}</span>
                  <span
                    class="p2p-vip"
                    :title="$t('p2p.vip-copy')"
                    @click.stop="copyText(selfVip, 'p2p.vip-copy')"
                  >{{ selfVip || $t('p2p.vip-none') }}</span>
                </div>
                <p class="p2p-desc">{{ $t('p2p.vip-desc') }}</p>
                <p class="p2p-desc conflict-text">{{ $t('p2p.ping-warning') }}</p>
              </div>
            </section>

            <section class="p2p-card">
              <div class="p2p-card-head">
                <h5>{{ $t('p2p.members-title') }}</h5>
              </div>

              <div
                v-for="p in pending"
                :key="`pending-${p.fp}`"
                class="p2p-row pending"
              >
                <div class="p2p-cell p2p-cell-name">
                  <span class="p2p-name">{{ $t('p2p.pending-name') }}</span>
                </div>
                <!-- 申请还没分到 HL 号，只能靠指纹区分多个申请人 -->
                <div class="p2p-cell p2p-cell-fp">
                  <span class="p2p-fp">{{ p.fp }}</span>
                </div>
                <div class="p2p-cell p2p-cell-status">
                  <el-tag size="mini">{{ $t('p2p.pending-tag') }}</el-tag>
                </div>
                <div class="p2p-cell p2p-cell-actions p2p-row-actions">
                  <el-button
                    type="primary"
                    size="mini"
                    @click="onApprove(p.fp)"
                  >{{ $t('p2p.approve') }}</el-button>
                  <el-button
                    size="mini"
                    @click="onReject(p.fp)"
                  >{{ $t('p2p.reject') }}</el-button>
                </div>
              </div>

              <div
                v-for="m in members"
                :key="m.fp"
                class="p2p-row"
                :class="{ 'is-self': m.isSelf }"
                :title="rowTitle(m)"
              >
                <div class="p2p-cell p2p-cell-name">
                  <span class="p2p-name">{{ m.name }}</span>
                  <el-tag
                    v-if="m.isOwnerRow"
                    size="mini"
                    type="warning"
                  >{{ $t('p2p.owner-tag') }}</el-tag>
                  <el-tag
                    v-if="m.isSelf"
                    size="mini"
                    type="info"
                  >{{ $t('p2p.self-tag') }}</el-tag>
                </div>
                <div
                  v-if="m.vip"
                  class="p2p-cell p2p-cell-vip"
                >
                  <span
                    class="p2p-vip"
                    :title="$t('p2p.vip-copy')"
                    @click.stop="copyText(m.vip, 'p2p.vip-copy')"
                  >{{ m.vip }}</span>
                </div>
                <div class="p2p-cell p2p-cell-status">
                  <span
                    class="p2p-dot"
                    :class="{ 'is-online': m.online }"
                  />
                  <span class="p2p-status-text">{{ m.online ? $t('p2p.online') : $t('p2p.offline') }}</span>
                </div>
                <div
                  v-if="!m.isSelf"
                  class="p2p-cell p2p-cell-stats"
                >
                  <span
                    class="p2p-latency"
                    :class="latencyClass(m)"
                  >{{ latencyText(m) }}</span>
                  <span
                    v-if="speedText(m)"
                    class="p2p-speed"
                    :class="{ stale: speedStale(m) }"
                    :title="$t('p2p.speed-hint')"
                  >{{ speedText(m) }}</span>
                </div>
                <div
                  v-if="!m.isSelf"
                  class="p2p-cell p2p-cell-actions p2p-row-actions"
                >
                  <el-button
                    size="mini"
                    round
                    :loading="speedBusy === m.fp"
                    @click="onSpeedTest(m)"
                  >{{ $t('p2p.speed-test') }}</el-button>
                  <el-button
                    size="mini"
                    round
                    @click="openPush(m)"
                  >{{ $t('p2p.push') }}</el-button>
                  <el-button
                    v-if="isOwner"
                    size="mini"
                    round
                    type="danger"
                    plain
                    @click="onKick(m)"
                  >{{ $t('p2p.kick') }}</el-button>
                </div>
              </div>
            </section>

            <section class="p2p-card">
              <h5>{{ $t('p2p.settings-title') }}</h5>

              <div class="p2p-field">
                <span class="p2p-field-label">{{ $t('p2p.open-ports') }}</span>
                <el-checkbox-group
                  v-model="checkedPorts"
                  @change="onSavePorts"
                >
                  <el-checkbox :label="16800">{{ $t('p2p.aria2-port') }}</el-checkbox>
                </el-checkbox-group>
                <div class="p2p-port-tags">
                  <el-tag
                    v-for="p in customPorts"
                    :key="`port-${p}`"
                    size="small"
                    closable
                    @close="removePort(p)"
                  >{{ p }}</el-tag>
                  <el-input
                    v-model="customPortInput"
                    size="mini"
                    class="p2p-port-input"
                    :placeholder="$t('p2p.custom-port-ph')"
                    @keyup.enter.native="addPort"
                  />
                  <el-button
                    size="mini"
                    @click="addPort"
                  >{{ $t('p2p.add-port') }}</el-button>
                </div>
                <p class="p2p-desc">{{ $t('p2p.open-ports-desc') }}</p>
              </div>

              <div class="p2p-field p2p-field-row">
                <span class="p2p-field-label">{{ $t('p2p.receive-push') }}</span>
                <el-switch
                  v-model="receivePush"
                  @change="onSaveReceivePush"
                />
              </div>

              <div class="p2p-field p2p-field-row">
                <span class="p2p-field-label">{{ $t('p2p.forward-switch') }}</span>
                <el-switch
                  v-model="vipForward"
                  @change="onSaveVipForward"
                />
                <p class="p2p-desc">{{ $t('p2p.forward-status', { count: forwardCount }) }}</p>
                <p
                  v-for="c in forwardConflicts"
                  :key="`conflict-${c.vip}-${c.port}`"
                  class="p2p-desc conflict-text"
                >{{ $t('p2p.forward-conflict', { port: c.port }) }}</p>
                <p class="p2p-desc">{{ punchText }}</p>
                <p class="p2p-desc">{{ $t('p2p.mc-hint') }}</p>
              </div>
            </section>

            <div class="p2p-danger">
              <el-button
                size="small"
                type="danger"
                plain
                @click="onLeave"
              >{{ leaveLabel }}</el-button>
            </div>
          </div>
        </template>
      </div>

      <el-dialog
        :title="$t('p2p.push-title')"
        :visible.sync="pushVisible"
        width="440px"
        append-to-body
      >
        <p class="p2p-desc">{{ $t('p2p.push-target', { name: pushTargetName }) }}</p>
        <el-input
          v-model="pushUrls"
          type="textarea"
          :rows="4"
          :placeholder="$t('p2p.push-ph')"
        />
        <span
          slot="footer"
          class="dialog-footer"
        >
          <el-button
            size="small"
            @click="pushVisible = false"
          >{{ $t('p2p.cancel') }}</el-button>
          <el-button
            type="primary"
            size="small"
            :loading="busy === 'push'"
            @click="onPush"
          >{{ $t('p2p.push-send') }}</el-button>
        </span>
      </el-dialog>
    </el-main>
  </el-container>
</template>

<script>
  import { clipboard } from 'electron'
  import { mapState } from 'vuex'
  import { Message } from 'element-ui'

  export default {
    name: 'mo-content-p2p',
    data () {
      return {
        busy: '',
        speedBusy: '',
        createForm: { name: '' },
        joinForm: { code: '' },
        checkedPorts: [],
        customPortInput: '',
        receivePush: true,
        vipForward: true,
        pushVisible: false,
        pushTargetFp: '',
        pushTargetName: '',
        pushUrls: ''
      }
    },
    computed: {
      ...mapState('p2p', [
        'loaded',
        'status',
        'role',
        'enabled',
        'self',
        'group',
        'endpoint',
        'members',
        'pending',
        'links',
        'speed',
        'settings',
        'lastError',
        'forward',
        'punch'
      ]),
      inGroup () {
        return !!this.group.gid && (this.role === 'owner' || this.role === 'member') &&
          this.status !== 'rejected' && this.status !== 'kicked'
      },
      isOwner () {
        return this.role === 'owner'
      },
      groupName () {
        return this.group.name || ''
      },
      statusTag () {
        const map = {
          idle: { type: 'info', text: this.$t('p2p.status-idle') },
          starting: { type: 'info', text: this.$t('p2p.status-starting') },
          joining: { type: 'warning', text: this.$t('p2p.status-joining') },
          joined: { type: 'success', text: this.isOwner ? this.$t('p2p.status-owner') : this.$t('p2p.status-joined') },
          rejected: { type: 'danger', text: this.$t('p2p.status-rejected') },
          kicked: { type: 'danger', text: this.$t('p2p.status-kicked') },
          error: { type: 'danger', text: this.$t('p2p.status-error') }
        }
        return map[this.status] || null
      },
      endpointText () {
        if (!this.endpoint.h) {
          return this.$t('p2p.no-endpoint')
        }
        return `${this.endpoint.h}:${this.endpoint.listenPort}`
      },
      sourceText () {
        const map = {
          upnp: this.$t('p2p.source-upnp'),
          stun: this.$t('p2p.source-stun'),
          lan: this.$t('p2p.source-lan'),
          manual: this.$t('p2p.source-manual'),
          none: this.$t('p2p.source-none')
        }
        return map[this.endpoint.source] || this.endpoint.source || ''
      },
      endpointWarningText () {
        if (!this.inGroup && this.status !== 'joining') {
          return ''
        }
        if (this.endpoint.warning === 'unreachable') {
          return this.$t('p2p.warn-unreachable')
        }
        if (this.endpoint.warning === 'lan-only' || this.endpoint.lanOnly) {
          return this.$t('p2p.warn-lan')
        }
        if (this.endpoint.warning === 'unmapped' || (this.isOwner && !this.endpoint.mapped)) {
          return this.$t('p2p.warn-unmapped')
        }
        return ''
      },
      customPorts () {
        return (this.settings.openPorts || []).filter((p) => p !== 16800)
      },
      leaveLabel () {
        return this.isOwner ? this.$t('p2p.dissolve') : this.$t('p2p.leave')
      },
      selfVip () {
        return (this.self && this.self.vip) || ''
      },
      forwardCount () {
        return (this.forward && this.forward.listeners) || 0
      },
      forwardConflicts () {
        return (this.forward && this.forward.conflicts) || []
      },
      punchText () {
        const p = this.punch
        if (!p || !p.last) {
          return `${this.$t('p2p.punch-label')}: ${this.$t('p2p.punch-none')}`
        }
        const result = p.last === 'ok'
          ? this.$t('p2p.punch-ok')
          : this.$t('p2p.punch-fail')
        return `${this.$t('p2p.punch-label')}: ${result}`
      }
    },
    watch: {
      'settings.openPorts': {
        immediate: true,
        handler (ports) {
          this.checkedPorts = (ports || []).filter((p) => p === 16800)
        }
      },
      'settings.receiveTaskPush': {
        immediate: true,
        handler (val) {
          this.receivePush = !!val
        }
      },
      'settings.vipForward': {
        immediate: true,
        handler (val) {
          this.vipForward = val !== false
        }
      }
    },
    created () {
      this.$store.dispatch('p2p/fetchState')
    },
    methods: {
      copyText (text, key) {
        if (!text) {
          return
        }
        clipboard.writeText(String(text))
        Message.success(this.$t(key))
      },
      async onCreate () {
        this.busy = 'create'
        try {
          const resp = await this.$store.dispatch('p2p/createGroup', {
            name: this.createForm.name
          })
          if (resp.ok) {
            Message.success(this.$t('p2p.created'))
          } else {
            Message.error(resp.error)
          }
        } finally {
          this.busy = ''
        }
      },
      async onJoin () {
        if (!this.joinForm.code || !this.joinForm.code.trim()) {
          Message.warning(this.$t('p2p.code-required'))
          return
        }
        this.busy = 'join'
        try {
          const resp = await this.$store.dispatch('p2p/joinGroup', {
            code: this.joinForm.code
          })
          if (resp.ok) {
            Message.success(this.$t('p2p.joined'))
          } else {
            Message.error(resp.error || resp.result?.reason || this.$t('p2p.status-rejected'))
          }
        } catch (err) {
          Message.error(err.message)
        } finally {
          this.busy = ''
        }
      },
      async onApprove (fp) {
        const resp = await this.$store.dispatch('p2p/approve', fp)
        if (!resp.ok) {
          Message.error(resp.error)
        }
      },
      async onReject (fp) {
        const resp = await this.$store.dispatch('p2p/reject', fp)
        if (!resp.ok) {
          Message.error(resp.error)
        }
      },
      async onKick (m) {
        try {
          await this.$confirm(this.$t('p2p.kick-confirm', { name: m.name }), this.$t('p2p.kick'), {
            confirmButtonText: this.$t('p2p.confirm'),
            cancelButtonText: this.$t('p2p.cancel'),
            type: 'warning'
          })
        } catch (err) {
          return
        }
        const resp = await this.$store.dispatch('p2p/kick', m.fp)
        if (!resp.ok) {
          Message.error(resp.error)
        }
      },
      async onResetCode () {
        try {
          await this.$confirm(this.$t('p2p.reset-code-confirm'), this.$t('p2p.invite-reset'), {
            confirmButtonText: this.$t('p2p.confirm'),
            cancelButtonText: this.$t('p2p.cancel'),
            type: 'warning'
          })
        } catch (err) {
          return
        }
        const resp = await this.$store.dispatch('p2p/resetCode')
        if (resp.ok) {
          Message.success(this.$t('p2p.code-reset'))
        } else {
          Message.error(resp.error)
        }
      },
      async onLeave () {
        try {
          await this.$confirm(
            this.isOwner ? this.$t('p2p.dissolve-confirm') : this.$t('p2p.leave-confirm'),
            this.leaveLabel,
            {
              confirmButtonText: this.$t('p2p.confirm'),
              cancelButtonText: this.$t('p2p.cancel'),
              type: 'warning'
            }
          )
        } catch (err) {
          return
        }
        const resp = await this.$store.dispatch('p2p/leave')
        if (!resp.ok) {
          Message.error(resp.error)
        }
      },
      async onSavePorts () {
        const custom = this.customPorts
        const ports = [...new Set([...this.checkedPorts, ...custom])]
        const resp = await this.$store.dispatch('p2p/updateSettings', { openPorts: ports })
        if (!resp.ok) {
          Message.error(resp.error)
        }
      },
      addPort () {
        const port = Number(this.customPortInput)
        if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
          Message.warning(this.$t('p2p.bad-port'))
          return
        }
        this.customPortInput = ''
        const ports = [...new Set([...(this.settings.openPorts || []), port])]
        this.$store.dispatch('p2p/updateSettings', { openPorts: ports })
      },
      removePort (port) {
        const ports = (this.settings.openPorts || []).filter((p) => p !== port)
        this.$store.dispatch('p2p/updateSettings', { openPorts: ports })
      },
      async onSaveReceivePush () {
        const resp = await this.$store.dispatch('p2p/updateSettings', {
          receiveTaskPush: this.receivePush
        })
        if (!resp.ok) {
          Message.error(resp.error)
        }
      },
      async onSaveVipForward () {
        const resp = await this.$store.dispatch('p2p/updateSettings', {
          vipForward: this.vipForward
        })
        if (!resp.ok) {
          Message.error(resp.error)
        }
      },
      async onResetError () {
        await this.$store.dispatch('p2p/resetError')
      },
      openPush (m) {
        this.pushTargetFp = m.fp
        this.pushTargetName = m.name
        this.pushUrls = ''
        this.pushVisible = true
      },
      async onPush () {
        const urls = this.pushUrls.split('\n').map((s) => s.trim()).filter(Boolean)
        if (!urls.length) {
          Message.warning(this.$t('p2p.push-required'))
          return
        }
        this.busy = 'push'
        try {
          const resp = await this.$store.dispatch('p2p/pushTask', {
            target: this.pushTargetFp,
            urls
          })
          if (resp.ok) {
            const failed = (resp.result?.results || []).filter((r) => !r.ok)
            if (failed.length) {
              Message.warning(failed.map((r) => r.reason).join('; '))
            } else {
              Message.success(this.$t('p2p.push-sent'))
            }
            this.pushVisible = false
          } else {
            Message.error(resp.error)
          }
        } finally {
          this.busy = ''
        }
      },
      reachText (m) {
        if (m.reachable === true) {
          return this.$t('p2p.reachable')
        }
        if (m.reachable === false) {
          return this.$t('p2p.unreachable')
        }
        return this.$t('p2p.reach-unknown')
      },
      linkOf (m) {
        return (this.links || {})[m.fp] || null
      },
      latencyText (m) {
        const l = this.linkOf(m)
        if (!l || l.rtt === null || l.rtt === undefined) {
          return this.$t('p2p.latency-na')
        }
        const relay = !this.isOwner && !m.isOwnerRow
        const prefix = relay ? `${this.$t('p2p.relay-tag')} ` : ''
        return `${prefix}${l.rtt}ms · ${l.loss}%`
      },
      latencyClass (m) {
        const l = this.linkOf(m)
        if (!l || l.rtt === null || l.rtt === undefined) {
          return 'na'
        }
        if (l.loss >= 50 || l.rtt >= 300) {
          return 'bad'
        }
        if (l.loss > 0 || l.rtt >= 120) {
          return 'mid'
        }
        return 'ok'
      },
      /* 一行的悬停说明：指纹 + 可达性 + 链路采样。
         指纹列已从成员行撤掉——名字改成 HL-n 之后人眼不需要靠它区分成员；
         待审批行仍常驻显示指纹，那是多个申请人之间唯一的区分手段。 */
      rowTitle (m) {
        const parts = [m.fp]
        if (!m.isSelf) {
          parts.push(this.reachText(m))
          const l = this.linkOf(m)
          if (l) {
            const relay = !this.isOwner && !m.isOwnerRow
            parts.push(relay ? `${this.$t('p2p.relay-tag')} · ${l.samples}` : String(l.samples))
          }
        }
        return parts.join(' · ')
      },
      speedText (m) {
        const s = (this.speed || {})[m.fp]
        if (!s || !s.down) {
          return ''
        }
        return this.$t('p2p.speed-result', { down: s.down, up: s.up })
      },
      speedStale (m) {
        const s = (this.speed || {})[m.fp]
        return !s || (Date.now() - s.ts) > 300000
      },
      async onSpeedTest (m) {
        if (this.speedBusy) {
          Message.info(this.$t('p2p.speed-busy'))
          return
        }
        this.speedBusy = m.fp
        try {
          const resp = await this.$store.dispatch('p2p/speedTest', { target: m.fp })
          if (!resp.ok) {
            Message.error(resp.error)
          } else if (resp.result) {
            Message.success(this.$t('p2p.speed-result', { down: resp.result.down, up: resp.result.up }))
          }
        } catch (err) {
          Message.error(err.message)
        } finally {
          this.speedBusy = ''
        }
      }
    }
  }
</script>

<style lang="scss">
/* 页面内缩。写在 el-main(.panel-content) 上会被主题的
   `.panel .panel-content:not(.dashboard-content) { padding: 0 }` 清零，
   所以内缩落在内层 .p2p-body —— 同 .task-list / .form-preference 的做法。 */
.p2p-body {
  padding: 24px 40px 72px;
}

@media only screen and (min-width: 568px) {
  .p2p-body {
    padding-left: 80px;
    padding-right: 80px;
  }
}

@media only screen and (min-width: 1280px) {
  .p2p-body {
    padding-left: 96px;
    padding-right: 96px;
  }
}

/* 标题和状态标签排成一行：.p2p-header-actions 是块级元素，原本会整行掉到
   标题下方，把头部撑到 104px（其余页面是 80px）。 */
.panel .panel-header.p2p-header {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  box-sizing: border-box;
}

.p2p-heading {
  margin: 0;
}

.p2p-header-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 12px;
}

.p2p-loading {
  padding: 48px 0;
  text-align: center;
  color: var(--mo-text-regular);
}

/* 与卡片同宽同左边界，否则警告条会比卡片宽出一截、贴着窗口边 */
.p2p-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  max-width: 960px;
  margin-bottom: 20px;
  padding: 12px 16px;
  border-radius: $mo-radius-md;
  font-size: 13px;
  line-height: 1.5;

  &.error {
    background: rgba(245, 108, 108, 0.12);
    border: 1px solid rgba(245, 108, 108, 0.4);
    color: var(--mo-text-regular);
  }
  &.warn {
    background: rgba(230, 162, 60, 0.1);
    border: 1px solid rgba(230, 162, 60, 0.38);
    color: var(--mo-text-regular);
  }
}

/* 左对齐（不再 margin:0 auto 居中）：居中会让标题、警告条、卡片各占一条左边界 */
.p2p-onboard {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 20px;
  max-width: 960px;
}

.p2p-group {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 960px;
}

.p2p-card {
  @include mo-glass-surface();
  @include mo-glass-sheen();
  padding: 18px 20px;

  h5 {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 500;
    color: var(--mo-text-primary);
  }

  .el-input + .el-input,
  .el-input + .el-button,
  .el-textarea + .el-input,
  .el-input + .el-textarea {
    margin-top: 10px;
  }

  .el-button {
    margin-top: 14px;
  }
}

.p2p-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  h5 {
    margin: 0;
  }

  .el-button {
    margin-top: 0;
  }
}

/* 说明文字统一降到 11px / secondary，相邻段收紧节奏，
   橙色的 .conflict-text 仍是这一叠文字里唯一的强调色。 */
.p2p-desc {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.75;
  color: var(--mo-text-secondary, rgba(255, 255, 255, 0.55));

  & + .p2p-desc {
    margin-top: 3px;
  }
}

/* 邀请码块与虚拟地址说明之间的分组分隔线 */
.p2p-section {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid rgba(48, 49, 51, 0.1);

  &.is-first {
    margin-top: 8px;
    padding-top: 0;
    border-top: none;
  }
}

.p2p-code {
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: $mo-radius-sm;
  background: rgba(48, 49, 51, 0.06);
  border: 1px dashed rgba(var(--mo-primary-rgb), 0.45);
  font-family: "SF Mono", Consolas, "Cascadia Mono", "Courier New", monospace;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-all;
  color: var(--mo-text-primary);
  cursor: pointer;
  user-select: all;
  transition: $mo-transition-fast;

  &:hover {
    border-color: var(--mo-primary);
  }

  &.small {
    font-size: 12px;
    padding: 8px 12px;
    display: inline-block;
  }
}

.p2p-joining {
  max-width: 420px;
  text-align: center;

  .el-icon-loading {
    display: inline-block;
    margin-top: 12px;
    font-size: 22px;
    color: var(--mo-primary);
  }
}

/* 成员行改用 flex：身份信息（名字/虚拟地址/指纹）聚在左边，
   状态·链路·操作用 margin-left:auto 推到右边。
   原来的 grid 第一列是 1.3fr，实测 475px 只装下约 140px 内容，中段空出 335px；
   stats 列 minmax(110px,auto) 空着也占 110px。 */
.p2p-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 0;
  border-top: 1px solid rgba(48, 49, 51, 0.08);

  .p2p-cell {
    flex: 0 0 auto;
  }

  .p2p-cell-status {
    margin-left: auto;
  }

  &.pending {
    background: rgba(var(--mo-primary-rgb), 0.06);
    border-radius: $mo-radius-sm;
    border-top: none;
    padding: 10px 12px;
    margin-bottom: 8px;
  }

  &.is-self {
    opacity: 0.85;
  }

  &:first-of-type {
    border-top: none;
  }

  @media (max-width: 920px) {
    .p2p-cell-status {
      margin-left: 0;
    }

    .p2p-cell-actions {
      margin-left: auto;
    }
  }
}

.p2p-cell {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.p2p-cell-name {
  .p2p-name {
    margin-right: 2px;
  }
}

.p2p-cell-actions {
  justify-content: flex-end;
}

/* 在线状态改成圆点 + 文字（沿用仪表盘 .live-dot 的语义）：
   绿胶囊、可达胶囊、延迟胶囊同框太吵。 */
.p2p-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: $mo-radius-pill;
  background-color: var(--mo-text-secondary);
  opacity: 0.4;
  transition: $mo-transition-fast;

  &.is-online {
    opacity: 1;
    background-color: var(--mo-accent-green);
    box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.16);
  }
}

.p2p-status-text {
  font-size: 12px;
  color: var(--mo-text-secondary);
}

.p2p-row-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;

  .el-button {
    margin-top: 0;
  }
}

.p2p-latency {
  font-family: "SF Mono", Consolas, "Cascadia Mono", "Courier New", monospace;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: $mo-radius-sm;
  border: 1px solid transparent;
  white-space: nowrap;

  &.ok {
    color: #67c23a;
    background: rgba(103, 194, 58, 0.12);
    border-color: rgba(103, 194, 58, 0.35);
  }
  &.mid {
    color: #e6a23c;
    background: rgba(230, 162, 60, 0.12);
    border-color: rgba(230, 162, 60, 0.35);
  }
  &.bad {
    color: #f56c6c;
    background: rgba(245, 108, 108, 0.12);
    border-color: rgba(245, 108, 108, 0.35);
  }
  &.na {
    color: var(--mo-text-secondary, rgba(255, 255, 255, 0.45));
    background: rgba(48, 49, 51, 0.05);
    border-color: rgba(48, 49, 51, 0.12);
  }
}

.p2p-speed {
  font-family: "SF Mono", Consolas, "Cascadia Mono", "Courier New", monospace;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: $mo-radius-sm;
  background: rgba(var(--mo-primary-rgb), 0.12);
  border: 1px solid rgba(var(--mo-primary-rgb), 0.3);
  color: var(--mo-primary);
  white-space: nowrap;

  &.stale {
    opacity: 0.45;
  }
}

.p2p-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--mo-text-regular);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.p2p-fp {
  font-family: "SF Mono", Consolas, "Cascadia Mono", "Courier New", monospace;
  font-size: 12px;
  color: var(--mo-text-secondary, rgba(255, 255, 255, 0.45));
}

.p2p-vip {
  padding: 2px 8px;
  border-radius: $mo-radius-sm;
  background: rgba(var(--mo-primary-rgb), 0.14);
  border: 1px solid rgba(var(--mo-primary-rgb), 0.35);
  font-family: "SF Mono", Consolas, "Cascadia Mono", "Courier New", monospace;
  font-size: 12px;
  color: var(--mo-primary);
  cursor: pointer;
  user-select: all;
  transition: $mo-transition-fast;

  &:hover {
    border-color: var(--mo-primary);
  }
}

.conflict-text {
  color: #e6a23c;
}

.p2p-field {
  margin-bottom: 14px;

  &:last-child {
    margin-bottom: 0;
  }
}

.p2p-field-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--mo-text-secondary, rgba(255, 255, 255, 0.55));
}

.p2p-field-row {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  align-items: center;
  gap: 4px 12px;

  .p2p-field-label {
    margin-bottom: 0;
  }

  > .p2p-desc,
  > .conflict-text {
    grid-column: 2;
    margin-top: 4px;
  }

  .el-input {
    max-width: 260px;
  }
}

.p2p-vip-line {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;

  .p2p-field-label {
    margin-bottom: 0;
    flex-shrink: 0;
  }

  .p2p-vip {
    margin-top: 0;
    font-size: 13px;
    padding: 4px 10px;
  }
}

/* 分组内的第一行不需要再抬一次头 */
.p2p-section .p2p-vip-line {
  margin-top: 0;
}

.p2p-group-badge {
  margin: 0;
  padding: 2px 10px;
  border-radius: $mo-radius-sm;
  background: rgba(48, 49, 51, 0.05);
  border: 1px solid rgba(48, 49, 51, 0.1);
  white-space: nowrap;
}

.p2p-port-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;

  .el-tag {
    margin-top: 0;
  }
}

.p2p-port-input {
  width: 120px;

  .el-input__inner {
    margin-top: 0;
  }
}

/* 退出/解散不再独占一张玻璃卡 —— 一行右对齐的动作就够了 */
.p2p-danger {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;

  .el-button {
    margin-top: 0;
  }
}

/* 上面的深色块与细线是亮色基线（同 Theme/Default.scss 的约定），
   暗色在这里覆盖 —— 白系值放到暗色下会整片隐形。 */
.theme-dark {
  .p2p-code {
    background: rgba(0, 0, 0, 0.28);
    color: var(--mo-text-regular);
  }

  .p2p-group-badge {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.1);
  }

  .p2p-row {
    border-top-color: rgba(255, 255, 255, 0.06);
  }

  .p2p-section {
    border-top-color: rgba(255, 255, 255, 0.14);
  }

  .p2p-latency.na {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.12);
  }
}
</style>
