# 主密钥：在自己电脑上生成（5 步）

主密钥用来加密全部备份。私钥只在你的电脑和 U 盘上，永远不发给任何人，也不发进聊天（D64）。

1. **插上 U 盘**（没有也行，会默认存到桌面）。
2. **下载小工具**：打开 Releases 页 <https://github.com/uniwof/Aroomo-Developer/releases/tag/master-key-v1>，下载附件 `New-AroomoMasterKey.cmd`。
   **核对 SHA-256**，必须完全等于：
   `d9f09ba2422f2e17820c3197fa4e6681568e01cf5961914bfbaafa49c4fc8ffc`
   （核对方法：在下载文件夹里按住 Shift 右键 →「在终端中打开」，输入 `Get-FileHash .\New-AroomoMasterKey.cmd`，看 Hash 一栏；大小写不同不要紧。不一致就不要运行，告诉 Hark。）
   不要从分支（dev 等）的 raw 地址下载执行——分支内容会变，只认这个 Release 附件和上面的哈希。
3. **双击运行** `New-AroomoMasterKey.cmd`（若 Windows 提示「已保护你的电脑」，点「更多信息」→「仍要运行」）。弹出保存窗口时**选 U 盘**，按「保存」。文件名是 `aroomo-master-key.txt`。
4. **大字窗口显示公钥（age1 开头），已经复制好了**。直接粘贴给 Hark，然后点「好了」。公钥可以公开。
5. **私钥存两份**：U 盘一份；再把文件里的私钥抄在纸上放好（文件里已按 4 个字符一组排好，方便抄写）。丢了就再也打不开备份。

出错了：把屏幕上的红字告诉 Hark（不要发私钥文件）。工具只联网一次，从 age 官方发布页下载 v1.2.1 并核对指纹；生成私钥时不联网。私钥只在内存里从 age-keygen 的输出读取，从不写进临时目录，唯一落盘处是你在第 3 步选的位置。
