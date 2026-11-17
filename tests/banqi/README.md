# 暗棋 AI：回歸、量測與對局

Node.js 18 以上；不需安裝套件。從專案根目錄執行。測試從實際的
`games/banqi.html` 載入規則與 AI，不另複製一套引擎，也不啟動瀏覽器。

## 固定版本與指令

原版固定為 `8e50d139bb7887cb2b1ae8efa7ea118c217d3440`。相關 PR #1 的
版本是 `f983b60e155fcfb5b70421d7f8ab6edc7f1ca33a`；2026-11-16 查核時
仍為 open / draft / 未合併。這次實作從 main 出發，參考其剋星估值與翻棋
加分上限，沒有將 PR #1 當成已完成的整體解法。

```bash
node --test tests/banqi-ai.test.cjs tests/banqi-middlegame.test.cjs tests/banqi-record.test.cjs
BANQI_REF=8e50d139bb7887cb2b1ae8efa7ea118c217d3440 node --test tests/banqi-ai.test.cjs

# 同一個 1 秒上限；實際用時會列出，舊版可能提前停止。
node tests/banqi/bench.cjs --ms 1000 --colors --out /tmp/banqi-time.json

# 可重現的節點預算，計算至最多 6 層；先完成最低一輪，再套節點目標。
node tests/banqi/bench.cjs --nodes 60000 --depth 6 --colors --out /tmp/banqi-nodes.json

# 從固定公開局面開始對局，每個種子交換新版執紅／黑，逐手檢查合法性與庫存。
node tests/banqi/match.cjs --ms 1000 --seeds 17 \
  --positions opening,middlegame,safe_pressure,few_piece,cannon_screen \
  --out /tmp/banqi-matches.json

# 固定節點對局，可增加種子和局面數；達到 240 手仍未終局就記 unfinished。
node tests/banqi/match.cjs --nodes 8000 --plies 240 --seeds 17,91 \
  --positions opening,middlegame,safe_pressure,last_counter,few_piece,long_pursuit,cannon_screen,last_target_trade \
  --out /tmp/banqi-node-matches.json

node tests/banqi/summarize.cjs /tmp/banqi-time.json /tmp/banqi-matches.json
```

`--refs baseline,current`、`--positions id,id`、`--depth` 可縮小量測範圍。
`match.cjs --out file.json.gz` 可直接輸出壓縮棋譜；`summarize.cjs` 同時支援
`.json` 與 `.json.gz`。報告保留壓縮棋譜以減少儲存空間，內容仍是完整逐手 JSON。
`BANQI_REF` 與 `--refs` 也接受任意本機 Git ref；若要測 PR #1，先
`git fetch origin refs/pull/1/head:refs/remotes/origin/pr-1`。

## 局面與驗收方式

座標 a4 在左上，h1 在右下。完整盤面、暗棋位置、公開池、計數均定義在
`positions.cjs`；沒有把未知棋子身分預先放進測試棋盤。

- `safe_pressure`：紅帥 b2、馬 b1；黑士 a3、象 c4；a2/a4/d4/d3 為暗棋，
  公開池為黑卒、紅馬、紅車、黑馬，quiet=35。驗收 b2→b3，並實際驗證士
  無走子退路、帥不受明子直接攻擊。測試包括紅黑、左右、上下變換。
- `pressure`：保留 PR 中更複雜的七暗棋案例，另有 b4 暗棋與更多卒。
  不要求它與上例作相同決策。若黑翻 b4 卒，紅立即吃 a3 士後，黑可
  b4→b3 封死帥；安全撤退才是合理應對。測試實際走出這條陷阱及撤退。
- `pawn_danger` / `cannon_danger` / `recapture_danger`：直接驗證敵方合法
  吃子走法，要求避開 b2→b3，不能用「有主動性」掩蓋送子。
- `last_counter`：保留受車攻擊的最後炮，避免炮吃將後被士反吃；兩士仍存活。
  `hidden_backup`、`last_target_trade`、`forced_trade`、`score_trade` 分別
  驗證暗棋備援、消除最後目標、無其他合法走法、避免立即比分輸棋的例外。
- `cannon_screen`：先走車建立炮架；枚舉黑方每個合法回應，確認下一手實際吃士。
  炮擊、大子交換、兵吃將、炮架數量、少子殘局另有基準。
- 50 手測試實際執行動作後檢查勝負與計數；「不能吃士」不等於判負。
- 獨立、不剪枝的小型機率樹核對後續翻棋、第二次翻棋的條件機率與搜尋界限。
  另核對混合勝負距離的期望值不會跨絕對手數錯用轉置快取。
  這是搜尋正確性測試，棋力驗收仍以其他測試的合法動作與對局結果為準。
