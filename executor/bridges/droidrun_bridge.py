#!/usr/bin/env python3
"""DroidRun（mobilerun，MIT）桥：本机执行员通过它让大模型操作云手机 / 安卓设备。

- 只在所有者电脑上运行（连云手机或 USB 手机），不在服务器跑模拟器（D157 红线）。
- 输入：stdin 一个 JSON（不走命令行参数，不写文件）：
  {"probe": true} 只检查 mobilerun 是否已安装；
  或 {"goal", "model", "api_base", "api_key", "credentials": {SECRET_ID: 值}, "device": {...}, "steps"}。
- 凭据交给 DroidRun 的 credentials（type_secret 动作按 secret id 输入），模型只看到 secret id，看不到值。
- 输出：stdout 最后一行 __AROOMO__{json}；其余输出一律被执行员丢弃，不记日志。
"""

import asyncio
import json
import sys

MARK = "__AROOMO__"


def out(obj):
    sys.stdout.write(MARK + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def run(job):
    from mobilerun import MobileAgent, load_llm  # noqa: WPS433（按需导入，probe 时也靠它判断是否安装）
    from mobilerun.config_manager import ConfigLoader

    config = ConfigLoader.load(None)
    try:
        config.telemetry.enabled = False
    except Exception:
        pass
    dev = job.get("device") or {}
    if dev.get("serial"):
        config.device.serial = dev["serial"]
    if dev.get("control_backend"):
        config.device.control_backend = dev["control_backend"]
    if dev.get("device_id"):
        config.device.device_id = dev["device_id"]
    if job.get("steps"):
        config.agent.max_steps = int(job["steps"])

    llm = load_llm("OpenAILike", model=job["model"], api_base=job["api_base"], api_key=job["api_key"], is_chat_model=True)
    agent = MobileAgent(goal=job["goal"], llms=llm, config=config, credentials=job.get("credentials") or None, timeout=900)
    result = await agent.run()
    return {"success": bool(getattr(result, "success", False)), "reason": str(getattr(result, "reason", ""))[:500], "steps": int(getattr(result, "steps", 0) or 0)}


def main():
    try:
        job = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        out({"ok": False, "code": "BAD_INPUT", "message": "输入不是 JSON"})
        return
    if job.get("probe"):
        try:
            import mobilerun  # noqa: F401
            out({"ok": True, "data": True})
        except Exception:
            out({"ok": True, "data": False})
        return
    try:
        data = asyncio.run(run(job))
        out({"ok": True, "data": data})
    except Exception as e:  # 不回传异常详情里的变量值，只给类型和截断后的消息
        out({"ok": False, "code": type(e).__name__, "message": str(e)[:200]})


if __name__ == "__main__":
    main()
