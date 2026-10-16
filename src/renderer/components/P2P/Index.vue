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
          <i class="el-icon-loading" />
          <span>{{ $t('p2p.loading') }}</span>
        </div>

        <template v-else>
          <div
            v-if="lastError && !outcome"
            class="p2p-alert error"
          >
            <i class="el-icon-circle-close" />
            <span class="p2p-alert-text">{{ p2pErrText(lastError) }}</span>
            <el-button
              v-if="lastRetry"
              size="mini"
              plain
              @click="onRetry"
            >{{ $t('p2p.retry') }}</el-button>
            <el-button
              size="mini"
              plain
              @click="onResetError"
            >{{ $t('p2p.dismiss') }}</el-button>
          </div>

          <!-- 结束态：被移出 / 群已解散 / 申请未通过，各给原因与出路 -->
          <div
            v-if="outcome"
            class="p2p-outcome mo-stagger-item"
          >
            <span class="p2p-outcome-icon">
              <i :class="outcome.icon" />
            </span>
            <h3 class="p2p-outcome-title">{{ outcome.title }}</h3>
            <p class="p2p-outcome-desc">{{ outcome.desc }}</p>
            <p class="p2p-outcome-hint">{{ outcome.hint }}</p>
            <el-button
              size="mini"
              plain
              @click="onResetError"
            >{{ $t('p2p.dismiss') }}</el-button>
          </div>

          <div
            v-if="endpointWarningText"
            class="p2p-alert warn"
          >
            <i class="el-icon-warning-outline" />
            <span class="p2p-alert-text">{{ endpointWarningText }}</span>
          </div>

          <!-- 未入群：hero 介绍区 + 创建 / 加入两卡 -->
          <div
            v-if="!inGroup"
            class="p2p-onboard-wrap"
          >
            <div
              class="p2p-hero mo-stagger-item"
              style="--mo-enter-delay: 0ms;"
            >
              <span class="p2p-hero-icon">
                <mo-icon
                  name="menu-p2p"
                  width="28"
                  height="28"
                />
              </span>
              <h3 class="p2p-hero-title">{{ $t('p2p.hero-title') }}</h3>
              <p class="p2p-hero-desc">{{ $t('p2p.hero-desc') }}</p>
            </div>

            <div class="p2p-onboard">
              <section
                class="p2p-card mo-stagger-item"
                style="--mo-enter-delay: 80ms;"
              >
                <div class="p2p-card-title">
                  <span class="p2p-card-icon">
                    <mo-icon
                      name="menu-add"
                      width="16"
                      height="16"
                    />
                  </span>
                  <h5>{{ $t('p2p.create-title') }}</h5>
                </div>
                <p class="p2p-desc">{{ $t('p2p.create-desc') }}</p>
                <el-button
                  class="p2p-card-cta"
                  type="primary"
                  :loading="busy === 'create'"
                  @click="onCreate"
                >{{ $t('p2p.create-action') }}</el-button>
              </section>

              <section
                class="p2p-card mo-stagger-item"
                style="--mo-enter-delay: 160ms;"
              >
                <div class="p2p-card-title">
                  <span class="p2p-card-icon">
                    <mo-icon
                      name="link"
                      width="16"
                      height="16"
                    />
                  </span>
                  <h5>{{ $t('p2p.join-title') }}</h5>
                </div>
                <p class="p2p-desc">{{ $t('p2p.join-desc') }}</p>
                <el-input
                  v-model="joinForm.code"
                  class="p2p-join-input"
                  type="textarea"
                  :rows="3"
                  :placeholder="$t('p2p.code-ph')"
                />
                <el-button
                  class="p2p-card-cta"
                  type="primary"
                  :loading="busy === 'join'"
                  @click="onJoin"
                >{{ $t('p2p.join-action') }}</el-button>
              </section>
            </div>
          </div>

          <!-- 等待审批 -->
          <div
            v-else-if="status === 'joining'"
            class="p2p-card p2p-joining mo-stagger-item"
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
            <section
              class="p2p-card p2p-info mo-stagger-item"
              style="--mo-enter-delay: 0ms;"
            >
              <div class="p2p-card-head">
                <div class="p2p-card-title">
                  <span class="p2p-card-icon">
                    <mo-icon
                      name="menu-p2p"
                      width="16"
                      height="16"
                    />
                  </span>
                  <h5>{{ isOwner ? $t('p2p.invite-title') : $t('p2p.my-info-title') }}</h5>
                </div>
                <div class="p2p-info-side">
                  <span
                    v-if="groupName || members.length"
                    class="p2p-desc p2p-group-badge"
                  >{{ groupName }} · {{ $t('p2p.group-meta', { count: members.length }) }}</span>
                  <el-button
                    v-if="isOwner"
                    size="mini"
                    plain
                    :loading="busy === 'reset-code'"
                    @click="onResetCode"
                  >{{ $t('p2p.invite-reset') }}</el-button>
                </div>
              </div>
              <div
                v-if="isOwner"
                class="p2p-code"
                role="button"
                tabindex="0"
                :title="$t('p2p.invite-copy-hint')"
                :aria-label="$t('p2p.invite-copy-hint')"
                @click="copyText(group.codeText, 'p2p.code-copied')"
                @keyup.enter="copyText(group.codeText, 'p2p.code-copied')"
                @keyup.space="copyText(group.codeText, 'p2p.code-copied')"
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
                    role="button"
                    tabindex="0"
                    :title="$t('p2p.vip-copy')"
                    :aria-label="$t('p2p.vip-copy')"
                    @click.stop="copyText(selfVip, 'p2p.vip-copy')"
                    @keyup.enter.stop="copyText(selfVip, 'p2p.vip-copy')"
                    @keyup.space.stop="copyText(selfVip, 'p2p.vip-copy')"
                  >{{ selfVip || $t('p2p.vip-none') }}</span>
                </div>
                <p class="p2p-desc">{{ $t('p2p.vip-desc') }}</p>
                <p class="p2p-desc conflict-text">{{ $t('p2p.ping-warning') }}</p>
              </div>
            </section>

            <section
              class="p2p-card mo-stagger-item"
              style="--mo-enter-delay: 80ms;"
            >
              <div class="p2p-card-head">
                <div class="p2p-card-title">
                  <span class="p2p-card-icon">
                    <mo-icon
                      name="node"
                      width="16"
                      height="16"
                    />
                  </span>
                  <h5>{{ $t('p2p.members-title') }}</h5>
                </div>
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
                  <!-- 来源地址 + 已等待时长：原来只有 8 位指纹，等于盲选 -->
                  <span class="p2p-pending-meta">{{ pendingMeta(p) }}</span>
                </div>
                <div class="p2p-cell p2p-cell-status">
                  <el-tag size="mini">{{ $t('p2p.pending-tag') }}</el-tag>
                </div>
                <div class="p2p-cell p2p-cell-actions p2p-row-actions">
                  <el-button
                    type="primary"
                    size="mini"
                    :loading="busy === 'approve:' + p.fp"
                    @click="onApprove(p.fp)"
                  >{{ $t('p2p.approve') }}</el-button>
                  <el-button
                    size="mini"
                    :loading="busy === 'reject:' + p.fp"
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
                </div>
                <!-- 徽章独占一列：姓名列只放名字，列中心才真正属于名字 -->
                <div class="p2p-cell p2p-cell-badges">
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
                    role="button"
                    tabindex="0"
                    :title="$t('p2p.vip-copy')"
                    :aria-label="$t('p2p.vip-copy')"
                    @click.stop="copyText(m.vip, 'p2p.vip-copy')"
                    @keyup.enter.stop="copyText(m.vip, 'p2p.vip-copy')"
                    @keyup.space.stop="copyText(m.vip, 'p2p.vip-copy')"
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
                    plain
                    :disabled="busy.speed"
                    :loading="speedBusy === m.fp"
                    @click="onSpeedTest(m)"
                  >{{ $t('p2p.speed-test') }}</el-button>
                  <el-button
                    size="mini"
                    plain
                    :title="$t('p2p.push-title')"
                    @click="openPush(m)"
                  >{{ $t('p2p.push') }}</el-button>
                  <el-button
                    size="mini"
                    plain
                    :disabled="!!file.sending || busy.send"
                    :loading="fileBusyFp === m.fp"
                    :title="$t('p2p.send-file-title')"
                    @click="onSendFile(m)"
                  >{{ $t('p2p.send-file') }}</el-button>
                  <el-button
                    v-if="isOwner"
                    size="mini"
                    type="danger"
                    plain
                    :loading="busy === 'kick:' + m.fp"
                    @click="onKick(m)"
                  >{{ $t('p2p.kick') }}</el-button>
                </div>
              </div>

              <!-- 群主独占、无人待审时的引导空态 -->
              <p
                v-if="isOwner"
                class="p2p-desc p2p-members-count"
                :class="{ 'p2p-full-text': members.length >= maxMembers }"
              >{{ membersLabel() }}</p>

              <p
                v-if="isOwner && !pending.length && members.length <= 1"
                class="p2p-desc p2p-members-empty"
              >{{ $t('p2p.members-empty') }}</p>
            </section>

            <section
              class="p2p-card mo-stagger-item"
              style="--mo-enter-delay: 140ms;"
            >
              <div class="p2p-card-head">
                <div class="p2p-card-title">
                  <span class="p2p-card-icon">
                    <mo-icon
                      name="link"
                      width="16"
                      height="16"
                    />
                  </span>
                  <h5>{{ $t('p2p.transfer-title') }}</h5>
                </div>
              </div>

              <p
                v-if="!fileRows.length && !(file.offers || []).length"
                class="p2p-desc"
              >{{ $t('p2p.transfer-empty') }}</p>

              <div
                v-for="o in (file.offers || [])"
                :key="`offer-${o.tid}`"
                class="p2p-file-row"
              >
                <div class="p2p-file-main">
                  <span
                    class="p2p-file-name"
                    :title="o.name"
                  >{{ o.name }}</span>
                  <span class="p2p-file-peer">{{ $t('p2p.transfer-from', { name: o.from }) }}</span>
                </div>
                <div class="p2p-file-meta">
                  <span>{{ $t('p2p.offer-waiting', { size: fmtBytes(o.size) }) }}</span>
                </div>
              </div>

              <div
                v-for="row in fileRows"
                :key="`${row.dir}-${row.tid}`"
                class="p2p-file-row"
              >
                <div class="p2p-file-main">
                  <span
                    class="p2p-file-name"
                    :title="row.savedAs || row.name"
                  >{{ row.savedAs || row.name }}</span>
                  <span class="p2p-file-peer">{{ row.dir === 'send'
                    ? $t('p2p.transfer-to', { name: peerName(row.peer) })
                    : $t('p2p.transfer-from', { name: peerName(row.peer) }) }}</span>
                </div>
                <el-progress
                  :percentage="filePercent(row)"
                  :status="fileProgressStatus(row)"
                  :stroke-width="8"
                />
                <div class="p2p-file-meta">
                  <span>{{ phaseText(row) }}</span>
                  <span v-if="isLivePhase(row)">{{ fmtBytes(row.transferred) }} / {{ fmtBytes(row.size) }} · {{ fmtSpeed(row) }}</span>
                  <span
                    v-else-if="row.reason"
                    class="fail-text"
                  >{{ reasonText(row.reason) }}</span>
                </div>
                <div
                  v-if="row.phase !== 'done'"
                  class="p2p-file-actions"
                >
                  <!-- 失败行给一个「重新发送」：重选同一文件即从断点续传 -->
                  <el-button
                    v-if="row.dir === 'send' && row.phase === 'failed'"
                    size="mini"
                    plain
                    :disabled="!!file.sending || busy.send"
                    @click="onResend(row)"
                  >{{ $t('p2p.resend') }}</el-button>
                  <el-button
                    size="mini"
                    type="danger"
                    plain
                    :loading="busy === 'cancel:' + row.tid"
                    @click="onCancelFile(row)"
                  >{{ $t('p2p.cancel-file') }}</el-button>
                </div>
              </div>

              <!-- 未完成接收占了多少盘：以前这些 .part 只会在 7 天后悄悄消失 -->
              <div
                v-if="partsInfo()"
                class="p2p-parts"
              >
                <span class="p2p-parts-text">{{ partsInfo() }}</span>
                <el-button
                  v-if="(file.parts || {}).bytes > 0"
                  size="mini"
                  plain
                  :loading="busy === 'clear-parts'"
                  @click="onClearParts"
                >{{ $t('p2p.parts-clear') }}</el-button>
              </div>

              <!-- 最近传输：发完就消失的卡片让"到底成功没有"无从确认 -->
              <div
                v-if="(file.recent || []).length"
                class="p2p-recent"
              >
                <p class="p2p-field-label">{{ $t('p2p.recent-title') }}</p>
                <div
                  v-for="r in file.recent"
                  :key="`recent-${r.ts}-${r.tid}`"
                  class="p2p-recent-row"
                >
                  <span
                    class="p2p-recent-name"
                    :title="r.savedAs || r.name"
                  >{{ r.savedAs || r.name }}</span>
                  <span class="p2p-recent-meta">{{ recentText(r) }}</span>
                </div>
              </div>
            </section>

            <section
              class="p2p-card mo-stagger-item"
              style="--mo-enter-delay: 160ms;"
            >
              <div class="p2p-card-head">
                <div class="p2p-card-title">
                  <span class="p2p-card-icon">
                    <mo-icon
                      name="settings"
                      width="16"
                      height="16"
                    />
                  </span>
                  <h5>{{ $t('p2p.settings-title') }}</h5>
                </div>
              </div>

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
                <span class="p2p-field-label">{{ $t('p2p.file-receive') }}</span>
                <el-switch
                  v-model="fileReceiveEnabled"
                  @change="onSaveFileReceive"
                />
                <p class="p2p-desc">{{ $t('p2p.file-receive-desc') }}</p>
              </div>

              <div
                v-if="fileReceiveEnabled"
                class="p2p-field p2p-field-row"
              >
                <span class="p2p-field-label">{{ $t('p2p.file-ask') }}</span>
                <el-switch
                  v-model="fileReceiveAsk"
                  @change="onSaveFileAsk"
                />
                <p class="p2p-desc">{{ $t('p2p.file-ask-desc') }}</p>
              </div>

              <div
                v-if="fileReceiveEnabled"
                class="p2p-field p2p-field-row"
              >
                <span class="p2p-field-label">{{ $t('p2p.receive-dir') }}</span>
                <el-button
                  size="mini"
                  plain
                  @click="onPickReceiveDir"
                >{{ $t('p2p.choose-dir') }}</el-button>
                <p
                  class="p2p-desc dir-path"
                  :title="settings.fileReceiveDir"
                >{{ settings.fileReceiveDir }}</p>
                <p class="p2p-desc">{{ $t('p2p.file-limit', { mb: settings.fileMaxMb || 10240 }) }}</p>
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
                <p
                  v-if="punchText"
                  class="p2p-desc"
                >{{ punchText }}</p>
                <p class="p2p-desc">{{ $t('p2p.mc-hint') }}</p>
              </div>
            </section>

            <div class="p2p-danger">
              <el-button
                size="small"
                type="danger"
                plain
                :loading="busy === 'leave'"
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
  import { bytesToSize } from '@shared/utils'
  import { Message } from 'element-ui'

  /* Icon.register 是 import 副作用且页面为懒加载 chunk，
     本页用到的图标全部自行注册，不依赖其它页面先加载。 */
  import '@/components/Icons/menu-p2p'
  import '@/components/Icons/menu-add'
  import '@/components/Icons/link'
  import '@/components/Icons/node'
  import '@/components/Icons/settings'

  // a 12-sample window only earns a colour verdict after a few probes —
  // one lost sample out of two would otherwise flash red right after join
  const PROBE_MIN_SAMPLES = 3

  export default {
    name: 'mo-content-p2p',
    data () {
      return {
        busy: '',
        // re-runnable action behind the error bar's "retry" (null = nothing to retry)
        lastRetry: null,
        // local edits in flight: a stale snapshot must not overwrite them
        dirty: {
          receivePush: false,
          vipForward: false,
          fileReceiveEnabled: false,
          fileReceiveAsk: false
        },
        speedBusy: '',
        fileBusyFp: '',
        clock: Date.now(),
        clockTimer: null,
        joinForm: { code: '' },
        checkedPorts: [],
        customPortInput: '',
        receivePush: true,
        vipForward: true,
        fileReceiveEnabled: true,
        fileReceiveAsk: true,
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
        'file',
        'settings',
        'lastError',
        'forward',
        'punch'
      ]),
      inGroup () {
        return !!this.group.gid && (this.role === 'owner' || this.role === 'member') &&
          this.status !== 'rejected' && this.status !== 'kicked' && this.status !== 'dissolved'
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
          dissolved: { type: 'danger', text: this.$t('p2p.status-dissolved') },
          error: { type: 'danger', text: this.$t('p2p.status-error') }
        }
        return map[this.status] || null
      },
      /**
       * Why the group ended, told as one card instead of a bare red bar:
       * "removed" and "dissolved" used to be the same state, and being removed
       * is permanent (the hub keeps a ban) — the user has to know that.
       */
      outcome () {
        const code = this.lastError && this.lastError.code
        if (!code || this.inGroup) {
          return null
        }
        if (code === 'kicked' || code === 'removed') {
          return {
            icon: 'el-icon-remove-outline',
            title: this.$t('p2p.outcome-removed-title'),
            desc: this.$t('p2p.outcome-removed-desc'),
            hint: this.$t('p2p.outcome-removed-hint')
          }
        }
        if (code === 'dissolved') {
          return {
            icon: 'el-icon-circle-close-outline',
            title: this.$t('p2p.outcome-dissolved-title'),
            desc: this.$t('p2p.outcome-dissolved-desc'),
            hint: this.$t('p2p.outcome-dissolved-hint')
          }
        }
        if (code === 'rejected' || code === 'banned' || code === 'approval-timeout' || code === 'approval-failed') {
          return {
            icon: 'el-icon-warning-outline',
            title: this.$t('p2p.outcome-rejected-title'),
            desc: code === 'banned' ? this.$t('p2p.outcome-banned-desc') : this.$t('p2p.outcome-rejected-desc'),
            hint: this.$t('p2p.outcome-rejected-hint')
          }
        }
        return null
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
      /**
       * Proof of actual connectivity (owner: someone is online right now;
       * member: the link to the owner is up). While that holds, inbound
       * direct-reach complaints describe a path nobody needs — stay silent.
       */
      endpointConnected () {
        if (!this.inGroup) {
          return false
        }
        if (this.isOwner) {
          return this.members.some((m) => !m.isSelf && m.online)
        }
        const owner = this.members.find((m) => m.isOwnerRow)
        return !!(owner && owner.online)
      },
      endpointWarningText () {
        if (this.endpointConnected) {
          return ''
        }
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
      /**
       * Punch outcome is only newsworthy when it actually blocked someone:
       * failures toward a member that is offline right now. Success and
       * "not attempted" are internal plumbing states — silence is the UI.
       */
      punchText () {
        const p = this.punch
        if (!p || p.last !== 'fail') {
          return ''
        }
        const target = this.members.find((m) => m.fp === p.target)
        if (target && target.online) {
          return ''
        }
        return `${this.$t('p2p.punch-label')}: ${this.$t('p2p.punch-fail')}`
      },
      fileRows () {
        const rows = []
        const f = this.file || {}
        if (f.sending) {
          rows.push({ dir: 'send', ...f.sending })
        }
        if (f.receiving) {
          rows.push({ dir: 'recv', ...f.receiving })
        }
        return rows
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
          if (this.dirty.receivePush) {
            return
          }
          this.receivePush = !!val
        }
      },
      'settings.vipForward': {
        immediate: true,
        handler (val) {
          if (this.dirty.vipForward) {
            return
          }
          this.vipForward = val !== false
        }
      },
      'settings.fileReceiveEnabled': {
        immediate: true,
        handler (val) {
          if (this.dirty.fileReceiveEnabled) {
            return
          }
          this.fileReceiveEnabled = val !== false
        }
      },
      'settings.fileReceiveAsk': {
        immediate: true,
        handler (val) {
          if (this.dirty.fileReceiveAsk) {
            return
          }
          this.fileReceiveAsk = val !== false
        }
      }
    },
    created () {
      this.$store.dispatch('p2p/fetchState')
    },
    mounted () {
      // speedStale must expire on the clock, not on "whenever the next
      // state-change happens to render" — links stops pushing when offline
      this.clockTimer = setInterval(() => {
        this.clock = Date.now()
      }, 5000)
    },
    beforeDestroy () {
      clearInterval(this.clockTimer)
    },
    methods: {
      /**
       * Failure text in the UI language: the main process sends a stable `code`
       * (plus a human-readable fallback), so an English UI no longer shows the
       * Chinese string that happened to be baked into the error.
       */
      p2pErrText (payload) {
        if (!payload) {
          return ''
        }
        const fallback = payload.error || payload.message || ''
        const code = payload.code
        if (!code) {
          return fallback
        }
        const key = `p2p.err-${code}`
        const text = this.$t(key)
        return text === key ? fallback : text
      },
      copyText (text, key) {
        if (!text) {
          return
        }
        clipboard.writeText(String(text))
        Message.success(this.$t(key))
      },
      async onCreate () {
        if (this.busy) {
          return
        }
        this.busy = 'create'
        try {
          const resp = await this.$store.dispatch('p2p/createGroup')
          if (resp.ok) {
            Message.success(this.$t('p2p.created'))
          } else {
            this.lastRetry = () => this.onCreate()
            Message.error(this.p2pErrText(resp))
          }
        } finally {
          this.busy = ''
        }
      },
      async onJoin () {
        if (this.busy) {
          return
        }
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
            this.lastRetry = () => this.onJoin()
            Message.error(this.p2pErrText(resp) || resp.result?.reason || this.$t('p2p.status-rejected'))
          }
        } catch (err) {
          this.lastRetry = () => this.onJoin()
          Message.error(this.p2pErrText(err))
        } finally {
          this.busy = ''
        }
      },
      async onApprove (fp) {
        if (this.busy) {
          return
        }
        this.busy = `approve:${fp}`
        try {
          const resp = await this.$store.dispatch('p2p/approve', fp)
          if (!resp.ok) {
            Message.error(this.p2pErrText(resp))
          }
        } finally {
          this.busy = ''
        }
      },
      async onReject (fp) {
        if (this.busy) {
          return
        }
        this.busy = `reject:${fp}`
        try {
          const resp = await this.$store.dispatch('p2p/reject', fp)
          if (!resp.ok) {
            Message.error(this.p2pErrText(resp))
          }
        } finally {
          this.busy = ''
        }
      },
      async onKick (m) {
        if (this.busy) {
          return
        }
        try {
          await this.$confirm(this.$t('p2p.kick-confirm', { name: m.name }), this.$t('p2p.kick'), {
            confirmButtonText: this.$t('p2p.confirm'),
            cancelButtonText: this.$t('p2p.cancel'),
            type: 'warning'
          })
        } catch (err) {
          return
        }
        this.busy = `kick:${m.fp}`
        try {
          const resp = await this.$store.dispatch('p2p/kick', m.fp)
          if (!resp.ok) {
            Message.error(this.p2pErrText(resp))
          }
        } finally {
          this.busy = ''
        }
      },
      async onResetCode () {
        if (this.busy) {
          return
        }
        try {
          await this.$confirm(this.$t('p2p.reset-code-confirm'), this.$t('p2p.invite-reset'), {
            confirmButtonText: this.$t('p2p.confirm'),
            cancelButtonText: this.$t('p2p.cancel'),
            type: 'warning'
          })
        } catch (err) {
          return
        }
        this.busy = 'reset-code'
        try {
          const resp = await this.$store.dispatch('p2p/resetCode')
          if (resp.ok) {
            Message.success(this.$t('p2p.code-reset'))
          } else {
            this.lastRetry = () => this.onResetCode()
            Message.error(this.p2pErrText(resp))
          }
        } finally {
          this.busy = ''
        }
      },
      async onLeave () {
        if (this.busy) {
          return
        }
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
        this.busy = 'leave'
        try {
          const resp = await this.$store.dispatch('p2p/leave')
          if (!resp.ok) {
            Message.error(this.p2pErrText(resp))
          }
        } finally {
          this.busy = ''
        }
      },
      onResend (row) {
        const member = this.members.find((m) => m.fp === row.peer)
        if (!member) {
          Message.warning(this.$t('p2p.push-target-gone'))
          return
        }
        this.onSendFile(member)
      },
      /** Re-run the action that produced the current error bar (if we know it). */
      onRetry () {
        const fn = this.lastRetry
        this.lastRetry = null
        if (typeof fn === 'function') {
          fn()
        }
      },
      /**
       * Every settings write goes through here: the call used to be fired
       * without looking at the answer, so a rejected update (or a thrown IPC
       * error) meant "the switch moved but nothing happened" — silently.
       */
      async saveSettings (patch, revert, dirtyKey = null) {
        const back = () => {
          if (dirtyKey) {
            this.dirty[dirtyKey] = false
          }
          if (typeof revert === 'function') {
            revert()
          }
        }
        try {
          const resp = await this.$store.dispatch('p2p/updateSettings', patch)
          if (resp && resp.ok) {
            if (dirtyKey) {
              this.dirty[dirtyKey] = false
            }
            return true
          }
          Message.error(this.p2pErrText(resp) || this.$t('p2p.settings-failed'))
          back()
          return false
        } catch (err) {
          Message.error(this.p2pErrText(err) || this.$t('p2p.settings-failed'))
          back()
          return false
        }
      },
      async onSavePorts () {
        const custom = this.customPorts
        const ports = [...new Set([...this.checkedPorts, ...custom])]
        await this.saveSettings({ openPorts: ports })
      },
      async addPort () {
        const port = Number(this.customPortInput)
        if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
          Message.warning(this.$t('p2p.bad-port'))
          return
        }
        const ports = [...new Set([...(this.settings.openPorts || []), port])]
        if (await this.saveSettings({ openPorts: ports })) {
          // clear only on success, so a rejected port is not swallowed
          this.customPortInput = ''
        }
      },
      async removePort (port) {
        const ports = (this.settings.openPorts || []).filter((p) => p !== port)
        await this.saveSettings({ openPorts: ports })
      },
      async onSaveReceivePush () {
        this.dirty.receivePush = true
        await this.saveSettings(
          { receiveTaskPush: this.receivePush },
          () => { this.receivePush = !!this.settings.receiveTaskPush },
          'receivePush'
        )
      },
      async onSaveVipForward () {
        this.dirty.vipForward = true
        await this.saveSettings(
          { vipForward: this.vipForward },
          () => { this.vipForward = this.settings.vipForward !== false },
          'vipForward'
        )
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
        // the dialog may have been open while the member was kicked or went
        // offline: re-check against the live roster before sending
        const target = this.members.find((m) => m.fp === this.pushTargetFp)
        if (!target) {
          this.pushVisible = false
          Message.warning(this.$t('p2p.push-target-gone'))
          return
        }
        this.pushTargetName = target.name
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
            Message.error(this.p2pErrText(resp))
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
        if (!l || l.samples < PROBE_MIN_SAMPLES) {
          return this.$t('p2p.latency-na')
        }
        if (l.rtt === null || l.rtt === undefined) {
          return this.$t('p2p.latency-dead')
        }
        const relay = !this.isOwner && !m.isOwnerRow
        const prefix = relay ? `${this.$t('p2p.relay-tag')} ` : ''
        return `${prefix}${l.rtt}ms · ${l.loss}%`
      },
      latencyClass (m) {
        const l = this.linkOf(m)
        if (!l || l.samples < PROBE_MIN_SAMPLES) {
          return 'na'
        }
        if (l.rtt === null || l.rtt === undefined) {
          // window full of nothing but losses — the worst verdict a link
          // can earn, and it must be RED, not a quiet grey dash
          return 'bad'
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
          // online = the link works, full stop — inbound-reach verdicts only
          // matter as a diagnostic once the member is actually gone
          if (!m.online) {
            parts.push(this.reachText(m))
          }
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
        return !s || (this.clock - s.ts) > 300000
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
            Message.error(this.p2pErrText(resp))
          } else if (resp.result) {
            Message.success(this.$t('p2p.speed-result', { down: resp.result.down, up: resp.result.up }))
          }
        } catch (err) {
          Message.error(this.p2pErrText(err))
        } finally {
          this.speedBusy = ''
        }
      },
      /* ---- file transfer ---- */
      async onSendFile (m) {
        if (this.file && this.file.sending) {
          Message.info(this.$t('p2p.file-busy-send'))
          return
        }
        this.fileBusyFp = m.fp
        try {
          // main process runs the native pick + confirm dialogs; a null
          // result just means the user backed out of one of them
          const resp = await this.$store.dispatch('p2p/sendFile', { target: m.fp })
          if (!resp.ok) {
            Message.error(this.p2pErrText(resp))
          }
        } catch (err) {
          Message.error(this.p2pErrText(err))
        } finally {
          this.fileBusyFp = ''
        }
      },
      async onCancelFile (row) {
        if (this.busy) {
          return
        }
        this.busy = `cancel:${row.tid}`
        try {
          const resp = await this.$store.dispatch('p2p/cancelFile', { dir: row.dir, tid: row.tid })
          if (!resp.ok) {
            Message.error(this.p2pErrText(resp))
          }
        } finally {
          this.busy = ''
        }
      },
      async onPickReceiveDir () {
        try {
          const resp = await this.$store.dispatch('p2p/pickReceiveDir')
          if (resp && resp.ok === false) {
            Message.error(this.p2pErrText(resp) || this.$t('p2p.settings-failed'))
          }
        } catch (err) {
          Message.error(this.p2pErrText(err) || this.$t('p2p.settings-failed'))
        }
      },
      async onSaveFileReceive () {
        this.dirty.fileReceiveEnabled = true
        await this.saveSettings(
          { fileReceiveEnabled: this.fileReceiveEnabled },
          () => { this.fileReceiveEnabled = this.settings.fileReceiveEnabled !== false },
          'fileReceiveEnabled'
        )
      },
      async onSaveFileAsk () {
        this.dirty.fileReceiveAsk = true
        await this.saveSettings(
          { fileReceiveAsk: this.fileReceiveAsk },
          () => { this.fileReceiveAsk = this.settings.fileReceiveAsk !== false },
          'fileReceiveAsk'
        )
      },
      maxMembers () {
        return this.$store.state.p2p.maxMembers || 64
      },
      /** 群主看得到人数上限：满员时要能提前知道，而不是等申请人报错 */
      membersLabel () {
        const max = this.maxMembers()
        if (this.members.length >= max) {
          return this.$t('p2p.group-full-hint', { max })
        }
        return this.$t('p2p.members-count', { count: this.members.length, max })
      },
      pendingMeta (p) {
        const ip = p.ip || this.$t('p2p.ip-unknown')
        const waited = Math.max(0, Math.floor(((this.clock || Date.now()) - (p.since || 0)) / 1000))
        return this.$t('p2p.pending-meta', { ip, sec: waited })
      },
      /** 未完成接收占用 + 磁盘剩余（数字来自主进程缓存的扫描结果） */
      partsInfo () {
        const p = this.file.parts || {}
        if (!p.bytes && p.free === null) {
          return ''
        }
        return this.$t('p2p.parts-usage', {
          size: this.fmtBytes(p.bytes || 0),
          free: typeof p.free === 'number' ? this.fmtBytes(p.free) : '—'
        })
      },
      async onClearParts () {
        if (this.busy) {
          return
        }
        try {
          await this.$confirm(this.$t('p2p.parts-clear-confirm'), this.$t('p2p.parts-clear'), {
            confirmButtonText: this.$t('p2p.confirm'),
            cancelButtonText: this.$t('p2p.cancel'),
            type: 'warning'
          })
        } catch (err) {
          return
        }
        this.busy = 'clear-parts'
        try {
          const resp = await this.$store.dispatch('p2p/clearParts')
          if (resp && resp.ok !== false) {
            const freed = (resp.result && resp.result.freed) || 0
            Message.success(this.$t('p2p.parts-cleared', { size: this.fmtBytes(freed) }))
          } else {
            Message.error(this.p2pErrText(resp) || this.$t('p2p.settings-failed'))
          }
        } catch (err) {
          Message.error(this.p2pErrText(err) || this.$t('p2p.settings-failed'))
        } finally {
          this.busy = ''
        }
      },
      /** 最近传输一行：方向 · 对方 · 大小 · 结果 · 时间（HH:MM） */
      recentText (r) {
        const dir = r.dir === 'send' ? this.$t('p2p.recent-sent') : this.$t('p2p.recent-received')
        const result = r.ok ? this.$t('p2p.phase-done') : this.reasonText(r.reason)
        const when = new Date(r.ts || Date.now()).toTimeString().slice(0, 5)
        return `${dir} · ${r.peerName || '?'} · ${this.fmtBytes(r.size)} · ${result} · ${when}`
      },
      peerName (fp) {
        const m = this.members.find((x) => x.fp === fp)
        return m ? m.name : (fp || '?')
      },
      isLivePhase (row) {
        return ['hashing', 'waiting', 'sending', 'receiving', 'verifying'].includes(row.phase)
      },
      phaseText (row) {
        return this.$t(`p2p.phase-${row.phase || 'starting'}`)
      },
      reasonText (reason) {
        return this.$t(`p2p.reason-${reason || 'error'}`)
      },
      filePercent (row) {
        if (!row.size) {
          return 0
        }
        return Math.min(100, Math.round((row.transferred || 0) / row.size * 100))
      },
      fileProgressStatus (row) {
        if (row.phase === 'failed') {
          return 'exception'
        }
        return row.phase === 'done' ? 'success' : undefined
      },
      fmtBytes (n) {
        return bytesToSize(Number(n) || 0, 1)
      },
      fmtSpeed (row) {
        const sec = Math.max(1, (Date.now() - (row.startedAt || Date.now())) / 1000)
        return `${bytesToSize((row.transferred || 0) / sec, 1)}/s`
      }
    }
  }
