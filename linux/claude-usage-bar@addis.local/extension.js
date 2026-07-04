import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const POLL_SECONDS = 180;     // gentle on the rate-limited endpoint; countdown still recomputed each poll
const SESSION_BAR = 64;       // px width of the session bar
const WEEKLY_BAR = 48;        // px width of the weekly bar
const BAR_HEIGHT = 12;
// ------------------------------------------------------------------

function colorFor(percent, severity) {
    if (severity === 'critical' || percent >= 90) return '#e01b24';
    if (severity === 'warning' || percent >= 70) return '#ff7800';
    return '#2ec27e';
}

function fmtCountdown(ms) {
    if (ms <= 0) return 'reset';
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}` : `${m}m`;
}

function fmtReset(iso) {
    const d = new Date(iso);
    const rel = fmtCountdown(d.getTime() - Date.now());
    const clock = d.toLocaleString([], {weekday: 'short', hour: '2-digit', minute: '2-digit'});
    return `${clock}  (in ${rel})`;
}

function makeBar(width) {
    const track = new St.BoxLayout({style_class: 'cub-track', y_align: Clutter.ActorAlign.CENTER});
    track.set_style(`width:${width}px; height:${BAR_HEIGHT}px;`);
    const fill = new St.Widget({y_align: Clutter.ActorAlign.CENTER});
    track.add_child(fill);
    return {track, fill, width};
}

function setBar(bar, percent, color) {
    const w = Math.max(0, Math.min(100, percent)) / 100 * bar.width;
    bar.fill.set_style(`width:${w}px; height:${BAR_HEIGHT}px; background-color:${color}; border-radius:6px;`);
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Claude Usage Bar');
        this._ext = ext;
        this._cancellable = null;

        const box = new St.BoxLayout({style_class: 'cub-panel', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Label({text: '◉', style_class: 'cub-icon', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._icon);

        // session bar + label
        this._sBar = makeBar(SESSION_BAR);
        box.add_child(this._sBar.track);
        this._sLabel = new St.Label({text: '…', style_class: 'cub-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._sLabel);

        // weekly bar + label
        this._wLabel0 = new St.Label({text: 'W', style_class: 'cub-tag', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._wLabel0);
        this._wBar = makeBar(WEEKLY_BAR);
        box.add_child(this._wBar.track);
        this._wLabel = new St.Label({text: '', style_class: 'cub-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._wLabel);

        this.add_child(box);

        // dropdown
        this._mTitle = new PopupMenu.PopupMenuItem('Claude Usage', {reactive: false});
        this._mTitle.label.add_style_class_name('cub-menu-title');
        this.menu.addMenuItem(this._mTitle);
        this._mSession = this._infoItem();
        this._mWeekly = this._infoItem();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._mUpdated = this._infoItem();
        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refresh);

        this._render({ok: false, error: 'loading'});
    }

    _infoItem() {
        const it = new PopupMenu.PopupMenuItem('', {reactive: false});
        it.label.add_style_class_name('cub-menu-line');
        this.menu.addMenuItem(it);
        return it;
    }

    _showWeekly(visible) {
        this._wLabel0.visible = visible;
        this._wBar.track.visible = visible;
        this._wLabel.visible = visible;
    }

    _render(data) {
        if (!data.ok) {
            const err = data.error || '';
            const msg = {
                loading: 'Loading…', 'no-credentials': 'no login', 'no-token': 'no login',
                'auth-expired': 'auth — open Claude', network: 'offline', 'http-429': 'rate-limited',
            }[err] || (/^http-\d/.test(err) ? 'API error' : err);
            this._icon.text = '○';
            this._sLabel.text = msg;
            setBar(this._sBar, 0, 'rgba(255,255,255,0.3)');
            this._showWeekly(false);
            this._mSession.label.text = data.error === 'auth-expired'
                ? `Token expired — ${data.hint || 'run Claude Code once'}`
                : `Unavailable (${data.error})`;
            this._mWeekly.label.text = '';
            this._mUpdated.label.text = '';
            return;
        }

        this._icon.text = '◉';
        const s = data.session;
        const w = (data.limits || []).find(l => l.kind === 'weekly_all');

        // session (panel bar + countdown)
        if (s) {
            const c = colorFor(s.percent, s.severity);
            setBar(this._sBar, s.percent, c);
            const rel = s.resetsAt ? fmtCountdown(new Date(s.resetsAt).getTime() - Date.now()) : '';
            this._sLabel.text = `${s.percent}%${rel ? ' · ' + rel : ''}`;
            this._mSession.label.text = `Session (5h): ${s.percent}%   resets ${s.resetsAt ? fmtReset(s.resetsAt) : 'n/a'}`;
        } else {
            setBar(this._sBar, 0, '#2ec27e');
            this._sLabel.text = 'n/a';
            this._mSession.label.text = 'Session: n/a';
        }

        // weekly (second panel bar)
        if (w) {
            this._showWeekly(true);
            setBar(this._wBar, w.percent, colorFor(w.percent, w.severity));
            this._wLabel.text = `${w.percent}%`;
            this._mWeekly.label.text = `Weekly: ${w.percent}%   resets ${w.resetsAt ? fmtReset(w.resetsAt) : 'n/a'}`;
        } else {
            this._showWeekly(false);
            this._mWeekly.label.text = 'Weekly: n/a';
        }

        this._mTitle.label.text = `Claude Usage${data.subscription ? ' — ' + data.subscription : ''}`;
        const stamp = `Updated ${new Date(data.fetchedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
        if (data.stale) {
            const why = data.note === 'auth-expired' ? 'token expired — run Claude Code'
                : data.note === 'offline' ? 'offline'
                : `API throttled (${data.note})`;
            this._mUpdated.label.text = `⚠ ${why} — cached ${data.cacheAgeSec ?? '?'}s ago`;
        } else {
            this._mUpdated.label.text = stamp;
        }
    }

    _refresh() {
        if (this._cancellable) this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        const script = GLib.build_filenamev([this._ext.path, 'usage-fetch.mjs']);

        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['/bin/bash', '-lc', `node ${GLib.shell_quote(script)}`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._render({ok: false, error: 'spawn'});
            logError(e, 'claude-usage-bar spawn');
            return;
        }
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            let stdout = '';
            try {
                [, stdout] = p.communicate_utf8_finish(res);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._render({ok: false, error: 'run'});
                return;
            }
            try {
                this._render(JSON.parse(stdout || '{}'));
            } catch (e) {
                this._render({ok: false, error: 'parse'});
                logError(e, 'claude-usage-bar parse');
            }
        });
    }

    startPolling() {
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
        if (this._cancellable) { this._cancellable.cancel(); this._cancellable = null; }
        super.destroy();
    }
});

export default class ClaudeUsageBarExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._indicator.startPolling();
    }
    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
