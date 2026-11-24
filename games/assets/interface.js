// 大廳與牌桌共用瀏覽器的主題偏好。獨立打開遊戲檔也能使用。
(() => {
    const themes = {
        felt: '經典牌桌',
        paper: '紙上棋室',
        night: '東京夜色',
        harbor: '港灣晨霧',
        sakura: '春日櫻花',
        amber: '琥珀茶室',
        graphite: '石墨銀灰'
    };
    const storageKey = 'game-lobby-theme';
    const root = document.documentElement;
    let picker;
    let chrome = document.querySelector('meta[name="theme-color"]');
    if (!chrome) {
        chrome = document.createElement('meta');
        chrome.name = 'theme-color';
        document.head.append(chrome);
    }

    function savedTheme() {
        try { return localStorage.getItem(storageKey); }
        catch { return root.dataset.theme; }
    }
    function applyTheme(value) {
        const theme = Object.prototype.hasOwnProperty.call(themes, value) ? value : 'felt';
        root.dataset.theme = theme;
        chrome.content = getComputedStyle(root).getPropertyValue('--chrome').trim();
        if (picker) picker.value = theme;
    }
    applyTheme(savedTheme());
    window.addEventListener('storage', event => {
        if (event.key === storageKey || event.key === null) applyTheme(savedTheme());
    });
    window.addEventListener('pageshow', event => {
        if (event.persisted) applyTheme(savedTheme());
    });

    function setupPicker() {
        let label = document.querySelector('[data-theme-picker]');
        if (!label) {
            const rules = document.querySelector('#rulesModal .overflow-y-auto, #rulesDialog .modal-body');
            if (!rules) return;
            label = document.createElement('label');
            label.className = 'game-theme-setting';
            label.textContent = '遊戲主題';
            label.append(document.createElement('select'));
            rules.prepend(label);
        }
        picker = label.querySelector('select');
        for (const [value, name] of Object.entries(themes)) picker.add(new Option(name, value));
        picker.value = root.dataset.theme;
        label.hidden = false;
        picker.addEventListener('change', () => {
            applyTheme(picker.value);
            try { localStorage.setItem(storageKey, picker.value); } catch { /* 此分頁仍可切換。 */ }
        });
    }

    function setupFilters() {
        const filters = document.querySelector('.filters');
        if (!filters) return;
        const cards = document.querySelectorAll('.game-card');
        const buttons = filters.querySelectorAll('button');
        const count = document.getElementById('game-count');
        filters.addEventListener('click', event => {
            const selected = event.target.closest('button');
            if (!selected) return;
            const category = selected.dataset.filter;
            let visible = 0;
            for (const card of cards) {
                card.hidden = Boolean(category && category !== card.dataset.category);
                if (!card.hidden) visible++;
            }
            for (const button of buttons) button.setAttribute('aria-pressed', String(button === selected));
            count.textContent = visible + ' 款遊戲';
        });
        filters.hidden = false;
    }

    function visibleControls(area, selector = 'button, select, input, textarea, a[href], summary') {
        return [...area.querySelectorAll(selector)].filter(el =>
            !el.matches(':disabled, [aria-disabled="true"]') && el.getClientRects().length);
    }

    function arrowStep(key) {
        if (key === 'ArrowUp' || key === 'ArrowLeft') return -1;
        if (key === 'ArrowDown' || key === 'ArrowRight') return 1;
        return 0;
    }

    function modifiedKey(event) {
        return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing;
    }

    function adjacent(items, current, step) {
        const index = items.indexOf(current);
        if (index < 0) return step > 0 ? items[0] : items.at(-1);
        return items[index + step];
    }

    function setupMenu() {
        const menu = document.querySelector('.table-menu');
        if (!menu) return;
        const trigger = menu.querySelector('summary');
        const items = () => visibleControls(menu, '.menu-panel button');
        // 開彈窗前先將焦點交回選單開關，關閉彈窗時可從同一處繼續操作。
        menu.addEventListener('click', event => {
            if (event.target.closest('.menu-panel button')) {
                trigger.focus({ preventScroll: true });
                menu.open = false;
            } else if (trigger.contains(event.target) && event.detail === 0 && !menu.open) {
                event.preventDefault();
                menu.open = true;
                items()[0]?.focus();
            }
        }, true);
        function closeOutside(event) {
            if (menu.open && !menu.contains(event.target)) menu.open = false;
        }
        document.addEventListener('pointerdown', closeOutside);
        document.addEventListener('focusin', closeOutside);
        document.addEventListener('keydown', event => {
            if (!menu.open || event.defaultPrevented || modifiedKey(event)) return;
            const key = event.key;
            if (key !== 'Escape' && !arrowStep(key)) return;
            const buttons = items(), current = document.activeElement;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (key === 'Escape' || key === 'ArrowLeft' ||
                (key === 'ArrowUp' && (current === trigger || current === buttons[0]))) {
                menu.open = false;
                trigger.focus();
            } else if (key === 'ArrowUp' || key === 'ArrowDown') {
                adjacent(buttons, current, arrowStep(key))?.focus();
            }
        }, true);
    }

    function setupTileInfo() {
        const dialog = document.getElementById('tileInfoDialog');
        if (!dialog) return;
        const panels = ['valueCard', 'statusCard'].map(id => document.getElementById(id));
        const columns = panels.map(panel => panel.parentElement);
        const content = dialog.querySelector('.info-content');
        document.querySelector('.mj-info-button').addEventListener('click', () => {
            // 使用原本會隨出牌更新的兩張資訊卡。
            content.append(...panels);
            dialog.showModal();
        });
        dialog.addEventListener('close', () => {
            if (!dialog.open) panels.forEach((panel, index) => columns[index].append(panel));
        });
        dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape') event.stopPropagation();
        });
        matchMedia('(min-width: 640px)').addEventListener('change', event => {
            if (event.matches && dialog.open) dialog.close();
        });
    }

    function setupDialogs() {
        const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
        if (!dialogs.length && !document.querySelector('dialog')) return;
        let active, previous;
        function sync() {
            const visible = dialogs.filter(dialog => !dialog.classList.contains('hidden'));
            const next = visible[visible.length - 1];
            if (next === active) return;
            if (!active && next) previous = document.activeElement;
            active = next;
            if (active) {
                active.tabIndex = -1;
                active.focus({ preventScroll: true });
            } else if (previous?.isConnected) {
                previous.focus({ preventScroll: true });
            }
        }
        const observer = new MutationObserver(sync);
        for (const dialog of dialogs) observer.observe(dialog, { attributes: true, attributeFilter: ['class'] });
        sync();
        document.addEventListener('keydown', event => {
            const dialog = document.querySelector('dialog[open]') || active;
            if (!dialog || event.defaultPrevented) return;
            const step = arrowStep(event.key);
            if (step) {
                if (modifiedKey(event) || event.target.isContentEditable || event.target.closest?.('input, textarea')) return;
                const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
                if (vertical && event.target.closest?.('select')) return;
                event.preventDefault();
                const content = vertical && dialog.querySelector('.overflow-y-auto, .modal-body, .info-content');
                if (content && (step > 0 ? content.scrollTop + content.clientHeight < content.scrollHeight - 1 : content.scrollTop > 0)) {
                    content.scrollBy(0, step * 48);
                } else {
                    adjacent(visibleControls(dialog), document.activeElement, step)?.focus();
                }
                return;
            }
            if (dialog !== active) return; // 原生 dialog 自行處理 Tab 與 Escape。
            if (event.key === 'Escape') {
                const close = active.querySelector('button[aria-label="關閉視窗"], button[onclick^="game.close"]');
                if (close) {
                    event.stopImmediatePropagation();
                    event.preventDefault();
                    close.click();
                }
                return;
            }
            if (event.key !== 'Tab') return;
            const items = visibleControls(active);
            if (!items.length) { event.preventDefault(); return; }
            const index = items.indexOf(document.activeElement);
            if (event.shiftKey && index <= 0) {
                event.preventDefault();
                items[items.length - 1].focus();
            } else if (!event.shiftKey && (index < 0 || index === items.length - 1)) {
                event.preventDefault();
                items[0].focus();
            }
        }, true);
    }

    // 棋格已依畫面順序排列（含執黑時翻轉的象棋盤）。上下換排時盡量維持同一列。
    function nextBoardChoice(choices, current, columns, key, step) {
        const square = el => Number(el.dataset.keyCell);
        const vertical = key === 'ArrowUp' || key === 'ArrowDown';
        const position = vertical ? el => Math.floor(square(el) / columns) : square;
        const from = position(current);
        const ahead = choices.filter(el => (position(el) - from) * step > 0);
        const next = step > 0 ? ahead[0] : ahead.at(-1);
        if (!vertical || !next) return next;
        const row = position(next);
        const distance = el => Math.abs(square(el) % columns - square(current) % columns);
        return ahead.filter(el => position(el) === row).reduce((a, b) => distance(a) <= distance(b) ? a : b);
    }

    function setupGameKeyboard() {
        if (!root.dataset.game) return;
        const header = document.querySelector('.table-header');
        const board = document.querySelector('[data-key-columns]');
        const playArea = board ?? document.querySelector('#hand, #playerHand, .gz-hand');
        if (!playArea) return;
        if (!playArea.hasAttribute('tabindex')) playArea.tabIndex = -1;
        const commands = document.querySelector('[data-table-commands]');
        const towardCommands = commands?.dataset.tableCommands === 'above' ? 'ArrowUp' : 'ArrowDown';
        const choiceSelector = '[data-game-choice="true"]:not(:disabled, [aria-disabled="true"])';
        const toolSelector = '.table-home, .table-tools > button:not(.unavailable), .table-menu > summary';
        const openOverlay = 'dialog[open], div[role="dialog"]:not(.hidden), .table-menu[open]';
        let lastChoice = null;
        document.addEventListener('focusin', event => {
            if (event.target.matches(choiceSelector)) lastChoice = event.target;
        });
        function enterToolbar() {
            const tools = visibleControls(header, toolSelector);
            (tools.find(el => !el.matches('.table-home')) ?? tools[0])?.focus();
        }
        function gameChoices(area) {
            const choices = visibleControls(area, choiceSelector);
            if (board) choices.sort((a, b) => Number(a.dataset.keyCell) - Number(b.dataset.keyCell));
            return choices;
        }
        function returnToPlay(choices, options) {
            let next = lastChoice;
            if (lastChoice && !choices.includes(lastChoice)) {
                // 重畫會替換麻將牌或象棋落點。相同的麻將牌依手牌位置區分。
                const label = lastChoice.getAttribute('aria-label');
                next = choices.find(el => label
                    ? el.getAttribute('aria-label') === label && el.dataset.i === lastChoice.dataset.i
                    : el.isEqualNode(lastChoice));
            }
            (next ?? choices[0] ?? playArea)?.focus(options);
        }
        function focusTurn() {
            const current = document.activeElement;
            if (document.hidden || !current || document.querySelector(openOverlay)) return;
            if (current !== document.body && current !== playArea) {
                // 保留正在操作的功能、表單，以及仍可出的那張牌。
                if (!current.matches('[data-game-choice], [data-turn-action]')) return;
                if (current.matches(choiceSelector + ', [data-turn-action]:enabled') && current.getClientRects().length) return;
            }
            const plays = gameChoices(playArea);
            const choices = plays.length ? plays : visibleControls(document, '[data-turn-action]');
            if (choices.length) returnToPlay(choices, { preventScroll: true });
        }
        function enableKeyboardMode() {
            root.dataset.keyboardMode = '';
            // 每批重畫結束後才恢復焦點。等電腦出牌時沒有可選項，就等下次畫面更新。
            const observer = new MutationObserver(focusTurn);
            const changes = { childList: true, subtree: true, attributeFilter: ['data-game-choice', 'disabled', 'hidden'] };
            observer.observe(playArea, changes);
            const actions = document.getElementById('actionBar');
            if (actions) observer.observe(actions, changes);
            for (const dialog of document.querySelectorAll('dialog, div[role="dialog"]')) {
                observer.observe(dialog, { attributeFilter: ['open', 'class'] });
            }
            document.addEventListener('visibilitychange', focusTurn);
            requestAnimationFrame(focusTurn);
        }
        const modeKey = 'game-keyboard-mode';
        let usedKeyboard = false;
        try { usedKeyboard = sessionStorage.getItem(modeKey) === '1'; } catch { /* 此頁仍可使用鍵盤。 */ }
        if (usedKeyboard) enableKeyboardMode();
        else {
            window.addEventListener('keydown', function firstKey(event) {
                if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.target.isContentEditable
                    || event.target.closest?.('input, textarea')) return;
                const key = event.key;
                if (key.length !== 1 && !arrowStep(key) && !['Tab', 'Enter', 'Escape'].includes(key)) return;
                window.removeEventListener('keydown', firstKey, true);
                try { sessionStorage.setItem(modeKey, '1'); } catch { /* 保留本頁的鍵盤模式。 */ }
                enableKeyboardMode();
            }, true);
        }
        document.addEventListener('keydown', event => {
            const key = event.key, step = arrowStep(key);
            const activate = key === 'Enter' || key === ' ';
            if (event.defaultPrevented || (!step && !activate)) return;
            const control = event.target.closest?.('[data-game-choice]');
            const blocked = modifiedKey(event) || event.target.isContentEditable || event.target.closest?.('input, select, textarea')
                || document.querySelector(openOverlay);
            if (activate) {
                if (event.repeat && event.target.closest?.('button, summary, a[href], [role="button"]')) {
                    event.preventDefault();
                    return;
                }
                if (!control) return;
                if (blocked || control.dataset.gameChoice !== 'true') event.preventDefault();
                else if (control.matches('[role="button"]:not(button)')) {
                    event.preventDefault();
                    control.click();
                }
                return;
            }
            if (blocked) return;

            const choices = gameChoices(document);
            const buttons = commands ? visibleControls(document, 'button[data-table-commands], [data-table-commands] button') : [];
            const playable = choices.length ? choices : buttons;
            const current = document.activeElement;
            const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
            event.preventDefault();
            if (header.contains(current)) {
                if (key === 'ArrowDown') returnToPlay(playable);
                if (horizontal) adjacent(visibleControls(header, toolSelector), current, step)?.focus();
            } else if (commands?.contains(current)) {
                if (horizontal) adjacent(buttons, current, step)?.focus();
                else if (key !== towardCommands && choices.length) returnToPlay(choices);
                else if (key === 'ArrowUp') enterToolbar();
            } else if (board && current?.hasAttribute('data-key-cell')) {
                const next = nextBoardChoice(choices, current, Number(board.dataset.keyColumns), key, step);
                if (next) next.focus();
                else if (key === 'ArrowUp') enterToolbar();
            } else if (key === towardCommands && buttons.length && choices.includes(current)) {
                buttons[0].focus();
            } else if (key === 'ArrowUp') {
                enterToolbar();
            } else if (key === 'ArrowDown') {
                returnToPlay(playable);
            } else {
                adjacent(playable, current, step)?.focus();
            }
        }, true);
    }

    document.addEventListener('DOMContentLoaded', () => {
        setupPicker();
        setupFilters();
        setupMenu();
        setupTileInfo();
        setupDialogs();
        setupGameKeyboard();
    });
})();
