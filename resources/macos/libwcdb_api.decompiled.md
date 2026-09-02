# `libwcdb_api.dylib` 反编译笔记（macOS arm64）

> 生成对象：`libwcdb_api.dylib`（arm64 Mach-O）
> 这不是原始源码，也不能保证变量名、结构体字段和所有分支完全准确；它是依据未剥离的导出/内部符号、反汇编、动态链接符号与常量字符串整理的可读伪 C++。
> 未修改原始 dylib。

## 已确认的入口与调用关系

```text
wcdb_set_client_info(...) ──> wcdb_license::set_client_info(...)
wcdb_set_app_version(...) ─> wcdb_license::set_application_version(...)
wcdb_check_license() ──────> security_check()
wcdb_init() ───────────────> security_check() ──成功──> load_wcdb_library()
```

`wcdb_init()` 在 `security_check()` 返回非零时直接返回该错误码，不会调用 `load_wcdb_library()`。

## 可读伪代码

```cpp
// 函数地址：0x2bc4；导出符号：wcdb_check_license
int32_t wcdb_check_license() {
    return security_check();
}

// 函数地址：0x2bc8；内部符号：security_check
int32_t security_check() {
    // g_hwm_mutex、g_hwm、g_last_observed_wall_time、g_steady_anchor 等为推定命名。
    std::lock_guard<std::mutex> lock(g_hwm_mutex);
    ensure_hwm_loaded_locked();

    int64_t wall_now = time(nullptr);
    if (wall_now == -1) wall_now = 0;

    // 若之前已有“墙上时间 + monotonic clock”锚点，取两者的较大值，
    // 防止用户把系统时钟调回去。
    int64_t trusted_now = wall_now;
    if (g_has_steady_anchor) {
        int64_t from_steady_clock = g_anchor_wall_time
            + seconds_since(g_anchor_steady_clock, std::chrono::steady_clock::now());
        trusted_now = std::max(trusted_now, from_steady_clock);
    }
    trusted_now = std::max(trusted_now, g_hwm);
    bump_hwm_locked(trusted_now, /*persist=*/false);
    // lock 在此处释放

    LicenseCheckResult result = wcdb_license::check(trusted_now);
    // result.code 是结构体中的第一个 int32 字段；result.message 为可选日志字符串。

    // 反汇编确认：命中一个较窄的成功区间时，更新墙上时间/单调时钟锚点，
    // 并持久化高水位。该范围的业务含义无法仅靠二进制完全确定。
    if (is_result_in_trusted_time_update_range(result.code)) {
        std::lock_guard<std::mutex> lock(g_hwm_mutex);
        ensure_hwm_loaded_locked();
        g_anchor_wall_time = trusted_now;
        g_anchor_steady_clock = std::chrono::steady_clock::now();
        g_has_steady_anchor = true;
        bump_hwm_locked(trusted_now, /*persist=*/true);
    }

    if (result.code != 0) {
        if (!result.message.empty()) log_line(result.message);
        return result.code;
    }

    // 成功后还会检查本 dylib 所在目录。
    const auto dir = dylib_dir();
    const bool host_exists = file_exists(dir / "libwcdb_api.dylib");
    const bool wcdb_exists = file_exists(dir / "libWCDB.dylib");
    if (!host_exists || !wcdb_exists) {
        log_line("wcdb_api host check failed: missing sibling dylibs");
        return -10;
    }

    return 0;
}

// 函数地址：0x2fe0；导出符号：wcdb_init
int32_t wcdb_init() {
    int32_t rc = security_check();
    if (rc != 0) return rc;
    return load_wcdb_library();
}
```

## 授权模块的静态证据

库保留了 `wcdb_license::check(int64_t)`、`wcdb_license::set_client_info(...)`、
`wcdb_license::set_application_version(...)` 等 C++ 符号。其字符串常量包含：

```text
wcdb-license-v1.jws
https://dll.aiqji.com/api/v1/wcdb/lease
issued_at
expires_at
refresh_after
offline_until
license-2026-01
```

结合导入的 `SecKeyVerifySignature`、`CC_SHA256`、`NSURLSession`、IOKit API，可合理还原为：

