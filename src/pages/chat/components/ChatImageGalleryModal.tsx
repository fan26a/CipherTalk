import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsRotateLeft, CircleDashed, Picture, PlayFill, Video } from '@gravity-ui/icons'
import { Button, ListBox, Modal, Select, Tabs } from '@heroui/react'
import DateRangePicker from '../../../components/DateRangePicker'
import { formatDateValue } from '../../../components/AppDatePicker'
import type { ChatSession } from '../../../types/models'
import { enqueueDecrypt } from './messageBubble/mediaState'
import { formatDateDivider } from '../utils/time'
import { useTopToast } from '../hooks/useTopToast'

type GalleryMedia = {
  mediaType: 'image' | 'video'
  localId: number
  serverId: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  imageMd5?: string
  imageDatName?: string
  rawContent?: string
  videoMd5?: string
  videoDuration?: number
}

type GalleryImage = GalleryMedia & { mediaType: 'image' }
type GalleryVideo = GalleryMedia & { mediaType: 'video' }
type MediaTypeFilter = 'all' | 'image' | 'video'
type ImageQuality = 'thumbnail' | 'large'
type ImageQualityFilter = 'all' | ImageQuality
type MediaLoadState = 'idle' | 'loading' | 'ready' | 'error'

type GalleryVideoInfo = {
  videoUrl: string
  thumbUrl?: string
  coverUrl?: string
  error?: string
}

interface ChatImageGalleryModalProps {
  isOpen: boolean
  session: ChatSession
  onOpenChange: (open: boolean) => void
}

interface GalleryImageCardProps {
  image: GalleryImage
  sessionId: string
  senderLabel: string
  knownQuality?: ImageQuality
  onQualityChange: (key: string, quality: ImageQuality) => void
  onUpgradeResult: (success: boolean, message: string) => void
}

interface GalleryVideoCardProps {
  video: GalleryVideo
  senderLabel: string
}

const INITIAL_VISIBLE_COUNT = 100
const LOAD_MORE_COUNT = 100
const QUALITY_INSPECTION_CHUNK_SIZE = 120
const SENDER_LOOKUP_CHUNK_SIZE = 20
const SELF_SENDER_KEY = '__self__'
const UNKNOWN_SENDER_KEY = '__unknown__'

function isGalleryImage(media: GalleryMedia): media is GalleryImage {
  return media.mediaType === 'image'
}

function isGalleryVideo(media: GalleryMedia): media is GalleryVideo {
  return media.mediaType === 'video'
}

function mediaMessageKey(media: GalleryMedia): string {
  const mediaIdentity = media.mediaType === 'image'
    ? media.imageMd5 || media.imageDatName || ''
    : media.videoMd5 || ''
  return `${media.mediaType}-${media.serverId}-${media.localId}-${media.createTime}-${media.sortSeq}-${mediaIdentity}`
}

function getMediaDateKey(media: GalleryMedia): string {
  return media.createTime > 0 ? formatDateValue(new Date(media.createTime * 1000)) : ''
}

