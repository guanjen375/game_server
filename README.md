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
- `--model-dir <資料夾>`：訓練好的模型改從別的資料夾讀（預設是專案裡的 `train_out/`，見下方「讓電腦照模型出牌」）

紀錄檔寫在 `server.log`。程式不會設定開機自動啟動，重新開機後要再執行一次。

iPhone／iPad 用 Safari 打開遊戲大廳，點「分享」→「加入主畫面」，就能像 App 一樣開啟；進入遊戲後點左上角的圖示可以回到大廳。

在大廳的「大廳主題」可選經典牌桌（預設）、紙上棋室或東京夜色。七款遊戲都會沿用這個外觀。對局中也可以打開規則說明，在「遊戲主題」直接切換並繼續這一局。同一個瀏覽器會記住選擇。後兩款的配色分別參考 [Solarized](https://ethanschoonover.com/solarized/) 與 [Tokyo Night](https://github.com/tokyo-night/tokyo-night-vscode-theme)。

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

玩家按過「提示」才出的那一手會標 `hint`，麻將「自動胡牌」替玩家打的牌標 `auto`；悔掉的那幾手不會留在紀錄裡。電腦照模型出的牌標 `bot`（見下方「讓電腦照模型出牌」）。各遊戲的牌、棋子和座位怎麼編號，寫在各遊戲檔裡 `getRecord()` 上面的說明。

## 訓練模型

`train_gpu.py` 用 `gaming_data/` 的對局紀錄，訓練「照玩家的習慣出牌（下棋）」的模型，之後做自己的電腦對手用。要在有 NVIDIA GPU、裝了 [PyTorch](https://pytorch.org/get-started/locally/)（支援 CUDA 的版本）的電腦上執行；找不到 NVIDIA GPU 會直接顯示錯誤，不會改用 CPU。

```bash
python3 train_gpu.py gongzhu           # 用 gaming_data/gongzhu/ 的紀錄訓練，模型放在 train_out/gongzhu/
                                       # 訓練中：按 p 暫停／繼續，按 q 存檔後離開
python3 train_gpu.py gongzhu status    # 看練到哪裡
python3 train_gpu.py                   # 列出每個遊戲有幾局紀錄、練到哪裡
```

其他遊戲把 `gongzhu` 換成 `mahjong`、`bigtwo`……（就是 `gaming_data/` 底下的資料夾名稱）。在 Windows 上把開頭的 `python3` 換成 `python`。

- **暫停**都在訓練的那個視窗裡按鍵：
  - `p`：暫停。訓練把進度存好、把 GPU 完全讓出來，視窗停在暫停；再按一次 `p`（或 Enter）就從暫停的地方接著練。
  - `q`（或 Ctrl+C）：存檔後離開。之後再執行一次同一個指令，一樣從停下來的地方接著練。
  - 訓練途中 GPU 出錯也會停在暫停，GPU 可以用了再按 `p` 接著練。
  - 訓練途中每 60 秒會自動存檔（`--save-every` 可以改），被強制關掉或當機時，下次執行從最後一次存檔接著練。
- 建議開在 `tmux` 裡跑（`tmux new -s train`）：斷線了訓練還在，`tmux attach -t train` 回來一樣按 `p`、`q`。放在背景或排程執行、沒有視窗可以按鍵時，改用 `python3 train_gpu.py gongzhu pause`（或 Ctrl+C、kill）暫停。
- **學什麼**：把每一局重排一遍，在玩家每次要做決定的時候，記下他當時看得到的東西和他選了什麼，讓模型學著猜。只學真人的決定；電腦對手的、按過「提示」才做的、麻將自動胡牌替玩家打的都不學（`--players all`、`--with-hints` 可以改）。`--ip <來源 IP>` 只用某一台裝置玩的紀錄。
- **產出**在 `train_out/<遊戲>/`：`model.pt`（模型，驗證成績最好的那一輪）、`log.csv`（每一輪的成績）、`checkpoint.pt`（訓練進度，接著練用）、`status.json`（目前狀態）。
- **分享模型**：`model.pt` 和 `log.csv` 會進 git，練完 `git add train_out`、commit、push，別人拉下來就能用（用模型不需要 GPU，裝了 PyTorch 就行，讀法見 `train_gpu.py` 的 `load_model()`；遊戲伺服器用它出牌連 PyTorch 都不用，見下方「讓電腦照模型出牌」）。訓練進度、狀態這些只在訓練那台用的檔案列在 `.gitignore` 裡，不會進 git。
- 訓練完會顯示「沒練過的對局裡猜中玩家怎麼選的比例」，旁邊附上亂選的比例當對照。對局越多越準；只有幾十局時模型只能當參考。
- 之後多了新的對局，再執行一次就會用全部的紀錄重新訓練（上一個模型留成 `model.previous.pt`）；紀錄沒變的話不會重練，要重練加 `--restart`。
- 訓練的電腦和遊戲伺服器不是同一台時，把 `gaming_data/` 複製過去（它不在 git 裡），或用 `--data-dir` 指到紀錄的資料夾；`--out-dir` 可以改模型放哪裡。其他設定見 `python3 train_gpu.py --help`。

## 讓電腦照模型出牌

`train_out/<遊戲>/model.pt` 放著，遊戲裡就多了模型可以選：選了之後，電腦不用頁面內建的打法，改成每一手都問模型。伺服器這邊不需要 PyTorch，也不需要 GPU。目前接上的是拱豬（三家電腦用同一個模型）。

從訓練到用上：

```bash
# 訓練的那台：練完把模型推上去
python3 train_gpu.py gongzhu
git add train_out && git commit -m "Update the Gong Zhu model" && git push

# 遊戲伺服器這台：拉下來就生效，不用重開伺服器
git pull
python3 open_server.py status     # 會列出現在哪些遊戲有模型可以選、是哪個模型
```

然後在遊戲裡選：**規則說明**和**計分板**（每一局結算時會自動打開）裡都有「電腦的打法」，底下一行寫著伺服器上的模型（用幾局練的、什麼時候存檔、猜中的比例）。選了之後這台裝置會記住，其他裝置不受影響。大廳裡，有模型可以選的遊戲會標「可以和模型對打」。

- **原本的電腦**（預設）：頁面內建的算法，和沒有模型的時候一樣。
- **模型・正常**：完全照模型，每一手都出模型分數最高的那一張。
- **模型・較弱**：一樣照模型，但照它估的機率抽一張，所以有時會出它的第二、第三選擇。模型估的機率不到一成的牌不出；同一個局面每次出的都一樣（悔牌重來不會換一張）。要更弱或沒那麼弱，改 `model_bot.py` 開頭的 `WEAK_FLOOR`、`WEAK_TEMPERATURE`（旁邊有各種設定量出來的差距），改完重開伺服器。

其他：

- 模型不一定比原本的電腦強：`train_gpu.py` 練的是「學玩家的出牌習慣」的模型，對局少的時候通常比較弱，所以預設還是原本的電腦。拱豬現在放的是另外用自我對打練的 20261122 版，比原本的電腦強（見下面）。
- 模型檔換了不用重開伺服器，玩的人也不用重新整理頁面：下一局開始就用新的。
- 選了模型，但沒有模型檔、模型和現在的程式對不上（看牌的欄位改過，要重新訓練）、或玩的時候連不上伺服器，電腦就用原本的打法照常出牌，「電腦的打法」底下會寫原因。「出牌提示」一直是內建的算法，和模型無關。
- 對局紀錄裡，模型出的牌標 `bot`（值是當時的打法 `normal` 或 `weak`），那一局另外有 `model`：模型檔的 git blob 編號，`git log --all --find-object=<model>` 查得到是哪一次 commit 的模型。沒標的是內建電腦出的。訓練只學真人的決定，這些標記不影響訓練。

### 拱豬現在的模型：20261122 版

`train_out/gongzhu/model.pt` 現在是 **20261122 版**：2026-11-22 在 H200 那台用自己和自己對打練出來的（不是學玩家的紀錄）。訓練那邊的檔名是 `generation-7_20261122-161404.pt`，git blob 編號 `e9e87aaf87953dbb5ce7285c711b0e2b726f85fc`（對局紀錄的 `model` 就是這個編號）。

- 強度（訓練那邊量的）：一家模型對三家內建電腦，每副牌四個座位各坐一次，7,168 副牌共 28,672 局，模型每局比內建電腦平均多 20.3 分（95% 區間 18.5～22.0）。
- 在遊戲伺服器這台，模型出一張牌約 0.04～0.07 秒。
- **換版本的標準**：以 20261122 版當基準。新練出來的模型要和它直接對打，每局平均贏超過 10 分才換上去；沒超過就繼續用 20261122 版。
- 每個版本在 `train_out/gongzhu/model_backup/` 留一份，檔名帶日期（`model_20261122.pt`），看得出是哪一天的版本；遊戲只讀 `model.pt`，備份不會被拿去用。
- 換的時候把新的模型檔蓋到 `train_out/gongzhu/model.pt`、在 `model_backup/` 多放一份帶日期的，這一段的版本名稱、編號和成績跟著改。
- `python3 train_gpu.py gongzhu` 練的是「學玩家出牌」的模型，一開始練就會把這裡的 `model.pt` 改名成 `model.previous.pt`、練完換成新的。要留著 20261122 版，就加 `--out-dir` 練到別的資料夾。

## 新增遊戲

把單一檔案的網頁遊戲放進 `games/`，檔名就是網址：`games/foo.html` 對應 `http://<IP>:8686/foo`，不用重開伺服器。沒有登記在 `open_server.py` 的 `CATALOG` 裡的遊戲，會用網頁標題列在大廳的「其他」；想指定名稱、分類、圖示和說明，就在 `CATALOG` 加一筆。

新遊戲要自動記錄，得自己交出紀錄：伺服器會在每個遊戲頁面放一個 `window.GameRecorder`，每一局開始時呼叫 `GameRecorder.begin(fn)`（`fn()` 回傳這一局目前的紀錄，打完時帶 `finished: true`；還沒有值得記的內容時回傳 `null`），一局結束、或還沒打完就要換掉這一局之前呼叫 `GameRecorder.end()`。現有七個遊戲的 `getRecord()`、`recordBegin()`、`recordEnd()` 可以照著寫。要讓 `train_gpu.py` 也能拿新遊戲的紀錄訓練，還要在 `train_gpu.py` 裡替它寫一個 `Game`（怎麼把一局紀錄重排成一個一個的決定），現有七個遊戲的可以參考。

要讓一個遊戲的電腦可以照模型出牌（目前只有拱豬接上），兩邊各加一小段：`train_gpu.py` 那個遊戲的 `Game` 加 `upcoming()`（從這一局到目前為止的紀錄，算出輪到的人看到什麼）；遊戲頁面加一個讓玩家選「電腦的打法」的地方，每一局開始時呼叫 `GameBot.refresh()`，玩家選了模型的話，輪到電腦時呼叫 `GameBot.choose(這一局到目前為止的紀錄, 座位, 打法)`，拿到的是模型選的那一手，拿到 `null`（沒有模型、連不上）就用自己原本的電腦。`GameBot` 是伺服器加在頁面上的（`open_server.py` 的 `BOT`），拱豬的 `executeAITurn()`、`setBotMode()` 可以照著寫。