```cpp
namespace wcdb_license {
  int32_t check(int64_t trusted_now) {
      // 读取本地授权租约/缓存；字段包含签发、到期、刷新及离线截止时间。
      // 需要时通过 /api/v1/wcdb/lease 刷新租约。
      // 对 JWS/签名材料作 SHA-256 与系统 Security 框架验签。
      // 校验客户端信息、应用版本、原生库版本及可信时间。
      // 返回 0 或错误码。
  }
}
```

上面 `wcdb_license::check` 的细节属于**基于符号、字符串和导入 API 的推断**；这份 dylib 未包含可直接恢复的原始 C++ 源文件或调试信息，不能把它当作逐行等价源码。

## `security_check` 的外部请求与本地状态

### 网络请求

二进制中只有一个授权服务地址，并明确包含 HTTP 方法和内容类型：

```text
POST https://dll.aiqji.com/api/v1/wcdb/lease
Content-Type: application/json
Accept: application/json
```

请求协议中可确认的字段名为：`application_id`、`client_type`、`host_name`、`app_name`、
`device_id`、`nonce`、`app_version`、`native_version`、`platform`、`architecture`。
本库的固定平台/架构字符串为 `macos` / `arm64`；应用层当前传入的是
`ciphertalk` / `desktop` / 当前应用版本。

响应/租约中可确认的字段包括：`allowed`、`reason`、`server_time`、`issued_at`、
`expires_at`、`refresh_after`、`offline_until`、`policy_version`、`minimum_app_version`、
`minimum_native_version`。响应经过 ES256 签名验证。

触发规律可从控制流和错误字符串确定：首次没有可用缓存时必须联网；到达刷新时间会尝试续租；
刷新失败时，只要缓存签名仍有效且没有超过 `offline_until`，会继续使用缓存。过了离线期限则失败。

### 本地文件与系统信息

| 位置 | 用途 | 读写时机 |
| --- | --- | --- |
| `~/Library/Application Support/WCDBApi/licenses/<缓存键>.jws` | 当前授权租约缓存；`<缓存键>`由运行时传入，库在其后追加 `.jws` | 校验时读取，租约刷新后写入；无效缓存会删除 |
| `~/Library/Application Support/CipherTalk/wcdb-license-v1.jws` | 兼容旧版本的授权缓存 | 当前缓存不存在时尝试读取 |
| `~/Library/Application Support/WCDBApi/.wcdbts` | 可信时间高水位，防止系统时间回拨 | 检查开始时读取；时间推进/成功检查后更新 |
| `~/Library/Application Support/WCDBApi/licenses/.wcdb-device-id` | 当无法读到 macOS 硬件 UUID 时生成并保存的设备标识 | 仅硬件 UUID 不可用时读取/写入 |
| 与 `libwcdb_api.dylib` 同目录的 `libwcdb_api.dylib`、`libWCDB.dylib` | 完整性/宿主文件存在性检查；后者是实际动态加载的 WCDB 运行库 | 每次 `security_check` 成功后检查 |

时间文件使用 `CT1M` 魔数、经简单变换的时间值和校验字段，而不是明文 JSON。
设备标识优先从 IOKit 的 `IOPlatformExpertDevice` / `IOPlatformUUID` 读取；再结合
`wcdb_api-device-v1:` 前缀做 SHA-256 派生，授权请求不会直接发送这个原始 UUID。

## 可从工程确认的错误码

```text
-9   签名到期，停止使用
-10  主机/软件校验失败（security_check 中也用于缺少同目录 dylib）
-11  首次必须联网获取时间
-12  签名无效
-13  请勿使用盗版
-14  已被禁用
-15  已停用
-16  云端授权服务请求失败
-17  CipherTalk 版本不受支持
-18  WCDB 原生库版本不受支持
```

这些中文含义来自应用层的错误码映射，而非 dylib 的原始调试符号。

## 反汇编定位

| 函数 | 地址 | 关键指令/行为 |
| --- | ---: | --- |
| `wcdb_check_license` | `0x2bc4` | 无条件跳转 `security_check` |
| `security_check` | `0x2bc8` | 可信时间高水位、`wcdb_license::check`、同目录库文件检查 |
| `wcdb_init` | `0x2fe0` | `bl security_check`，非零立即返回 |
| `load_wcdb_library` | `0x30c0` | 仅在授权检查成功后调用 |
| `ensure_hwm_loaded_locked` | `0xa198` | 加载可信时间高水位状态 |
| `bump_hwm_locked` | `0xa3c4` | 更新/可持久化可信时间高水位 |
