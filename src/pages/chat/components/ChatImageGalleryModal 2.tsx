import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsRotateLeft, CircleDashed, Picture } from '@gravity-ui/icons'
import { Button, Modal, Tabs } from '@heroui/react'
import DateRangePicker from '../../../components/DateRangePicker'
import { formatDateValue } from '../../../components/AppDatePicker'
import type { ChatSession } from '../../../types/models'
import { enqueueDecrypt } from './messageBubble/mediaState'
import { formatDateDivider } from '../utils/time'
import { useTopToast } from '../hooks/useTopToast'

type GalleryImage = {
  localId: number
  serverId: number
  createTime: number
  sortSeq: number
  imageMd5?: string
  imageDatName?: string
}

type ImageQuality = 'thumbnail' | 'large'
type ImageQualityFilter = 'all' | ImageQuality
type ImageLoadState = 'idle' | 'loading' | 'ready' | 'error'

interface ChatImageGalleryModalProps {
  isOpen: boolean
  session: ChatSession
  onOpenChange: (open: boolean) => void
}

interface GalleryImageCardProps {
  image: GalleryImage
  sessionId: string
  knownQuality?: ImageQuality
  onQualityChange: (key: string, quality: ImageQuality) => void
  onUpgradeResult: (success: boolean, message: string) => void
}

const INITIAL_VISIBLE_COUNT = 120
const LOAD_MORE_COUNT = 120
const QUALITY_INSPECTION_CHUNK_SIZE = 120

function imageMessageKey(image: GalleryImage): string {
  return `${image.serverId}-${image.localId}-${image.createTime}-${image.sortSeq}-${image.imageMd5 || image.imageDatName || ''}`
}

function getImageDateKey(image: GalleryImage): string {
  return image.createTime > 0 ? formatDateValue(new Date(image.createTime * 1000)) : ''
}

function getQualityFromPath(path: string): ImageQuality {
  const lower = path.toLowerCase()
  return /(?:_thumb|_t)(?:\.|$)/.test(lower) || /\.t\./.test(lower)
    ? 'thumbnail'
    : 'large'
}

function detectImageMimeFromBase64(base64: string): string {
  try {
    const head = window.atob(base64.slice(0, 48))
    const bytes = Uint8Array.from(head, char => char.charCodeAt(0))
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return 'image/webp'
  } catch { /* 使用 JPEG 作为旧记录兜底 */ }
  return 'image/jpeg'
}

