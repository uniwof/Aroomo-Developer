# 主密钥：在自己电脑上生成（5 步）

主密钥用来加密全部备份。私钥只在你的电脑和 U 盘上，永远不发给任何人，也不发进聊天（D64）。

1. **插上 U 盘**（没有也行，会默认存到桌面）。
2. **按 Win + R**，粘贴下面这一行，按回车：
   `powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/uniwof/Aroomo-Developer/dev/tools/master-key/New-AroomoMasterKey.cmd | iex"`
   （也可以下载 `tools/master-key/New-AroomoMasterKey.cmd` 后双击。）
3. **弹出保存窗口时，选 U 盘**，按「保存」。文件名是 `aroomo-master-key.txt`。
4. **大字窗口显示公钥（age1 开头），已经复制好了**。直接粘贴给 Hark，然后点「好了」。公钥可以公开。
5. **私钥存两份**：U 盘一份；再把文件里的私钥抄在纸上放好（文件里已按 4 个字符一组排好，方便抄写）。丢了就再也打不开备份。

出错了：把屏幕上的红字告诉 Hark（不要发私钥文件）。工具只联网一次，从 age 官方发布页下载 v1.2.1 并核对指纹；生成私钥时不联网。
