import { useState } from 'react'
import { CircleCheck, CircleDashed, CircleExclamation, CircleXmark, Microphone } from '@gravity-ui/icons'
import { Button, Checkbox, Label, Modal, ProgressBar } from '@heroui/react'
import { formatBatchDateLabel } from '../utils/time'

type Progress = { current: number; total: number; phase: 'saving' | 'transcribing' }
type Result = { success: number; fail: number; failedCreateTimes: number[] }

interface BatchTranscribeModalProps {
  showConfirm: boolean
  onCloseConfirm: () => void
  voiceDates: string[]
  countByDate: Map<string, number>
  selectedDates: Set<string>
  selectedMessageCount: number
  onToggleDate: (date: string) => void
  onSelectAllDates: () => void
  onClearAllDates: () => void
  onConfirm: () => void | Promise<void>
  showProgress: boolean
  progress: Progress
  showResult: boolean
  result: Result
  onCloseResult: () => void
}

function formatFailedVoiceTime(createTime: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(createTime * 1000))
}

export function BatchTranscribeModal({
  showConfirm,
  onCloseConfirm,
  voiceDates,
  countByDate,
  selectedDates,
  selectedMessageCount,
  onToggleDate,
  onSelectAllDates,
  onClearAllDates,
  onConfirm,
  showProgress,
  progress,
  showResult,
  result,
  onCloseResult
}: BatchTranscribeModalProps) {
  const [showFailureDetails, setShowFailureDetails] = useState(false)

  const closeResult = () => {
    setShowFailureDetails(false)
    onCloseResult()
  }

  return (
    <>
      <Modal.Backdrop isOpen={showConfirm} onOpenChange={(open) => { if (!open) onCloseConfirm() }}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-110">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Icon className="bg-default text-foreground">
                <Microphone className="size-5" />
              </Modal.Icon>
              <Modal.Heading>批量语音转文字</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm text-muted">选择要转写的日期（仅显示有语音的日期），然后开始转写。</p>

              {voiceDates.length > 0 && (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Button size="sm" variant="tertiary" onPress={onSelectAllDates}>全选</Button>
                    <Button size="sm" variant="tertiary" onPress={onClearAllDates}>取消全选</Button>
                  </div>
                  <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                    {voiceDates.map(dateStr => {
                      const count = countByDate.get(dateStr) ?? 0
                      const checked = selectedDates.has(dateStr)
                      return (
                        <li key={dateStr}>
                          <Checkbox
                            className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-surface"
                            isSelected={checked}
                            onChange={() => onToggleDate(dateStr)}
                          >
                            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                            <Checkbox.Content className="flex flex-1 items-center justify-between">
                              <Label>{formatBatchDateLabel(dateStr)}</Label>
                              <span className="text-xs text-muted">{count} 条语音</span>
                            </Checkbox.Content>
                          </Checkbox>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="mt-3 flex flex-col gap-1 text-sm">
                <div>
                  <span className="text-muted">已选：</span>
                  <span className="font-medium">{selectedDates.size} 天有语音，共 {selectedMessageCount} 条语音</span>
                </div>
                <div>
                  <span className="text-muted">预计耗时：</span>
                  <span className="font-medium">约 {Math.ceil(selectedMessageCount * 2 / 60)} 分钟</span>
                </div>
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning-soft-foreground">
                <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
                <span>批量转写可能需要较长时间，处理过程中可以继续使用其他功能。本地语音和文字均存在时会自动跳过。</span>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="secondary">取消</Button>
              <Button onPress={onConfirm}>
                <Microphone className="size-4" />
                开始转写
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={showProgress} isDismissable={false}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-90">
            <Modal.Header>
              <Modal.Icon className="bg-default text-foreground">
                <CircleDashed className="size-5 animate-spin" />
              </Modal.Icon>
              <Modal.Heading>{progress.phase === 'saving' ? '正在保存语音...' : '正在转换文字...'}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <ProgressBar aria-label="转写进度" value={progress.current} maxValue={Math.max(1, progress.total)}>
                <Label>
                  {progress.phase === 'saving' ? '已保存' : '已转换'} {progress.current} / {progress.total} 条
                </Label>
                <ProgressBar.Output />
                <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
              </ProgressBar>
              <p className="mt-2 text-xs text-muted">
                {progress.phase === 'saving'
                  ? '全部语音保存完成后再开始文字转换'
                  : '正在使用本地语音文件转换文字'}
              </p>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={showResult} onOpenChange={(open) => { if (!open) closeResult() }}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-90">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Icon className="bg-success-soft text-success-soft-foreground">
                <CircleCheck className="size-5" />
              </Modal.Icon>
              <Modal.Heading>转写完成</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <CircleCheck width={18} height={18} className="text-success" />
                  <span className="text-muted">成功：</span>
                  <span className="font-medium">{result.success} 条</span>
                </div>
                {result.fail > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <CircleXmark width={18} height={18} className="text-danger" />
                      <span className="text-muted">失败：</span>
                      <span className="font-medium">{result.fail} 条</span>
                    </div>
                    <Button size="sm" variant="tertiary" onPress={() => setShowFailureDetails(true)}>
                      查看详情
                    </Button>
                  </div>
                )}
              </div>
              {result.fail > 0 && (
                <div className="mt-3 flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning-soft-foreground">
                  <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
                  <span>部分语音转写失败，可能是语音文件损坏或网络问题</span>
                </div>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close">确定</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop
        isOpen={showResult && showFailureDetails}
        onOpenChange={(open) => { if (!open) setShowFailureDetails(false) }}
      >
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-105">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Icon className="bg-danger-soft text-danger-soft-foreground">
                <CircleXmark className="size-5" />
              </Modal.Icon>
              <Modal.Heading>转写失败详情</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm text-muted">以下时间的语音转写失败：</p>
              {result.failedCreateTimes.length > 0 ? (
                <ol className="mt-2 flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
                  {result.failedCreateTimes.map((createTime, index) => (
                    <li
                      key={`${createTime}-${index}`}
                      className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2 text-sm"
                    >
                      <span className="w-6 shrink-0 text-right text-xs text-muted">{index + 1}</span>
                      <time dateTime={new Date(createTime * 1000).toISOString()} className="font-medium">
                        {formatFailedVoiceTime(createTime)}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 rounded-lg bg-surface px-3 py-2 text-sm text-muted">未记录到失败时间</p>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close">关闭</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
