#!/usr/bin/env python3
# Claude Usage — Raspberry Pi OS tray indicator (labwc / wf-panel-pi).
#
# Raspberry Pi OS draws its panel with wf-panel-pi, not GNOME Shell, so the
# extension in linux/ can't load there. wf-panel-pi does host StatusNotifierItem
# icons in its tray, so this registers one: the icon (session % over a session bar
# and a weekly bar) is drawn on the fly and the menu mirrors the GNOME dropdown.
# Data comes from the same usage-fetch.mjs the GNOME extension runs, so the cache,
# the 429 cooldown and the shared cache behave identically.
#
# The item is spoken over D-Bus directly rather than through libayatana-appindicator:
# that library can only name an icon file, and wf-panel-pi's tray never picks up an
# icon from IconThemePath or an absolute path. Sending IconPixmap (raw pixels), as
# Electron apps do, always shows, and a redrawn icon replaces the old one at once.
import fcntl
import json
import math
import os
import sys
from datetime import datetime, timezone

import cairo
from gi.repository import Gio, GLib

# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------
POLL_SECONDS = 180      # gentle on the rate-limited endpoint
REDRAW_SECONDS = 60     # recompute countdowns from the last reading between polls
# Same rule as the other bars: a cached copy under 10 minutes old is effectively
# live, and the "Updated HH:MM" stamp already says how old it is.
QUIET_STALE_SEC = 600
ICON_PX = 64            # drawn at 64px; the tray scales it to the panel's icon size
# ------------------------------------------------------------------

HERE = os.path.dirname(os.path.realpath(__file__))
FETCH = os.path.join(HERE, 'usage-fetch.mjs')
RUN_DIR = os.path.join(os.path.expanduser('~'), '.cache', 'claude-usage-tray')

GREEN, ORANGE, RED, GREY = '#2ec27e', '#ff7800', '#e01b24', '#9a9996'


def color_for(percent, severity):
    if severity == 'critical' or percent >= 90:
        return RED
    if severity == 'warning' or percent >= 70:
        return ORANGE
    return GREEN


def rgb(hex_color):
    h = hex_color.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def ms_until(iso):
    try:
        return (datetime.fromisoformat(iso) - datetime.now(timezone.utc)).total_seconds() * 1000
    except (TypeError, ValueError):
        return None


