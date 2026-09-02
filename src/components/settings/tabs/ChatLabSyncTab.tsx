import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  Chip,
  ComboBox,
  Description,
  Input,
  InputGroup,
  Label,
  ListBox,
  Modal,
  Select,
  Switch,
  TextField,
  TimeField,
  type Key
} from '@heroui/react'
import { Time } from '@internationalized/date'
import { ArrowRotateLeft, Check, CircleCheck, CircleExclamation, PlugConnection, Plus, TrashBin } from '@gravity-ui/icons'
import type { ChatSession } from '../../../types/models'
import { fetchAllSessions } from '../../../services/chatSessions'

interface ChatLabSyncJob {
  sessionId: string
  sessionName: string
  enabled: boolean
  intervalMinutes: number
  dailyTime?: string
  lastSyncedAt?: number
  lastMessageId?: string
  lastRunAt?: number
}

interface ChatLabSyncLogEntry {
  runId: string
  sessionId: string
  sessionName: string
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

interface ChatLabSyncTabProps {
  showMessage: (text: string, success: boolean) => void
}

const INTERVAL_OPTIONS = [
  { value: 60, label: '每小时' },
  { value: 360, label: '每 6 小时' },
  { value: 1440, label: '每天' }
]
const DEFAULT_INTERVAL = 1440

function intervalLabel(minutes: number): string {
  return INTERVAL_OPTIONS.find((o) => o.value === minutes)?.label || `每 ${minutes} 分钟`
}

/** "HH:mm" → Time；非法或缺省回退 03:00。 */
function toDailyTimeValue(dailyTime?: string): Time {
  const raw = String(dailyTime || '03:00')
  const [h, m] = raw.split(':').map(Number)
  if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
    return new Time(h, m)
  }
  return new Time(3, 0)
}

