import type { MainProcessContext } from '../main/context'
import { exportService } from './exportService'

// 每分钟 tick 一次，检查各同步任务是否到期（不同任务可配不同间隔）
const CHECK_INTERVAL_MS = 60 * 1000
// 启动 30 秒后先跑一次：已有游标则做增量，无游标则做首次全量
const STARTUP_DELAY_MS = 30_000
// 增量窗口向前重叠 10 分钟，靠 ChatLab 的 platformMessageId 去重吸收边界重叠
const OVERLAP_SECONDS = 600
// 每批推送的消息条数上限（协议建议 5000）
const BATCH_SIZE = 5000
// 默认 ChatLab API 地址
const DEFAULT_BASE_URL = 'http://127.0.0.1:3110'
// 「每天」同步的默认时间点
const DEFAULT_DAILY_TIME = '03:00'

/** 解析 "HH:mm" 为 [hour, minute]；非法时回退默认 03:00。 */
function parseDailyTime(dailyTime?: string): [number, number] {
  const raw = String(dailyTime || '').trim()
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(raw)
  if (match) {
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return [hour, minute]
    }
  }
  const [defaultHour, defaultMinute] = DEFAULT_DAILY_TIME.split(':').map(Number)
  return [defaultHour, defaultMinute]
}

export interface ChatLabSyncJob {
  sessionId: string
  sessionName: string
  enabled: boolean
  intervalMinutes: number
  dailyTime?: string
  lastSyncedAt?: number
  lastMessageId?: string
  lastRunAt?: number
}

export interface ChatLabSyncResult {
  sessionId: string
  sessionName: string
  ok: boolean
  written: number
  duplicate: number
  error?: string
}

export interface ChatLabTestResult {
  ok: boolean
  error?: string
  info?: { name?: string; version?: string; sessionCount?: number }
}

export interface ChatLabSyncLogEntry {
  runId: string
  sessionId: string
  sessionName: string
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

// 内存保留最近日志条数上限
const MAX_LOG_ENTRIES = 500

class ChatLabSyncService {
  private ctx: MainProcessContext | null = null
  private timer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private running = false
  // sessionId -> 上次尝试时间戳（ms）。仅内存，用于失败退避（5 分钟内不重复尝试）。
  private lastAttemptAt = new Map<string, number>()
  // 最近同步日志（内存环形缓冲，供前端查看；也经 broadcastToWindows 实时推送）
  private recentLogs: ChatLabSyncLogEntry[] = []

  init(ctx: MainProcessContext): void {
    if (this.timer) return
    this.ctx = ctx
    this.timer = setInterval(() => {
      void this.tick()
    }, CHECK_INTERVAL_MS)
    this.startupTimer = setTimeout(() => {
      void this.tick()
    }, STARTUP_DELAY_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    this.ctx = null
    this.lastAttemptAt.clear()
  }

  private getToken(): string {
    return String(this.ctx?.getConfigService()?.get('chatLabToken') || '').trim()
  }

  private getBaseUrl(): string {
    const url = String(this.ctx?.getConfigService()?.get('chatLabBaseUrl') || '').trim()
    return (url || DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  private getJobs(): ChatLabSyncJob[] {
    const jobs = this.ctx?.getConfigService()?.get('chatLabSyncJobs')
    return Array.isArray(jobs) ? jobs : []
  }

  private persistJob(job: ChatLabSyncJob): void {
    const jobs = this.getJobs().map((item) => (item.sessionId === job.sessionId ? job : item))
    this.ctx?.getConfigService()?.set('chatLabSyncJobs', jobs)
  }

  private log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
    const logService = this.ctx?.getLogService()
    if (!logService) return
    logService[level]('ChatLabSync', message, extra)
  }

  /** 记录一条同步日志：写入内存缓冲、经 LogService 落盘、并广播给所有窗口实时展示。 */
  private emitLog(runId: string, job: ChatLabSyncJob, level: 'info' | 'warn' | 'error', message: string): void {
    const entry: ChatLabSyncLogEntry = {
      runId,
      sessionId: job.sessionId,
      sessionName: job.sessionName || job.sessionId,
      at: Date.now(),
      level,
      message
    }
    this.recentLogs.push(entry)
    if (this.recentLogs.length > MAX_LOG_ENTRIES) {
      this.recentLogs.splice(0, this.recentLogs.length - MAX_LOG_ENTRIES)
    }
    this.log(level, `[${job.sessionName || job.sessionId}] ${message}`)
    try {
      this.ctx?.broadcastToWindows('chatlab-sync:log', entry)
    } catch {
      // 广播失败不影响同步本身
    }
  }

  /** 返回最近同步日志（供设置页查看历史）。 */
  getRecentLogs(): ChatLabSyncLogEntry[] {
    return this.recentLogs.slice()
  }

  /**
   * 计算任务下次应触发的时间戳（ms）。
   * - 「每天」（intervalMinutes >= 1440）：按 dailyTime 定点，到点触发；无 dailyTime 用 03:00。
   * - 间隔型（每小时/每 6 小时）：以上次实际运行时间 + 间隔计算。
   * - 从未运行过（无 lastRunAt 也无游标）：返回 0 表示立即，触发首次全量。
   */
  private computeNextRun(job: ChatLabSyncJob, nowMs: number): number {
    if (!job.lastRunAt && !job.lastSyncedAt) return 0

    if (job.intervalMinutes >= 1440) {
      const [hour, minute] = parseDailyTime(job.dailyTime)
      const now = new Date(nowMs)
      const todayTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)

      // 还没到今天的时间点：等今天到点
      if (nowMs < todayTime.getTime()) {
        return todayTime.getTime()
      }

      // 今天时间点已过：若今天还没同步过（启动补跑错过的点），立即补一次
      if (!this.ranToday(job, now)) {
        return 0
      }

      // 今天已同步过：顺延到明天同一时间点
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0)
      return tomorrow.getTime()
    }

    const intervalMs = Math.max(1, job.intervalMinutes || 1440) * 60 * 1000
    return (job.lastRunAt ? job.lastRunAt * 1000 : 0) + intervalMs
  }