function formatImageTime(createTime: number): string {
  if (!createTime) return '时间未知'
  return new Date(createTime * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function GalleryImageCard({
  image,
  sessionId,
  knownQuality,
  onQualityChange,
  onUpgradeResult,
}: GalleryImageCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const loadingRef = useRef(false)
  const [isVisible, setIsVisible] = useState(false)
  const [loadState, setLoadState] = useState<ImageLoadState>('idle')
  const [localPath, setLocalPath] = useState('')
  const [liveVideoPath, setLiveVideoPath] = useState<string | undefined>()
  const [quality, setQuality] = useState<ImageQuality | null>(knownQuality ?? null)
  const [isUpgrading, setIsUpgrading] = useState(false)
  const [upgradeError, setUpgradeError] = useState('')

  useEffect(() => {
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (knownQuality) setQuality(knownQuality)
  }, [knownQuality])

  const commitQuality = useCallback((nextQuality: ImageQuality) => {
    setQuality(nextQuality)
    onQualityChange(imageMessageKey(image), nextQuality)
  }, [image, onQualityChange])

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        setIsVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '480px 0px', threshold: 0 })
    observer.observe(card)
    return () => observer.disconnect()
  }, [])

  const loadImage = useCallback((force = false) => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoadState('loading')

    enqueueDecrypt(async () => {
      if (!mountedRef.current) {
        loadingRef.current = false
        return
      }
      const payload = {
        sessionId,
        imageMd5: image.imageMd5,
        imageDatName: image.imageDatName,
        createTime: image.createTime,
      }

      try {
        let result = force
          ? await window.electronAPI.image.decrypt({ ...payload, force: true, quick: false })
          : await window.electronAPI.image.resolveCache(payload)

        if ((!result.success || !result.localPath) && !force) {
          result = await window.electronAPI.image.decrypt({ ...payload, force: false, quick: true })
        }

        if (!mountedRef.current) return
        if (result.success && result.localPath) {
          setLocalPath(result.localPath)
          setLiveVideoPath(result.liveVideoPath)
          const isThumbnail = result.isThumb ?? (getQualityFromPath(result.localPath) === 'thumbnail')
          commitQuality(isThumbnail ? 'thumbnail' : 'large')
          setLoadState('ready')
        } else if (image.localId > 0) {
          const fallback = await window.electronAPI.chat.getImageData(sessionId, String(image.localId), image.createTime)
          if (!mountedRef.current) return
          if (fallback.success && fallback.data) {
            setLocalPath(`data:${detectImageMimeFromBase64(fallback.data)};base64,${fallback.data}`)
            setLiveVideoPath(fallback.liveVideoPath)
            commitQuality(fallback.isThumb ? 'thumbnail' : 'large')
            setLoadState('ready')
          } else {
            setLoadState('error')
          }
        } else {
          setLoadState('error')
        }
      } catch {
        if (mountedRef.current) setLoadState('error')
      } finally {
        loadingRef.current = false
      }
    })
  }, [commitQuality, image.createTime, image.imageDatName, image.imageMd5, image.localId, sessionId])

  useEffect(() => {
    if (isVisible && loadState === 'idle') loadImage()
  }, [isVisible, loadImage, loadState])

  const handlePress = () => {
    if (!localPath) {
      loadImage(true)
      return
    }
    void window.electronAPI.window.openImageViewerWindow(localPath, liveVideoPath).catch((error) => {
      console.error('[ChatImageGallery] 打开图片查看器失败:', error)
    })
  }

  const handleUpgrade = async () => {
    if (isUpgrading) return
    setIsUpgrading(true)
    setUpgradeError('')
    try {
      const result = await window.electronAPI.image.decrypt({
        sessionId,
        imageMd5: image.imageMd5,
        imageDatName: image.imageDatName,
        createTime: image.createTime,
        force: true,
        quick: false,
      })
      if (!mountedRef.current) return
      if (result.success && result.localPath && result.isThumb !== true) {
        setLocalPath(result.localPath)
        setLiveVideoPath(result.liveVideoPath)
        setLoadState('ready')
        commitQuality('large')
        onUpgradeResult(true, '大图获取成功')
      } else {
        const message = result.error || '获取失败，当前仍是缩略图'
        setUpgradeError(message)
        onUpgradeResult(false, message)
      }
    } catch (cause) {
      if (!mountedRef.current) return
      const message = cause instanceof Error ? cause.message : '大图获取失败'
      setUpgradeError(message)
      onUpgradeResult(false, message)
    } finally {
      if (mountedRef.current) setIsUpgrading(false)
    }
  }

  const timeLabel = formatImageTime(image.createTime)

  return (
    <div
      ref={cardRef}
      className="group relative aspect-square min-w-0 overflow-hidden rounded-xl border border-border bg-default shadow-sm transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md"
    >
      <button
        type="button"
        className="absolute inset-0 size-full text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
        aria-label={`${quality === 'thumbnail' ? '缩略图' : quality === 'large' ? '大图' : '图片'}，${timeLabel}`}
        onClick={handlePress}
      >
        {localPath ? (
          <img
            src={localPath}
            alt={`${timeLabel}的聊天图片`}
            className="size-full object-cover transition duration-200 group-hover:scale-[1.03]"
            loading="lazy"
            decoding="async"
            onError={() => {
              setLocalPath('')
              setQuality(null)
              setLoadState('error')
            }}
          />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-2 text-muted">
            {loadState === 'loading'
              ? <CircleDashed className="size-6 animate-spin" />
              : loadState === 'error'
                ? <><ArrowsRotateLeft className="size-6" /><span className="text-xs">点击重试</span></>
                : <Picture className="size-7 opacity-55" />}
          </span>
        )}
      </button>

      <span className={`pointer-events-none absolute left-2 top-2 z-10 rounded-full px-2 py-1 text-[11px] font-semibold shadow-sm backdrop-blur-md ${
        quality === 'thumbnail'
          ? 'bg-warning/85 text-warning-foreground'
          : quality === 'large'
            ? 'bg-success/85 text-success-foreground'
            : 'bg-black/55 text-white'
      }`}>
        {quality === 'thumbnail' ? '缩略图' : quality === 'large' ? '大图' : loadState === 'error' ? '无法读取' : '识别中'}
      </span>

      {quality === 'thumbnail' && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute right-2 top-2 z-10 h-7 min-w-0 gap-1 px-2 text-[11px] shadow-sm"
          isDisabled={isUpgrading}
          aria-label={upgradeError ? `重试获取大图：${upgradeError}` : '重新查找并解密大图'}
          onPress={() => { void handleUpgrade() }}
        >
          {isUpgrading
            ? <><CircleDashed className="size-3.5 animate-spin" />获取中</>
            : <><ArrowsRotateLeft className="size-3.5" />{upgradeError ? '重试大图' : '获取大图'}</>}
        </Button>
      )}

      <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-2 pt-7 text-xs text-white">
        {timeLabel}
      </span>
    </div>
  )
}