</script>

<style lang="scss">
/* 页面内缩。写在 el-main(.panel-content) 上会被主题的
   `.panel .panel-content:not(.dashboard-content) { padding: 0 }` 清零，
   所以内缩落在内层 .p2p-body —— 同 .task-list / .form-preference 的做法。 */
.p2p-body {
  /* 功能色 rgb 三元组（仿主题的 --mo-primary-rgb 惯例）：
     亮色为基线，暗色只在这里覆写一次，胶囊/告警条取 rgba 用。 */
  --p2p-ok-rgb: 103, 194, 58;
  --p2p-warn-rgb: 230, 162, 60;
  --p2p-bad-rgb: 245, 108, 108;
  /* 同一组颜色作“文字”用时的深色档：Element 原色直接当文字只有
     2.2~2.9:1，读不清；描边与底色仍用上面的三元组。 */
  --p2p-ok-text: #3d7f1f;
  --p2p-warn-text: #96601a;
  --p2p-bad-text: #b93b3b;
  /* 本页作用域内把次级说明文字压深到 ≥4.5:1
     （只覆盖页面内的 token，不动全局，避免波及其它页面） */
  --mo-text-secondary: #6a6e78;
  padding: 24px 40px 72px;
}

.theme-dark .p2p-body {
  /* light-2 一档，在暗玻璃上不发灰 */
  --p2p-ok-rgb: 133, 206, 97;
  --p2p-warn-rgb: 235, 181, 99;
  --p2p-bad-rgb: 247, 137, 137;
  /* 暗色下原色本身够亮，文字直接沿用 */
  --p2p-ok-text: rgb(var(--p2p-ok-rgb));
  --p2p-warn-text: rgb(var(--p2p-warn-rgb));
  --p2p-bad-text: rgb(var(--p2p-bad-rgb));
  --mo-text-secondary: #9a9cab;
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
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 0;
  color: var(--mo-text-regular);

  .el-icon-loading {
    font-size: 22px;
    color: var(--mo-primary);
  }
}