function formatLastSyncedAt(ts?: number): string {
  if (!ts) return '未同步'
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatLogTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function isPrivateSession(s: ChatSession): boolean {
  const u = String(s.username || '').toLowerCase()
  if (!u) return false
  if (u.includes('@chatroom')) return false
  if (u.startsWith('gh_')) return false
  if (s.isOfficialAccount || s.isOfficialFolder || s.isFoldGroup) return false
  return true
}

export default function ChatLabSyncTab({ showMessage }: ChatLabSyncTabProps) {
  const [token, setToken] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [jobs, setJobs] = useState<ChatLabSyncJob[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [logModalOpen, setLogModalOpen] = useState(false)
  const [logs, setLogs] = useState<ChatLabSyncLogEntry[]>([])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.electronAPI.config.get('chatLabToken'),
      window.electronAPI.config.get('chatLabBaseUrl'),
      window.electronAPI.config.get('chatLabSyncJobs')
    ]).then(([tok, url, jobList]) => {
      if (cancelled) return
      setToken(String(tok || ''))
      setBaseUrl(String(url || 'http://127.0.0.1:3110'))
      setJobs(Array.isArray(jobList) ? (jobList as ChatLabSyncJob[]) : [])
    })

    setSessionsLoading(true)
    fetchAllSessions()
      .then((all) => {
        if (!cancelled) setSessions(all.filter(isPrivateSession))
      })
      .catch((e) => {
        if (!cancelled) showMessage(`加载会话列表失败：${e instanceof Error ? e.message : String(e)}`, false)
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [showMessage])

  const persistJobs = useCallback((next: ChatLabSyncJob[]) => {
    setJobs(next)
    void window.electronAPI.config.set('chatLabSyncJobs', next)
  }, [])

  const handleTokenChange = useCallback((value: string) => {
    setToken(value)
    setTestResult(null)
    void window.electronAPI.config.set('chatLabToken', value)
  }, [])

  const handleBaseUrlChange = useCallback((value: string) => {
    setBaseUrl(value)
    setTestResult(null)
    void window.electronAPI.config.set('chatLabBaseUrl', value)
  }, [])

  const handleAddSession = useCallback(() => {
    if (!selectedSession) {
      showMessage('请先选择要同步的私聊会话', false)
      return
    }
    if (jobs.some((j) => j.sessionId === selectedSession)) {
      showMessage('该会话已在同步列表中', false)
      return
    }
    const session = sessions.find((s) => s.username === selectedSession)
    const next: ChatLabSyncJob = {
      sessionId: selectedSession,
      sessionName: session?.displayName || session?.username || selectedSession,
      enabled: true,
      intervalMinutes: DEFAULT_INTERVAL,
      dailyTime: '03:00'
    }
    persistJobs([...jobs, next])
    setSelectedSession(null)
    setSearchKeyword('')
    showMessage(`已添加「${next.sessionName}」`, true)
  }, [selectedSession, jobs, sessions, persistJobs, showMessage])

  const handleRemove = useCallback((sessionId: string) => {
    persistJobs(jobs.filter((j) => j.sessionId !== sessionId))
  }, [jobs, persistJobs])

  const handleToggle = useCallback((sessionId: string, enabled: boolean) => {
    persistJobs(jobs.map((j) => (j.sessionId === sessionId ? { ...j, enabled } : j)))
  }, [jobs, persistJobs])

  const handleIntervalChange = useCallback((sessionId: string, minutes: number) => {
    persistJobs(jobs.map((j) => (j.sessionId === sessionId ? { ...j, intervalMinutes: minutes } : j)))
  }, [jobs, persistJobs])

  const handleDailyTimeChange = useCallback((sessionId: string, value: Time | null) => {
    if (!value) return
    const timeStr = `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`
    persistJobs(jobs.map((j) => (j.sessionId === sessionId ? { ...j, dailyTime: timeStr } : j)))
  }, [jobs, persistJobs])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.chatLabSync.test()
      if (result.ok) {
        const info = result.info
        const text = info?.name
          ? `连接成功（${info.name}${info.version ? ' ' + info.version : ''}${typeof info.sessionCount === 'number' ? `，${info.sessionCount} 个会话` : ''}）`
          : '连接成功'
        setTestResult({ ok: true, text })
        showMessage('ChatLab 连接成功', true)
      } else {
        setTestResult({ ok: false, text: result.error || '连接失败' })
        showMessage(`连接失败：${result.error || '未知错误'}`, false)
      }
    } finally {
      setTesting(false)
    }
  }, [showMessage])

  const handleSyncNow = useCallback(async () => {
    if (!jobs.some((j) => j.enabled)) {
      showMessage('没有启用的同步任务', false)
      return
    }
    setLogs([])
    setLogModalOpen(true)
    setSyncing(true)
    const off = window.electronAPI.chatLabSync.onLog((entry) => {
      setLogs((prev) => [...prev, entry])
    })
    try {
      await window.electronAPI.chatLabSync.syncNow()
      // 同步会更新游标（lastSyncedAt），刷新本地显示
      const jobList = await window.electronAPI.config.get('chatLabSyncJobs')
      setJobs(Array.isArray(jobList) ? (jobList as ChatLabSyncJob[]) : jobs)
      // 同步结束后拉取完整日志，确保不遗漏广播尾部的条目
      setLogs(await window.electronAPI.chatLabSync.getRecentLogs())
    } finally {
      off()
      setSyncing(false)
    }
  }, [jobs, showMessage])

  const handleOpenLogs = useCallback(async () => {
    setLogs(await window.electronAPI.chatLabSync.getRecentLogs())
    setLogModalOpen(true)
  }, [])

  const availableSessions = sessions.filter((s) => {
    if (jobs.some((j) => j.sessionId === s.username)) return false
    const kw = searchKeyword.trim().toLowerCase()
    if (!kw) return true
    return (
      (s.displayName || '').toLowerCase().includes(kw) ||
      s.username.toLowerCase().includes(kw) ||
      s.summary.toLowerCase().includes(kw)
    )
  })

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Card.Header className="flex-col items-start gap-1">
          <Card.Title>连接 ChatLab</Card.Title>
          <Card.Description>把指定私聊会话定时增量同步到本机 ChatLab。请先在 ChatLab 的「设置 → ChatLab API」开启服务并获取 Token。</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <TextField fullWidth onChange={handleTokenChange} value={token}>
            <Label>API Token</Label>
            <InputGroup fullWidth variant="secondary">
              <InputGroup.Input placeholder="clb_..." type="password" />
            </InputGroup>
            <Description>格式为 clb_ 开头的一串字符，仅保存在本地。</Description>
          </TextField>

          <TextField fullWidth onChange={handleBaseUrlChange} value={baseUrl}>
            <Label>服务地址</Label>
            <InputGroup fullWidth variant="secondary">
              <InputGroup.Input placeholder="http://127.0.0.1:3110" />
            </InputGroup>
            <Description>默认监听 127.0.0.1:3110，一般无需修改。</Description>
          </TextField>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              isDisabled={testing || !token}
              onPress={() => void handleTest()}
            >
              <PlugConnection width={16} height={16} />
              测试连接
            </Button>
            {testResult && (
              <span className={`flex items-center gap-1 text-sm ${testResult.ok ? 'text-success' : 'text-danger'}`}>
                {testResult.ok ? <CircleCheck width={16} height={16} /> : <CircleExclamation width={16} height={16} />}
                {testResult.text}
              </span>
            )}
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header className="flex-col items-start gap-1">
          <Card.Title>同步任务</Card.Title>
          <Card.Description>选择要同步的私聊会话，默认每天同步一次；首次会自动全量导入，之后仅同步新增消息。</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <div className="flex items-end gap-3">
            <ComboBox
              fullWidth
              variant="secondary"
              inputValue={searchKeyword}
              onInputChange={setSearchKeyword}
              selectedKey={selectedSession}
              onSelectionChange={(key: Key | null) => setSelectedSession(key ? String(key) : null)}
              isDisabled={sessionsLoading}
              allowsEmptyCollection
            >
              <Label>添加会话</Label>
              <ComboBox.InputGroup>
                <Input placeholder={sessionsLoading ? '正在加载会话…' : '搜索并选择私聊会话'} />
                <ComboBox.Trigger />
              </ComboBox.InputGroup>
              <ComboBox.Popover>
                <ListBox>
                  {availableSessions.map((s) => (
                    <ListBox.Item key={s.username} id={s.username} textValue={s.displayName || s.username}>
                      {s.displayName || s.username}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </ComboBox.Popover>
            </ComboBox>
            <Button type="button" variant="primary" isDisabled={!selectedSession} onPress={handleAddSession}>
              <Plus width={16} height={16} />
              添加
            </Button>
          </div>

          {jobs.length === 0 ? (
            <p className="text-sm text-foreground-500">暂无同步任务，选择上方会话添加。</p>
          ) : (
            <div className="flex flex-col gap-3">
              {jobs.map((job) => (
                <div key={job.sessionId} className="flex items-center gap-3 rounded-lg border border-divider p-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-sm font-medium">{job.sessionName || job.sessionId}</span>
                    <span className="text-xs text-foreground-500">
                      上次同步：{formatLastSyncedAt(job.lastSyncedAt)}
                    </span>
                  </div>

                  <Select
                    className="w-32"
                    variant="secondary"
                    selectedKey={job.intervalMinutes}
                    onSelectionChange={(key: Key | null) => {
                      if (key != null) handleIntervalChange(job.sessionId, Number(key))
                    }}
                  >
                    <Select.Trigger>
                      <Select.Value>{intervalLabel(job.intervalMinutes)}</Select.Value>
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {INTERVAL_OPTIONS.map((o) => (
                          <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                            {o.label}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>

                  {job.intervalMinutes >= 1440 && (
                    <TimeField
                      className="w-28"
                      granularity="minute"
                      hourCycle={24}
                      shouldForceLeadingZeros
                      value={toDailyTimeValue(job.dailyTime)}
                      onChange={(value) => handleDailyTimeChange(job.sessionId, value)}
                      aria-label={`${job.sessionName || job.sessionId} 每天同步时间`}
                    >
                      <TimeField.Group fullWidth variant="secondary">
                        <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
                      </TimeField.Group>
                    </TimeField>
                  )}

                  <Switch
                    isSelected={job.enabled}
                    onChange={(enabled) => handleToggle(job.sessionId, enabled)}
                    aria-label={`启用 ${job.sessionName || job.sessionId}`}
                  />

                  <Button
                    type="button"
                    variant="ghost"
                    isIconOnly
                    onPress={() => handleRemove(job.sessionId)}
                    aria-label={`删除 ${job.sessionName || job.sessionId}`}
                  >
                    <TrashBin width={16} height={16} />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="primary"
              isDisabled={syncing || !jobs.some((j) => j.enabled)}
              onPress={() => void handleSyncNow()}
            >
              {syncing ? <ArrowRotateLeft width={16} height={16} className="animate-spin" /> : <Check width={16} height={16} />}
              立即同步
            </Button>
            <Button
              type="button"
              variant="secondary"
              onPress={() => void handleOpenLogs()}
            >
              同步日志
            </Button>
            {jobs.some((j) => j.enabled) && (
              <Chip size="sm" variant="soft">
                已启用 {jobs.filter((j) => j.enabled).length} 个任务
              </Chip>
            )}
          </div>
        </Card.Content>
      </Card>

      <Modal.Backdrop
        isOpen={logModalOpen}
        isDismissable={!syncing}
        onOpenChange={setLogModalOpen}
      >
        <Modal.Container placement="center" scroll="inside" size="lg">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>ChatLab 同步日志</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {logs.length === 0 ? (
                <p className="text-sm text-foreground-500">{syncing ? '正在同步…' : '暂无同步日志'}</p>
              ) : (
                <div className="flex max-h-96 flex-col gap-1 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs">
                  {logs.map((entry, idx) => (
                    <div key={`${entry.runId}-${idx}`} className="flex items-start gap-2">
                      <span className="shrink-0 text-foreground-400">{formatLogTime(entry.at)}</span>
                      <span className="shrink-0 text-foreground-500">{entry.sessionName}</span>
                      <span className={entry.level === 'error' ? 'text-danger' : entry.level === 'warn' ? 'text-warning' : undefined}>
                        {entry.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Modal.Body>
            <Modal.Footer className="justify-end">
              <Button type="button" variant="secondary" onPress={() => setLogModalOpen(false)}>
                关闭
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  )
}
