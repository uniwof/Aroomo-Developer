#!/usr/bin/env python3
"""从 aroomo-resource-list.md 生成 core/src/capabilities/seed.ts（不含 Key；验证失败项只标状态）。
用法：python3 scripts/gen-capabilities-seed.py <资源清单.md> > core/src/capabilities/seed.ts
"""
import json
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()


def section(title_prefix):
    m = re.search(r"^## " + re.escape(title_prefix) + r".*?$(.*?)(?=^## |\Z)", text, re.S | re.M)
    return m.group(1) if m else ""


def rows(block):
    out = []
    for line in block.splitlines():
        if not line.startswith("|") or re.match(r"^\|[\s\-|]+\|$", line):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if cells and cells[0].isdigit():
            out.append(cells)
    return out


STATUS = {"已填且可用": "ready", "已填但验证失败": "failed", "未填": "missing", "免 Key": "keyless"}


def status_of(s):
    if s.startswith("已填（未验证"):
        return "unverified"
    return STATUS.get(s, "missing")


# 永久免费 free / 试用 trial / 付费 paid —— 按清单里写的免费额度判断，拿不准的标试用
ACCESS = {
    "Groq": "free", "NVIDIA NIM": "free", "Google Gemini": "free", "Agnes AI": "trial", "Poke": "free",
    "Pollinations（免 Key）": "free", "Cloudflare Workers AI": "free",
    "Modal": "free", "Kaggle": "free", "Lightning AI": "trial", "Lambda Cloud": "paid", "Beam": "paid",
    "E2B": "trial", "Daytona": "trial", "InstaBox": "free", "Phonebox 云手机": "trial", "Airtap 云手机": "trial",
    "Freestyle 云浏览器": "free", "Saperly 电话号码": "trial", "Bark 推送（iPhone）": "free",
}
QUOTA = {
    "Groq": (1000, "次/天", "每天"), "Cloudflare Workers AI": (10000, "neurons/天", "每天 00:00 UTC"),
    "Modal": (30, "美元/月", "每月"), "Kaggle": (30, "小时/周", "每周"), "E2B": (100, "美元(一次性)", None),
    "Daytona": (200, "美元(一次性)", None), "Freestyle 云浏览器": (200, "vCPU 小时/月", "每月"),
    "Phonebox 云手机": (2, "美元(一次性)", None), "Saperly 电话号码": (5, "美元(一次性)", None),
    "Pollinations（免 Key）": (2, "次/分钟", "按 IP"),
}
KIND_BY_GROUP = {"模型": "model"}


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "x"


items, tools = [], []
for r in rows(section("一、")):
    _, name, group, status, free, what, url = (r + [""] * 7)[:7]
    st = status_of(status)
    access = ACCESS.get(name, "trial")
    q = QUOTA.get(name)
    quota = {"used": None, "limit": q[0], "unit": q[1], **({"resets": q[2]} if q[2] else {})} if q else None
    note = free[:160] if free else None
    if group == "模型":
        models = [m.strip() for m in re.split(r"[、,，]", what) if m.strip()] or [name]
        if name == "Cloudflare Workers AI":
            models = ["Workers AI 开源模型"]
        if name == "Pollinations（免 Key）":
            models = ["openai-fast"]
        provider = name.replace("（免 Key）", "")
        for m in models:
            kind = "image" if "image" in m else "video" if "video" in m else "text"
            items.append({"id": f"{slug(provider)}-{slug(m)}", "name": m, "kind": kind, "provider": provider,
                          "access": access, "status": st, "quota": quota, "note": note})
    else:
        tools.append({"id": slug(name), "name": name, "group": group, "access": access, "status": st,
                      "quota": quota, "note": note})

# 技能 / 学习资源计数
library = {}
for key, title in (("skills", "三、"), ("resources", "四、")):
    block = section(title)
    groups = [{"name": n, "count": int(c)} for n, c in re.findall(r"^### (.+?)（(\d+)）", block, re.M)]
    total = int(re.search(r"（(\d+) 个）", text[text.index("## " + title):]).group(1))
    library[key] = {"total": total, "groups": groups}

seed = {"source": "aroomo-resource-list.md（2026-10-30 所有者导出，不含 Key）", "items": items, "tools": tools, "library": library}
print("// 由 scripts/gen-capabilities-seed.py 生成，勿手改。种子数据不含任何 Key；验证失败项只标状态，不自动注册。")
print("import type { CapabilitySeed } from './types.js';\n")
print("export const CAPABILITY_SEED: CapabilitySeed = " + json.dumps(seed, ensure_ascii=False, indent=2) + ";")
