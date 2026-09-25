/* SPIRIT DERBY — ui/chat.js
 * Simulated Twitch chat in the sidebar Chat tab (M2):
 *  - append-only feed (cap 80 rows): viewer lines with a coloured name chip, command replies
 *    indented with ↳ in their severity colour, dim system lines (race start/finish, hype);
 *  - an input row: "@Name: !cmd" (or "Name: !cmd") speaks as Name, otherwise as the sender
 *    picked in the <select> (recent senders + Streamer = source 'admin', isMod);
 *  - a "🤖 Demo bots" toggle: six fictional viewers send plausible commands every 2–4 s;
 *  - in overlay mode (body.sd-overlay) command replies also pop up as toasts under the track.
 * Everything goes through SD.commands.handleChat — the same pipeline Twitch uses in M7.
 * Panel contract: SD.ui.chat = { init(rootEl), render(state), destroy() }.
 */
(function (SD) {
  'use strict';

  const dom = SD.ui.dom;
  const esc = dom.esc;

  const FEED_MAX = 80;
  const RECENT_MAX = 8;
  const STREAMER = 'Streamer';
  const UI_KEY = 'spiritderby.ui';
  const BOTS = ['FoxFan', 'MothMom', 'AcornAndy', 'WispWatcher', 'BrambleBob', 'LanternLiz'];
  const BOT_MIN_MS = 2000;
  const BOT_SPREAD_MS = 2000;
  const NAME_COLORS = ['#e6c65e', '#9fd67a', '#e0875f', '#8fb5e6', '#c69be6', '#7fe0c0', '#f0a3b5', '#d9b38c', '#b5d98f', '#f2c38a'];
  const STAT_WORDS = ['speed', 'speed', 'stamina', 'power', 'wisdom', 'luck', 'spd', 'sta', 'pow'];
  const CHATTER = [
    "LET'S GOOO", 'the owl is cheating', 'Pog', 'chat is this real', 'forest spirits pls', 'no way',
    'that raccoon is up to something', 'hype hype hype', 'who fed the boar', 'I trust the process',
    'my runner is sleepy again', 'first time here, what is going on', 'mushroom rings are OP', 'this is my whole personality now'
  ];
  const SEVS = { info: 1, good: 1, bad: 1, epic: 1 };

  function sev(s) { return SEVS[s] ? s : 'info'; }
  function rand(n) { return Math.floor(Math.random() * n); }        // UI-only randomness (bots)
  function pick(arr) { return arr[rand(arr.length)]; }
  function weighted(items) {
    let total = 0;
    items.forEach(function (it) { total += Math.max(0, it[0]); });
    let x = Math.random() * total;
    for (let i = 0; i < items.length; i++) { x -= Math.max(0, items[i][0]); if (x < 0) return items[i][1]; }
    return items.length ? items[items.length - 1][1] : null;
  }

  function hashStr(s) {
    if (SD.rng && typeof SD.rng.hash === 'function') return SD.rng.hash(String(s));
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function nameColor(key) { return NAME_COLORS[hashStr(String(key || '').toLowerCase()) % NAME_COLORS.length]; }

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writePrefs(patch) {
    try { localStorage.setItem(UI_KEY, JSON.stringify(Object.assign(readPrefs(), patch))); } catch (e) { /* private mode */ }
  }

  function template() {
    return '' +
      '<div class="chat__head">' +
        '<h2 class="chat__title">Stream chat <span class="chat__sim">simulated</span></h2>' +
        '<button type="button" class="btn btn--sm chat__bots" data-ref="bots" aria-pressed="false" ' +
          'title="Six fictional viewers send commands every 2–4 seconds">🤖 Demo bots</button>' +
      '</div>' +
      '<ol class="chat__feed" data-ref="feed" aria-live="polite" aria-label="Chat messages, newest last"></ol>' +
      '<form class="chat__form" data-ref="form" autocomplete="off">' +
        '<select class="field chat__sender" data-ref="sender" aria-label="Send as" title="Send as (or type @Name: before the message)"></select>' +
        '<input class="field chat__input" data-ref="input" type="text" maxlength="300" spellcheck="false" ' +
          'placeholder="!join  or  @FoxFan: !train speed" aria-label="Chat message">' +
        '<button type="submit" class="btn btn--primary chat__send">Send</button>' +
      '</form>' +
      '<p class="chat__hint" data-ref="hint">Try <b>!join</b> · <b>!claim</b> · <b>!train speed</b> · <b>!rest</b> · <b>!cheer moss</b> · ' +
        '<b>!status</b> · <b>!inspect moss</b> · <b>!help</b>. Start a line with <b>@Name:</b> to speak as that viewer.</p>';
  }

  const chat = {
    name: 'chat',
    root: null,
    refs: {},
    offs: [],
    sender: STREAMER,
    recent: [],
    senderKey: '',
    botsOn: false,
    botTimer: 0,
    botTurn: 0,
    observer: null,

    init: function (root) {
      const self = this;
      this.root = root;
      root.innerHTML = template();
      this.refs = dom.refs(root);

      // Enable the sidebar tab (disabled in index.html until this module loads).
      const tab = document.getElementById('tab-chat');
      if (tab) {
        tab.disabled = false;
        const soon = tab.querySelector('.tab__soon');
        if (soon && soon.parentNode) soon.parentNode.removeChild(soon);
      }

      const prefs = readPrefs().chat || {};
      if (Array.isArray(prefs.recent)) this.recent = prefs.recent.filter(function (n) { return typeof n === 'string' && n; }).slice(0, RECENT_MAX);
      if (typeof prefs.sender === 'string' && prefs.sender) this.sender = prefs.sender;
      this.fillSenders();

      this.refs.form.addEventListener('submit', function (e) { e.preventDefault(); self.submit(); });
      this.refs.sender.addEventListener('change', function () { self.setSender(self.refs.sender.value); });
      this.refs.bots.addEventListener('click', function () { self.setBots(!self.botsOn); });

      this.offs.push(dom.on('CHAT_MESSAGE', function (m) { self.onMessage(m); }));
      this.offs.push(dom.on('RACE_STARTED', function (p) {
        const rec = p && p.record;
        self.system('🏁 ' + (rec ? rec.trackName + ' · ' + rec.distance + ' m — ' : '') +
          'the gates are opening! Training is locked until the results; !cheer still works.', 'info');
      }));
      this.offs.push(dom.on('RACE_FINISHED', function (p) {
        const sum = p && p.record && p.record.summary;
        self.system('🏆 ' + (sum && sum.winnerName ? sum.winnerName + ' wins!' : 'The race is over!') + ' Training is open again.', 'epic');
      }));
      this.offs.push(dom.on('RACE_ABORTED', function (p) {
        if (p && p.reset) return;
        self.system('The race was cancelled. Training is open again.', 'info');
      }));
      this.offs.push(dom.on('HYPE_THRESHOLD', function (p) { if (p && p.text) self.system('🔥 ' + p.text, 'epic'); }));

      // Render whatever the pipeline already recorded this session.
      const feed = (SD.state && SD.state.runtime && SD.state.runtime.chatFeed) || [];
      if (feed.length) feed.forEach(function (m) { self.append(m); });
      else this.showEmpty();
      if (!SD.commands) {
        this.refs.input.disabled = true;
        this.refs.hint.textContent = 'The command pipeline (js/commands.js) did not load, so chat is read-only.';
        this.refs.bots.disabled = true;
      }

      // The feed has no height while its tab is hidden: jump to the newest line when shown.
      const panel = document.getElementById('panel-chat');
      if (panel && typeof MutationObserver === 'function') {
        this.observer = new MutationObserver(function () { if (!panel.hidden) self.scrollToEnd(true); });
        this.observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
      }

      const s = dom.state();
      if (s) this.render(s);
    },

    destroy: function () {
      this.offs.forEach(function (off) { off(); });
      this.offs = [];
      this.setBots(false, true);
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
    },

    render: function () {
      const b = this.refs.bots;
      if (b) {
        b.setAttribute('aria-pressed', String(this.botsOn));
        b.classList.toggle('chat__bots--on', this.botsOn);
      }
      this.fillSenders();
    },

    // ---------------------------------------------------------------- feed
    showEmpty: function () {
      const feed = this.refs.feed;
      if (!feed || feed.children.length) return;
      feed.appendChild(dom.el('li', { class: 'chat__empty', text: 'Chat is quiet. Type !join below, or switch on the demo bots.' }));
    },

    onMessage: function (m) {
      if (!m) return;
      this.append(m);
      if (m.kind === 'user' && m.displayName && m.source !== 'system') this.noteSender(m.displayName);
      // Overlay: viewers only see command feedback through the reply-toast strip.
      if (m.kind === 'reply' && !m.unknown && document.body.classList.contains('sd-overlay')) {
        dom.toast(m.text, sev(m.severity), { who: '@' + (m.displayName || m.username || ''), ms: 6500 });
      }
    },

    append: function (m) {
      const feed = this.refs.feed;
      if (!feed || !m) return;
      const empty = feed.querySelector('.chat__empty');
      if (empty) feed.removeChild(empty);
      const stick = this.nearBottom();
      const li = document.createElement('li');
      const kind = m.kind === 'reply' || m.kind === 'system' ? m.kind : 'user';
      li.setAttribute('data-id', m.id || '');
      if (kind === 'user') {
        const streamer = m.source === 'admin';
        const badge = streamer ? '🎙 ' : (m.isMod ? '🛡 ' : '');
        li.className = 'chat__row chat__row--user' + (m.isCommand ? ' chat__row--cmd' : '');
        li.innerHTML = '<span class="chat__name' + (streamer ? ' chat__name--streamer' : '') + '" style="--chip:' +
          esc(streamer ? 'var(--gold-bright)' : nameColor(m.username || m.displayName)) + '" title="' + esc(m.source || 'sim') + '">' +
          esc(badge + (m.displayName || m.username || '?')) + '</span><span class="chat__text">' + esc(m.text) + '</span>';
      } else if (kind === 'reply') {
        li.className = 'chat__row chat__row--reply sev-' + sev(m.severity) + (m.ok === false ? ' chat__row--refused' : '');
        li.innerHTML = '<span class="chat__arrow" aria-hidden="true">↳</span><span class="chat__text">' +
          '<span class="chat__to">@' + esc(m.displayName || m.username || '') + '</span> ' + esc(m.text) + '</span>';
      } else {
        li.className = 'chat__row chat__row--system sev-' + sev(m.severity);
        li.textContent = m.text || '';
      }
      feed.appendChild(li);
      while (feed.children.length > FEED_MAX) feed.removeChild(feed.firstElementChild);
      if (stick) this.scrollToEnd();
    },

    system: function (text, severity) {
      if (SD.commands && typeof SD.commands.system === 'function') SD.commands.system(text, severity);
      else this.append({ kind: 'system', text: text, severity: severity });
    },

    nearBottom: function () {
      const f = this.refs.feed;
      if (!f || !f.clientHeight) return true;
      return f.scrollHeight - f.scrollTop - f.clientHeight < 48;
    },

    scrollToEnd: function () {
      const f = this.refs.feed;
      if (f) f.scrollTop = f.scrollHeight;
    },

    // ---------------------------------------------------------------- senders
    // Keep the casing a viewer already has (typing "foxfan:" speaks as FoxFan).
    canonicalName: function (name) {
      const key = String(name || '').toLowerCase();
      if (key === STREAMER.toLowerCase()) return STREAMER;
      const s = dom.state();
      const p = s && s.players && s.players[key];
      if (p && p.displayName) return p.displayName;
      const known = this.recent.concat(BOTS).filter(function (n) { return n.toLowerCase() === key; })[0];
      return known || name;
    },

    noteSender: function (name) {
      if (!name || name.toLowerCase() === STREAMER.toLowerCase()) return;
      const key = name.toLowerCase();
      this.recent = [name].concat(this.recent.filter(function (n) { return n.toLowerCase() !== key; })).slice(0, RECENT_MAX);
      this.fillSenders();
    },

    setSender: function (name) {
      this.sender = name || STREAMER;
      if (this.sender !== STREAMER) this.noteSender(this.sender);
      this.fillSenders();
      writePrefs({ chat: { sender: this.sender, recent: this.recent } });
    },

    fillSenders: function () {
      const sel = this.refs.sender;
      if (!sel) return;
      const names = [STREAMER].concat(this.recent.filter(function (n) { return n.toLowerCase() !== STREAMER.toLowerCase(); }));
      if (this.sender && names.map(function (n) { return n.toLowerCase(); }).indexOf(this.sender.toLowerCase()) < 0) names.push(this.sender);
      const key = names.join('|') + '#' + this.sender;
      if (key === this.senderKey || document.activeElement === sel) return;
      this.senderKey = key;
      sel.innerHTML = names.map(function (n) {
        return '<option value="' + esc(n) + '">' + esc(n === STREAMER ? '🎙 Streamer' : n) + '</option>';
      }).join('');
      sel.value = this.sender;
    },

    // ---------------------------------------------------------------- input
    submit: function () {
      const input = this.refs.input;
      if (!input || !SD.commands) return;
      const raw = input.value.trim();
      if (!raw) return;
      let name = this.sender || STREAMER;
      let text = raw;
      const m = /^@?([A-Za-z0-9_]{1,25})\s*:\s*(\S[\s\S]*)$/.exec(raw);
      if (m && !/^\/\//.test(m[2])) {           // "Name: text" (but not "https://...")
        name = this.canonicalName(m[1]);
        text = m[2];
        this.setSender(name);
      }
      this.send(name, text);
      input.value = '';
      input.focus();
    },

    send: function (name, text) {
      const streamer = name.toLowerCase() === STREAMER.toLowerCase();
      try {
        return SD.commands.handleChat({
          username: name, displayName: name, text: text,
          source: streamer ? 'admin' : 'sim', isMod: streamer
        });
      } catch (e) {
        console.error('[chat] handleChat failed', e);
        dom.toast('Chat failed: ' + ((e && e.message) || e), 'bad');
        return null;
      }
    },

    // ---------------------------------------------------------------- demo bots
    setBots: function (on, silent) {
      const self = this;
      on = !!on && !!SD.commands;
      clearTimeout(this.botTimer);
      this.botTimer = 0;
      const was = this.botsOn;
      this.botsOn = on;
      if (on) {
        const next = function () {
          self.botTimer = setTimeout(function () {
            if (!self.botsOn) return;
            try { self.botStep(); } catch (e) { console.error('[chat] demo bot failed', e); }
            next();
          }, BOT_MIN_MS + Math.random() * BOT_SPREAD_MS);
        };
        next();
      }
      if (!silent && was !== on) {
        this.system(on ? '🤖 Demo bots joined the chat: ' + BOTS.join(', ') + '.' : '🤖 Demo bots went quiet.', 'info');
      }
      this.render();
    },

    botStep: function () {
      const s = dom.state();
      if (!s) return;
      // Mostly rotate through the bots so all six take part, with a little randomness.
      this.botTurn = (this.botTurn + 1 + (Math.random() < 0.3 ? 1 : 0)) % BOTS.length;
      const name = BOTS[this.botTurn];
      const line = this.botLine(s, name);
      if (line) this.send(name, line);
    },

    // A plausible chat line for a bot given the current state.
    botLine: function (s, name) {
      const key = name.toLowerCase();
      const p = s.players && s.players[key];
      if (!p) return Math.random() < 0.85 ? '!join' : pick(CHATTER);
      const runners = (s.runners || []).filter(function (r) { return !r.retired; });
      if (!runners.length) return pick(CHATTER);
      const locked = dom.isRaceLocked(s);
      const cd = function (cmd) { return SD.commands.cooldownLeft ? SD.commands.cooldownLeft(name, cmd) : 0; };
      const mine = p.runnerId ? runners.filter(function (r) { return r.id === p.runnerId && r.owner && r.owner.toLowerCase() === key; })[0] : null;
      const short = function (r) { return shortName(s, r); };

      if (!mine && !locked && cd('claim') === 0) {
        const free = runners.filter(function (r) { return !r.owner; });
        if (free.length) return Math.random() < 0.6 ? '!claim ' + short(pick(free)) : '!claim';
      }

      const opts = [];
      if (locked) {
        const field = (s.currentRace && s.currentRace.record && s.currentRace.record.entrants) || [];
        if (cd('cheer') === 0) {
          const target = mine && field.some(function (e) { return e.runnerId === mine.id; }) ? mine
            : (field.length ? runners.filter(function (r) { return r.id === pick(field).runnerId; })[0] : null);
          opts.push([60, '!cheer' + (target && Math.random() < 0.7 ? ' ' + short(target) : '')]);
        }
        opts.push([18, pick(CHATTER)]);
        opts.push([6, '!race']);
        opts.push([4, '!train speed']);                 // shows the race-lock reply now and then
      } else {
        if (cd('train') === 0) {
          if (mine && mine.energy >= 25) opts.push([40, '!train ' + pick(STAT_WORDS)]);
          if (s.settings && s.settings.openTraining !== false) opts.push([mine ? 10 : 30, '!train ' + short(pick(runners)) + ' ' + pick(STAT_WORDS)]);
        }
        if (cd('cheer') === 0) {
          const target = mine && Math.random() < 0.7 ? mine : pick(runners);
          opts.push([30, '!cheer' + (Math.random() < 0.75 ? ' ' + short(target) : '')]);
        }
        if (mine && cd('rest') === 0 && (!SD.training || SD.training.restCooldownLeft(mine) === 0)) {
          opts.push([mine.energy < 35 ? 50 : 4, '!rest']);
        }
        opts.push([6, '!status']);
        opts.push([3, '!inspect ' + short(pick(runners))]);
        opts.push([2, '!race']);
        opts.push([8, pick(CHATTER)]);
      }
      return weighted(opts) || pick(CHATTER);
    }
  };

  // "Moss Runner" -> "moss" when that prefix is unambiguous (how chat actually types names).
  function shortName(s, r) {
    const first = String(r.name || '').split(/\s+/)[0].toLowerCase();
    try {
      const f = SD.state.findRunner(first, s);
      if (f && f.runner && f.runner.id === r.id) return first;
    } catch (e) { /* fall back to the full name */ }
    return r.name;
  }

  SD.ui.chat = chat;
})(globalThis.SD = globalThis.SD || {});
