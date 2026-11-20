# 遊戲伺服器（Tailscale 內網）

在自己的電腦上開一個網頁遊戲大廳，只有同一個 [Tailscale](https://tailscale.com/) 內網的裝置連得到。手機、平板、電腦用瀏覽器打開就能玩，不用安裝 App。

| 遊戲 | 網址 | 說明 |
| --- | --- | --- |
| 暗棋 | `/banqi` | 翻開棋子、以大吃小，不允許連吃 |
| 中國象棋 | `/xiangqi` | 標準規則，可悔棋、提示，也能兩人對下 |
| 黑白棋 | `/reversi` | 夾住對方的棋子就翻面，子多的獲勝；可悔棋、提示，也能兩人對下 |
| 台灣十六張麻將 | `/mahjong` | 花牌、吃碰槓、台數計算，和三家電腦對打 |
| 台灣麻將（自我模式） | `/mahjong-me` | 胡牌被胡限定個人（電腦不會自摸、也不會胡別家電腦的牌） |
| 拱豬 | `/gongzhu` | 四人撲克吃墩，避開豬（♠Q）、搶到羊（♦J） |
| 大老二 | `/bigtwo` | 四人撲克，♣3 開局，最先出完手牌的人獲勝 |

## 需求

- Linux 與 Python 3（只用標準函式庫，不用另外安裝套件）
- 已安裝並登入 Tailscale：`tailscale ip -4` 要能印出 100.x.x.x 的位址
- 玩家的瀏覽器要能連上網際網路（遊戲頁面從 CDN 載入 Tailwind CSS 與 Google Fonts）

## 使用方式

```bash
python3 open_server.py            # 在背景開啟伺服器（關掉終端機、登出後仍會繼續執行）
python3 open_server.py status     # 查看狀態與網址
python3 open_server.py stop       # 關閉
python3 open_server.py restart    # 重新啟動
python3 open_server.py run        # 在前景執行（Ctrl+C 結束），除錯用
```

伺服器啟動時會自動抓這台的 Tailscale IP，只在這個位址上監聽（預設 port 8686），所以區網或外網都連不到，只有同一個 Tailscale 內網的裝置可以。啟動後會印出網址，用 Tailscale 內網的裝置打開 `http://<這台的 Tailscale IP>:8686/` 就是遊戲大廳。

- `--port 9000`：改用其他 port
- `--host <位址>`：改在其他位址監聽（例如 `127.0.0.1` 只給這台自己用）
- `--data-dir <資料夾>`：對局紀錄改存到別的資料夾（預設是專案裡的 `gaming_data/`，見下方「對局紀錄」）

紀錄檔寫在 `server.log`。程式不會設定開機自動啟動，重新開機後要再執行一次。

iPhone／iPad 用 Safari 打開遊戲大廳，點「分享」→「加入主畫面」，就能像 App 一樣開啟；進入遊戲後點左上角的圖示可以回到大廳。

## 對局紀錄

每一局都會自動記錄下來，不用按任何按鈕（之後分析打牌習慣、訓練電腦用）：

- 一局打完時存一次。打到一半關掉頁面、回大廳或按「重新開始」，打到一半的進度也會存下來。只是打開頁面、還沒出過牌（下過棋）的不記。
- 存在 `gaming_data/<遊戲>/<年-月>/<編號>.json`，一局一個檔；編號是開局時間加亂碼，例如 `gaming_data/mahjong/2026-11/20261120-164512-k3f9x2.json`。
- `gaming_data/` 列在 `.gitignore` 裡，不會進 git（裡面有連線裝置的 IP）；要備份就複製這個資料夾。
- 玩的時候連不上伺服器（Tailscale 斷線、伺服器重開）也不會漏：紀錄先留在瀏覽器裡，連得上時、或下次打開任何一個遊戲時補送。

每個檔的內容：

| 欄位 | 說明 |
| --- | --- |
| `game`、`id`、`status` | 哪個遊戲、這一局的編號、`finished`（打完）或 `unfinished`（沒打完） |
| `started`、`ended`、`saved` | 這一局開始、結束的時間（玩家裝置的時間），和伺服器存檔的時間 |
| `ip`、`ua` | 哪一台裝置玩的（Tailscale IP 和瀏覽器） |
| `session`、`seq` | 同一次打開頁面玩的各局 `session` 相同；`seq` 是這一局第幾次存檔（中途存過進度的會大於 1） |
| `build` | 遊戲檔的版本（git 的 blob 編號），用 `git log --all --find-object=<build>` 查得到是哪一次 commit 的檔案 |
| 其餘欄位 | 這一局的內容：第幾局、設定、各家是誰（`ai` 表示電腦）、發到的牌、依順序的每一手、結果 |

玩家按過「提示」才出的那一手會標 `hint`，麻將「自動胡牌」替玩家打的牌標 `auto`；悔掉的那幾手不會留在紀錄裡。各遊戲的牌、棋子和座位怎麼編號，寫在各遊戲檔裡 `getRecord()` 上面的說明。

## 新增遊戲

把單一檔案的網頁遊戲放進 `games/`，檔名就是網址：`games/foo.html` 對應 `http://<IP>:8686/foo`，不用重開伺服器。沒有登記在 `open_server.py` 的 `CATALOG` 裡的遊戲，會用網頁標題列在大廳的「其他」；想指定名稱、分類、圖示和說明，就在 `CATALOG` 加一筆。

新遊戲要自動記錄，得自己交出紀錄：伺服器會在每個遊戲頁面放一個 `window.GameRecorder`，每一局開始時呼叫 `GameRecorder.begin(fn)`（`fn()` 回傳這一局目前的紀錄，打完時帶 `finished: true`；還沒有值得記的內容時回傳 `null`），一局結束、或還沒打完就要換掉這一局之前呼叫 `GameRecorder.end()`。現有七個遊戲的 `getRecord()`、`recordBegin()`、`recordEnd()` 可以照著寫。