- 在第 1、2、37、128、1024、8192 節點及牆鐘逾時中斷，逐項確認 board、
  pool、alive、hidden、quiet 還原；未完成一輪時也要回傳合法動作。

以上均為明確定義的類似局面，**不是半張原圖的精確重建**。

## 公平性與統計的解讀

比較關閉選步的分數雜訊及其搜尋容許範圍（noise=margin=0），但保留固定種子的同分排序；翻棋使用完全獨立的
亂數來源，只有執行完選步才抽棋、公開更新棋池。交換引擎執紅／黑時保持
相同起始局面與抽棋亂數種子；不同走法可能改變抽棋時間與棋池，並不保證
兩盤會翻出相同的局面。`opening` 是已定色、已有兩枚明子的開局，並非
從第一手隨機定色開始。

固定節點比較的兩版均先完成最低一輪，再套節點目標；否則舊版首輪中斷可能
回傳空動作，不能當作棋力輸棋。若最低一輪本身已超過目標，JSON 的實際節點
會明列超額。一般產品的時間限制與新版合法備援動作不受這項測試政策影響。
此模式把搜尋用牆鐘固定，因此舊版按「時間已過 25%」凍結翻棋的策略不會啟動；
它是可重現的節點／深度控制實驗，不是瀏覽器時間策略的等價重播。1 秒對局
則保留原版真實的時間分配邏輯。

節點是一般搜尋與 qsearch 的進入次數，不是不同盤面數；轉入 qsearch 時會各計一次。
一個節點的成本在兩版並不相同，不能把節點
預算對局當作同耗時對局。時間預算也列出實際耗時：原版的「預測下一輪
來不及」可能使它只用掉一部分上限。請勿只挑某一版有利的比較方式。

JSON 逐手記錄動作、實際翻出的棋、被吃棋、比分、quiet、完成深度、節點
和時間。新版的 `moveDepth/flipDepth` 只計最後共同完成的根迭代；原版分別
記錄兩者，可能不同。`maxPly` 包含吃子延伸，`chanceStops` 表示用完翻棋
預算又沒有走子，因而停在估值的次數；「標示 12 層」不表示每條分支都有
12 手實際行動。

`counterLostInTradeWhileBehind` 記錄「剛吃子就被反吃、比分落後、產生新的
無剋星敵類」事件；`newUncoveredTypes` 則包含所有造成無剋星的吃子。
它們是回放檢查線索，**不是自動宣判策略錯誤**，因為可能沒有保存方法。
`nonwinningCycles` 記錄比分未領先時的第三次以上重複；比分領先的重複
另記 `scoringCycles`，不把合法的比分獲勝策略當作失誤。

測試含多個同型變換，通過數不能當成同樣數量的獨立棋局。少量配對對局
只能提供初步證據，沒有 Elo 或統計顯著性的宣稱。

## 搜尋與仍有的限制

保留 alpha-beta、殺手走法及四層吃子延伸，加入每次決策清空的轉置表與
評估快取。估值計算公開庫存中的剩餘剋星、安全鄰格、穿越空格的安全路徑；
每枚移動子先移除出發格，再計算其專屬炮線；逐格核對與真的搬子後判斷一致。
沒有「暗棋數從 1 變 0 就把距離權重放大」的切換。
已被明子攻擊、又無安全退路時，補上受困風險；炮的安全跳吃也算退路。
這些仍是有限的估值，可能有其他棋子擋炮或反擊，並非直接判定必失或解出完整包圍計畫。

翻棋位置先全看一輪，後續根搜尋保留前四名及邊界同分者；內部選相鄰明子、
炮線較相關的前兩格及邊界同分者（暗棋至多四格時全看）。每個入選格子都
完整枚舉公開池的棋種，使用 `count / total`，減少池後才繼續搜尋；機率結果
以完整窗口求值，不能平均 alpha-beta 截斷的上下界。

每條路徑至多翻一次；池只剩四枚以下時至多兩次，因第二次的格數與棋種
分支已大幅減少。超過此範圍的翻棋屬於未搜尋邊界，沒有再用讓手假裝翻棋。
候選位置篩選與翻棋次數上限仍可能漏掉遠處的準備手或連續翻棋計畫；不是
完整的暗棋 expectiminimax。qsearch 保留四層吃子延伸；第二輪僅在無暗棋、
quiet=49 時加入安靜走法的精確比分檢查。其他安靜解圍仍依靠主搜尋和估值，
沒有宣稱解決所有 zugzwang 或長期圍捕。

困難仍為最多 12 層、1 秒上限；普通仍最多 2 層、600ms，簡單保留隨機失誤，
提示最多 3 層。普通是頁面預設難度，不能將困難模式的深度數字套到普通。
搜尋仍同步執行於頁面主執行緒；沒有增加等待時間或接入外部引擎。