/* 与卡片同宽同左边界，否则警告条会比卡片宽出一截、贴着窗口边 */
.p2p-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 960px;
  margin: 0 auto 20px;
  padding: 12px 16px;
  border-radius: $mo-radius-md;
  font-size: 13px;
  line-height: 1.5;

  > i {
    flex-shrink: 0;
    font-size: 16px;
  }

  .p2p-alert-text {
    flex: 1;
    min-width: 0;
  }

  .el-button {
    flex-shrink: 0;
    margin-left: auto;
  }

  &.error {
    background: rgba(var(--p2p-bad-rgb), 0.12);
    border: 1px solid rgba(var(--p2p-bad-rgb), 0.4);
    color: var(--mo-text-regular);

    > i {
      color: var(--p2p-bad-text);
    }
  }
  &.warn {
    background: rgba(var(--p2p-warn-rgb), 0.1);
    border: 1px solid rgba(var(--p2p-warn-rgb), 0.38);
    color: var(--mo-text-regular);

    > i {
      color: var(--p2p-warn-text);
    }
  }
}

/* 结束态卡片（被移出 / 群解散 / 申请未通过）：与警告条同一条居中列，
   把「发生了什么 + 现在还能做什么」一次说清，替代原来那条只有一句红字的气泡。 */
.p2p-outcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 640px;
  margin: 8px auto 28px;
  padding: 24px 28px;
  text-align: center;
  border-radius: $mo-radius-lg;
  background: rgba(var(--p2p-bad-rgb), 0.08);
  border: 1px solid rgba(var(--p2p-bad-rgb), 0.32);

  .p2p-outcome-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: $mo-radius-pill;
    color: var(--p2p-bad-text);
    background: rgba(var(--p2p-bad-rgb), 0.12);
    border: 1px solid rgba(var(--p2p-bad-rgb), 0.35);

    > i {
      font-size: 26px;
    }
  }

  .p2p-outcome-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--mo-text-primary);
  }

  .p2p-outcome-desc {
    margin: 0;
    max-width: 520px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--mo-text-regular);
  }

  .p2p-outcome-hint {
    margin: 0;
    max-width: 520px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--mo-text-secondary);
  }
}

