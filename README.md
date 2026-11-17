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

紀錄檔寫在 `server.log`。程式不會設定開機自動啟動，重新開機後要再執行一次。

iPhone／iPad 用 Safari 打開遊戲大廳，點「分享」→「加入主畫面」，就能像 App 一樣開啟；進入遊戲後點左上角的圖示可以回到大廳。

## 新增遊戲

把單一檔案的網頁遊戲放進 `games/`，檔名就是網址：`games/foo.html` 對應 `http://<IP>:8686/foo`，不用重開伺服器。沒有登記在 `open_server.py` 的 `CATALOG` 裡的遊戲，會用網頁標題列在大廳的「其他」；想指定名稱、分類、圖示和說明，就在 `CATALOG` 加一筆。