  /** 判断任务今天（本地日期）是否已经跑过。 */
  private ranToday(job: ChatLabSyncJob, now: Date): boolean {
    if (!job.lastRunAt) return false
    const last = new Date(job.lastRunAt * 1000)
    return (
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate()
    )
  }

  private genRunId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  private async tick(): Promise<void> {
    if (this.running) return
    if (!this.getToken()) return
    const jobs = this.getJobs().filter((job) => job.enabled && job.sessionId)
    if (jobs.length === 0) return

    this.running = true
    try {
      const nowMs = Date.now()
      for (const job of jobs) {
        if (nowMs < this.computeNextRun(job, nowMs)) continue
        // 失败退避：5 分钟内不重复尝试（成功则由 lastRunAt 决定下次）
        const lastAttempt = this.lastAttemptAt.get(job.sessionId) ?? 0
        if (nowMs - lastAttempt < 5 * 60 * 1000) continue
        this.lastAttemptAt.set(job.sessionId, nowMs)

        const result = await this.syncOne(job, this.genRunId())
        if (result.ok) {
          job.lastRunAt = Math.floor(nowMs / 1000)
          this.persistJob(job)
        }
      }
    } finally {
      this.running = false
    }
  }

  /** 立即同步所有启用的任务（供设置页「立即同步」触发）。 */
  async syncNow(): Promise<ChatLabSyncResult[]> {
    if (!this.getToken()) return []
    const jobs = this.getJobs().filter((job) => job.enabled && job.sessionId)
    const results: ChatLabSyncResult[] = []
    const nowMs = Date.now()
    for (const job of jobs) {
      const result = await this.syncOne(job, this.genRunId())
      results.push(result)
      if (result.ok) {
        job.lastRunAt = Math.floor(nowMs / 1000)
        this.persistJob(job)
      }
    }
    return results
  }