function getSenderFilterKey(media: GalleryMedia): string {
  if (media.isSend === 1) return SELF_SENDER_KEY
  const username = media.senderUsername?.trim()
  return username ? `user:${username}` : UNKNOWN_SENDER_KEY
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

function formatMediaDateTime(createTime: number): string {
  if (!createTime) return '发送时间未知'
  return new Date(createTime * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatVideoDuration(duration?: number): string {
  if (!duration || duration <= 0) return ''
  const seconds = Math.floor(duration)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function MediaMetadata({ senderLabel, createTime }: { senderLabel: string; createTime: number }) {
  return (
    <div className="border-t border-border px-3 py-2.5">
      <p className="truncate text-xs font-semibold text-foreground" title={senderLabel}>{senderLabel}</p>
      <p className="mt-1 truncate text-[11px] text-muted" title={formatMediaDateTime(createTime)}>
        {formatMediaDateTime(createTime)}
      </p>
    </div>
  )
}

function GalleryImageCard({
  image,
  sessionId,
  senderLabel,
  knownQuality,
  onQualityChange,
  onUpgradeResult,
}: GalleryImageCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const loadingRef = useRef(false)
  const [isVisible, setIsVisible] = useState(false)
  const [loadState, setLoadState] = useState<MediaLoadState>('idle')
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
    onQualityChange(mediaMessageKey(image), nextQuality)
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
      console.error('[ChatMediaGallery] 打开图片查看器失败:', error)
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

  return (
    <div
      ref={cardRef}
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-default shadow-sm transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md"
    >
      <div className="group relative aspect-square overflow-hidden bg-default">
        <button
          type="button"
          className="absolute inset-0 size-full text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          aria-label={`${quality === 'thumbnail' ? '缩略图' : quality === 'large' ? '大图' : '图片'}，发送人 ${senderLabel}`}
          onClick={handlePress}
        >
          {localPath ? (
            <img
              src={localPath}
              alt={`${senderLabel}发送的聊天图片`}
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
      </div>

      <MediaMetadata senderLabel={senderLabel} createTime={image.createTime} />
    </div>
  )
}

function GalleryVideoCard({ video, senderLabel }: GalleryVideoCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const loadingRef = useRef(false)
  const [isVisible, setIsVisible] = useState(false)
  const [loadState, setLoadState] = useState<MediaLoadState>('idle')
  const [videoInfo, setVideoInfo] = useState<GalleryVideoInfo | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => {
    return () => { mountedRef.current = false }
  }, [])

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

  const loadVideo = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoadState('loading')
    try {
      const result = await window.electronAPI.video.getVideoInfo(video.videoMd5 || '', video.rawContent)
      if (!mountedRef.current) return
      if (result.success && result.exists && result.videoUrl) {
        setPreviewFailed(false)
        setVideoInfo({
          videoUrl: result.videoUrl,
          thumbUrl: result.thumbUrl,
          coverUrl: result.coverUrl,
        })
        setLoadState('ready')
      } else {
        setVideoInfo({
          videoUrl: '',
          thumbUrl: result.thumbUrl,
          coverUrl: result.coverUrl,
          error: result.diagnostics?.summary || result.error || '未找到本地视频',
        })
        setLoadState('error')
      }
    } catch (cause) {
      if (!mountedRef.current) return
      setVideoInfo({
        videoUrl: '',
        error: cause instanceof Error ? cause.message : '视频读取失败',
      })
      setLoadState('error')
    } finally {
      loadingRef.current = false
    }
  }, [video.rawContent, video.videoMd5])

  useEffect(() => {
    if (isVisible && loadState === 'idle') void loadVideo()
  }, [isVisible, loadState, loadVideo])

  const handlePress = () => {
    if (videoInfo?.videoUrl) {
      void window.electronAPI.window.openVideoPlayerWindow(videoInfo.videoUrl).catch((error) => {
        console.error('[ChatMediaGallery] 打开视频播放器失败:', error)
      })
      return
    }
    setPreviewFailed(false)
    setVideoInfo(null)
    setLoadState('idle')
  }

  const previewUrl = videoInfo?.thumbUrl || videoInfo?.coverUrl
  const durationLabel = formatVideoDuration(video.videoDuration)

  return (
    <div
      ref={cardRef}
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-default shadow-sm transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md"
    >
      <div className="group relative aspect-square overflow-hidden bg-black/90">
        <button
          type="button"
          className="absolute inset-0 size-full text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          aria-label={`视频，发送人 ${senderLabel}${durationLabel ? `，时长 ${durationLabel}` : ''}`}
          onClick={handlePress}
        >
          {previewUrl && !previewFailed ? (
            <img
              src={previewUrl}
              alt={`${senderLabel}发送的视频封面`}
              className="size-full object-cover opacity-90 transition duration-200 group-hover:scale-[1.03] group-hover:opacity-100"
              loading="lazy"
              decoding="async"
              onError={() => setPreviewFailed(true)}
            />
          ) : (
            <span className="flex size-full flex-col items-center justify-center gap-2 px-4 text-center text-white/75">
              {loadState === 'loading'
                ? <CircleDashed className="size-7 animate-spin" />
                : <Video className="size-9" />}
              {loadState === 'error' && (
                <span className="line-clamp-2 text-xs">{videoInfo?.error || '视频不可用，点击重试'}</span>
              )}
            </span>
          )}

          {loadState === 'ready' && (
            <span className="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white shadow-lg backdrop-blur-sm transition group-hover:scale-105">
              <PlayFill className="ml-0.5 size-5" />
            </span>
          )}
        </button>

        <span className="pointer-events-none absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[11px] font-semibold text-white shadow-sm backdrop-blur-md">
          <Video className="size-3" />视频
        </span>
        {durationLabel && (
          <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white">
            {durationLabel}
          </span>
        )}
      </div>

      <MediaMetadata senderLabel={senderLabel} createTime={video.createTime} />
    </div>
  )
}

export function ChatImageGalleryModal({ isOpen, session, onOpenChange }: ChatImageGalleryModalProps) {
  const requestIdRef = useRef(0)
  const qualityRequestIdRef = useRef(0)
  const { showTopToast } = useTopToast()
  const [mediaItems, setMediaItems] = useState<GalleryMedia[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isInspectingQualities, setIsInspectingQualities] = useState(false)
  const [error, setError] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>('all')
  const [qualityFilter, setQualityFilter] = useState<ImageQualityFilter>('all')
  const [senderFilter, setSenderFilter] = useState('all')
  const [qualityByKey, setQualityByKey] = useState<Map<string, ImageQuality>>(() => new Map())
  const [senderNames, setSenderNames] = useState<Map<string, string>>(() => new Map())
  const [selfDisplayName, setSelfDisplayName] = useState('')
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
    setIsInspectingQualities(items.length > 0)
    try {
      for (let start = 0; start < items.length; start += QUALITY_INSPECTION_CHUNK_SIZE) {
        if (requestId !== qualityRequestIdRef.current) return
        const chunk = items.slice(start, start + QUALITY_INSPECTION_CHUNK_SIZE)
        const result = await window.electronAPI.image.inspectQualities(chunk.map(image => ({
          key: mediaMessageKey(image),
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
            if (next.get(item.key) === 'large' && item.quality === 'thumbnail') continue
            next.set(item.key, item.quality)
          }
          return next
        })
      }
    } catch (cause) {
      console.warn('[ChatMediaGallery] 识别图片类型失败:', cause)
    } finally {
      if (requestId === qualityRequestIdRef.current) setIsInspectingQualities(false)
    }
  }, [session.username])

  const resolveSenderNames = useCallback(async (items: GalleryMedia[], requestId: number) => {
    const usernames = Array.from(new Set(
      items
        .filter(item => item.isSend !== 1)
        .map(item => item.senderUsername?.trim())
        .filter((username): username is string => Boolean(username))
    ))

    void window.electronAPI.chat.getMyUserInfo().then((result) => {
      if (requestId !== requestIdRef.current || !result.success || !result.userInfo) return
      setSelfDisplayName(result.userInfo.nickName || result.userInfo.alias || '')
    }).catch(() => { })

    for (let start = 0; start < usernames.length; start += SENDER_LOOKUP_CHUNK_SIZE) {
      if (requestId !== requestIdRef.current) return
      const chunk = usernames.slice(start, start + SENDER_LOOKUP_CHUNK_SIZE)
      const resolved = await Promise.all(chunk.map(async (username) => {
        try {
          const contact = await window.electronAPI.chat.getContactAvatar(username)
          return [username, contact?.displayName || username] as const
        } catch {
          return [username, username] as const
        }
      }))
      if (requestId !== requestIdRef.current) return
      setSenderNames((current) => {
        const next = new Map(current)
        for (const [username, displayName] of resolved) next.set(username, displayName)
        return next
      })
    }
  }, [])

  const loadMedia = useCallback(async () => {
    const requestId = ++requestIdRef.current
    qualityRequestIdRef.current += 1
    setIsLoading(true)
    setIsInspectingQualities(false)
    setError('')
    try {
      const result = await window.electronAPI.chat.getAllMediaMessages(session.username)
      if (requestId !== requestIdRef.current) return
      if (!result.success) {
        setMediaItems([])
        setError(result.error || '读取聊天媒体失败')
        return
      }
      const sorted = [...(result.media ?? [])].sort((a, b) =>
        b.createTime - a.createTime || b.sortSeq - a.sortSeq || b.localId - a.localId
      ) as GalleryMedia[]
      setMediaItems(sorted)
      setQualityByKey(new Map())
      setSenderNames(new Map())
      setSelfDisplayName('')
      void resolveSenderNames(sorted, requestId)
      const qualityRequestId = ++qualityRequestIdRef.current
      void inspectImageQualities(sorted.filter(isGalleryImage), qualityRequestId)
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setMediaItems([])
        setError(cause instanceof Error ? cause.message : '读取聊天媒体失败')
      }
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false)
    }
  }, [inspectImageQualities, resolveSenderNames, session.username])

  useEffect(() => {
    if (!isOpen) return
    setStartDate('')
    setEndDate('')
    setMediaTypeFilter('all')
    setQualityFilter('all')
    setSenderFilter('all')
    setQualityByKey(new Map())
    setVisibleCount(INITIAL_VISIBLE_COUNT)
    void loadMedia()
    return () => {
      requestIdRef.current += 1
      qualityRequestIdRef.current += 1
      setIsInspectingQualities(false)
    }
  }, [isOpen, loadMedia])

  const getSenderLabel = useCallback((media: GalleryMedia): string => {
    if (media.isSend === 1) return selfDisplayName ? `我 · ${selfDisplayName}` : '我'
    const username = media.senderUsername?.trim()
    if (username) {
      return senderNames.get(username) || (username === session.username ? session.displayName : '') || username
    }
    return session.displayName || session.username || '未知发送人'
  }, [selfDisplayName, senderNames, session.displayName, session.username])

  const senderOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const media of mediaItems) {
      const key = getSenderFilterKey(media)
      const current = counts.get(key)
      if (current) current.count += 1
      else counts.set(key, { label: getSenderLabel(media), count: 1 })
    }
    return Array.from(counts.entries())
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => {
        if (a.key === SELF_SENDER_KEY) return -1
        if (b.key === SELF_SENDER_KEY) return 1
        return a.label.localeCompare(b.label, 'zh-CN')
      })
  }, [getSenderLabel, mediaItems])

  const dateFilteredMedia = useMemo(() => mediaItems.filter((media) => {
    const dateKey = getMediaDateKey(media)
    if (startDate && (!dateKey || dateKey < startDate)) return false
    if (endDate && (!dateKey || dateKey > endDate)) return false
    return true
  }), [endDate, mediaItems, startDate])

  const senderFilteredMedia = useMemo(() => {
    if (senderFilter === 'all') return dateFilteredMedia
    return dateFilteredMedia.filter(media => getSenderFilterKey(media) === senderFilter)
  }, [dateFilteredMedia, senderFilter])

  const mediaCounts = useMemo(() => {
    let image = 0
    let video = 0
    for (const media of senderFilteredMedia) {
      if (media.mediaType === 'image') image += 1
      else video += 1
    }
    return { all: senderFilteredMedia.length, image, video }
  }, [senderFilteredMedia])

  const qualityCounts = useMemo(() => {
    let thumbnail = 0
    let large = 0
    let imageCount = 0
    for (const media of senderFilteredMedia) {
      if (!isGalleryImage(media)) continue
      imageCount += 1
      const quality = qualityByKey.get(mediaMessageKey(media))
      if (quality === 'thumbnail') thumbnail += 1
      else if (quality === 'large') large += 1
    }
    return { thumbnail, large, unknown: imageCount - thumbnail - large, imageCount }
  }, [qualityByKey, senderFilteredMedia])

  const filteredMedia = useMemo(() => senderFilteredMedia.filter((media) => {
    if (mediaTypeFilter !== 'all' && media.mediaType !== mediaTypeFilter) return false
    if (qualityFilter === 'all') return true
    return isGalleryImage(media) && qualityByKey.get(mediaMessageKey(media)) === qualityFilter
  }), [mediaTypeFilter, qualityByKey, qualityFilter, senderFilteredMedia])

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }, [startDate, endDate, mediaTypeFilter, qualityFilter, senderFilter])

  const visibleMedia = useMemo(
    () => filteredMedia.slice(0, visibleCount),
    [filteredMedia, visibleCount]
  )
  const dateCountByKey = useMemo(() => {
    const counts = new Map<string, number>()
    for (const media of filteredMedia) {
      const key = getMediaDateKey(media)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [filteredMedia])
  const groupedMedia = useMemo(() => {
    const groups = new Map<string, GalleryMedia[]>()
    for (const media of visibleMedia) {
      const dateKey = getMediaDateKey(media)
      const group = groups.get(dateKey)
      if (group) group.push(media)
      else groups.set(dateKey, [media])
    }
    return Array.from(groups.entries())
  }, [visibleMedia])

  const selectedSenderLabel = senderFilter === 'all'
    ? '全部发送人'
    : senderOptions.find(option => option.key === senderFilter)?.label || '未知发送人'
  const qualityFilterLabel = qualityFilter === 'large'
    ? `大图 ${qualityCounts.large}`
    : qualityFilter === 'thumbnail'
      ? `缩略图 ${qualityCounts.thumbnail}`
      : `全部图片质量 ${qualityCounts.imageCount}`

  const handleMediaTypeChange = (key: string) => {
    const next = key as MediaTypeFilter
    setMediaTypeFilter(next)
    if (next === 'video') setQualityFilter('all')
  }

  const handleQualityFilterChange = (key: string) => {
    const next = key as ImageQualityFilter
    setQualityFilter(next)
    if (next !== 'all') setMediaTypeFilter('image')
  }

  const getEmptyMessage = () => {
    if (mediaItems.length === 0) return '这个会话中还没有图片或视频'
    if (mediaTypeFilter === 'video') return '所选条件内没有视频'
    if (mediaTypeFilter === 'image' && qualityFilter === 'large') return '所选条件内没有大图'
    if (mediaTypeFilter === 'image' && qualityFilter === 'thumbnail') return '所选条件内没有缩略图'
    if (mediaTypeFilter === 'image') return '所选条件内没有图片'
    return '所选条件内没有媒体'
  }

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      variant="blur"
      className="z-2000"
    >
      <Modal.Container size="lg" scroll="inside" placement="center">
        <Modal.Dialog className="max-h-[calc(100vh-3rem)] w-[min(1180px,calc(100vw-3rem))] max-w-none!">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <Picture className="size-5" />
            </Modal.Icon>
            <div className="min-w-0">
              <Modal.Heading>聊天媒体</Modal.Heading>
              <p className="mt-0.5 truncate text-xs text-muted">{session.displayName || session.username} · 图片与视频按日期倒序</p>
            </div>
          </Modal.Header>

          <Modal.Body className="min-h-0 px-0 pb-0">
            <div className="sticky top-0 z-20 flex flex-col gap-3 border-b border-border bg-overlay/95 px-5 pb-4 pt-1 backdrop-blur-xl">
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
                      ? `正在识别图片质量 · ${qualityCounts.imageCount - qualityCounts.unknown} / ${qualityCounts.imageCount}`
                      : `当前结果 ${filteredMedia.length} 项`}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <Tabs
                  selectedKey={mediaTypeFilter}
                  onSelectionChange={(key) => handleMediaTypeChange(String(key))}
                  className="min-w-0"
                >
                  <Tabs.ListContainer>
                    <Tabs.List aria-label="媒体类型筛选" className="*:h-8 *:gap-1.5 *:px-3 *:text-xs">
                      <Tabs.Tab id="all">全部 {mediaCounts.all}<Tabs.Indicator /></Tabs.Tab>
                      <Tabs.Tab id="image">图片 {mediaCounts.image}<Tabs.Indicator /></Tabs.Tab>
                      <Tabs.Tab id="video">视频 {mediaCounts.video}<Tabs.Indicator /></Tabs.Tab>
                    </Tabs.List>
                  </Tabs.ListContainer>
                </Tabs>

                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Select
                    selectedKey={qualityFilter}
                    onSelectionChange={(key) => handleQualityFilterChange(String(key))}
                    variant="secondary"
                    className="w-44"
                    isDisabled={mediaTypeFilter === 'video'}
                    aria-label="图片质量筛选"
                  >
                    <Select.Trigger className="h-8 text-xs">
                      <Select.Value>{qualityFilterLabel}</Select.Value>
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        <ListBox.Item id="all" textValue="全部图片质量">全部图片质量 {qualityCounts.imageCount}<ListBox.ItemIndicator /></ListBox.Item>
                        <ListBox.Item id="large" textValue="大图">大图 {qualityCounts.large}<ListBox.ItemIndicator /></ListBox.Item>
                        <ListBox.Item id="thumbnail" textValue="缩略图">缩略图 {qualityCounts.thumbnail}<ListBox.ItemIndicator /></ListBox.Item>
                      </ListBox>
                    </Select.Popover>
                  </Select>

                  <Select
                    selectedKey={senderFilter}
                    onSelectionChange={(key) => setSenderFilter(String(key))}
                    variant="secondary"
                    className="w-52"
                    aria-label="发送人筛选"
                  >
                    <Select.Trigger className="h-8 text-xs">
                      <Select.Value>{selectedSenderLabel}</Select.Value>
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        <ListBox.Item id="all" textValue="全部发送人">全部发送人 {mediaItems.length}<ListBox.ItemIndicator /></ListBox.Item>
                        {senderOptions.map(option => (
                          <ListBox.Item key={option.key} id={option.key} textValue={option.label}>
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            <span className="ml-auto text-xs text-muted">{option.count}</span>
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </div>
              </div>
            </div>

            <div className="px-5 pb-5 pt-4">
              {isLoading ? (
                <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-muted">
                  <CircleDashed className="size-7 animate-spin" />
                  <span className="text-sm">正在整理聊天图片和视频…</span>
                </div>
              ) : error ? (
                <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center">
                  <Picture className="size-9 text-muted" />
                  <p className="max-w-md text-sm text-danger">{error}</p>
                  <Button size="sm" variant="secondary" onPress={() => { void loadMedia() }}>
                    <ArrowsRotateLeft className="size-4" />重新加载
                  </Button>
                </div>
              ) : filteredMedia.length === 0 ? (
                <div className="flex min-h-72 flex-col items-center justify-center gap-2 text-center text-muted">
                  {isInspectingQualities && qualityFilter !== 'all'
                    ? <CircleDashed className="size-7 animate-spin" />
                    : mediaTypeFilter === 'video'
                      ? <Video className="size-9 opacity-60" />
                      : <Picture className="size-9 opacity-60" />}
                  <p className="text-sm">
                    {isInspectingQualities && qualityFilter !== 'all' ? '正在识别图片质量…' : getEmptyMessage()}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-7">
                  {groupedMedia.map(([dateKey, group]) => (
                    <section key={dateKey || 'unknown'}>
                      <div className="mb-3 flex items-center gap-3">
                        <h3 className="text-sm font-semibold text-foreground">
                          {dateKey ? formatDateDivider(group[0].createTime) : '日期未知'}
                        </h3>
                        <span className="text-xs text-muted">{dateCountByKey.get(dateKey) ?? group.length} 项</span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                      <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                        {group.map(media => isGalleryImage(media) ? (
                          <GalleryImageCard
                            key={`${session.username}-${mediaMessageKey(media)}`}
                            image={media}
                            sessionId={session.username}
                            senderLabel={getSenderLabel(media)}
                            knownQuality={qualityByKey.get(mediaMessageKey(media))}
                            onQualityChange={handleQualityChange}
                            onUpgradeResult={handleUpgradeResult}
                          />
                        ) : isGalleryVideo(media) ? (
                          <GalleryVideoCard
                            key={`${session.username}-${mediaMessageKey(media)}`}
                            video={media}
                            senderLabel={getSenderLabel(media)}
                          />
                        ) : null)}
                      </div>
                    </section>
                  ))}

                  {visibleMedia.length < filteredMedia.length && (
                    <div className="flex flex-col items-center gap-2 border-t border-border pt-5">
                      <span className="text-xs text-muted">已显示 {visibleMedia.length} / {filteredMedia.length} 项</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => setVisibleCount(count => count + LOAD_MORE_COUNT)}
                      >
                        加载更多媒体
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