/* 未入群引导态的页顶介绍区：居中一块，图标带主色光晕。
   hero / 警告条 / 两卡 / 已入群三卡 / 等待审批卡全部锁在同一条 960 居中列
   ——早年「两卡左对齐」的决定在宽窗下会把 hero 中轴和卡片中轴拉开，
   放大后图标悬在右卡上方、右侧死区一大片，故统一 margin-inline:auto。 */
.p2p-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 640px;
  margin: 28px auto 36px;
  text-align: center;

  .p2p-hero-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    margin-bottom: 16px;
    border-radius: $mo-radius-pill;
    color: var(--mo-primary);
    background: rgba(var(--mo-primary-rgb), 0.12);
    border: 1px solid rgba(var(--mo-primary-rgb), 0.35);
    box-shadow: 0 0 28px rgba(var(--mo-primary-rgb), 0.35);
  }

  .p2p-hero-title {
    margin: 0 0 8px;
    font-size: 20px;
    font-weight: 600;
    color: var(--mo-text-primary);
  }

  .p2p-hero-desc {
    margin: 0;
    font-size: 13px;
    line-height: 1.8;
    color: var(--mo-text-secondary);
  }
}

.p2p-onboard {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 20px;
  max-width: 960px;
  margin-inline: auto;

  /* 列向 flex：CTA 用 margin-top:auto 贴底，两卡等高时按钮底边对齐 */
  .p2p-card {
    display: flex;
    flex-direction: column;
  }

  .p2p-desc {
    font-size: 13px;
    margin-bottom: 16px;
  }

  .p2p-join-input {
    margin-bottom: 18px;
  }

  .p2p-card .p2p-card-cta.el-button {
    margin-top: auto;
  }
}