def fmt_countdown(ms):
    if ms is None:
        return ''
    if ms <= 0:
        return 'reset'
    total_min = int(ms // 60000)
    h, m = divmod(total_min, 60)
    return f'{h}:{m:02d}' if h > 0 else f'{m}m'


def fmt_reset(iso):
    try:
        local = datetime.fromisoformat(iso).astimezone()
    except (TypeError, ValueError):
        return 'n/a'
    return f"{local.strftime('%a %H:%M')}  (in {fmt_countdown(ms_until(iso))})"


def fmt_clock(iso):
    try:
        return datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone().strftime('%H:%M')
    except (AttributeError, ValueError):
        return '?'


# ------------------------------------------------------------------
# Icon
# ------------------------------------------------------------------
def draw_icon(text, bars, ok=True):
    """Dark rounded badge (legible on light and dark panels): the session % on
    top, then one bar per (percent, color) in `bars`. Returns a cairo surface."""
    s = ICON_PX
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, s, s)
    cr = cairo.Context(surf)

    r = s * 0.16
    cr.new_sub_path()
    cr.arc(s - r, r, r, -math.pi / 2, 0)
    cr.arc(s - r, s - r, r, 0, math.pi / 2)
    cr.arc(r, s - r, r, math.pi / 2, math.pi)
    cr.arc(r, r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()
    cr.set_source_rgba(0.13, 0.13, 0.14, 0.92)
    cr.fill()

    # number, shrunk to fit ("100" is wider than "7")
    cr.select_font_face('Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    size = s * 0.5
    while size > 8:
        cr.set_font_size(size)
        ext = cr.text_extents(text)
        if ext.width <= s * 0.86:
            break
        size -= 1
    ext = cr.text_extents(text)
    cr.set_source_rgb(*((1, 1, 1) if ok else rgb(GREY)))
    cr.move_to((s - ext.width) / 2 - ext.x_bearing, s * 0.47 - ext.y_bearing - ext.height / 2)
    cr.show_text(text)

    # bars: track + fill, stacked from the bottom
    pad, bh, gap = s * 0.12, s * 0.12, s * 0.06
    y = s - pad - bh * len(bars) - gap * (len(bars) - 1)
    w = s - 2 * pad
    for percent, color in bars:
        cr.set_source_rgba(1, 1, 1, 0.22)
        cr.rectangle(pad, y, w, bh)
        cr.fill()
        fill = max(0.0, min(100.0, percent)) / 100 * w
        if fill > 0:
            cr.set_source_rgb(*rgb(color))
            cr.rectangle(pad, y, max(fill, s * 0.04), bh)
            cr.fill()
        y += bh + gap

    surf.flush()
    return surf


def to_pixmap(surf):
    """cairo's native-endian, premultiplied ARGB32 → the SNI wire format:
    straight-alpha ARGB32 in network byte order."""
    w, h, stride = surf.get_width(), surf.get_height(), surf.get_stride()
    src = bytes(surf.get_data())
    little = sys.byteorder == 'little'
    out = bytearray(w * h * 4)
    o = 0
    for y in range(h):
        row = y * stride
        for x in range(w):
            i = row + x * 4
            if little:
                b, g, r, a = src[i], src[i + 1], src[i + 2], src[i + 3]
            else:
                a, r, g, b = src[i], src[i + 1], src[i + 2], src[i + 3]
            if 0 < a < 255:
                r, g, b = (min(255, c * 255 // a) for c in (r, g, b))
            out[o:o + 4] = bytes((a, r, g, b))
            o += 4
    return (w, h, bytes(out))


# ------------------------------------------------------------------
# D-Bus: StatusNotifierItem + com.canonical.dbusmenu
# ------------------------------------------------------------------
SNI_XML = '''
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionMovieName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewAttentionIcon"/>
    <signal name="NewOverlayIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
  </interface>
</node>'''

MENU_XML = '''
<node>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg type="i" name="parentId" direction="in"/>
      <arg type="i" name="recursionDepth" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="u" name="revision" direction="out"/>
      <arg type="(ia{sv}av)" name="layout" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg type="ai" name="ids" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="a(ia{sv})" name="properties" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="name" direction="in"/>
      <arg type="v" name="value" direction="out"/>
    </method>
    <method name="Event">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="eventId" direction="in"/>
      <arg type="v" name="data" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg type="a(isvu)" name="events" direction="in"/>
      <arg type="ai" name="idErrors" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg type="i" name="id" direction="in"/>
      <arg type="b" name="needUpdate" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg type="ai" name="ids" direction="in"/>
      <arg type="ai" name="updatesNeeded" direction="out"/>
      <arg type="ai" name="idErrors" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated">
      <arg type="a(ia{sv})" name="updatedProps"/>
      <arg type="a(ias)" name="removedProps"/>
    </signal>
    <signal name="LayoutUpdated">
      <arg type="u" name="revision"/>
      <arg type="i" name="parent"/>
    </signal>
    <signal name="ItemActivationRequested">
      <arg type="i" name="id"/>
      <arg type="u" name="timestamp"/>
    </signal>
  </interface>
</node>'''

SNI_PATH, MENU_PATH = '/StatusNotifierItem', '/MenuBar'
WATCHER = 'org.kde.StatusNotifierWatcher'
ID_REFRESH, ID_QUIT = 1, 2      # actionable menu ids; info lines get 10+


class Tray:
    def __init__(self, loop):
        self.loop = loop
        self.data = {'ok': False, 'error': 'loading'}
        self.cancellable = None
        self.conn = None
        self.bus_name = f'org.kde.StatusNotifierItem-{os.getpid()}-1'

        self.title = 'Claude Usage'
        self.pixmap = to_pixmap(draw_icon('…', [(0, GREY)], ok=False))
        self.tooltip = 'Claude usage: loading…'
        self.menu_lines = ['Loading…']     # info lines, rebuilt on every render
        self.revision = 1

        Gio.bus_get(Gio.BusType.SESSION, None, self._on_bus)

    # ---------------- D-Bus plumbing ----------------
    def _on_bus(self, _src, res):
        self.conn = Gio.bus_get_finish(res)
        self.conn.register_object(SNI_PATH, Gio.DBusNodeInfo.new_for_xml(SNI_XML).interfaces[0],
                                  self._sni_call, self._sni_prop, None)
        self.conn.register_object(MENU_PATH, Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0],
                                  self._menu_call, self._menu_prop, None)
        Gio.bus_own_name_on_connection(self.conn, self.bus_name, Gio.BusNameOwnerFlags.NONE, None, None)
        # (Re-)register whenever a watcher appears — the panel restarting gets a new one.
        Gio.bus_watch_name_on_connection(self.conn, WATCHER, Gio.BusNameWatcherFlags.NONE,
                                         self._on_watcher, None)
        self.render()
        self.refresh()
        GLib.timeout_add_seconds(POLL_SECONDS, self._tick_poll)
        GLib.timeout_add_seconds(REDRAW_SECONDS, self._tick_redraw)

    def _on_watcher(self, conn, _name, _owner):
        conn.call(WATCHER, '/StatusNotifierWatcher', WATCHER, 'RegisterStatusNotifierItem',
                  GLib.Variant('(s)', (self.bus_name,)), None, Gio.DBusCallFlags.NONE, -1, None, None)

    def _emit(self, path, iface, signal, params=None):
        if self.conn:
            self.conn.emit_signal(None, path, iface, signal, params)

    def _sni_prop(self, _conn, _sender, _path, _iface, name):
        empty_px = GLib.Variant('a(iiay)', [])
        return {
            'Category': GLib.Variant('s', 'ApplicationStatus'),
            'Id': GLib.Variant('s', 'claude-usage-tray'),
            'Title': GLib.Variant('s', self.title),
            'Status': GLib.Variant('s', 'Active'),
            'WindowId': GLib.Variant('i', 0),
            'IconName': GLib.Variant('s', ''),
            'IconThemePath': GLib.Variant('s', ''),
            'IconPixmap': GLib.Variant('a(iiay)', [self.pixmap]),
            'OverlayIconName': GLib.Variant('s', ''),
            'OverlayIconPixmap': empty_px,
            'AttentionIconName': GLib.Variant('s', ''),
            'AttentionIconPixmap': empty_px,
            'AttentionMovieName': GLib.Variant('s', ''),
            'ToolTip': GLib.Variant('(sa(iiay)ss)', ('', [], 'Claude Usage', self.tooltip)),
            # The panel opens the menu on a left click too, like the GNOME dropdown.
            'ItemIsMenu': GLib.Variant('b', True),
            'Menu': GLib.Variant('o', MENU_PATH),
        }.get(name)

    def _sni_call(self, _conn, _sender, _path, _iface, method, _params, inv):
        # Clicks are handled by the panel showing our menu; nothing else to do.
        inv.return_value(None)

    # ---------------- menu ----------------
    def _menu_items(self):
        """[(id, props)] in display order."""
        lines = [(10 + i, {'label': t}) for i, t in enumerate(self.menu_lines)]
        return lines + [
            (3, {'type': 'separator'}),
            (ID_REFRESH, {'label': 'Refresh now'}),
            (ID_QUIT, {'label': 'Quit'}),
        ]

    @staticmethod
    def _props(props):
        return {k: GLib.Variant('s', v) for k, v in props.items()}

    def _layout(self):
        children = [GLib.Variant('(ia{sv}av)', (i, self._props(p), [])) for i, p in self._menu_items()]
        return (0, {'children-display': GLib.Variant('s', 'submenu')}, children)

    def _menu_prop(self, _conn, _sender, _path, _iface, name):
        return {
            'Version': GLib.Variant('u', 3),
            'TextDirection': GLib.Variant('s', 'ltr'),
            'Status': GLib.Variant('s', 'normal'),
            'IconThemePath': GLib.Variant('as', []),
        }.get(name)

    def _menu_call(self, _conn, _sender, _path, _iface, method, params, inv):
        if method == 'GetLayout':
            inv.return_value(GLib.Variant('(u(ia{sv}av))', (self.revision, self._layout())))
        elif method == 'GetGroupProperties':
            ids = set(params.unpack()[0])
            rows = [(i, self._props(p)) for i, p in self._menu_items() if not ids or i in ids]
            if not ids or 0 in ids:
                rows.insert(0, (0, {'children-display': GLib.Variant('s', 'submenu')}))
            inv.return_value(GLib.Variant('(a(ia{sv}))', (rows,)))
        elif method == 'GetProperty':
            item_id, name = params.unpack()
            props = dict(self._menu_items()).get(item_id, {})
            inv.return_value(GLib.Variant('(v)', (GLib.Variant('s', props.get(name, '')),)))
        elif method == 'Event':
            item_id, event = params.unpack()[:2]
            if event == 'clicked':
                self._clicked(item_id)
            inv.return_value(None)
        elif method == 'EventGroup':
            for item_id, event, _data, _ts in params.unpack()[0]:
                if event == 'clicked':
                    self._clicked(item_id)
            inv.return_value(GLib.Variant('(ai)', ([],)))
        elif method == 'AboutToShow':
            inv.return_value(GLib.Variant('(b)', (False,)))
        elif method == 'AboutToShowGroup':
            inv.return_value(GLib.Variant('(aiai)', ([], [])))
        else:
            inv.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', method)

    def _clicked(self, item_id):
        # Defer: a reply must go out before we tear the connection down on Quit.
        if item_id == ID_REFRESH:
            GLib.idle_add(lambda: self.refresh(force=True) and False)
        elif item_id == ID_QUIT:
            GLib.idle_add(self.loop.quit)

    # ---------------- publishing ----------------
    def _publish(self, text, bars, ok, tooltip, title, lines):
        self.pixmap = to_pixmap(draw_icon(text, bars, ok))
        self.tooltip, self.title = tooltip, title
        self._emit(SNI_PATH, 'org.kde.StatusNotifierItem', 'NewIcon')
        self._emit(SNI_PATH, 'org.kde.StatusNotifierItem', 'NewToolTip')
        self._emit(SNI_PATH, 'org.kde.StatusNotifierItem', 'NewTitle')
        if lines != self.menu_lines:
            self.menu_lines = lines
            self.revision += 1
            self._emit(MENU_PATH, 'com.canonical.dbusmenu', 'LayoutUpdated',
                       GLib.Variant('(ui)', (self.revision, 0)))

    def render(self):
        d = self.data
        if not d.get('ok'):
            err = d.get('error', '')
            msg = {
                'loading': 'Loading…', 'no-credentials': 'no login', 'no-token': 'no login',
                'auth-expired': 'auth — open Claude', 'network': 'offline',
                'rate-limited': 'rate-limited', 'http-429': 'rate-limited',
            }.get(err) or ('API error' if err.startswith('http-') else err)
            if err == 'auth-expired':
                line = f"Token expired — {d.get('hint') or 'run Claude Code once'}"
            elif err == 'rate-limited':
                line = f"Rate-limited — retrying in {fmt_countdown((d.get('retryInSec') or 0) * 1000)}"
            elif err == 'loading':
                line = 'Loading…'
            else:
                line = f'Unavailable ({err})'
            self._publish('…' if err == 'loading' else '!', [(0, GREY)], False,
                          f'Claude usage: {msg}', f'Claude Usage — {msg}', ['Claude Usage', line])
            return

        limits = d.get('limits') or []
        s = d.get('session')
        w = next((l for l in limits if l.get('kind') == 'weekly_all'), None)
        # Per-model weekly caps (Fable today). The icon has room for one weekly
        # bar, so it shows whichever weekly limit will cut you off first.
        scoped = sorted((l for l in limits if l.get('kind') == 'weekly_scoped'),
                        key=lambda l: l.get('percent') or 0, reverse=True)

        sub = d.get('subscription')
        lines = [f"Claude Usage{' — ' + sub if sub else ''}"]
        bars, tip = [], []
        if s:
            bars.append((s['percent'], color_for(s['percent'], s.get('severity'))))
            rel = fmt_countdown(ms_until(s.get('resetsAt')))
            tip.append(f"{s['percent']}%{' · ' + rel if rel else ''}")
            lines.append(f"Session (5h): {s['percent']}%   resets {fmt_reset(s.get('resetsAt'))}")
        else:
            lines.append('Session: n/a')

        worst = max([x for x in [w] + scoped[:1] if x], key=lambda l: l.get('percent') or 0, default=None)
        if worst:
            bars.append((worst['percent'], color_for(worst['percent'], worst.get('severity'))))
        if w:
            tip.append(f"W {w['percent']}%")
            lines.append(f"Weekly: {w['percent']}%   resets {fmt_reset(w.get('resetsAt'))}")
        else:
            lines.append('Weekly: n/a')
        if scoped:
            x = scoped[0]
            tip.append(f"{(x.get('scopeName') or 'S')[0].upper()} {x['percent']}%")
        lines += [f"{l['label']}: {l['percent']}%   resets {fmt_reset(l.get('resetsAt'))}" for l in scoped]

        if d.get('stale') and (d.get('cacheAgeSec') or 0) > QUIET_STALE_SEC:
            # A 429 is a cooldown, not a dead end: say when we'll try again, so it's
            # clear why "Refresh now" is deliberately doing nothing.
            note = d.get('note')
            if note == 'auth-expired':
                why = 'token expired — run Claude Code'
            elif note == 'offline':
                why = 'offline'
            elif d.get('rateLimited'):
                why = f"rate-limited — retrying in {fmt_countdown((d.get('retryInSec') or 0) * 1000)}"
            else:
                why = f'API throttled ({note})'
            lines.append(f"⚠ {why} — cached {d.get('cacheAgeSec', '?')}s ago")
        else:
            lines.append(f"Updated {fmt_clock(d.get('fetchedAt'))}")

        summary = '  ·  '.join(tip)
        self._publish(f"{s['percent']}" if s else '–', bars or [(0, GREY)], True,
                      summary, f'Claude  {summary}', lines)

    # ---------------- fetching ----------------
    # `force` (the "Refresh now" item) makes the fetcher skip its freshness guards.
    # It still obeys a 429 cooldown — retrying during the penalty is what extends it.
    def refresh(self, force=False):
        if self.cancellable:
            self.cancellable.cancel()
        self.cancellable = Gio.Cancellable()
        node = GLib.find_program_in_path('node') or '/usr/bin/node'
        argv = [node, FETCH] + (['--force'] if force else [])
        try:
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
        except GLib.Error as e:
            print(f'claude-usage-tray: spawn failed: {e.message}', file=sys.stderr)
            self.data = {'ok': False, 'error': 'spawn'}
            self.render()
            return
        proc.communicate_utf8_async(None, self.cancellable, self._on_done)

    def _on_done(self, proc, res):
        try:
            _, stdout, _ = proc.communicate_utf8_finish(res)
        except GLib.Error as e:
            if not e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED):
                self.data = {'ok': False, 'error': 'run'}
                self.render()
            return
        try:
            self.data = json.loads(stdout or '{}')
        except ValueError:
            self.data = {'ok': False, 'error': 'parse'}
        self.render()

    def _tick_poll(self):
        self.refresh()
        return True

    def _tick_redraw(self):
        self.render()
        return True


def main():
    # One tray per session: a second launch (autostart plus a manual start) would
    # just double the polling against the shared rate limit.
    os.makedirs(RUN_DIR, exist_ok=True)
    lock = open(os.path.join(RUN_DIR, 'tray.lock'), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print('claude-usage-tray: already running', file=sys.stderr)
        return
    if not os.path.isfile(FETCH):
        sys.exit(f'claude-usage-tray: missing {FETCH} (run install-rpi.sh)')
    loop = GLib.MainLoop()
    Tray(loop)
    loop.run()


if __name__ == '__main__':
    main()
