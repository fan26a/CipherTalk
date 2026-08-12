import { createWriteStream, unlinkSync } from 'fs'
import http from 'http'
import https from 'https'

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])
const MP4_BOX_TYPES = new Set(['ftyp', 'mdat', 'moov', 'free', 'skip', 'wide'])

export const SNS_VIDEO_DECRYPT_PREFIX_BYTES = 128 * 1024

export const isPlayableVideoBuffer = (buffer: Uint8Array): boolean => {
  if (buffer.length < 12) return false

  // MP4/MOV files normally start with a size followed by one of these box types.
  const boxType = Buffer.from(buffer.buffer, buffer.byteOffset + 4, 4).toString('ascii')
  if (MP4_BOX_TYPES.has(boxType)) return true

  // Keep the same fallback formats accepted by the standalone video player.
  const signature = Buffer.from(buffer.buffer, buffer.byteOffset, 4).toString('hex')
  return signature === '1a45dfa3' || signature === '464c5601' // WebM / FLV
}

export interface SnsVideoDownloadOptions {
  maxRedirects?: number
  timeoutMs?: number
}

export type SnsVideoDownloadResult =
  | { success: true }
  | { success: false; error: string }

/**
 * Download an SNS video while preserving its original HTTP/HTTPS scheme.
 * Some WeChat CDN hosts are HTTP-only, and CDN responses may redirect to a
 * different protocol or host.
 */
export const downloadSnsVideoToFile = (
  sourceUrl: string,
  destinationPath: string,
  options: SnsVideoDownloadOptions = {}
): Promise<SnsVideoDownloadResult> => {
  const maxRedirects = options.maxRedirects ?? 5
  const timeoutMs = options.timeoutMs ?? 30_000

  return new Promise((resolve) => {
    let settled = false

    const removePartialFile = () => {
      try { unlinkSync(destinationPath) } catch { }
    }

    const finish = (result: SnsVideoDownloadResult) => {
      if (settled) return
      settled = true
      if (!result.success) removePartialFile()
      resolve(result)
    }

    const requestUrl = (currentUrl: string, redirectsLeft: number) => {
      if (settled) return

      let parsedUrl: URL
      try {
        parsedUrl = new URL(currentUrl)
      } catch {
        finish({ success: false, error: '视频地址无效' })
        return
      }

      const client = parsedUrl.protocol === 'https:'
        ? https
        : parsedUrl.protocol === 'http:'
          ? http
          : null
      if (!client) {
        finish({ success: false, error: `不支持的视频地址协议: ${parsedUrl.protocol}` })
        return
      }

      const request = client.request({
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'MicroMessenger Client',
          'Accept': '*/*',
          'Connection': 'keep-alive'
        },
        rejectUnauthorized: false
      }, (response) => {
        const statusCode = response.statusCode || 0

        if (REDIRECT_STATUS_CODES.has(statusCode) && response.headers.location) {
          response.resume()
          if (redirectsLeft <= 0) {
            finish({ success: false, error: '视频地址重定向次数过多' })
            return
          }

          let redirectUrl: string
          try {
            redirectUrl = new URL(response.headers.location, currentUrl).toString()
          } catch {
            finish({ success: false, error: '视频重定向地址无效' })
            return
          }
          requestUrl(redirectUrl, redirectsLeft - 1)
          return
        }

        if (statusCode !== 200 && statusCode !== 206) {
          response.resume()
          finish({ success: false, error: `HTTP ${statusCode || 'unknown'}` })
          return
        }

        const expectedBytes = Number(response.headers['content-length'] || 0) || 0
        let downloadedBytes = 0
        let writeFinished = false
        const writer = createWriteStream(destinationPath, { flags: 'w' })

        response.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length
        })
        response.on('error', (error) => {
          writer.destroy()
          finish({ success: false, error: error.message })
        })
        writer.on('error', (error) => {
          response.destroy()
          finish({ success: false, error: error.message })
        })
        writer.on('finish', () => {
          writeFinished = true
        })
        writer.on('close', () => {
          if (!writeFinished) return
          if (expectedBytes > 0 && downloadedBytes !== expectedBytes) {
            finish({ success: false, error: `视频下载不完整（${downloadedBytes}/${expectedBytes} 字节）` })
            return
          }
          finish({ success: true })
        })

        response.pipe(writer)
      })

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('视频下载超时'))
      })
      request.on('error', (error) => {
        finish({ success: false, error: error.message })
      })
      request.end()
    }

    requestUrl(sourceUrl, maxRedirects)
  })
}