.p2p-group {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 960px;
  margin-inline: auto;
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

/* 卡头「图标块 + 标题」，与仪表盘 .card-header 同一套语言 */
.p2p-card-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;

  h5 {
    margin: 0;
  }
}

.p2p-card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: $mo-radius-sm;
  color: var(--mo-primary);
  background-color: rgba(var(--mo-primary-rgb), 0.12);
}

.p2p-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;

  .p2p-card-title {
    margin-bottom: 0;
  }

  h5 {
    margin: 0;
  }

  .el-button {
    margin-top: 0;
  }
}

/* 说明文字统一 12px / secondary（引导卡内提到 13px），相邻段收紧节奏，
   橙色的 .conflict-text 仍是这一叠文字里唯一的强调色。 */
.p2p-desc {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--mo-text-secondary, rgba(255, 255, 255, 0.55));

  & + .p2p-desc {
    margin-top: 3px;
  }
}

/* 邀请码块与虚拟地址说明之间的分组分隔线 */
.p2p-section {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--mo-glass-border);

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
  background: var(--mo-glass-chrome-background);
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
  margin-inline: auto;
  text-align: center;

  .el-icon-loading {
    display: inline-block;
    margin-top: 12px;
    font-size: 22px;
    color: var(--mo-primary);
  }
}