  /** 测试 ChatLab API 连通性与 Token 有效性。 */
  async testConnection(): Promise<ChatLabTestResult> {
    const token = this.getToken()
    if (!token) return { ok: false, error: '未配置 ChatLab Token' }
    const baseUrl = this.getBaseUrl()
    try {
      const res = await fetch(`${baseUrl}/api/v1/status`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        return { ok: false, error: `HTTP ${res.status} ${detail.slice(0, 200)}` }
      }
      const data = (await res.json().catch(() => null)) as { data?: ChatLabTestResult['info'] } | null
      return { ok: true, info: data?.data }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async syncOne(job: ChatLabSyncJob, runId: string): Promise<ChatLabSyncResult> {
    const token = this.getToken()
    const baseUrl = this.getBaseUrl()
    const result: ChatLabSyncResult = {
      sessionId: job.sessionId,
      sessionName: job.sessionName || job.sessionId,
      ok: false,
      written: 0,
      duplicate: 0
    }

    if (!token) {
      result.error = '未配置 ChatLab Token'
      this.emitLog(runId, job, 'error', '未配置 ChatLab Token')
      return result
    }

    try {
      const now = Math.floor(Date.now() / 1000)
      const isIncremental = Boolean(job.lastSyncedAt)
      this.emitLog(runId, job, 'info', isIncremental ? '开始增量同步' : '开始全量同步')

      // 增量窗口：从上次同步时间往前重叠 OVERLAP_SECONDS；无游标则首次全量
      const dateRange = job.lastSyncedAt ? { start: job.lastSyncedAt - OVERLAP_SECONDS, end: now } : undefined

      const built = await exportService.buildChatLabPayload(job.sessionId, dateRange, {
        transcribeVoices: true,
        maxTranscribe: 30
      })
      if (!built.success) {
        if (built.error === '没有消息可同步' || built.error === '未找到该会话的消息') {
          // 无新消息：首次同步时也落一个游标，避免下次重复全量扫描
          if (!job.lastSyncedAt) {
            job.lastSyncedAt = now
            this.persistJob(job)
          }
          result.ok = true
          this.emitLog(runId, job, 'info', '无新消息，跳过')
          return result
        }
        result.error = built.error
        this.emitLog(runId, job, 'error', `读取消息失败：${built.error}`)
        return result
      }

      const payload = built.payload!
      const messages = payload.messages
      if ((built.transcribedCount || 0) > 0) {
        this.emitLog(runId, job, 'info', `自动转写 ${built.transcribedCount} 条语音`)
      }
      this.emitLog(runId, job, 'info', `待同步消息 ${messages.length} 条`)
      if (messages.length === 0) {
        result.ok = true
        return result
      }

      const chatLabSessionId = `wechat_${job.sessionId}`

      // 按时间顺序分批（messages 已按 createTime 升序）
      const batchCount = Math.ceil(messages.length / BATCH_SIZE)
      let maxTs = job.lastSyncedAt ?? 0
      let lastMsgId = job.lastMessageId

      for (let i = 0; i < batchCount; i++) {
        const batch = messages.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
        const isFirst = i === 0
        // 首批携带 chatlab/meta/members 触发会话创建；后续批次只带 messages
        const body: Record<string, unknown> = isFirst
          ? { chatlab: payload.chatlab, meta: payload.meta, members: payload.members, messages: batch }
          : { messages: batch }
        const idempotencyKey = `${chatLabSessionId}-${i}-${dateRange?.start ?? 0}`
        this.emitLog(runId, job, 'info', `推送第 ${i + 1}/${batchCount} 批（${batch.length} 条）…`)
        const pushed = await this.pushWithRetry(chatLabSessionId, body, token, baseUrl, idempotencyKey)
        if (!pushed.ok) {
          result.error = pushed.error
          this.emitLog(runId, job, 'error', `推送第 ${i + 1} 批失败：${pushed.error}`)
          return result
        }
        result.written += pushed.written ?? batch.length
        result.duplicate += pushed.duplicate ?? 0
      }

      // 推进游标：以本批最大时间戳为准；失败时上面已提前 return，游标不动
      for (const message of messages) {
        if (message.timestamp > maxTs) maxTs = message.timestamp
      }
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.platformMessageId) lastMsgId = lastMessage.platformMessageId
      job.lastSyncedAt = maxTs || now
      if (lastMsgId) job.lastMessageId = lastMsgId
      this.persistJob(job)

      result.ok = true
      this.emitLog(runId, job, 'info', `同步完成：写入 ${result.written} 条，去重 ${result.duplicate} 条`)
      return result
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e)
      this.emitLog(runId, job, 'error', `同步异常：${result.error}`)
      return result
    }
  }

  private async pushWithRetry(
    sessionId: string,
    body: Record<string, unknown>,
    token: string,
    baseUrl: string,
    idempotencyKey: string
  ): Promise<{ ok: boolean; error?: string; written?: number; duplicate?: number }> {
    const maxAttempts = 3
    const delaysMs = [5000, 15000, 45000]
    let status = 0
    let detail = ''

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let errorCode = ''
      try {
        const res = await fetch(`${baseUrl}/api/v1/imports/${sessionId}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey
          },
          body: JSON.stringify(body)
        })
        status = res.status

        if (res.ok) {
          const data = (await res.json().catch(() => null)) as {
            data?: { batch?: { writtenCount?: number; duplicateCount?: number } }
          } | null
          return {
            ok: true,
            written: data?.data?.batch?.writtenCount ?? (body.messages as unknown[])?.length,
            duplicate: data?.data?.batch?.duplicateCount ?? 0
          }
        }

        const parsed = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
        errorCode = parsed?.error?.code || ''
        detail = parsed?.error?.message || (await res.text().catch(() => ''))

        // 可重试：409 导入进行中 / 幂等键待完成，以及所有 5xx
        const retryable =
          status === 409
            ? errorCode !== 'IDEMPOTENCY_CONFLICT'
            : status >= 500

        if (!retryable) break
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e)
      }

      if (attempt < maxAttempts - 1) {
        const jitter = Math.floor(Math.random() * 1000)
        await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt] + jitter))
      }
    }

    return { ok: false, error: `HTTP ${status || 'network'} ${detail.slice(0, 200)}`.trim() }
  }
}

export const chatLabSyncService = new ChatLabSyncService()