瀏覽器可在下一次決策後讀取 `BanqiAI.lastSearch` 查看此次完成迭代與統計。

## 第二輪：困難模式的再驗證

比較對手固定為已上線的 `27136d6c5567806758ef28f690c40335ebc3ad17`。
第一輪報告保留原貌；第二輪的正反結果見
[`reports/banqi/round2/README.md`](../../reports/banqi/round2/README.md)。
沒有採用測試中退步的安靜解圍、翻棋深度／候選篩選、控制估值、PVS 等實驗。
正式修改是無暗棋時第 49 手的比分延伸，以及公開棋譜量測。計算優化雖增加
吞吐量，時間對局沒有證明棋力收益，因此同樣保留在實驗資料，未採用。
**這些成果不等於已證明解決整體棋力斷層。**

```bash
node --test tests/banqi-ai.test.cjs tests/banqi-middlegame.test.cjs tests/banqi-record.test.cjs

# 前版在新增的 50 手策略案例失敗，為預期的修改前比較。
BANQI_REF=27136d6 node --test tests/banqi-middlegame.test.cjs

# 重現未採用的計算優化：等值不等於對局變強。
gzip -dc reports/banqi/round2/rejected-evalopt.html.gz > /tmp/rejected-evalopt.html
node tests/banqi/equivalence.cjs --source /tmp/rejected-evalopt.html --out /tmp/banqi-equivalence.json

# 凍結可達局面：使用固定前版、公開歷史、獨立抽棋來源。
node tests/banqi/corpus.cjs --out /tmp/banqi-corpus.json.gz
node tests/banqi/phase-bench.cjs --corpus /tmp/banqi-corpus.json.gz \
  --ms 1000 --out /tmp/banqi-phase-time.json

# 新前版都有合法備援，使用嚴格節點上限，不再額外放寬首輪。
node tests/banqi/match.cjs --production --opponent 27136d6 \
  --corpus reports/banqi/round2/development-corpus.json.gz \
  --ids s11-p0,s23-p0,s11-p24,s23-p24 --nodes 20000 --strict-nodes \
  --independent-reveals --plies 260 --seeds 137 --out /tmp/banqi-nodes.json.gz

# 真正的相同時間上限；執行時不要同時跑其他大量計算。
node tests/banqi/match.cjs --production --opponent 27136d6 \
  --corpus reports/banqi/round2/time-corpus.json.gz \
  --ids s601-p0,s701-p0,s601-p24,s701-p24 --ms 1000 \
  --independent-reveals --plies 260 --seeds 2557 --out /tmp/banqi-time.json.gz
```

第二輪使用 `--production` 保留產品困難模式的 noise=0.25 / margin=1。
`--independent-reveals` 把局面 ID 納入抽棋種子，避免不同起始局面共用同一串
抽棋；同局面的兩個換色對照仍共用抽棋種子。種子只供外部規則引擎抽棋，
不傳給 AI。`--source /path/to/candidate.html` 可在獨立檔案測試候選版本，
不用改動正在由伺服器提供的網頁。輸出包含完整 HTML 的 SHA-256。

`browser-check.cjs` 在實際頁面選擇「困難」，經 `executeAITurn()` 驗證動作、
搜尋還原、回合交接、匯出事件及 JavaScript 錯誤。它需要已有的 Puppeteer
與 Chrome；可用 `BANQI_PUPPETEER`、`BANQI_CHROME` 指定位置。這兩者是選用
測試工具，遊戲與其餘測試不依賴它們。

## 回報實際棋局

規則／設定視窗底部有 **匯出本局棋譜**，並顯示 AI 版本。它下載 JSON，
包含已下過的動作、當時難度、每次電腦搜尋的完成深度、實際最大手數、
節點數、耗時、公開剩餘棋池與目前比分計數。未翻位置仍為 15，沒有未來棋子
身分，也不包含尚未發生的抽棋序列。重新整理頁面才會載入新 JS；再玩一局
會沿用目前頁面已載入的版本。

```bash
# 驗證整份棋譜的合法性、庫存與最終盤面。
node tests/banqi/replay.cjs /path/to/banqi-round-1-move-52.json

# 回到第 25 手之前再分析；只讀前 24 手，後續抽棋與最終盤面不送給 AI。
node tests/banqi/replay.cjs /path/to/record.json --before 25 --analyze --ms 1000
node tests/banqi/replay.cjs /path/to/record.json --before 25 --analyze --ref 27136d6
```

棋譜能精確還原公開局面；1 秒搜尋會受裝置速度、當時負載及選步亂數影響，
不保證每次選同一手。`maxReveals` 記錄真正展開的翻棋層數，`quietExtensions`
記錄第 49 手的比分延伸，`completedDepth` 仍不能當成每條路徑的實際手數。
