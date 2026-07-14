# Video Agent Studio

**OpenMontage × Claude Agent SDK** — 在 OpenMontage 原生的 Backlot 製作看板上,直接用對話指揮 AI agent 做影片。

```
你(瀏覽器)—— 唯一入口:http://localhost:4750(Backlot 專案庫)
 ├─ 專案庫:「＋ 新專案」按鈕(本專案注入)
 └─ 專案看板:💬 聊天抽屜(本專案注入)── 指揮 agent、回覆關卡
 (4747 只是後端;開 http://localhost:4747 會自動轉到 4750)

Studio 伺服器(server.js,port 4747)
 ├─ Claude Agent SDK:每個專案一個 agent session(等同 headless Claude Code)
 │    cwd = OpenMontage repo,載入 CLAUDE.md,照 OpenMontage 的 agent 協議工作
 ├─ 自動拉起 Backlot(port 4750)
 └─ 專案註冊表 studio-projects.json

OpenMontage repo(agent 的工作場)
 └─ projects/<slug>/   ← 每個專案的素材、checkpoint、成片
```

---

## 一、環境需求

| 需求 | 說明 |
|---|---|
| macOS / Linux | Windows 需自行調整路徑 |
| Python 3.10+ | OpenMontage 用 |
| Node.js 18+ | Studio 伺服器 + Remotion 用 |
| FFmpeg | `brew install ffmpeg` |
| Claude Code 已登入 | Agent SDK 走本機 Claude Code 的憑證(或設 `ANTHROPIC_API_KEY`) |

## 二、部署(拿到這個 repo 之後)

**三步跑起來:**

```bash
git clone https://github.com/WellyXY/Video_agent.git && cd Video_agent
./setup.sh      # 一鍵搞定:檢查環境 → 裝依賴 → clone OpenMontage → 建 venv → 注入聊天部件
npm start       # 啟動(4747 為後端;Backlot 會自動拉起於 4750)
```

然後瀏覽器開 **http://localhost:4750**,右下角「＋ 新專案」開始。

> **注意:** 這個 repo 只含源碼(~200KB)。`OpenMontage/`、`node_modules/`、venv 都**不在 repo 裡**,由 `setup.sh` 自動下載重建 —— **首次 setup 約需下載 700MB 依賴**(Remotion 內含 Chromium、Agent SDK 內嵌 Claude Code、Python ONNX/語音模型),視網速需幾分鐘。

`setup.sh` 是**冪等**的(重跑安全),並且會自動處理兩個換機常見坑:
- **venv 綁絕對路徑** —— repo 從別台機器複製過來時,偵測壞掉的 venv 並自動重建
- **agent session 綁原機器** —— 自動重置 `studio-projects.json` 的 sessionId(專案與素材保留)

**唯一的手動前提:** 這台機器要能用 Claude —— 裝好 Claude Code 並登入(`npm i -g @anthropic-ai/claude-code && claude login`),或設好 `ANTHROPIC_API_KEY` 環境變數。`setup.sh` 檢查不到時會提醒。

<details>
<summary>手動安裝步驟(setup.sh 做的事,除錯時參考)</summary>

```bash
npm install                                          # Studio 依賴
git clone --depth 1 https://github.com/calesthio/OpenMontage.git   # 若還沒有
cd OpenMontage && make setup && cd ..                # venv + Python 依賴 + Remotion + Piper
OpenMontage/.venv/bin/python -m pip install pytest   # demo 模擬腳本需要
# 注入聊天部件:在 OpenMontage/backlot/ui/board.html 與 index.html 的 </body> 前各加:
#   <script src="http://localhost:4747/chat-widget.js" defer></script>
node server.js
```
</details>

**環境變數(都有預設值,一般不用動):** `PORT`(Studio,4747)、`BACKLOT_PORT`(4750)、`OM_REPO`(OpenMontage 路徑)、`AGENT_PROVIDER`(見下)。

### 切換 Agent 大腦:Claude 或 GPT

```bash
node server.js                          # 預設:Claude(Claude Agent SDK,需 claude login 或 ANTHROPIC_API_KEY)
AGENT_PROVIDER=openai node server.js    # GPT:自建工具迴圈(需 OPENAI_API_KEY,填環境變數或 OpenMontage/.env)
OPENAI_MODEL=gpt-5 AGENT_PROVIDER=openai node server.js   # 指定模型(預設 gpt-5;OPENAI_BASE_URL 可換相容端點)
```

兩種 provider 的差異:

