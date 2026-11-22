// 大廳與牌桌共用瀏覽器的主題偏好。獨立打開遊戲檔也能使用。
(() => {
    const themes = { felt: '經典牌桌', paper: '紙上棋室', night: '東京夜色' };
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

    function setupMenu() {
        const menu = document.querySelector('.table-menu');
        if (!menu) return;
        const trigger = menu.querySelector('summary');
        // 開彈窗前先將焦點交回選單開關，關閉彈窗時可從同一處繼續操作。
        menu.addEventListener('click', event => {
            if (event.target.closest('.menu-panel button')) {
                trigger.focus({ preventScroll: true });
                menu.open = false;
            }
        }, true);
        function closeOutside(event) {
            if (menu.open && !menu.contains(event.target)) menu.open = false;
        }
        document.addEventListener('pointerdown', closeOutside);
        document.addEventListener('focusin', closeOutside);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && menu.open) {
                event.stopImmediatePropagation();
                menu.open = false;
                trigger.focus();
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
        if (!dialogs.length) return;
        let active, previous;
        const controls = dialog => [...dialog.querySelectorAll('button:enabled, select:enabled, input:enabled, a[href], summary')]
            .filter(control => control.getClientRects().length);
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
            if (!active) return;
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
            const items = controls(active);
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

    document.addEventListener('DOMContentLoaded', () => {
        setupPicker();
        setupFilters();
        setupMenu();
        setupTileInfo();
        setupDialogs();
    });
})();