/* 文件传输卡片：一行一个传输（发送/接收共用） */
.p2p-file-row {
  padding: 10px 0;

  & + .p2p-file-row {
    border-top: 1px solid var(--mo-glass-border);
  }

  .el-progress {
    margin: 8px 0 6px;
  }
}

.p2p-file-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.p2p-file-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--mo-text-primary);
}

.p2p-file-peer {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--mo-text-secondary);
}

.p2p-file-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--mo-text-secondary);

  .fail-text {
    color: var(--p2p-bad-text);
  }
}

.p2p-file-actions {
  margin-top: 8px;
  text-align: right;
}

.dir-path {
  word-break: break-all;
}

/* Rows are a fixed 6-track grid — same info type = same column, content
   centered on that column's axis (align/justify below). Tracks 2-6 are FIXED
   px so every row computes identical tracks: an fr/max-content mix made the
   fr columns shift whenever a row's actions cell differed (self row has
   none, pending has two buttons). Missing cells leave an empty fixed track,
   which still holds the column.
   Budget at the 1024px default window (row inner 735px): fixed 576 + 5×8 gaps
   = 616, leaving the name track 119px — every member stays on ONE line. */
.p2p-row {
  display: grid;
  grid-template-columns: minmax(56px, 1fr) 80px 88px 56px 100px 252px;
  align-items: center;
  justify-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin: 0 -12px;
  border-top: 1px solid var(--mo-glass-border);
  border-radius: $mo-radius-sm;
  transition: $mo-transition-fast;

  &:hover {
    background: var(--mo-glass-background-hover);
  }

  /* ① 姓名 ② 徽章(群主/我) ③ VIP/指纹 ④ 在线状态 ⑤ 延迟+测速 ⑥ 操作（贴右） */
  .p2p-cell-name {
    grid-column: 1;
  }

  .p2p-cell-badges {
    grid-column: 2;
  }

  .p2p-cell-vip,
  .p2p-cell-fp {
    grid-column: 3;
  }

  .p2p-cell-status {
    grid-column: 4;
  }

  .p2p-cell-stats {
    grid-column: 5;
  }

  .p2p-cell-actions {
    grid-column: 6;
    justify-self: end;
  }

  &.pending {
    background: rgba(var(--mo-primary-rgb), 0.06);
    border-top: none;
    border-left: 2px solid var(--mo-primary);
    padding: 10px 12px;
    margin-bottom: 8px;

    &:hover {
      background: rgba(var(--mo-primary-rgb), 0.1);
    }
  }

  &.is-self {
    opacity: 0.85;
  }

  &:first-of-type {
    border-top: none;
  }

  @media (max-width: 760px) {
    /* 极窄窗才降级为两行：上排 姓名|徽章|状态|按钮，下排 VIP·指纹 | 延迟
       （定宽同理——auto 轨道会随行内容漂移） */
    grid-template-columns: minmax(0, 1fr) 80px 84px 252px;
    gap: 8px;

    .p2p-cell-name {
      grid-column: 1;
      grid-row: 1;
    }

    .p2p-cell-badges {
      grid-column: 2;
      grid-row: 1;
    }

    .p2p-cell-status {
      grid-column: 3;
      grid-row: 1;
    }

    .p2p-cell-actions {
      grid-column: 4;
      grid-row: 1;
    }

    .p2p-cell-vip,
    .p2p-cell-fp {
      grid-column: 1;
      grid-row: 2;
      justify-self: start;
    }

    .p2p-cell-stats {
      grid-column: 2 / span 3;
      grid-row: 2;
      justify-self: end;
    }
  }

  /* 最小窗口（窗口最小宽度 478）：上一条断点里 80+84+252 三列定宽仍然超出
     可用宽度，按钮会被裁掉且没有横向滚动条可救。这里再降一级——两列轨道，
     按钮整行放到第三排并允许换行，保证任何宽度下都能点到。 */
  @media (max-width: 560px) {
    grid-template-columns: minmax(0, 1fr) 76px;

    .p2p-cell-status {
      grid-column: 2;
      grid-row: 1;
      justify-self: end;
    }

    .p2p-cell-badges {
      grid-column: 2;
      grid-row: 2;
      justify-self: end;
    }

    .p2p-cell-vip,
    .p2p-cell-fp {
      grid-column: 1;
      grid-row: 2;
      justify-self: start;
    }

    .p2p-cell-actions {
      grid-column: 1 / -1;
      grid-row: 3;
      justify-self: stretch;
      justify-content: flex-start;
      flex-wrap: wrap;
    }

    .p2p-cell-stats {
      grid-column: 1 / -1;
      grid-row: 4;
      justify-self: start;
    }
  }
}

