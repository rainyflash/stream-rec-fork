# R2 录播下载器

本工具是一个只监听 `127.0.0.1` 的本机 Web GUI，用于从 Cloudflare R2 下载录播文件。它不保存 R2 密钥，只调用本机已经配置好的 `rclone` remote。

默认 remote：

```text
stream-rec-r2:stream-rec-recordings
```

启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\r2-downloader-gui\start.ps1
```

打开：

```text
http://127.0.0.1:15721
```

## Motrix Next

如果本机运行了 Motrix Next，本工具可以把选中的 R2 文件发送到 Motrix。实现方式是：

1. 用 `rclone link` 生成 R2 presigned URL。
2. 读取 Motrix Next 本机 RPC 端口和 token。
3. 调用 `aria2.addUri` 添加下载任务。

R2 presigned URL 最长有效期为 7 天。

可选环境变量：

```powershell
$env:RCLONE_PATH="C:\path\to\rclone.exe"
$env:R2_REMOTE="stream-rec-r2:stream-rec-recordings"
$env:PORT="15721"
```