export function ChatImageGalleryModal({ isOpen, session, onOpenChange }: ChatImageGalleryModalProps) {
  const requestIdRef = useRef(0)
  const qualityRequestIdRef = useRef(0)
  const { showTopToast } = useTopToast()
  const [images, setImages] = useState<GalleryImage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isInspectingQualities, setIsInspectingQualities] = useState(false)
  const [error, setError] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [qualityFilter, setQualityFilter] = useState<ImageQualityFilter>('all')
  const [qualityByKey, setQualityByKey] = useState<Map<string, ImageQuality>>(() => new Map())
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)

  const handleQualityChange = useCallback((key: string, quality: ImageQuality) => {
    setQualityByKey((current) => {
      if (current.get(key) === quality) return current
      const next = new Map(current)
      next.set(key, quality)
      return next
    })
  }, [])

  const handleUpgradeResult = useCallback((success: boolean, message: string) => {
    showTopToast(message, success)
  }, [showTopToast])

  const inspectImageQualities = useCallback(async (items: GalleryImage[], requestId: number) => {
    setIsInspectingQualities(true)
    try {
      for (let start = 0; start < items.length; start += QUALITY_INSPECTION_CHUNK_SIZE) {
        if (requestId !== qualityRequestIdRef.current) return
        const chunk = items.slice(start, start + QUALITY_INSPECTION_CHUNK_SIZE)
        const result = await window.electronAPI.image.inspectQualities(chunk.map(image => ({
          key: imageMessageKey(image),
          sessionId: session.username,
          imageMd5: image.imageMd5,
          imageDatName: image.imageDatName,
          createTime: image.createTime,
        })))
        if (requestId !== qualityRequestIdRef.current) return
        if (!result.success) continue
        setQualityByKey((current) => {
          const next = new Map(current)
          for (const item of result.items) {
            if (item.quality === 'unknown') continue
            // 用户手动获取成功的大图不应被较早的后台识别结果覆盖。
            if (next.get(item.key) === 'large' && item.quality === 'thumbnail') continue
            next.set(item.key, item.quality)
          }
          return next
        })
      }
    } catch (cause) {
      console.warn('[ChatImageGallery] 识别图片类型失败:', cause)
    } finally {
      if (requestId === qualityRequestIdRef.current) setIsInspectingQualities(false)
    }
  }, [session.username])

  const loadImages = useCallback(async () => {
    const requestId = ++requestIdRef.current
    qualityRequestIdRef.current += 1
    setIsLoading(true)
    setIsInspectingQualities(false)
    setError('')
    try {
      const result = await window.electronAPI.chat.getAllImageMessages(session.username)
      if (requestId !== requestIdRef.current) return
      if (!result.success) {
        setImages([])
        setError(result.error || '读取聊天图片失败')
        return
      }
      const sorted = [...(result.images ?? [])].sort((a, b) =>
        b.createTime - a.createTime || b.sortSeq - a.sortSeq || b.localId - a.localId
      )
      setImages(sorted)
      setQualityByKey(new Map())
      const qualityRequestId = ++qualityRequestIdRef.current
      void inspectImageQualities(sorted, qualityRequestId)
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setImages([])
        setError(cause instanceof Error ? cause.message : '读取聊天图片失败')
      }
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false)
    }
  }, [inspectImageQualities, session.username])

  useEffect(() => {
    if (!isOpen) return
    setStartDate('')
    setEndDate('')
    setQualityFilter('all')
    setQualityByKey(new Map())
    setVisibleCount(INITIAL_VISIBLE_COUNT)
    void loadImages()
    return () => {
      requestIdRef.current += 1
      qualityRequestIdRef.current += 1
      setIsInspectingQualities(false)
    }
  }, [isOpen, loadImages])

  const dateFilteredImages = useMemo(() => images.filter((image) => {
    const dateKey = getImageDateKey(image)
    if (startDate && (!dateKey || dateKey < startDate)) return false
    if (endDate && (!dateKey || dateKey > endDate)) return false
    return true
  }), [endDate, images, startDate])

  const filteredImages = useMemo(() => {
    if (qualityFilter === 'all') return dateFilteredImages
    return dateFilteredImages.filter(image => qualityByKey.get(imageMessageKey(image)) === qualityFilter)
  }, [dateFilteredImages, qualityByKey, qualityFilter])

  const qualityCounts = useMemo(() => {
    let thumbnail = 0
    let large = 0
    for (const image of dateFilteredImages) {
      const quality = qualityByKey.get(imageMessageKey(image))
      if (quality === 'thumbnail') thumbnail += 1
      else if (quality === 'large') large += 1
    }
    return {
      thumbnail,
      large,
      unknown: dateFilteredImages.length - thumbnail - large,
    }
  }, [dateFilteredImages, qualityByKey])

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }, [startDate, endDate, qualityFilter])

  const visibleImages = useMemo(
    () => filteredImages.slice(0, visibleCount),
    [filteredImages, visibleCount]
  )
  const dateCountByKey = useMemo(() => {
    const counts = new Map<string, number>()
    for (const image of filteredImages) {
      const key = getImageDateKey(image)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [filteredImages])
  const groupedImages = useMemo(() => {
    const groups = new Map<string, GalleryImage[]>()
    for (const image of visibleImages) {
      const dateKey = getImageDateKey(image)
      const group = groups.get(dateKey)
      if (group) group.push(image)
      else groups.set(dateKey, [image])
    }
    return Array.from(groups.entries())
  }, [visibleImages])

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      variant="blur"
      className="z-2000"
    >
      <Modal.Container size="lg" scroll="inside" placement="center">
        <Modal.Dialog className="max-h-[calc(100vh-3rem)] w-[min(1120px,calc(100vw-3rem))] max-w-none!">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <Picture className="size-5" />
            </Modal.Icon>
            <div className="min-w-0">
              <Modal.Heading>聊天图片</Modal.Heading>
              <p className="mt-0.5 truncate text-xs text-muted">{session.displayName || session.username} · 按日期倒序</p>
            </div>
          </Modal.Header>

          <Modal.Body className="min-h-0 px-0 pb-0">
            <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-border bg-overlay/95 px-5 pb-4 pt-1 backdrop-blur-xl">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="w-full sm:max-w-100">
                  <DateRangePicker
                    startDate={startDate}
                    endDate={endDate}
                    onStartDateChange={setStartDate}
                    onEndDateChange={setEndDate}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
                  {isInspectingQualities && <CircleDashed className="size-3.5 animate-spin" />}
                  <span>
                    {isInspectingQualities
                      ? `正在识别图片类型·已识别 ${dateFilteredImages.length - qualityCounts.unknown} / ${dateFilteredImages.length} 张`
                      : qualityCounts.unknown > 0
                        ? `${dateFilteredImages.length} 张·${qualityCounts.unknown} 张类型未知`
                        : `${dateFilteredImages.length} 张`}
                  </span>
                </div>
              </div>

              <Tabs
                selectedKey={qualityFilter}
                onSelectionChange={(key) => setQualityFilter(String(key) as ImageQualityFilter)}
              >
                <Tabs.ListContainer>
                  <Tabs.List aria-label="图片类型筛选" className="*:h-8 *:gap-1.5 *:px-3 *:text-xs">
                    <Tabs.Tab id="all">全部 {dateFilteredImages.length}<Tabs.Indicator /></Tabs.Tab>
                    <Tabs.Tab id="large">大图 {qualityCounts.large}<Tabs.Indicator /></Tabs.Tab>
                    <Tabs.Tab id="thumbnail">缩略图 {qualityCounts.thumbnail}<Tabs.Indicator /></Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
            </div>

            <div className="px-5 pb-5 pt-4">
              {isLoading ? (
                <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-muted">
                  <CircleDashed className="size-7 animate-spin" />
                  <span className="text-sm">正在整理聊天图片…</span>
                </div>
              ) : error ? (
                <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center">
                  <Picture className="size-9 text-muted" />
                  <p className="max-w-md text-sm text-danger">{error}</p>
                  <Button size="sm" variant="secondary" onPress={() => { void loadImages() }}>
                    <ArrowsRotateLeft className="size-4" />重新加载
                  </Button>
                </div>
              ) : filteredImages.length === 0 ? (
                <div className="flex min-h-72 flex-col items-center justify-center gap-2 text-center text-muted">
                  {isInspectingQualities && qualityFilter !== 'all'
                    ? <CircleDashed className="size-7 animate-spin" />
                    : <Picture className="size-9 opacity-60" />}
                  <p className="text-sm">
                    {isInspectingQualities && qualityFilter !== 'all'
                      ? '正在识别图片类型…'
                      : images.length === 0
                        ? '这个会话中还没有图片'
                        : qualityFilter === 'large'
                          ? '所选条件内没有大图'
                          : qualityFilter === 'thumbnail'
                            ? '所选条件内没有缩略图'
                            : '所选日期内没有图片'}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-6">
                  {groupedImages.map(([dateKey, group]) => (
                    <section key={dateKey || 'unknown'}>
                      <div className="mb-3 flex items-center gap-3">
                        <h3 className="text-sm font-semibold text-foreground">
                          {dateKey ? formatDateDivider(group[0].createTime) : '日期未知'}
                        </h3>
                        <span className="text-xs text-muted">{dateCountByKey.get(dateKey) ?? group.length} 张</span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                        {group.map(image => (
                          <GalleryImageCard
                            key={`${session.username}-${imageMessageKey(image)}`}
                            image={image}
                            sessionId={session.username}
                            knownQuality={qualityByKey.get(imageMessageKey(image))}
                            onQualityChange={handleQualityChange}
                            onUpgradeResult={handleUpgradeResult}
                          />
                        ))}
                      </div>
                    </section>
                  ))}

                  {visibleImages.length < filteredImages.length && (
                    <div className="flex flex-col items-center gap-2 border-t border-border pt-5">
                      <span className="text-xs text-muted">已显示 {visibleImages.length} / {filteredImages.length} 张</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => setVisibleCount(count => count + LOAD_MORE_COUNT)}
                      >
                        加载更多图片
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
