import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { chatLabSyncService } from '../../services/chatLabSyncService'

/**
 * ChatLab 定时同步 IPC —— 只暴露「测试连接」和「立即同步」两个动作。
 * Token / 服务地址 / 同步任务列表均通过通用 config:get / config:set 读写，
 * 主进程 chatLabSyncService 定期读取配置并执行增量同步。
 */
export function registerChatLabSyncHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('chatlab-sync:test', async () => {
    return chatLabSyncService.testConnection()
  })

  ipcMain.handle('chatlab-sync:syncNow', async () => {
    return chatLabSyncService.syncNow()
  })

  ipcMain.handle('chatlab-sync:getRecentLogs', async () => {
    return chatLabSyncService.getRecentLogs()
  })
}