.p2p-cell {
  min-width: 0;
  max-width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
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
  flex-wrap: nowrap;
  gap: 0;

  .el-button {
    padding: 5px 10px;
  }

  .el-button + .el-button {
    margin-left: 6px;
  }
}

/* 延迟在上、测速在下各占一行：100px 定宽下两个 span 同行必换行断字 */
.p2p-cell-stats {
  flex-direction: column;
  gap: 2px;

  .p2p-latency,
  .p2p-speed {
    white-space: nowrap;
  }
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
    /* 与仪表盘 .live-dot.active 同款呼吸环 */
    box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.6);
    animation: mo-pulse-ring 1.8s $mo-ease-standard infinite;
  }
}

.p2p-status-text {
  font-size: 12px;
  color: var(--mo-text-secondary);
}

/* layout lives in .p2p-cell-actions (single source of truth);
   this block only resets the vertical button margin the card CSS adds */
.p2p-row-actions {
  .el-button {
    margin-top: 0;
  }
}

.p2p-latency {
  font-family: "SF Mono", Consolas, "Cascadia Mono", "Courier New", monospace;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: $mo-radius-pill;
  border: 1px solid transparent;
  white-space: nowrap;

  &.ok {
    color: var(--p2p-ok-text);
    background: rgba(var(--p2p-ok-rgb), 0.12);
    border-color: rgba(var(--p2p-ok-rgb), 0.35);
  }
  &.mid {
    color: var(--p2p-warn-text);
    background: rgba(var(--p2p-warn-rgb), 0.12);
    border-color: rgba(var(--p2p-warn-rgb), 0.35);
  }
  &.bad {
    color: var(--p2p-bad-text);
    background: rgba(var(--p2p-bad-rgb), 0.12);
    border-color: rgba(var(--p2p-bad-rgb), 0.35);
  }
  &.na {
    color: var(--mo-text-secondary, rgba(255, 255, 255, 0.45));
    background: var(--mo-glass-chrome-background);
    border-color: var(--mo-glass-border);
  }
}