| | `claude`(預設) | `openai` |
|---|---|---|
| 執行殼 | Claude Code(完整 harness:上下文壓縮、規劃) | 自建 tool-loop(run_bash / read_file / write_file) |
| 契約載入 | CLAUDE.md(SDK settingSources) | AGENTS.md + CODEX.md(注入 system prompt) |
| 對話續接 | Claude session resume | `sessions/<專案>.openai.json`(跨重啟保留) |
| 成本顯示 | 每回合 $ | 每回合 tokens |

注意:openai 路徑是輕量迴圈,長製作的上下文管理與規劃能力弱於 Claude Code 殼;跑大型 pipeline 建議 claude,openai 適合備援或 A/B 對比。

## 三、API Key(要用商業視頻模型才需要)

編輯 `OpenMontage/.env`,填你有的 key(不填也能跑**免費層**:免費素材庫 + Piper 配音 + FFmpeg/Remotion 合成):

- `FAL_KEY` —— 最推薦,一把 key 通 Kling / Luma / 多數模型
- 或個別的 Runway / Google(Veo/Imagen)/ ElevenLabs 等,見 OpenMontage 的 PROVIDERS 說明

不用重啟,agent 每次執行都會讀 `.env`。

## 四、日常使用

### 唯一流程:Backlot
1. 開 http://localhost:4750(專案庫)→ 右下「＋ 新專案」或點進既有專案
2. 右下角 **💬** 打開聊天抽屜,直接下指令(例:「做一支 15 秒 9:16 的產品廣告…」)
3. agent 到關卡會在聊天裡停下問你 → 按 **✅ 批准** 或打字修改
4. 看板即時亮起:階段、劇本、分鏡、每筆生成的成本/品質分;**▶ REPLAY RUN** 可回放整場製作

### 看板 Demo(不花錢看整個 flow)
```bash
cd OpenMontage
.venv/bin/python scripts/backlot_simulate_run.py --project demo-lighthouse
```
開著 http://localhost:4750/p/demo-lighthouse 看它 live 跑完一場假製作。

## 五、Agent 行為 — 與 OpenMontage 協議的一致性

Studio 的 agent 透過 Claude Agent SDK 啟動,並**明確設定**為與「在 OpenMontage repo 裡開 Claude Code」一致:

| 設定 | 值 | 作用 |
|---|---|---|
| `cwd` | OpenMontage repo 根目錄 | agent 的工作場 |
| `systemPrompt` | `{ preset: 'claude_code' }` | 使用 Claude Code 完整系統提示詞(SDK 預設不是,必須明設) |
| `settingSources` | `['user','project','local']` | 載入 repo 的 **CLAUDE.md**(OpenMontage 的 agent 契約) |
| `resume` | 每專案的 sessionId | 對話上下文跨訊息保留 |
| `permissionMode` | `bypassPermissions` | agent 可直接執行 OpenMontage 的 Python 工具。**僅建議本機自用** |

已實測驗證:agent 能正確覆述 CLAUDE.md 的核心規則(Rule Zero「所有影片製作必須走 pipeline」、關卡必停、付費動作先徵詢)。

## 六、常見問題

| 症狀 | 處理 |
|---|---|
| 4747 起不來 | `pkill -f "node server.js"` 再 `node server.js`;看 `/tmp/studio.log` |
| Backlot 黑屏/沒起 | 用 `http://localhost:4750`(別用 127.0.0.1 —— 跨站儲存分區會讓它白屏);或 `curl localhost:4747/api/backlot` 觸發自動拉起 |
| 聊天抽屜沒出現 | 確認 board.html 的注入行還在(OpenMontage 更新可能覆蓋);確認 4747 在跑 |
| venv 指令壞掉(cannot execute) | venv 綁絕對路徑;搬移資料夾後用 `.venv/bin/python -m pip ...` 代替 `.venv/bin/pip`,或重跑 `make setup` |
| 搬移資料夾後 agent 失憶 | session 綁路徑;把 `studio-projects.json` 的 `sessionId` 清成 `null`(素材不受影響) |
| 費用怎麼看 | 每回合結束聊天裡顯示 agent token 費;視頻生成費看板右上累計 |

## 七、檔案地圖

```
server.js               Studio 後端:專案 API、SSE 聊天、Agent SDK、Backlot 拉起、CORS、/api/bind
public/chat-widget.js   注入 Backlot 的聊天抽屜 + 專案庫「＋ 新專案」(自包含,無相依)
studio-projects.json    專案註冊表(id/slug/sessionId);刪專案不刪素材
docs/                   AI Video Agent 評測課題設計文檔(中英)
OpenMontage/            上游引擎(唯一改動:board.html 與 index.html 各注入一行)
```

## 授權注意

OpenMontage 為 **AGPL-3.0**。本 Studio 以獨立程序透過檔案系統與 HTTP 與其互動,聊天部件為注入式外掛。**本機/內部使用無虞**;若要對外提供服務,請先評估 AGPL 義務。