.p2p-speed {
  font-family: "SF Mono", Consolas, "Cascadia Mono", "Courier New", monospace;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: $mo-radius-pill;
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

/* 未完成接收占用 + 清理 */
.p2p-parts {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
}

.p2p-parts-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--mo-text-secondary);
}

/* 最近传输（最多 5 条，只读历史） */
.p2p-recent {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--mo-border-color, rgba(255, 255, 255, 0.08));
}

.p2p-recent-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  line-height: 20px;
}

.p2p-recent-name {
  flex: 0 1 auto;
  max-width: 45%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--mo-text-regular, rgba(255, 255, 255, 0.75));
}

.p2p-recent-meta {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--mo-text-secondary);
}

/* 待审批行第二行：来源地址 + 已等待时长 */
.p2p-pending-meta {
  font-size: 11px;
  color: var(--mo-text-secondary);
  white-space: nowrap;
}

.p2p-vip {
  padding: 2px 10px;
  border-radius: $mo-radius-pill;
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
  color: var(--p2p-warn-text);
}

.p2p-field {
  & + .p2p-field {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--mo-glass-border);
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
  border-radius: $mo-radius-pill;
  background: var(--mo-glass-chrome-background);
  border: 1px solid var(--mo-glass-border);
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

/* .el-input 自带 width:100%（同特异性、打包顺序靠后），多挂一级
   .el-input 类保证 120px 生效，端口输入和「添加」才能留在同一行 */
.p2p-port-input.el-input {
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

/* 群主独占时的成员空态（功能色与次级表面已全走 CSS 变量，
   暗色在 .p2p-body 覆写一次即可，无需再按类逐条 .theme-dark） */
.p2p-members-empty {
  margin-top: 8px;
}
</style>
